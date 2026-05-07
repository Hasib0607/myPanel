from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.command import run_command
from app.config import settings

router = APIRouter()


class ZoneApplyRequest(BaseModel):
    domain: str = Field(pattern=r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")
    zone: str
    zoneDir: str = "/etc/bind/zones"
    namedConfLocal: str = "/etc/bind/named.conf.local"
    namedConfOptions: str = "/etc/bind/named.conf.options"


def safe_zone_path(zone_dir: str, domain: str) -> Path:
    root = Path(zone_dir).resolve()
    target = (root / f"db.{domain}").resolve()
    if target.parent != root:
        raise ValueError("Zone path escapes configured zone directory")
    return target


def ensure_zone_declared(named_conf_local: str, domain: str, zone_path: Path) -> dict:
    conf_path = Path(named_conf_local).resolve()
    if conf_path.name != "named.conf.local":
        raise HTTPException(status_code=400, detail="Unsupported named.conf.local path")

    block = (
        f'\nzone "{domain}" {{\n'
        "    type master;\n"
        f'    file "{zone_path}";\n'
        "    allow-transfer { none; };\n"
        "};\n"
    )

    if not settings.allow_live_dns:
        return {"dryRun": True, "command": ["append-zone", str(conf_path)], "returncode": 0}

    conf_path.parent.mkdir(parents=True, exist_ok=True)
    current = conf_path.read_text(encoding="utf-8") if conf_path.exists() else ""
    if f'zone "{domain}"' not in current:
        conf_path.write_text(current.rstrip() + block, encoding="utf-8")
    return {"dryRun": False, "command": ["append-zone", str(conf_path)], "returncode": 0}


def ensure_public_authoritative_options(named_conf_options: str) -> dict:
    conf_path = Path(named_conf_options).resolve()
    if conf_path.name != "named.conf.options":
        raise HTTPException(status_code=400, detail="Unsupported named.conf.options path")

    config = """options {
    directory "/var/cache/bind";

    listen-on { any; };
    listen-on-v6 { any; };
    allow-query { any; };
    recursion no;

    dnssec-validation auto;
    auth-nxdomain no;
};
"""

    if not settings.allow_live_dns:
        return {"dryRun": True, "command": ["write-file", str(conf_path)], "returncode": 0}

    conf_path.parent.mkdir(parents=True, exist_ok=True)
    current = conf_path.read_text(encoding="utf-8") if conf_path.exists() else ""
    backup_path = conf_path.with_suffix(f"{conf_path.suffix}.vps-panel.bak")
    if current.strip() != config.strip():
        if current and not backup_path.exists():
            backup_path.write_text(current, encoding="utf-8")
        conf_path.write_text(config, encoding="utf-8")
    return {"dryRun": False, "command": ["write-file", str(conf_path)], "returncode": 0, "backupPath": str(backup_path)}


@router.post("/zone/apply")
def apply_zone(body: ZoneApplyRequest) -> dict:
    zone_path = safe_zone_path(body.zoneDir, body.domain)
    options = ensure_public_authoritative_options(body.namedConfOptions)
    if settings.allow_live_dns:
        zone_path.parent.mkdir(parents=True, exist_ok=True)
        zone_path.write_text(body.zone, encoding="utf-8")
    declare = ensure_zone_declared(body.namedConfLocal, body.domain, zone_path)
    return {
        "write": {
            "dryRun": not settings.allow_live_dns,
            "command": ["write-file", str(zone_path)],
            "returncode": 0,
            "stdout": "",
            "stderr": "",
        },
        "options": options,
        "declare": declare,
        "zoneCheck": run_command(["named-checkzone", body.domain, str(zone_path)], allow_live=settings.allow_live_dns),
        "confCheck": run_command(["named-checkconf"], allow_live=settings.allow_live_dns),
        "reconfig": run_command(["rndc", "reconfig"], allow_live=settings.allow_live_dns),
        "reload": run_command(["rndc", "reload", body.domain], allow_live=settings.allow_live_dns),
        "zonePath": str(zone_path),
    }
