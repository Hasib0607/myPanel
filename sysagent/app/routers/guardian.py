import json
import os
import ipaddress
import re
import shutil
import socket
import subprocess
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psutil
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.command import run_command
from app.config import settings

router = APIRouter()

WATCHED_SERVICES = [
    {"key": "nginx", "name": "Nginx", "unit": "nginx", "ports": [80]},
    {"key": "redis", "name": "Redis", "unit": "redis-server", "ports": [6379]},
    {"key": "postgres", "name": "PostgreSQL", "unit": "postgresql", "ports": [5432, 5433]},
    {"key": "pgbouncer", "name": "PgBouncer", "unit": "pgbouncer", "ports": [6432], "optional": True},
    {"key": "panel-api", "name": "Panel API", "unit": "vps-panel-api", "ports": [4000]},
    {"key": "panel-frontend", "name": "Panel Frontend", "unit": "vps-panel-frontend", "ports": [3000]},
    {"key": "panel-workers", "name": "Panel Workers", "unit": "vps-panel-workers", "ports": []},
    {"key": "sysagent", "name": "System Agent", "unit": "vps-panel-sysagent", "ports": [5000]},
]

WATCHED_PORTS = [80, 443, 2083, 3000, 4000, 5000, 6379, 5432, 5433, 6432]
NGINX_ACCESS_RE = re.compile(r'^(?P<ip>\S+) \S+ \S+ \[[^\]]+\] "(?P<method>\S+) (?P<path>[^"]*?) (?P<protocol>[^"]*?)" (?P<status>\d{3})')
SAFE_RESTART_UNITS = {
    "nginx": "nginx",
    "panel-api": "vps-panel-api",
    "panel-frontend": "vps-panel-frontend",
    "panel-workers": "vps-panel-workers",
}


class ServiceRestartRequest(BaseModel):
    serviceKey: str


class Pm2RestartRequest(BaseModel):
    name: str | None = None
    pmId: int | None = None


class LogCleanupRequest(BaseModel):
    olderThanDays: int = Field(default=1, ge=1, le=30)
    minSizeMb: int = Field(default=1, ge=0, le=1024)
    maxFiles: int = Field(default=200, ge=1, le=1000)


class IpActionRequest(BaseModel):
    ip: str
    reason: str | None = None


class RateLimitTemplateRequest(BaseModel):
    mode: str = Field(default="balanced", pattern="^(balanced|strict)$")


class FileQuarantineRequest(BaseModel):
    path: str


SUSPICIOUS_FILE_EXTENSIONS = {".php", ".phtml", ".phar", ".cgi", ".pl", ".py", ".sh"}
SUSPICIOUS_FILE_PATTERNS = ["base64_decode", "shell_exec", "passthru", "eval(", "assert($_", "preg_replace", "system("]
IGNORED_DIR_NAMES = {".git", "node_modules", "vendor", ".next", "__pycache__", "cache", "logs"}
RATE_LIMIT_TEMPLATES = {
    "balanced": "limit_req_zone $binary_remote_addr zone=vps_panel_guardian:10m rate=10r/s;\nlimit_conn_zone $binary_remote_addr zone=vps_panel_conn:10m;\n",
    "strict": "limit_req_zone $binary_remote_addr zone=vps_panel_guardian:10m rate=3r/s;\nlimit_conn_zone $binary_remote_addr zone=vps_panel_conn:10m;\n",
}


def command_output(command: list[str], timeout: int = 4) -> dict[str, Any]:
    if not shutil.which(command[0]):
        return {"available": False, "stdout": "", "stderr": f"{command[0]} unavailable", "returncode": 127}
    try:
        completed = subprocess.run(command, capture_output=True, text=True, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"available": True, "stdout": "", "stderr": f"{' '.join(command)} timed out", "returncode": 124}
    return {
        "available": True,
        "stdout": completed.stdout[-8000:],
        "stderr": completed.stderr[-4000:],
        "returncode": completed.returncode,
    }


