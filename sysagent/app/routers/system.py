import shutil
import subprocess

import psutil
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.command import run_command

router = APIRouter()

SERVICE_CHECKS = {
    "nginx": {"name": "Nginx", "port": 80, "unit": "nginx", "units": ["nginx"], "packages": ["nginx"]},
    "bind9": {"name": "BIND9", "port": 53, "unit": "bind9", "units": ["bind9", "named"], "packages": ["bind9", "bind9utils", "bind9-doc"]},
    "postfix": {"name": "Postfix", "port": 25, "unit": "postfix", "units": ["postfix"], "packages": ["postfix"]},
    "dovecot": {"name": "Dovecot", "port": 993, "unit": "dovecot", "units": ["dovecot"], "packages": ["dovecot-core", "dovecot-imapd", "dovecot-lmtpd"]},
}


class ServiceActionRequest(BaseModel):
    action: str


@router.get("/stats")
def stats() -> dict:
    disk = shutil.disk_usage("/")
    return {
        "cpuPercent": psutil.cpu_percent(interval=0.1),
        "loadAverage": psutil.getloadavg() if hasattr(psutil, "getloadavg") else [0, 0, 0],
        "memory": {
            "total": psutil.virtual_memory().total,
            "used": psutil.virtual_memory().used,
            "percent": psutil.virtual_memory().percent,
        },
        "disk": {
            "total": disk.total,
            "used": disk.used,
            "free": disk.free,
        },
        "network": psutil.net_io_counters()._asdict(),
    }


def listening_ports() -> set[int]:
    ports: set[int] = set()
    for connection in psutil.net_connections(kind="inet"):
        if connection.status == psutil.CONN_LISTEN and connection.laddr:
            ports.add(connection.laddr.port)
    return ports


def systemd_state(units: list[str]) -> tuple[str, str | None]:
    if not shutil.which("systemctl"):
        return "unknown", "systemctl unavailable"

    details = []
    for unit in units:
        completed = subprocess.run(
            ["systemctl", "is-active", unit],
            capture_output=True,
            text=True,
            check=False,
        )
        state = completed.stdout.strip() or completed.stderr.strip() or "unknown"
        details.append(f"{unit}:{state}")
        if state == "active":
            return "active", unit

    return "inactive", ", ".join(details)


def unit_installed(units: list[str]) -> bool:
    if not shutil.which("systemctl"):
        return False
    for unit in units:
        completed = subprocess.run(
            ["systemctl", "list-unit-files", f"{unit}.service", "--no-legend"],
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode == 0 and completed.stdout.strip():
            return True
    return False


@router.get("/services")
def services() -> dict:
    ports = listening_ports()
    items = []
    for key, service in SERVICE_CHECKS.items():
        state, detail = systemd_state(service["units"])
        installed = unit_installed(service["units"])
        port_open = service["port"] in ports
        healthy = state == "active" and port_open
        status = "healthy" if healthy else "down"
        if healthy:
            message = f"{detail} active and port {service['port']} listening"
        elif state == "active":
            message = f"{detail} active but port {service['port']} is not listening"
        elif port_open:
            message = f"port {service['port']} listening but systemd state is {state}"
        else:
            message = f"not active; {detail}"

        items.append({
            "key": key,
            "name": service["name"],
            "port": service["port"],
            "status": status,
            "detail": message,
            "systemdState": state,
            "portListening": port_open,
            "installed": installed,
            "manageable": True,
            "availableActions": ["install"] if not installed else ["start", "stop", "restart", "enable", "disable"],
        })

    return {"items": items}


@router.post("/services/{service_key}/action")
def service_action(service_key: str, body: ServiceActionRequest) -> dict:
    service = SERVICE_CHECKS.get(service_key)
    if not service:
        raise HTTPException(status_code=404, detail="Unknown service")

    action = body.action
    if action == "install":
        return run_command(
            ["apt-get", "install", "-y", *service["packages"]],
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

    if action not in {"start", "stop", "restart", "enable", "disable"}:
        raise HTTPException(status_code=400, detail="Unsupported service action")

    return run_command(["systemctl", action, service["unit"]])
