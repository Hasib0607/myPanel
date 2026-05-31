from __future__ import annotations

import os
import re
import shutil
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
    exclude_patterns: list[str] = Field(default_factory=lambda: [
        "node_modules",
        ".next/cache",
        "cache",
        "tmp",
        "*.log",
    ])
    encrypt_passphrase: str | None = None


class PruneRequest(BaseModel):
    keep_last: int = Field(default=10, ge=1, le=500)


class RestoreRequest(BaseModel):
    path: str
    mode: str = Field(default="full")
    execute: bool = False


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
    excludes = " ".join([f"--exclude='{pattern}'" for pattern in body.exclude_patterns])
    output_path = archive_path
    encryption_part = ""
    if body.encrypt_passphrase:
        output_path = archive_path.replace(".tar.gz", ".tar.gz.gpg")
        encryption_part = (
            f"gpg --batch --yes --passphrase '{body.encrypt_passphrase}' "
            f"--symmetric --cipher-algo AES256 --output \"{output_path}\" \"{archive_path}\" && rm -f \"{archive_path}\""
        )
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
tar --ignore-failed-read --warning=no-file-changed {excludes} -czf "{archive_path}" -C / {includes} "{staging_dir}/manifest.txt" {f'"{staging_dir}/panel-main.dump"' if body.include_database else ""}
{encryption_part}
sha256sum "{output_path}" > "{output_path}.sha256" 2>/dev/null || shasum -a 256 "{output_path}" > "{output_path}.sha256"
stat -c '%s' "{output_path}" 2>/dev/null || stat -f '%z' "{output_path}"
"""


@router.get("/plan")
def backup_plan() -> dict[str, Any]:
    return {
        "backupRoot": settings.backup_root,
        "liveEnabled": settings.allow_live_backup,
        "freeBytes": shutil.disk_usage(settings.backup_root if Path(settings.backup_root).exists() else "/").free,
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
        for path in sorted([*root.glob("mypanel-*.tar.gz"), *root.glob("mypanel-*.tar.gz.gpg")], key=lambda p: p.stat().st_mtime, reverse=True):
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
    root.mkdir(parents=True, exist_ok=True)
    label = safe_label(body.label)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive_path = str(root / f"mypanel-{label}-{stamp}.tar.gz")
    staging_dir = str(root / f".staging-{label}-{stamp}")
    script = backup_script(body, archive_path, staging_dir)
    result = run_command(["bash", "-lc", script], env={"DATABASE_URL": os.environ.get("DATABASE_URL", "")}, allow_live=settings.allow_live_backup, timeout=3600)
    final_path = archive_path.replace(".tar.gz", ".tar.gz.gpg") if body.encrypt_passphrase else archive_path
    size = None
    if result.get("returncode") == 0 and not result.get("dryRun"):
        try:
            size = Path(final_path).stat().st_size
        except FileNotFoundError:
            size = None
    return {
        "archivePath": final_path,
        "stagingDir": staging_dir,
        "includes": backup_paths(body),
        "sizeBytes": size,
        "result": result,
    }


def checked_archive(path: str) -> Path:
    archive = Path(path)
    root = Path(settings.backup_root).resolve()
    try:
        archive.resolve().relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Archive must be under backup root") from exc
    return archive


@router.post("/restore-preview")
def restore_preview(path: str) -> dict[str, Any]:
    archive = checked_archive(path)
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


@router.post("/restore")
def restore(body: RestoreRequest) -> dict[str, Any]:
    archive = checked_archive(body.path)
    commands = [
        "systemctl stop vps-panel-workers vps-panel-frontend vps-panel-api || true",
        f"tar -xzf {archive} -C /",
        "find /var/backups/vps-panel -name panel-main.dump -print -quit | xargs -r -I{} pg_restore --clean --if-exists --dbname \"$DATABASE_URL\" {}",
        "systemctl restart vps-panel-sysagent vps-panel-workers vps-panel-frontend vps-panel-api nginx",
    ]
    script = "set -Eeuo pipefail\n" + "\n".join(commands)
    result = run_command(["bash", "-lc", script], env={"DATABASE_URL": os.environ.get("DATABASE_URL", "")}, allow_live=settings.allow_live_backup and body.execute, timeout=3600)
    return {"archivePath": str(archive), "commands": commands, "result": result}


@router.post("/verify")
def verify(path: str) -> dict[str, Any]:
    archive = checked_archive(path)
    checksum = Path(str(archive) + ".sha256")
    command = ["bash", "-lc", f"cd {archive.parent} && sha256sum -c {checksum.name}"]
    if not checksum.exists():
        return {"ok": False, "archivePath": str(archive), "error": "Checksum file is missing"}
    result = run_command(command, allow_live=True, timeout=300)
    return {"ok": result.get("returncode") == 0, "archivePath": str(archive), "result": result}


@router.post("/manifest")
def manifest(path: str) -> dict[str, Any]:
    archive = checked_archive(path)
    result = run_command(["bash", "-lc", f"tar -tzf '{archive}' | sed -n '1,300p'"], allow_live=True, timeout=300)
    return {"archivePath": str(archive), "result": result, "entries": result.get("stdout", "").splitlines()}


@router.delete("/archive")
def delete_archive(path: str) -> dict[str, Any]:
    archive = checked_archive(path)
    result = run_command(["bash", "-lc", f"rm -f '{archive}' '{archive}.sha256'"], allow_live=settings.allow_live_backup, timeout=300)
    return {"archivePath": str(archive), "result": result}


@router.post("/prune")
def prune(body: PruneRequest) -> dict[str, Any]:
    root = Path(settings.backup_root)
    archives = sorted([*root.glob("mypanel-*.tar.gz"), *root.glob("mypanel-*.tar.gz.gpg")], key=lambda p: p.stat().st_mtime, reverse=True) if root.exists() else []
    removable = archives[body.keep_last:]
    script = "\n".join([f"rm -f '{path}' '{path}.sha256'" for path in removable]) or "true"
    result = run_command(["bash", "-lc", script], allow_live=settings.allow_live_backup, timeout=900)
    return {"kept": len(archives[:body.keep_last]), "removed": [str(path) for path in removable], "result": result}
