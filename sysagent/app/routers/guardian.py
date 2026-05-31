import os
import shutil
import socket
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psutil
from fastapi import APIRouter

router = APIRouter()

WATCHED_SERVICES = [
    {"key": "nginx", "name": "Nginx", "unit": "nginx", "port": 80},
    {"key": "redis", "name": "Redis", "unit": "redis-server", "port": 6379},
    {"key": "postgres", "name": "PostgreSQL", "unit": "postgresql", "port": 5432},
    {"key": "panel-api", "name": "Panel API", "unit": "vps-panel-api", "port": 4000},
    {"key": "panel-frontend", "name": "Panel Frontend", "unit": "vps-panel-frontend", "port": 3000},
    {"key": "panel-workers", "name": "Panel Workers", "unit": "vps-panel-workers", "port": None},
    {"key": "sysagent", "name": "System Agent", "unit": "vps-panel-sysagent", "port": 5000},
]

WATCHED_PORTS = [80, 443, 2083, 3000, 4000, 5000, 6379, 5432]


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
    try:
        with file_path.open("r", encoding="utf-8", errors="ignore") as handle:
            return handle.readlines()[-lines:]
    except OSError:
        return []


def count_patterns(lines: list[str], patterns: list[str]) -> int:
    lowered = [line.lower() for line in lines]
    return sum(1 for line in lowered if any(pattern in line for pattern in patterns))


def pm2_status() -> dict[str, Any]:
    result = command_output(["pm2", "jlist"], timeout=5)
    if not result["available"] or result["returncode"] != 0:
        return {"available": result["available"], "items": [], "detail": result["stderr"] or "pm2 unavailable"}
    return {"available": True, "items": [], "raw": result["stdout"]}


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
        port = service["port"]
        port_info = ports.get(port) if port else None
        port_listening = bool(port_info) if port else None
        healthy = state["state"] == "active" and (port is None or port_listening)
        services.append({
            **service,
            "status": "healthy" if healthy else "down",
            "systemdState": state["state"],
            "detail": state["detail"],
            "portListening": port_listening,
            "portOwner": port_info,
        })

    nginx_error_lines = tail_file("/var/log/nginx/error.log")
    nginx_access_lines = tail_file("/var/log/nginx/access.log")
    auth_lines = tail_file("/var/log/auth.log")
    nginx_errors = count_patterns(nginx_error_lines, ["error", "critical", "upstream", "connect() failed"])
    bad_http = count_patterns(nginx_access_lines, ['" 404 ', '" 500 ', '" 502 ', '" 503 ', '" 504 '])
    ssh_failures = count_patterns(auth_lines, ["failed password", "invalid user", "authentication failure"])

    incidents = []
    for service in services:
        if service["status"] == "down":
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
        "pm2": pm2_status(),
        "security": {
            "ufw": command_output(["ufw", "status", "verbose"]),
            "fail2ban": command_output(["fail2ban-client", "status"]),
            "sshFailures": ssh_failures,
        },
        "logs": {
            "nginxErrors": nginx_errors,
            "badHttpResponses": bad_http,
        },
        "incidents": incidents,
    }
