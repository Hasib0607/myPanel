from __future__ import annotations
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
from app.firewall_backend import auth_log_path, block_ip_command, firewall_status_command, unblock_ip_command
from app.platform import current_os, service_unit

router = APIRouter()

WATCHED_SERVICE_DEFS = [
    {"key": "nginx", "name": "Nginx", "unit": "nginx", "ports": [80]},
    {"key": "bind9", "name": "BIND9", "serviceKey": "bind9", "ports": [53]},
    {"key": "redis", "name": "Redis", "serviceKey": "redis", "ports": [6379]},
    {"key": "postgres", "name": "PostgreSQL", "unit": "postgresql", "ports": [5432, 5433]},
    {"key": "pgbouncer", "name": "PgBouncer", "unit": "pgbouncer", "ports": [6432], "optional": True},
    {"key": "panel-api", "name": "Panel API", "unit": "vps-panel-api", "ports": [4000]},
    {"key": "panel-frontend", "name": "Panel Frontend", "unit": "vps-panel-frontend", "ports": [3000]},
    {"key": "panel-workers", "name": "Panel Workers", "unit": "vps-panel-workers", "ports": []},
    {"key": "panel-guardian", "name": "Panel Guardian", "unit": "vps-panel-guardian", "ports": []},
    {"key": "sysagent", "name": "System Agent", "unit": "vps-panel-sysagent", "ports": [5000]},
]


def watched_services() -> list[dict[str, Any]]:
    info = current_os()
    services: list[dict[str, Any]] = []
    for item in WATCHED_SERVICE_DEFS:
        entry = {**item}
        if "serviceKey" in entry:
            entry["unit"] = service_unit(entry.pop("serviceKey"), info)
        services.append(entry)
    return services

