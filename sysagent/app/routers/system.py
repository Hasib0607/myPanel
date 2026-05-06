import shutil

import psutil
from fastapi import APIRouter

router = APIRouter()


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