def systemd_state(unit: str) -> dict[str, Any]:
    if not shutil.which("systemctl"):
        return {"state": "unknown", "detail": "systemctl unavailable"}
    completed = subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True, check=False, timeout=3)
    state = completed.stdout.strip() or completed.stderr.strip() or "unknown"
    return {"state": state, "detail": f"{unit}:{state}"}


def listening_ports() -> dict[int, dict[str, Any]]:
    ports: dict[int, dict[str, Any]] = {}
    for connection in psutil.net_connections(kind="inet"):
        if connection.status != psutil.CONN_LISTEN or not connection.laddr:
            continue
        pid = connection.pid
        process_name = None
        if pid:
            try:
                process_name = psutil.Process(pid).name()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                process_name = None
        ports[connection.laddr.port] = {
            "address": connection.laddr.ip,
            "pid": pid,
            "process": process_name,
        }
    return ports


def tail_file(path: str, lines: int = 80) -> list[str]:
    file_path = Path(path)
    if not file_path.exists() or not file_path.is_file():
        return []


def matching_log_lines(ip: str) -> dict[str, Any]:
    access = [line.strip() for line in tail_file("/var/log/nginx/access.log", 300) if ip in line]
    error = [line.strip() for line in tail_file("/var/log/nginx/error.log", 120) if ip in line]
    auth = [line.strip() for line in tail_file("/var/log/auth.log", 200) if ip in line]
    return {"ip": ip, "access": access[-50:], "error": error[-30:], "auth": auth[-50:]}
    try:
        with file_path.open("r", encoding="utf-8", errors="ignore") as handle:
            return handle.readlines()[-lines:]
    except OSError:
        return []


def count_patterns(lines: list[str], patterns: list[str]) -> int:
    lowered = [line.lower() for line in lines]
    return sum(1 for line in lowered if any(pattern in line for pattern in patterns))


def safe_ip(ip: str) -> bool:
    try:
        parsed = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (parsed.is_private or parsed.is_loopback or parsed.is_link_local or parsed.is_multicast or parsed.is_reserved)


def auth_ip_summary(lines: list[str]) -> list[dict[str, Any]]:
    counts: Counter[str] = Counter()
    for line in lines:
        lowered = line.lower()
        if not any(marker in lowered for marker in ["failed password", "invalid user", "authentication failure"]):
            continue
        match = re.search(r"from (?P<ip>[0-9a-fA-F:.]+)", line)
        if match and safe_ip(match.group("ip")):
            counts[match.group("ip")] += 1
    return [{"ip": ip, "sshFailures": count} for ip, count in counts.most_common(20)]


def pm2_status() -> dict[str, Any]:
    result = command_output(["pm2", "jlist"], timeout=5)
    if not result["available"] or result["returncode"] != 0:
        return {"available": result["available"], "items": [], "detail": result["stderr"] or "pm2 unavailable"}
    try:
        processes = json.loads(result["stdout"] or "[]")
    except json.JSONDecodeError:
        return {"available": True, "items": [], "detail": "pm2 JSON could not be parsed", "raw": result["stdout"][-2000:]}

    items = []
    for process in processes:
        env = process.get("pm2_env") or {}
        monit = process.get("monit") or {}
        status = env.get("status") or "unknown"
        items.append({
            "name": process.get("name") or env.get("name") or "unknown",
            "pmId": process.get("pm_id"),
            "pid": process.get("pid"),
            "status": status,
            "healthy": status == "online",
            "restarts": env.get("restart_time", 0),
            "unstableRestarts": env.get("unstable_restarts", 0),
            "uptimeMs": max(0, int(datetime.now(timezone.utc).timestamp() * 1000) - int(env.get("pm_uptime") or 0)) if env.get("pm_uptime") else None,
            "cpuPercent": monit.get("cpu"),
            "memoryBytes": monit.get("memory"),
        })

    return {
        "available": True,
        "items": items,
        "online": sum(1 for item in items if item["healthy"]),
        "total": len(items),
        "detail": f"{sum(1 for item in items if item['healthy'])}/{len(items)} online",
    }