WATCHED_PORTS = [80, 443, 3138, 3000, 4000, 5000, 6379, 5432, 5433, 6432, 8453]
NGINX_ACCESS_RE = re.compile(r'^(?P<ip>\S+) \S+ \S+ \[[^\]]+\] "(?P<method>\S+) (?P<path>[^"]*?) (?P<protocol>[^"]*?)" (?P<status>\d{3})')
SAFE_RESTART_UNITS = {
    "nginx": "nginx",
    "postgres": "postgresql",
    "pgbouncer": "pgbouncer",
    "panel-api": "vps-panel-api",
    "panel-frontend": "vps-panel-frontend",
    "panel-workers": "vps-panel-workers",
    "panel-guardian": "vps-panel-guardian",
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
PHP_FPM_POOL_GLOBS = ["/etc/php-fpm.d/*.conf", "/etc/php/*/fpm/pool.d/*.conf"]
PHP_INI_GLOBS = ["/etc/php.ini", "/etc/php/*/fpm/php.ini", "/etc/php/*/cli/php.ini", "/etc/opt/remi/php*/php.ini"]


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


def shell_output(command: str, timeout: int = 6) -> dict[str, Any]:
    try:
        completed = subprocess.run(["sh", "-lc", command], capture_output=True, text=True, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"available": True, "stdout": "", "stderr": f"{command} timed out", "returncode": 124}
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
    try:
        with file_path.open("r", encoding="utf-8", errors="ignore") as handle:
            return handle.readlines()[-lines:]
    except OSError:
        return []


def active_config_value(text: str, key: str) -> str | None:
    pattern = re.compile(rf"^\s*{re.escape(key)}\s*=\s*(?P<value>.+?)\s*$", re.MULTILINE)
    match = pattern.search(text)
    return match.group("value").strip() if match else None


def config_int(value: Any) -> int | None:
    try:
        return int(str(value or "").strip())
    except ValueError:
        return None


def memory_mb(value: Any) -> int | None:
    raw = str(value or "").strip().lower()
    if not raw:
        return None
    match = re.match(r"^(\d+)\s*([kmg])?$", raw)
    if not match:
        return None
    amount = int(match.group(1))
    unit = match.group(2) or "m"
    if unit == "g":
        return amount * 1024
    if unit == "k":
        return max(1, amount // 1024)
    return amount


def php_fpm_pool_config() -> dict[str, Any]:
    configs = []
    for glob in PHP_FPM_POOL_GLOBS:
        configs.extend(Path("/").glob(glob.lstrip("/")))
    pools = []
    for path in sorted(set(configs)):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        pools.append({
            "path": str(path),
            "pm": active_config_value(text, "pm"),
            "maxChildren": active_config_value(text, "pm.max_children"),
            "startServers": active_config_value(text, "pm.start_servers"),
            "minSpareServers": active_config_value(text, "pm.min_spare_servers"),
            "maxSpareServers": active_config_value(text, "pm.max_spare_servers"),
            "statusPath": active_config_value(text, "pm.status_path"),
            "slowlog": active_config_value(text, "slowlog"),
            "slowlogTimeout": active_config_value(text, "request_slowlog_timeout"),
            "requestTerminateTimeout": active_config_value(text, "request_terminate_timeout"),
        })
    return {"pools": pools}


def php_ini_config() -> dict[str, Any]:
    configs = []
    for glob in PHP_INI_GLOBS:
        configs.extend(Path("/").glob(glob.lstrip("/")))
    files = []
    for path in sorted(set(configs)):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        files.append({
            "path": str(path),
            "memoryLimit": active_config_value(text, "memory_limit"),
            "maxExecutionTime": active_config_value(text, "max_execution_time"),
            "opcacheMemoryConsumption": active_config_value(text, "opcache.memory_consumption"),
            "opcacheMaxAcceleratedFiles": active_config_value(text, "opcache.max_accelerated_files"),
            "opcacheValidateTimestamps": active_config_value(text, "opcache.validate_timestamps"),
        })
    return {"files": files}


def php_fpm_max_children_hits() -> dict[str, Any]:
    units = ["php-fpm", "php8.3-fpm", "php8.2-fpm", "php8.1-fpm", "php8.0-fpm"]
    hits = []
    for unit in units:
        result = shell_output(f"journalctl -u {unit} --since '24 hours ago' --no-pager 2>/dev/null | grep -i 'max_children\\|server reached' || true")
        lines = [line for line in (result.get("stdout") or "").splitlines() if line.strip()]
        if lines:
            hits.append({"unit": unit, "count": len(lines), "sample": lines[-3:]})
    return {"hits": hits}


def opcache_status() -> dict[str, Any]:
    result = shell_output("php -i 2>/dev/null | grep -i 'opcache.enable\\|opcache.memory_consumption\\|opcache.validate_timestamps' || true")
    stdout = result.get("stdout") or ""
    memory_match = re.search(r"opcache\.memory_consumption\s*=>\s*(?P<value>\d+)", stdout, re.IGNORECASE)
    validate_on = "opcache.validate_timestamps => On => On" in stdout
    return {
        "enabled": "opcache.enable => On => On" in stdout,
        "memoryConsumption": int(memory_match.group("value")) if memory_match else None,
        "validateTimestamps": validate_on,
        "raw": stdout,
        "result": result,
    }


def nginx_runtime_config() -> dict[str, Any]:
    result = shell_output("nginx -T 2>/dev/null | grep -i 'gzip\\|brotli\\|application/json\\|proxy_cache\\|fastcgi_cache\\|cache-control\\|vps_panel_static_cache_control\\|max-age=31536000\\|immutable' || true", timeout=10)
    text = (result.get("stdout") or "").lower()
    gzip_on = re.search(r"^\s*gzip\s+on\s*;", text, re.MULTILINE) is not None
    brotli_on = re.search(r"^\s*brotli\s+on\s*;", text, re.MULTILINE) is not None
    json_compressed = "application/json" in text and (gzip_on or brotli_on)
    has_proxy_cache = "proxy_cache" in text or "fastcgi_cache" in text
    has_static_cache = "cache-control" in text and ("max-age=31536000" in text or "immutable" in text)
    return {
        "gzipOn": gzip_on,
        "brotliOn": brotli_on,
        "jsonCompressed": json_compressed,
        "hasProxyCache": has_proxy_cache,
        "hasStaticCache": has_static_cache or "vps_panel_static_cache_control" in text,
        "hasCacheConfig": has_proxy_cache or has_static_cache or "vps_panel_static_cache_control" in text,
        "raw": result.get("stdout") or "",
        "result": result,
    }


def matching_log_lines(ip: str) -> dict[str, Any]:
    access = [line.strip() for line in tail_file("/var/log/nginx/access.log", 300) if ip in line]
    error = [line.strip() for line in tail_file("/var/log/nginx/error.log", 120) if ip in line]
    auth = [line.strip() for line in tail_file(auth_log_path(), 200) if ip in line]
    return {"ip": ip, "access": access[-50:], "error": error[-30:], "auth": auth[-50:]}


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
            "memoryLimitBytes": env.get("max_memory_restart"),
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


def performance_guard(memory: Any, disk: Any, cpu_percent: float, load_average: list[float] | tuple[float, ...], pm2: dict[str, Any]) -> dict[str, Any]:
    cpu_count = psutil.cpu_count() or 1
    swap = psutil.swap_memory()
    load_per_core = (load_average[0] / cpu_count) if load_average else 0
    pm2_items = pm2.get("items", []) if isinstance(pm2, dict) else []
    pm2_uncapped = [
        item for item in pm2_items
        if item.get("healthy") and not item.get("memoryLimitBytes")
    ]
    fpm_config = php_fpm_pool_config()
    php_ini = php_ini_config()
    fpm_hits = php_fpm_max_children_hits()
    opcache = opcache_status()
    nginx_runtime = nginx_runtime_config()
    fpm_pools = fpm_config.get("pools", [])
    ini_files = php_ini.get("files", [])
    fpm_slowlog_ready = any(pool.get("slowlog") and pool.get("slowlogTimeout") not in {None, "0", "0s"} for pool in fpm_pools)
    fpm_status_ready = any(pool.get("statusPath") for pool in fpm_pools)
    fpm_capacity_ready = any(
        str(pool.get("pm") or "").lower() == "dynamic"
        and (config_int(pool.get("maxChildren")) or 0) >= 80
        and (config_int(pool.get("startServers")) or 0) >= 10
        and (config_int(pool.get("minSpareServers")) or 0) >= 10
        and (config_int(pool.get("maxSpareServers")) or 0) >= 30
        and str(pool.get("requestTerminateTimeout") or "") == "30s"
        for pool in fpm_pools
    )
    php_runtime_ready = any(
        (memory_mb(item.get("memoryLimit")) or 0) >= 512
        and str(item.get("maxExecutionTime") or "") == "30"
        for item in ini_files
    )
    opcache_ini_ready = any(
        (config_int(item.get("opcacheMemoryConsumption")) or 0) >= 256
        and (config_int(item.get("opcacheMaxAcceleratedFiles")) or 0) >= 20000
        and str(item.get("opcacheValidateTimestamps") or "").lower() in {"0", "off", "false"}
        for item in ini_files
    )
    opcache_ready = bool(opcache.get("enabled")) and (
        ((opcache.get("memoryConsumption") or 0) >= 256 and not opcache.get("validateTimestamps"))
        or opcache_ini_ready
    )
    fpm_max_child_hit_count = sum(int(item.get("count") or 0) for item in fpm_hits.get("hits", []))
    checks = [
        {
            "key": "php_fpm_max_children",
            "label": "PHP-FPM max_children saturation",
            "status": "pass" if fpm_max_child_hit_count == 0 else "warn",
            "detail": "No max_children warnings found in the last 24h." if fpm_max_child_hit_count == 0 else f"{fpm_max_child_hit_count} max_children warning(s) found in PHP-FPM logs.",
            "safeAction": None if fpm_max_child_hit_count == 0 else "Increase pm.max_children only after checking RAM headroom, or reduce slow PHP requests.",
        },
        {
            "key": "php_fpm_capacity",
            "label": "PHP-FPM production capacity",
            "status": "pass" if fpm_capacity_ready else "warn",
            "detail": "At least one PHP-FPM pool has production capacity tuning." if fpm_capacity_ready else "No PHP-FPM pool shows pm=dynamic, max_children>=80, warm spare workers, and 30s terminate timeout.",
            "safeAction": None if fpm_capacity_ready else "Run deploy preflight/web runtime optimization, or set pm.max_children=80-150 with enough RAM headroom.",
        },
        {
            "key": "php_fpm_slowlog",
            "label": "PHP-FPM slowlog",
            "status": "pass" if fpm_slowlog_ready else "warn",
            "detail": "Slowlog and request_slowlog_timeout are enabled." if fpm_slowlog_ready else "Slowlog path or request_slowlog_timeout is not active in any PHP-FPM pool.",
            "safeAction": None if fpm_slowlog_ready else "Enable slowlog plus request_slowlog_timeout=5s, then reload PHP-FPM during a quiet window.",
        },
        {
            "key": "php_fpm_status",
            "label": "PHP-FPM status endpoint",
            "status": "pass" if fpm_status_ready else "warn",
            "detail": "pm.status_path is enabled in a PHP-FPM pool." if fpm_status_ready else "pm.status_path is not active, so listen queue and saturation cannot be monitored.",
            "safeAction": None if fpm_status_ready else "Enable pm.status_path=/fpm-status and add an internal Nginx status location.",
        },
        {
            "key": "opcache",
            "label": "PHP OPcache",
            "status": "pass" if opcache_ready else "warn",
            "detail": "OPcache has production tuning." if opcache_ready else "OPcache is missing, too small, or validate_timestamps is still enabled.",
            "safeAction": None if opcache_ready else "Use opcache.memory_consumption=256, opcache.max_accelerated_files=20000, and opcache.validate_timestamps=0 with deploy-time PHP-FPM reload.",
        },
        {
            "key": "php_runtime_limits",
            "label": "PHP runtime limits",
            "status": "pass" if php_runtime_ready else "warn",
            "detail": "PHP memory_limit and max_execution_time match production targets." if php_runtime_ready else "PHP ini does not show memory_limit>=512M and max_execution_time=30.",
            "safeAction": None if php_runtime_ready else "Run deploy preflight/web runtime optimization, or set memory_limit=512M and max_execution_time=30.",
        },
        {
            "key": "nginx_json_compression",
            "label": "Nginx JSON compression",
            "status": "pass" if nginx_runtime.get("jsonCompressed") else "warn",
            "detail": "gzip/Brotli config includes application/json." if nginx_runtime.get("jsonCompressed") else "gzip/Brotli JSON compression is not visible in nginx -T.",
            "safeAction": None if nginx_runtime.get("jsonCompressed") else "Enable gzip on and include application/json in gzip_types; add Brotli only if the module is installed.",
        },
        {
            "key": "nginx_cache_config",
            "label": "Nginx cache config",
            "status": "pass" if nginx_runtime.get("hasCacheConfig") else "warn",
            "detail": "Static cache headers or proxy/FastCGI cache config appears in nginx config." if nginx_runtime.get("hasCacheConfig") else "No static cache headers or proxy/FastCGI cache directive found in nginx -T.",
            "safeAction": None if nginx_runtime.get("hasCacheConfig") else "Add static asset cache headers first; add proxy/FastCGI cache only for safe public routes.",
        },
        {
            "key": "deploy_isolation",
            "label": "Deployment isolation",
            "status": "pass" if settings.deployment_resource_isolation_enabled else "fail",
            "detail": "Deploy commands run with resource limits before touching project runtime." if settings.deployment_resource_isolation_enabled else "Deploy commands can use unrestricted host resources.",
            "safeAction": None if settings.deployment_resource_isolation_enabled else "Enable DEPLOYMENT_RESOURCE_ISOLATION_ENABLED=true and restart sysagent/workers during maintenance.",
        },
        {
            "key": "deploy_memory_cap",
            "label": "Deploy RAM cap",
            "status": "pass" if settings.deployment_memory_max_mb <= 4096 else "warn",
            "detail": f"Deploy/Guardian command cap is {settings.deployment_memory_max_mb}MB.",
            "safeAction": None if settings.deployment_memory_max_mb <= 4096 else "Set DEPLOYMENT_MEMORY_MAX_MB=4096 so one deploy cannot starve live projects.",
        },
        {
            "key": "deploy_cpu_cap",
            "label": "Deploy CPU cap",
            "status": "pass" if settings.deployment_cpu_quota_percent <= 300 else "warn",
            "detail": f"Deploy/Guardian command cap is {settings.deployment_cpu_quota_percent}% CPU.",
            "safeAction": None if settings.deployment_cpu_quota_percent <= 300 else "Set DEPLOYMENT_CPU_QUOTA_PERCENT=300 to keep spare cores for live traffic.",
        },
        {
            "key": "worker_cap",
            "label": "Deploy worker cap",
            "status": "pass" if settings.deployment_worker_max <= 3 else "warn",
            "detail": f"Per-project worker limit is {settings.deployment_worker_max}.",
            "safeAction": None if settings.deployment_worker_max <= 3 else "Set DEPLOYMENT_WORKER_MAX=3 before heavy deploy periods.",
        },
        {
            "key": "deploy_nice",
            "label": "Deploy process priority",
            "status": "pass" if settings.deployment_nice >= 5 else "warn",
            "detail": f"Deploy commands run with nice={settings.deployment_nice}.",
            "safeAction": None if settings.deployment_nice >= 5 else "Raise DEPLOYMENT_NICE to 10 so deploy work yields to live traffic.",
        },
        {
            "key": "pm2_runtime_caps",
            "label": "PM2 runtime memory caps",
            "status": "pass" if len(pm2_uncapped) == 0 else "warn",
            "detail": f"{len(pm2_uncapped)} online PM2 app(s) do not expose a max-memory-restart cap.",
            "safeAction": None if len(pm2_uncapped) == 0 else "Redeploy or restart those apps during a maintenance window so PM2 picks up max-memory-restart.",
        },
        {
            "key": "swap",
            "label": "Swap safety",
            "status": "pass" if swap.total >= 2 * 1024 ** 3 else "warn",
            "detail": f"Swap available: {swap.total // (1024 ** 3)}GB.",
            "safeAction": None if swap.total >= 2 * 1024 ** 3 else "Add 2-4GB swap to absorb build spikes without killing live processes.",
        },
        {
            "key": "load",
            "label": "Load pressure",
            "status": "pass" if load_per_core < 0.8 and cpu_percent < 85 else "warn",
            "detail": f"CPU {cpu_percent:.0f}%, 1m load/core {load_per_core:.2f}.",
            "safeAction": None if load_per_core < 0.8 and cpu_percent < 85 else "Delay heavy deploys and inspect top PM2 apps before starting another build.",
        },
        {
            "key": "memory_pressure",
            "label": "Memory pressure",
            "status": "pass" if memory.percent < 85 else "warn",
            "detail": f"RAM usage is {memory.percent:.0f}%.",
            "safeAction": None if memory.percent < 85 else "Pause deploys, review PM2 memory usage, or add RAM/swap before another heavy build.",
        },
        {
            "key": "disk_pressure",
            "label": "Disk pressure",
            "status": "pass" if (disk.used / disk.total) < 0.85 else "warn",
            "detail": f"Disk usage is {(disk.used / disk.total * 100):.0f}%.",
            "safeAction": None if (disk.used / disk.total) < 0.85 else "Run Guardian log cleanup and prune unused releases/backups.",
        },
    ]
    return {
        "mode": "safe-monitor",
        "impactPolicy": "Guardian performance checks do not restart, stop, or kill customer project processes automatically.",
        "summary": {
            "cpuCount": cpu_count,
            "loadPerCore": load_per_core,
            "swapTotalBytes": swap.total,
            "pm2Online": pm2.get("online", 0) if isinstance(pm2, dict) else 0,
            "pm2Uncapped": len(pm2_uncapped),
            "phpFpmPools": len(fpm_pools),
            "phpFpmMaxChildrenHits": fpm_max_child_hit_count,
        },
        "phpFpm": {"config": fpm_config, "maxChildren": fpm_hits},
        "phpIni": php_ini,
        "opcache": opcache,
        "nginx": nginx_runtime,
        "checks": checks,
    }


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
    unit = service_unit("bind9", current_os()) if body.serviceKey == "bind9" else SAFE_RESTART_UNITS.get(body.serviceKey)
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
        "result": run_command(block_ip_command(body.ip), timeout=30),
    }


@router.post("/actions/unblock-ip")
def unblock_ip(body: IpActionRequest) -> dict[str, Any]:
    if not safe_ip(body.ip):
        raise HTTPException(status_code=400, detail="Invalid IP")
    return {
        "action": "unblock-ip",
        "ip": body.ip,
        "result": run_command(unblock_ip_command(body.ip), timeout=30),
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
    for service in watched_services():
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
    auth_lines = tail_file(auth_log_path())
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
    if not settings.allow_live_system_commands:
        incidents.append({
            "severity": "critical",
            "category": "sysagent",
            "title": "Sysagent live system commands are disabled",
            "detail": "ALLOW_LIVE_SYSTEM_COMMANDS=false. Deploy/start/repair commands will dry-run until it is set to true and vps-panel-sysagent plus vps-panel-workers are restarted.",
            "safeAction": "enable-live-system-commands",
        })

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
        "config": {
            "liveSystemCommandsEnabled": settings.allow_live_system_commands,
            "liveFileManagerEnabled": settings.allow_live_file_manager,
            "liveNginxEnabled": settings.allow_live_nginx,
            "liveSslEnabled": settings.allow_live_ssl,
            "deploymentResourceIsolationEnabled": settings.deployment_resource_isolation_enabled,
            "deploymentMemoryMaxMb": settings.deployment_memory_max_mb,
            "deploymentCpuQuotaPercent": settings.deployment_cpu_quota_percent,
            "deploymentTasksMax": settings.deployment_tasks_max,
            "deploymentNice": settings.deployment_nice,
            "deploymentIoWeight": settings.deployment_io_weight,
            "deploymentWorkerMax": settings.deployment_worker_max,
        },
        "performanceGuard": performance_guard(memory, disk, cpu_percent, load_average, pm2),
        "services": services,
        "ports": [{"port": port, "listening": port in ports, "owner": ports.get(port)} for port in WATCHED_PORTS],
        "pm2": pm2,
        "security": {
            "firewall": command_output(firewall_status_command()),
            "ufw": command_output(firewall_status_command()),
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
