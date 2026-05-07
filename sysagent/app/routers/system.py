import shutil
import subprocess

import psutil
from fastapi import APIRouter

router = APIRouter()

SERVICE_CHECKS = [
    {"name": "Nginx", "port": 80, "units": ["nginx"]},
    {"name": "BIND9", "port": 53, "units": ["bind9", "named"]},
    {"name": "Postfix", "port": 25, "units": ["postfix"]},
    {"name": "Dovecot", "port": 993, "units": ["dovecot"]},
]


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


@router.get("/services")
def services() -> dict:
    ports = listening_ports()
    items = []
    for service in SERVICE_CHECKS:
        state, detail = systemd_state(service["units"])
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
            "name": service["name"],
            "port": service["port"],
            "status": status,
            "detail": message,
            "systemdState": state,
            "portListening": port_open,
        })

    return {"items": items}
