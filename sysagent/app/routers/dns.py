from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from app.command import run_command
from app.config import settings

router = APIRouter()


class ZoneApplyRequest(BaseModel):
    domain: str
    zone: str
    zoneDir: str = "/etc/bind/zones"


def safe_zone_path(zone_dir: str, domain: str) -> Path:
    root = Path(zone_dir).resolve()
    target = (root / f"db.{domain}").resolve()
    if target.parent != root:
        raise ValueError("Zone path escapes configured zone directory")
    return target


@router.post("/zone/apply")
def apply_zone(body: ZoneApplyRequest) -> dict:
    zone_path = safe_zone_path(body.zoneDir, body.domain)
    if settings.allow_live_system_commands:
        zone_path.parent.mkdir(parents=True, exist_ok=True)
        zone_path.write_text(body.zone, encoding="utf-8")
    return {
        "write": {
            "dryRun": not settings.allow_live_system_commands,
            "command": ["write-file", str(zone_path)],
            "returncode": 0,
            "stdout": "",
            "stderr": "",
        },
        "check": run_command(["named-checkzone", body.domain, str(zone_path)]),
        "freeze": run_command(["rndc", "freeze", body.domain]),
        "reload": run_command(["rndc", "reload", body.domain]),
        "thaw": run_command(["rndc", "thaw", body.domain]),
        "zonePath": str(zone_path),
    }