def nginx_access_summary(lines: list[str]) -> dict[str, Any]:
    status_counts: Counter[str] = Counter()
    ip_counts: Counter[str] = Counter()
    bad_ip_counts: Counter[str] = Counter()
    path_counts: Counter[str] = Counter()
    parsed = 0

    for line in lines:
        match = NGINX_ACCESS_RE.match(line)
        if not match:
            continue
        parsed += 1
        ip = match.group("ip")
        path = match.group("path")
        status = match.group("status")
        status_counts[status] += 1
        ip_counts[ip] += 1
        if status.startswith(("4", "5")):
            bad_ip_counts[ip] += 1
            path_counts[path.split("?", 1)[0]] += 1

    return {
        "sampleSize": len(lines),
        "parsed": parsed,
        "statusCounts": [{"status": status, "count": count} for status, count in status_counts.most_common()],
        "topIps": [{"ip": ip, "count": count} for ip, count in ip_counts.most_common(8)],
        "topBadIps": [{"ip": ip, "count": count} for ip, count in bad_ip_counts.most_common(8)],
        "topBadPaths": [{"path": path, "count": count} for path, count in path_counts.most_common(8)],
    }


def suspicious_ip_candidates(auth_lines: list[str], access_summary: dict[str, Any]) -> list[dict[str, Any]]:
    by_ip: dict[str, dict[str, Any]] = {}
    for item in auth_ip_summary(auth_lines):
        by_ip[item["ip"]] = {"ip": item["ip"], "sshFailures": item["sshFailures"], "badHttp": 0, "requests": 0, "score": item["sshFailures"] * 20, "reasons": ["ssh failures"]}

    for item in access_summary.get("topIps", []):
        if not safe_ip(item["ip"]):
            continue
        by_ip.setdefault(item["ip"], {"ip": item["ip"], "sshFailures": 0, "badHttp": 0, "requests": 0, "score": 0, "reasons": []})
        by_ip[item["ip"]]["requests"] = item["count"]
        if item["count"] >= 50:
            by_ip[item["ip"]]["score"] += min(40, item["count"] // 5)
            by_ip[item["ip"]]["reasons"].append("request spike")

    for item in access_summary.get("topBadIps", []):
        if not safe_ip(item["ip"]):
            continue
        by_ip.setdefault(item["ip"], {"ip": item["ip"], "sshFailures": 0, "badHttp": 0, "requests": 0, "score": 0, "reasons": []})
        by_ip[item["ip"]]["badHttp"] = item["count"]
        by_ip[item["ip"]]["score"] += min(60, item["count"] * 10)
        by_ip[item["ip"]]["reasons"].append("bad HTTP responses")

    candidates = []
    for item in by_ip.values():
        item["recommendation"] = "auto-block" if item["score"] >= 80 else "suggest-block" if item["score"] >= 40 else "monitor"
        candidates.append(item)
    return sorted(candidates, key=lambda item: item["score"], reverse=True)[:20]


def file_watch_scan() -> dict[str, Any]:
    roots = [Path(root).resolve() for root in settings.guardian_file_watch_roots.split(",") if root.strip()]
    findings = []
    scanned = 0
    max_files = 4000
    for root in roots:
        if not root.exists() or not root.is_dir():
            continue
        for path in root.rglob("*"):
            if scanned >= max_files:
                break
            if any(part in IGNORED_DIR_NAMES for part in path.parts) or not path.is_file():
                continue
            scanned += 1
            try:
                stat = path.stat()
            except OSError:
                continue
            reasons = []
            suffix = path.suffix.lower()
            mode = oct(stat.st_mode & 0o777)
            publicish = any(part in {"public_html", "uploads", "storage"} for part in path.parts)
            if suffix in {".phtml", ".phar", ".cgi", ".pl", ".sh"} and publicish:
                reasons.append(f"suspicious executable extension {suffix}")
            if mode.endswith("777") or (stat.st_mode & 0o002):
                reasons.append("world-writable permissions")
            if path.name.startswith(".") and publicish:
                reasons.append("hidden file in public path")
            if suffix in SUSPICIOUS_FILE_EXTENSIONS and stat.st_size <= 512_000:
                try:
                    text = path.read_text(encoding="utf-8", errors="ignore").lower()
                    matched = [pattern for pattern in SUSPICIOUS_FILE_PATTERNS if pattern in text]
                    if matched:
                        reasons.append(f"suspicious code pattern: {', '.join(matched[:3])}")
                except OSError:
                    pass
            if reasons:
                findings.append({
                    "path": str(path),
                    "reason": "; ".join(reasons),
                    "risk": "CRITICAL" if any("code pattern" in reason or "world-writable" in reason for reason in reasons) else "WARNING",
                    "sizeBytes": stat.st_size,
                    "mode": mode,
                    "owner": f"{stat.st_uid}:{stat.st_gid}",
                    "modifiedAt": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                })
    return {"roots": [str(root) for root in roots], "scanned": scanned, "findings": findings[:200]}


@router.post("/actions/restart-service")
def restart_service(body: ServiceRestartRequest) -> dict[str, Any]:
    unit = SAFE_RESTART_UNITS.get(body.serviceKey)
    if not unit:
        raise HTTPException(status_code=400, detail="Service is not in the Guardian safe restart allowlist")
    return {
        "action": "restart-service",
        "serviceKey": body.serviceKey,
        "unit": unit,
        "result": run_command(["systemctl", "restart", unit], timeout=30),
    }


@router.post("/actions/restart-pm2")
def restart_pm2(body: Pm2RestartRequest) -> dict[str, Any]:
    target = str(body.pmId) if body.pmId is not None else body.name
    if not target:
        raise HTTPException(status_code=400, detail="PM2 name or pmId is required")
    return {
        "action": "restart-pm2",
        "target": target,
        "result": run_command(["pm2", "restart", target], timeout=60),
    }


@router.post("/actions/reload-nginx")
def reload_nginx() -> dict[str, Any]:
    test = run_command(["nginx", "-t"], timeout=30)
    if test.get("returncode") != 0:
        return {"action": "reload-nginx", "reloaded": False, "test": test, "reload": None}
    reload_result = run_command(["systemctl", "reload", "nginx"], timeout=30)
    return {"action": "reload-nginx", "reloaded": reload_result.get("returncode") == 0, "test": test, "reload": reload_result}


@router.post("/actions/cleanup-logs")
def cleanup_logs(body: LogCleanupRequest) -> dict[str, Any]:
    root = Path(settings.deployment_log_root).resolve()
    if not str(root).startswith("/var/log/vps-panel"):
        raise HTTPException(status_code=400, detail="Guardian log cleanup is restricted to /var/log/vps-panel")
    if not root.exists():
        return {"action": "cleanup-logs", "root": str(root), "removed": [], "dryRun": not settings.allow_live_system_commands}

    cutoff = datetime.now(timezone.utc).timestamp() - (body.olderThanDays * 86_400)
    candidates = []
    min_size = body.minSizeMb * 1024 * 1024
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix not in {".log", ".txt"}:
            continue
        try:
            stat = path.stat()
            if stat.st_mtime < cutoff and stat.st_size >= min_size:
                candidates.append({"path": path, "size": stat.st_size})
        except OSError:
            continue

    removed = []
    freed_bytes = 0
    if settings.allow_live_system_commands:
        for item in candidates[:body.maxFiles]:
            path = item["path"]
            try:
                path.unlink()
                removed.append(str(path))
                freed_bytes += item["size"]
            except OSError:
                continue
    else:
        removed = [str(item["path"]) for item in candidates[:body.maxFiles]]
        freed_bytes = sum(item["size"] for item in candidates[:body.maxFiles])

    return {
        "action": "cleanup-logs",
        "root": str(root),
        "olderThanDays": body.olderThanDays,
        "minSizeMb": body.minSizeMb,
        "candidateCount": len(candidates),
        "removed": removed,
        "freedBytes": freed_bytes,
        "dryRun": not settings.allow_live_system_commands,
    }


@router.post("/actions/block-ip")
def block_ip(body: IpActionRequest) -> dict[str, Any]:
    if not safe_ip(body.ip):
        raise HTTPException(status_code=400, detail="Refusing to block private, loopback, reserved, or invalid IP")
    return {
        "action": "block-ip",
        "ip": body.ip,
        "reason": body.reason,
        "result": run_command(["ufw", "deny", "from", body.ip], timeout=30),
    }


@router.post("/actions/unblock-ip")
def unblock_ip(body: IpActionRequest) -> dict[str, Any]:
    if not safe_ip(body.ip):
        raise HTTPException(status_code=400, detail="Invalid IP")
    return {
        "action": "unblock-ip",
        "ip": body.ip,
        "result": run_command(["ufw", "--force", "delete", "deny", "from", body.ip], timeout=30),
    }


@router.get("/file-watch")
def file_watch() -> dict[str, Any]:
    return file_watch_scan()


@router.get("/security/evidence/{ip}")
def security_evidence(ip: str) -> dict[str, Any]:
    if not safe_ip(ip):
        raise HTTPException(status_code=400, detail="Invalid public IP")
    return matching_log_lines(ip)


@router.post("/file-watch/quarantine")
def quarantine_file(body: FileQuarantineRequest) -> dict[str, Any]:
    source = Path(body.path).resolve()
    roots = [Path(root).resolve() for root in settings.guardian_file_watch_roots.split(",") if root.strip()]
    if not any(str(source).startswith(str(root)) for root in roots):
        raise HTTPException(status_code=400, detail="File is outside Guardian watch roots")
    if not source.exists() or not source.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    quarantine_root = Path("/var/quarantine/vps-panel")
    destination = quarantine_root / source.as_posix().lstrip("/")
    if not settings.allow_live_file_manager:
        return {"dryRun": True, "source": str(source), "destination": str(destination)}
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(destination))
    return {"dryRun": False, "source": str(source), "destination": str(destination)}


