from __future__ import annotations

from pathlib import Path
from shutil import copy2

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.command import run_command
from app.config import settings
from app.platform import is_rhel

router = APIRouter()


class ZoneApplyRequest(BaseModel):
    domain: str = Field(pattern=r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")
    zone: str
    zoneDir: str = "/etc/bind/zones"
    namedConfLocal: str = "/etc/bind/named.conf.local"
    namedConfOptions: str = "/etc/bind/named.conf.options"


def effective_dns_paths(body: ZoneApplyRequest) -> tuple[str, str, str]:
    if not is_rhel():
        return body.zoneDir, body.namedConfLocal, body.namedConfOptions

    zone_dir = "/var/named" if body.zoneDir == "/etc/bind/zones" else body.zoneDir
    named_conf_local = "/etc/named.vps-panel.zones" if body.namedConfLocal == "/etc/bind/named.conf.local" else body.namedConfLocal
    named_conf_options = "/etc/named.conf" if body.namedConfOptions == "/etc/bind/named.conf.options" else body.namedConfOptions
    return zone_dir, named_conf_local, named_conf_options


def safe_zone_path(zone_dir: str, domain: str) -> Path:
    root = Path(zone_dir).resolve()
    target = (root / f"db.{domain}").resolve()
    if target.parent != root:
        raise ValueError("Zone path escapes configured zone directory")
    return target


def zone_declaration_file_path(zone_path: Path) -> str:
    if is_rhel() and str(zone_path).startswith("/var/named/"):
        return zone_path.name
    return str(zone_path)


def ensure_zone_declared(named_conf_local: str, domain: str, zone_path: Path) -> dict:
    conf_path = Path(named_conf_local).resolve()
    if conf_path.name not in {"named.conf.local", "named.vps-panel.zones"}:
        raise HTTPException(status_code=400, detail="Unsupported named.conf.local path")

    bind_file = zone_declaration_file_path(zone_path)
    block = (
        f'\nzone "{domain}" {{\n'
        "    type master;\n"
        f'    file "{bind_file}";\n'
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
    if conf_path.name not in {"named.conf.options", "named.conf"}:
        raise HTTPException(status_code=400, detail="Unsupported named.conf.options path")

    if conf_path.name == "named.conf":
        config = """options {
    listen-on port 53 { any; };
    listen-on-v6 port 53 { any; };
    directory "/var/named";
    dump-file "/var/named/data/cache_dump.db";
    statistics-file "/var/named/data/named_stats.txt";
    memstatistics-file "/var/named/data/named_mem_stats.txt";
    secroots-file "/var/named/data/named.secroots";
    recursing-file "/var/named/data/named.recursing";
    allow-query { any; };
    recursion no;
    dnssec-validation auto;
    managed-keys-directory "/var/named/dynamic";
    geoip-directory "/usr/share/GeoIP";
    pid-file "/run/named/named.pid";
    session-keyfile "/run/named/session.key";
};

include "/etc/named.rfc1912.zones";
include "/etc/named.root.key";
include "/etc/named.vps-panel.zones";
"""
    else:
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


def command_ok(result: dict) -> bool:
    return int(result.get("returncode", 0) or 0) == 0


def command_has_output(result: dict) -> bool:
    return command_ok(result) and bool(str(result.get("stdout", "")).strip())


def restart_bind_service() -> dict:
    return run_command(
        ["sh", "-lc", "systemctl restart named 2>/dev/null || systemctl restart bind9"],
        allow_live=settings.allow_live_dns,
        timeout=30,
    )


def reload_bind_zone(domain: str) -> dict:
    reconfig = run_command(["rndc", "reconfig"], allow_live=settings.allow_live_dns, timeout=30)
    reload = (
        run_command(["rndc", "reload", domain], allow_live=settings.allow_live_dns, timeout=30)
        if command_ok(reconfig)
        else {"returncode": 1, "stderr": "Skipped because BIND reconfig failed"}
    )
    if command_ok(reconfig) and command_ok(reload):
        return {
            "dryRun": bool(reload.get("dryRun")),
            "command": ["rndc", "reload", domain],
            "returncode": 0,
            "stdout": "\n".join([str(reconfig.get("stdout", "")).strip(), str(reload.get("stdout", "")).strip()]).strip(),
            "stderr": "\n".join([str(reconfig.get("stderr", "")).strip(), str(reload.get("stderr", "")).strip()]).strip(),
            "reconfig": reconfig,
            "reload": reload,
        }

    restart = restart_bind_service()
    return {
        "dryRun": bool(restart.get("dryRun")),
        "command": ["bind-reload-or-restart", domain],
        "returncode": 0 if command_ok(restart) else 1,
        "stdout": str(restart.get("stdout", "")).strip(),
        "stderr": "\n".join([
            "rndc reload failed; restarted BIND service as fallback.",
            str(reconfig.get("stderr", "")).strip(),
            str(reload.get("stderr", "")).strip(),
            str(restart.get("stderr", "")).strip(),
        ]).strip(),
        "reconfig": reconfig,
        "reload": reload,
        "restart": restart,
    }


def local_zone_visible(domain: str) -> dict:
    return run_command(["dig", "@127.0.0.1", "+short", "SOA", domain], allow_live=settings.allow_live_dns, timeout=10)


def restore_file(path: Path, backup_path: Path | None) -> dict:
    if not settings.allow_live_dns:
        return {"dryRun": True, "command": ["restore-file", str(path)], "returncode": 0}
    if backup_path and backup_path.exists():
        copy2(backup_path, path)
        return {"dryRun": False, "command": ["restore-file", str(path)], "returncode": 0, "backupPath": str(backup_path)}
    if path.exists():
        path.unlink()
    return {"dryRun": False, "command": ["remove-file", str(path)], "returncode": 0}


@router.post("/zone/apply")
def apply_zone(body: ZoneApplyRequest) -> dict:
    zone_dir, named_conf_local, named_conf_options = effective_dns_paths(body)
    zone_path = safe_zone_path(zone_dir, body.domain)
    conf_path = Path(named_conf_local).resolve()
    options_path = Path(named_conf_options).resolve()
    zone_backup = zone_path.with_suffix(f"{zone_path.suffix}.vps-panel.rollback")
    conf_backup = conf_path.with_suffix(f"{conf_path.suffix}.vps-panel.rollback")
    options_backup = options_path.with_suffix(f"{options_path.suffix}.vps-panel.rollback")
    temp_zone_path = zone_path.with_suffix(f"{zone_path.suffix}.vps-panel.check")

    if settings.allow_live_dns:
        zone_path.parent.mkdir(parents=True, exist_ok=True)
        temp_zone_path.write_text(body.zone, encoding="utf-8")
    preflight_zone_check = run_command(["named-checkzone", body.domain, str(temp_zone_path if settings.allow_live_dns else zone_path)], allow_live=settings.allow_live_dns)
    if settings.allow_live_dns:
        temp_zone_path.unlink(missing_ok=True)
    if not command_ok(preflight_zone_check):
        return {
            "write": {"dryRun": not settings.allow_live_dns, "command": ["write-file", str(zone_path)], "returncode": 1, "stderr": "Zone preflight failed; live BIND files were not changed."},
            "zoneCheck": preflight_zone_check,
            "zonePath": str(zone_path),
            "rolledBack": False,
        }

    if settings.allow_live_dns:
        if zone_path.exists():
            copy2(zone_path, zone_backup)
        if conf_path.exists():
            copy2(conf_path, conf_backup)
        if options_path.exists():
            copy2(options_path, options_backup)

    options = ensure_public_authoritative_options(named_conf_options)
    if settings.allow_live_dns:
        zone_path.write_text(body.zone, encoding="utf-8")
    declare = ensure_zone_declared(named_conf_local, body.domain, zone_path)
    zone_check = run_command(["named-checkzone", body.domain, str(zone_path)], allow_live=settings.allow_live_dns)
    conf_check = run_command(["named-checkconf"], allow_live=settings.allow_live_dns)
    reload = reload_bind_zone(body.domain) if command_ok(zone_check) and command_ok(conf_check) else {"returncode": 1, "stderr": "Skipped because BIND validation failed"}
    local_check = local_zone_visible(body.domain) if command_ok(reload) else {"returncode": 1, "stderr": "Skipped because BIND reload/restart failed"}
    result = {
        "write": {
            "dryRun": not settings.allow_live_dns,
            "command": ["write-file", str(zone_path)],
            "returncode": 0,
            "stdout": "",
            "stderr": "",
        },
        "options": options,
        "declare": declare,
        "zoneCheck": zone_check,
        "confCheck": conf_check,
        "reload": reload,
        "localCheck": local_check,
        "zonePath": str(zone_path),
    }
    if not all(command_ok(step) for step in [zone_check, conf_check, reload]) or not command_has_output(local_check):
        restore_zone = restore_file(zone_path, zone_backup if zone_backup.exists() else None)
        restore_conf = restore_file(conf_path, conf_backup if conf_backup.exists() else None)
        restore_options = restore_file(options_path, options_backup if options_backup.exists() else None)
        restart = restart_bind_service()
        result["rolledBack"] = True
        result["rollback"] = {
            "zone": restore_zone,
            "conf": restore_conf,
            "options": restore_options,
            "restart": restart,
        }
    else:
        result["rolledBack"] = False
    return result
