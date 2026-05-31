from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.command import run_command
from app.config import settings

router = APIRouter()

SAFE_LABEL = re.compile(r"[^a-zA-Z0-9_.-]+")


class BackupRequest(BaseModel):
    label: str = Field(default="manual")
    app_dir: str = Field(default="/opt/vps-panel")
    include_app: bool = True
    include_env: bool = True
    include_database: bool = True
    include_accounts: bool = True
    include_deployments: bool = True
    include_nginx: bool = True
    include_dns: bool = True
    include_logs: bool = False


def safe_label(label: str) -> str:
    cleaned = SAFE_LABEL.sub("-", label.strip()).strip("-")
    return cleaned[:80] or "manual"


def backup_paths(body: BackupRequest) -> list[str]:
    paths: list[str] = []
    app_dir = Path(body.app_dir)
    if body.include_app:
        paths.append(str(app_dir))
    elif body.include_env:
        paths.append(str(app_dir / ".env"))
    if body.include_accounts:
        paths.append("/var/www/accounts")
    if body.include_deployments:
        paths.append("/var/www/deployments")
    if body.include_nginx:
        paths.extend(["/etc/nginx/sites-available", "/etc/nginx/sites-enabled", "/etc/nginx/conf.d"])
    if body.include_dns:
        paths.extend(["/etc/bind", "/var/cache/bind", "/etc/named.conf", "/var/named"])
    if body.include_logs:
        paths.append("/var/log/vps-panel")
    return paths


def backup_script(body: BackupRequest, archive_path: str, staging_dir: str) -> str:
    includes = " ".join([f'"{path}"' for path in backup_paths(body)])
    database_part = ""
    if body.include_database:
        database_part = (
            'if [ -n "${DATABASE_URL:-}" ]; then '
            f'pg_dump "$DATABASE_URL" --format=custom --file="{staging_dir}/panel-main.dump"; '
            'fi'
        )
    return f"""
set -Eeuo pipefail
mkdir -p "{staging_dir}"
cat > "{staging_dir}/manifest.txt" <<MANIFEST
created_at={datetime.now(timezone.utc).isoformat()}
hostname=$(hostname -f 2>/dev/null || hostname)
app_dir={body.app_dir}
MANIFEST
{database_part}
tar --ignore-failed-read --warning=no-file-changed -czf "{archive_path}" -C / {includes} "{staging_dir}/manifest.txt" {f'"{staging_dir}/panel-main.dump"' if body.include_database else ""}
sha256sum "{archive_path}" > "{archive_path}.sha256" 2>/dev/null || shasum -a 256 "{archive_path}" > "{archive_path}.sha256"
stat -c '%s' "{archive_path}" 2>/dev/null || stat -f '%z' "{archive_path}"
"""


@router.get("/plan")
def backup_plan() -> dict[str, Any]:
    return {
        "backupRoot": settings.backup_root,
        "liveEnabled": settings.allow_live_backup,
        "includes": [
            "/opt/vps-panel",
            "/opt/vps-panel/.env",
            "PostgreSQL DATABASE_URL dump",
            "/var/www/accounts",
            "/var/www/deployments",
            "/etc/nginx/sites-available",
            "/etc/nginx/sites-enabled",
            "BIND/named zone paths",
        ],
    }


@router.get("/archives")
def archives() -> dict[str, Any]:
    root = Path(settings.backup_root)
    items: list[dict[str, Any]] = []
    if root.exists():
        for path in sorted(root.glob("mypanel-*.tar.gz"), key=lambda p: p.stat().st_mtime, reverse=True):
            stat = path.stat()
            items.append({
                "path": str(path),
                "name": path.name,
                "sizeBytes": stat.st_size,
                "modifiedAt": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                "checksumPath": str(path) + ".sha256",
            })
    return {"items": items}


@router.post("/create")
def create_backup(body: BackupRequest) -> dict[str, Any]:
    root = Path(settings.backup_root)
    label = safe_label(body.label)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive_path = str(root / f"mypanel-{label}-{stamp}.tar.gz")
    staging_dir = str(root / f".staging-{label}-{stamp}")
    script = backup_script(body, archive_path, staging_dir)
    result = run_command(["bash", "-lc", script], env={"DATABASE_URL": os.environ.get("DATABASE_URL", "")}, allow_live=settings.allow_live_backup, timeout=3600)
    size = None
    if result.get("returncode") == 0 and not result.get("dryRun"):
        try:
            size = Path(archive_path).stat().st_size
        except FileNotFoundError:
            size = None
    return {
        "archivePath": archive_path,
        "stagingDir": staging_dir,
        "includes": backup_paths(body),
        "sizeBytes": size,
        "result": result,
    }


@router.post("/restore-preview")
def restore_preview(path: str) -> dict[str, Any]:
    archive = Path(path)
    root = Path(settings.backup_root).resolve()
    try:
        archive.resolve().relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Archive must be under backup root") from exc
    return {
        "archivePath": str(archive),
        "commands": [
            f"tar -tzf {archive}",
            f"tar -xzf {archive} -C /",
            "pg_restore --clean --if-exists --dbname \"$DATABASE_URL\" panel-main.dump",
            "systemctl restart vps-panel-sysagent vps-panel-workers vps-panel-frontend vps-panel-api nginx",
        ],
        "note": "Restore is preview-only. Run manually during maintenance after taking a fresh snapshot.",
    }