@router.get("/nginx-rate-limit/templates")
def nginx_rate_limit_templates() -> dict[str, Any]:
    return {"templates": [{"mode": key, "content": value} for key, value in RATE_LIMIT_TEMPLATES.items()]}


@router.post("/nginx-rate-limit/apply")
def nginx_rate_limit_apply(body: RateLimitTemplateRequest) -> dict[str, Any]:
    content = RATE_LIMIT_TEMPLATES[body.mode]
    path = Path("/etc/nginx/conf.d/vps-panel-guardian-rate-limit.conf")
    if not settings.allow_live_nginx:
        return {"dryRun": True, "path": str(path), "content": content}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    test = run_command(["nginx", "-t"], allow_live=True, timeout=30)
    return {"dryRun": False, "path": str(path), "content": content, "test": test}


@router.get("/diagnosis")
def diagnosis() -> dict[str, Any]:
    disk = shutil.disk_usage("/")
    memory = psutil.virtual_memory()
    cpu_percent = psutil.cpu_percent(interval=0.1)
    load_average = psutil.getloadavg() if hasattr(psutil, "getloadavg") else [0, 0, 0]
    ports = listening_ports()

    services = []
    for service in WATCHED_SERVICES:
        state = systemd_state(service["unit"])
        service_ports = service["ports"]
        port_details = [{"port": port, "listening": port in ports, "owner": ports.get(port)} for port in service_ports]
        port_listening = any(item["listening"] for item in port_details) if service_ports else None
        required = not service.get("optional", False)
        healthy = state["state"] == "active" and (not service_ports or port_listening)
        services.append({
            **service,
            "status": "healthy" if healthy else "down",
            "systemdState": state["state"],
            "detail": state["detail"],
            "portListening": port_listening,
            "portDetails": port_details,
            "optional": not required,
        })

    nginx_error_lines = tail_file("/var/log/nginx/error.log")
    nginx_access_lines = tail_file("/var/log/nginx/access.log")
    auth_lines = tail_file("/var/log/auth.log")
    nginx_errors = count_patterns(nginx_error_lines, ["error", "critical", "upstream", "connect() failed"])
    bad_http = count_patterns(nginx_access_lines, ['" 404 ', '" 500 ', '" 502 ', '" 503 ', '" 504 '])
    nginx_summary = nginx_access_summary(nginx_access_lines)
    ssh_failures = count_patterns(auth_lines, ["failed password", "invalid user", "authentication failure"])
    security_candidates = suspicious_ip_candidates(auth_lines, nginx_summary)
    pm2 = pm2_status()

    incidents = []
    for service in services:
        if service["status"] == "down" and not service.get("optional"):
            incidents.append({
                "severity": "critical",
                "category": "service",
                "title": f"{service['name']} is not healthy",
                "detail": service["detail"],
                "safeAction": "restart-known-service",
            })
    if memory.percent >= 90:
        incidents.append({"severity": "warning", "category": "resource", "title": "Memory usage is high", "detail": f"{memory.percent:.0f}% used"})
    if disk.used / disk.total >= 0.9:
        incidents.append({"severity": "warning", "category": "resource", "title": "Disk usage is high", "detail": f"{disk.free // (1024 ** 3)} GB free"})
    if cpu_percent >= 90:
        incidents.append({"severity": "warning", "category": "resource", "title": "CPU usage is high", "detail": f"{cpu_percent:.0f}% used"})
    if nginx_errors > 0 or bad_http > 10:
        incidents.append({"severity": "warning", "category": "nginx", "title": "Nginx log anomalies detected", "detail": f"{nginx_errors} error lines, {bad_http} recent bad HTTP responses"})
    if ssh_failures >= 5:
        incidents.append({"severity": "warning", "category": "security", "title": "Repeated SSH failures detected", "detail": f"{ssh_failures} recent auth log matches"})
    for process in pm2.get("items", []):
        if not process.get("healthy"):
            incidents.append({"severity": "warning", "category": "pm2", "title": f"PM2 app {process['name']} is not online", "detail": f"status={process['status']}, restarts={process['restarts']}"})

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "host": {
            "hostname": socket.gethostname(),
            "platform": os.uname().sysname if hasattr(os, "uname") else "unknown",
        },
        "resources": {
            "cpuPercent": cpu_percent,
            "loadAverage": load_average,
            "memory": {"total": memory.total, "used": memory.used, "percent": memory.percent},
            "disk": {"total": disk.total, "used": disk.used, "free": disk.free, "percent": disk.used / disk.total * 100},
        },
        "services": services,
        "ports": [{"port": port, "listening": port in ports, "owner": ports.get(port)} for port in WATCHED_PORTS],
        "pm2": pm2,
        "security": {
            "ufw": command_output(["ufw", "status", "verbose"]),
            "fail2ban": command_output(["fail2ban-client", "status"]),
            "fail2banSshd": command_output(["fail2ban-client", "status", "sshd"]),
            "sshFailures": ssh_failures,
            "suspiciousIps": security_candidates,
        },
        "logs": {
            "nginxErrors": nginx_errors,
            "badHttpResponses": bad_http,
            "nginxAccess": nginx_summary,
        },
        "incidents": incidents,
    }
