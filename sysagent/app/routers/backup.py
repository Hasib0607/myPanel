from __future__ import annotations

import os
import re
import shlex
import shutil
import json
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.command import run_command
from app.config import settings
from app.platform import current_os, package_install_command, package_install_env

router = APIRouter()

SAFE_LABEL = re.compile(r"[^a-zA-Z0-9_.-]+")


class BackupRequest(BaseModel):
    label: str = Field(default="manual")
    app_dir: str = Field(default="/opt/vps-panel", alias="appDir")
    include_app: bool = Field(default=True, alias="includeApp")
    include_env: bool = Field(default=True, alias="includeEnv")
    include_database: bool = Field(default=True, alias="includeDatabase")
    include_accounts: bool = Field(default=True, alias="includeAccounts")
    include_deployments: bool = Field(default=True, alias="includeDeployments")
    include_nginx: bool = Field(default=True, alias="includeNginx")
    include_dns: bool = Field(default=True, alias="includeDns")
    include_mail: bool = Field(default=True, alias="includeMail")
    include_ssl: bool = Field(default=True, alias="includeSsl")
    include_logs: bool = Field(default=False, alias="includeLogs")
    exclude_patterns: list[str] = Field(default_factory=lambda: [
        "node_modules",
        ".next/cache",
        "cache",
        "tmp",
        "*.log",
    ], alias="excludePatterns")
    encrypt_passphrase: str | None = Field(default=None, alias="encryptPassphrase")
    archive_path: str | None = Field(default=None, alias="archivePath")
    staging_dir: str | None = Field(default=None, alias="stagingDir")

    model_config = {"populate_by_name": True}


class PruneRequest(BaseModel):
    keep_last: int = Field(default=10, ge=1, le=500)


class RemoteUploadRequest(BaseModel):
    path: str
    remote_target: str = Field(alias="remoteTarget")
    google_drive: dict[str, Any] | None = Field(default=None, alias="googleDrive")

    model_config = {"populate_by_name": True}


class RemoteDownloadRequest(BaseModel):
    remote_path: str = Field(alias="remotePath")
    local_path: str = Field(alias="localPath")
    google_drive: dict[str, Any] | None = Field(default=None, alias="googleDrive")

    model_config = {"populate_by_name": True}


class RemotePruneRequest(BaseModel):
    remote_target: str = Field(alias="remoteTarget")
    keep_last: int = Field(default=2, ge=1, le=500, alias="keepLast")
    google_drive: dict[str, Any] | None = Field(default=None, alias="googleDrive")

    model_config = {"populate_by_name": True}


class RestoreRequest(BaseModel):
    path: str
    mode: str = Field(default="full")
    execute: bool = False


def safe_label(label: str) -> str:
    cleaned = SAFE_LABEL.sub("-", label.strip()).strip("-")
    return cleaned[:80] or "manual"


def path_under_backup_root(value: str) -> str:
    root = Path(settings.backup_root).resolve()
    path = Path(value).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Backup paths must be under backup root") from exc
    return str(path)


def backup_jobs_root() -> Path:
    root = Path(settings.backup_root) / ".jobs"
    root.mkdir(parents=True, exist_ok=True)
    return root


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, default=str), encoding="utf-8")
    tmp.replace(path)


def rclone_install_snippet() -> str:
    info = current_os()
    command = " ".join(shlex.quote(part) for part in package_install_command(["rclone"], info))
    env = " ".join(f"{shlex.quote(key)}={shlex.quote(value)}" for key, value in package_install_env(info).items())
    prefix = f"{env} " if env else ""
    rhel_prereqs = ""
    if info.is_rhel:
        rhel_prereqs = """
  if command -v dnf >/dev/null 2>&1; then
    dnf -y install dnf-plugins-core || true
    dnf config-manager --set-enabled crb || true
    dnf -y install epel-release || true
  fi
"""
    return f"""
if ! command -v rclone >/dev/null 2>&1; then
  echo "rclone is missing; attempting automatic install." >&2
{rhel_prereqs.rstrip()}
  {prefix}{command}
fi
if ! command -v rclone >/dev/null 2>&1; then
  echo "rclone is not installed and automatic install did not make it available. Install rclone, then retry Google Drive backup upload." >&2
  exit 127
fi
"""


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
    if body.include_mail:
        paths.extend(["/etc/postfix", "/etc/dovecot", "/var/mail", "/var/vmail", "/home/vmail"])
    if body.include_ssl:
        paths.extend(["/etc/letsencrypt", "/var/lib/letsencrypt"])
    if body.include_logs:
        paths.append("/var/log/vps-panel")
    return paths


def backup_script(body: BackupRequest, archive_path: str, staging_dir: str) -> str:
    includes = " ".join([shlex.quote(path.lstrip("/")) for path in backup_paths(body)])
    excludes = " ".join([f"--exclude={shlex.quote(pattern)}" for pattern in body.exclude_patterns])
    output_path = archive_path
    encryption_part = ""
    if body.encrypt_passphrase:
        output_path = archive_path.replace(".tar.gz", ".tar.gz.gpg")
        encryption_part = (
            f"gpg --batch --yes --passphrase {shlex.quote(body.encrypt_passphrase)} "
            f"--symmetric --cipher-algo AES256 --output {shlex.quote(output_path)} {shlex.quote(archive_path)} && rm -f {shlex.quote(archive_path)}"
        )
    database_part = ""
    if body.include_database:
        panel_dump = shlex.quote(f"{staging_dir}/panel-main.dump")
        postgres_dump = shlex.quote(f"{staging_dir}/postgres-all.sql")
        mysql_dump = shlex.quote(f"{staging_dir}/mysql-all.sql")
        database_part = (
            'if [ -n "${DATABASE_URL:-}" ]; then '
            f'pg_dump "$DATABASE_URL" --format=custom --file={panel_dump} || true; '
            'fi\n'
            f'if command -v pg_dumpall >/dev/null 2>&1; then pg_dumpall --file={postgres_dump} || true; fi\n'
            f'if command -v mysqldump >/dev/null 2>&1; then mysqldump --all-databases --single-transaction --routines --events --triggers > {mysql_dump} || true; '
            'fi'
        )
    staging_archive_paths = shlex.quote(staging_dir.lstrip("/")) if body.include_database else shlex.quote(f"{staging_dir}/manifest.txt".lstrip("/"))
    archive_arg = shlex.quote(archive_path)
    output_arg = shlex.quote(output_path)
    staging_arg = shlex.quote(staging_dir)
    return f"""
set -Eeuo pipefail
mkdir -p {staging_arg}
cat > {shlex.quote(f"{staging_dir}/manifest.txt")} <<MANIFEST
created_at={datetime.now(timezone.utc).isoformat()}
hostname=$(hostname -f 2>/dev/null || hostname)
app_dir={body.app_dir}
MANIFEST
{database_part}
tar --ignore-failed-read --warning=no-file-changed {excludes} -czf {archive_arg} -C / {includes} {staging_archive_paths}
{encryption_part}
sha256sum {output_arg} > {shlex.quote(output_path + ".sha256")} 2>/dev/null || shasum -a 256 {output_arg} > {shlex.quote(output_path + ".sha256")}
stat -c '%s' {output_arg} 2>/dev/null || stat -f '%z' {output_arg}
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
            "mail config and mailboxes",
            "Let's Encrypt certificate material",
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


@router.post("/create-jobs")
def create_backup_job(body: BackupRequest) -> dict[str, Any]:
    root = Path(settings.backup_root)
    root.mkdir(parents=True, exist_ok=True)
    label = safe_label(body.label)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive_path = path_under_backup_root(body.archive_path) if body.archive_path else str(root / f"mypanel-{label}-{stamp}.tar.gz")
    staging_dir = path_under_backup_root(body.staging_dir) if body.staging_dir else str(root / f".staging-{label}-{stamp}")
    final_path = archive_path.replace(".tar.gz", ".tar.gz.gpg") if body.encrypt_passphrase else archive_path
    includes = backup_paths(body)
    job_id = uuid.uuid4().hex
    job_dir = backup_jobs_root() / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    status_path = job_dir / "status.json"
    script_path = job_dir / "backup.sh"
    runner_path = job_dir / "runner.py"
    stdout_path = job_dir / "stdout.log"
    stderr_path = job_dir / "stderr.log"
    started_at = datetime.now(timezone.utc).isoformat()

    if not settings.allow_live_backup:
        status = {
            "jobId": job_id,
            "status": "FAILED",
            "archivePath": final_path,
            "stagingDir": staging_dir,
            "includes": includes,
            "sizeBytes": None,
            "startedAt": started_at,
            "finishedAt": datetime.now(timezone.utc).isoformat(),
            "result": {
                "dryRun": True,
                "liveCommandsDisabled": True,
                "returncode": 0,
                "stdout": "",
                "stderr": "ALLOW_LIVE_BACKUP=false. Set ALLOW_LIVE_BACKUP=true and restart vps-panel-sysagent plus vps-panel-workers.",
            },
        }
        write_json_atomic(status_path, status)
        return status

    script_path.write_text(backup_script(body, archive_path, staging_dir), encoding="utf-8")
    os.chmod(script_path, 0o700)
    initial = {
        "jobId": job_id,
        "status": "RUNNING",
        "archivePath": final_path,
        "stagingDir": staging_dir,
        "includes": includes,
        "sizeBytes": None,
        "startedAt": started_at,
        "finishedAt": None,
        "result": {"dryRun": False, "returncode": None, "stdout": "", "stderr": ""},
    }
    write_json_atomic(status_path, initial)

    runner = f"""
import json
import os
import signal
import subprocess
from datetime import datetime, timezone
from pathlib import Path

status_path = Path({str(status_path)!r})
script_path = Path({str(script_path)!r})
stdout_path = Path({str(stdout_path)!r})
stderr_path = Path({str(stderr_path)!r})
archive_path = {final_path!r}
staging_dir = {staging_dir!r}
includes = {includes!r}
job_id = {job_id!r}
started_at = {started_at!r}
timeout = 21600

def read_tail(path, limit=20000):
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return ""
    return data[-limit:].decode("utf-8", errors="replace")

def write_status(value):
    tmp = status_path.with_suffix(status_path.suffix + ".tmp")
    tmp.write_text(json.dumps(value), encoding="utf-8")
    tmp.replace(status_path)

def status(state, returncode=None, timed_out=False):
    size = None
    try:
        p = Path(archive_path)
        if p.exists():
            size = p.stat().st_size
    except Exception:
        size = None
    return {{
        "jobId": job_id,
        "status": state,
        "archivePath": archive_path,
        "stagingDir": staging_dir,
        "includes": includes,
        "sizeBytes": size,
        "startedAt": started_at,
        "finishedAt": datetime.now(timezone.utc).isoformat() if state != "RUNNING" else None,
        "result": {{
            "dryRun": False,
            "returncode": returncode,
            "stdout": read_tail(stdout_path),
            "stderr": ("Command timed out after " + str(timeout) + " seconds\\n" if timed_out else "") + read_tail(stderr_path),
        }},
    }}

with stdout_path.open("w", encoding="utf-8") as stdout, stderr_path.open("w", encoding="utf-8") as stderr:
    process = subprocess.Popen(
        ["bash", str(script_path)],
        stdout=stdout,
        stderr=stderr,
        text=True,
        env={{**os.environ, "DATABASE_URL": os.environ.get("DATABASE_URL", "")}},
        start_new_session=True,
    )
    try:
        returncode = process.wait(timeout=timeout)
        write_status(status("SUCCEEDED" if returncode == 0 else "FAILED", returncode))
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except ProcessLookupError:
            process.kill()
        process.wait()
        write_status(status("FAILED", 124, timed_out=True))
"""
    runner_path.write_text(runner, encoding="utf-8")
    os.chmod(runner_path, 0o700)
    subprocess.Popen(
        [sys.executable, str(runner_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )
    return initial


@router.get("/create-jobs/{job_id}")
def backup_job_status(job_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        raise HTTPException(status_code=400, detail="Invalid backup job id")
    status_path = backup_jobs_root() / job_id / "status.json"
    if not status_path.exists():
        raise HTTPException(status_code=404, detail="Backup job not found")
    return json.loads(status_path.read_text(encoding="utf-8"))


@router.post("/create")
def create_backup(body: BackupRequest) -> dict[str, Any]:
    root = Path(settings.backup_root)
    root.mkdir(parents=True, exist_ok=True)
    label = safe_label(body.label)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive_path = path_under_backup_root(body.archive_path) if body.archive_path else str(root / f"mypanel-{label}-{stamp}.tar.gz")
    staging_dir = path_under_backup_root(body.staging_dir) if body.staging_dir else str(root / f".staging-{label}-{stamp}")
    script = backup_script(body, archive_path, staging_dir)
    result = run_command(["bash", "-lc", script], env={"DATABASE_URL": os.environ.get("DATABASE_URL", "")}, allow_live=settings.allow_live_backup, timeout=21600)
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


def remote_name(remote_target: str) -> str:
    if ":" not in remote_target:
        return "mypanel-drive"
    return remote_target.split(":", 1)[0]


def rclone_env_and_setup(google_drive: dict[str, Any] | None, remote_target: str) -> tuple[str, dict[str, str]]:
    if not google_drive:
        return "", {}

    root = Path(settings.backup_root) / ".rclone"
    root.mkdir(parents=True, exist_ok=True)
    config_path = root / "rclone.conf"
    name = remote_name(remote_target)
    auth_mode = str(google_drive.get("authMode") or "SERVICE_ACCOUNT")
    folder_id = str(google_drive.get("folderId") or "")
    team_drive_id = str(google_drive.get("teamDriveId") or "")
    client_id = str(google_drive.get("clientId") or "")
    client_secret = str(google_drive.get("clientSecret") or "")
    refresh_token = str(google_drive.get("refreshToken") or "")
    service_account_json = str(google_drive.get("serviceAccountJson") or "")

    lines = [f"[{name}]", "type = drive", "scope = drive"]
    if folder_id:
        lines.append(f"root_folder_id = {folder_id}")
    if team_drive_id:
        lines.append(f"team_drive = {team_drive_id}")
    if client_id:
        lines.append(f"client_id = {client_id}")
    if client_secret:
        lines.append(f"client_secret = {client_secret}")

    if auth_mode == "SERVICE_ACCOUNT":
        if not service_account_json:
            raise HTTPException(status_code=400, detail="Google Drive service account JSON is not configured")
        service_account_path = root / "service-account.json"
        service_account_path.write_text(service_account_json, encoding="utf-8")
        lines.append(f"service_account_file = {service_account_path}")
    elif auth_mode == "OAUTH_REFRESH_TOKEN":
        if not client_id or not client_secret:
            raise HTTPException(status_code=400, detail="Google Drive OAuth client ID and client secret are required with a refresh token")
        if not refresh_token:
            raise HTTPException(status_code=400, detail="Google Drive refresh token is not configured")
        token = {"access_token": "", "refresh_token": refresh_token, "token_type": "Bearer", "expiry": "2000-01-01T00:00:00Z"}
        token_path = root / "token.json"
        token_path.write_text(json.dumps(token), encoding="utf-8")
        lines.append(f"token = {json.dumps(token)}")

    config_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(config_path, 0o600)
    return f"export RCLONE_CONFIG={shlex.quote(str(config_path))}\n", {"RCLONE_CONFIG": str(config_path)}


@router.post("/upload-remote")
def upload_remote(body: RemoteUploadRequest) -> dict[str, Any]:
    archive = checked_archive(body.path)
    checksum = Path(str(archive) + ".sha256")
    remote_target = body.remote_target.rstrip("/")
    remote_path = f"{remote_target}/{archive.name}"
    quoted_target = shlex.quote(remote_target)
    quoted_archive = shlex.quote(str(archive))
    quoted_checksum = shlex.quote(str(checksum))
    quoted_remote_path = shlex.quote(remote_path)
    setup, env = rclone_env_and_setup(body.google_drive, remote_target)
    script = f"""
set -Eeuo pipefail
{setup}
{rclone_install_snippet()}
echo "Preparing Google Drive target {remote_target}" >&2
rclone mkdir {quoted_target} --drive-acknowledge-abuse
echo "Uploading archive to {remote_path}" >&2
rclone copyto {quoted_archive} {quoted_remote_path} --drive-acknowledge-abuse --stats 30s
if [ -f {quoted_checksum} ]; then
  echo "Uploading checksum to {remote_path}.sha256" >&2
  rclone copyto {quoted_checksum} {shlex.quote(remote_path + ".sha256")} --drive-acknowledge-abuse
fi
"""
    result = run_command(["bash", "-lc", script], env=env, allow_live=settings.allow_live_backup, timeout=7200)
    return {"archivePath": str(archive), "remoteTarget": remote_target, "remotePath": remote_path, "result": result}


@router.post("/upload-jobs")
def upload_remote_job(body: RemoteUploadRequest) -> dict[str, Any]:
    archive = checked_archive(body.path)
    checksum = Path(str(archive) + ".sha256")
    remote_target = body.remote_target.rstrip("/")
    remote_path = f"{remote_target}/{archive.name}"
    quoted_target = shlex.quote(remote_target)
    quoted_archive = shlex.quote(str(archive))
    quoted_checksum = shlex.quote(str(checksum))
    quoted_remote_path = shlex.quote(remote_path)
    setup, env = rclone_env_and_setup(body.google_drive, remote_target)
    script = f"""
set -Eeuo pipefail
{setup}
{rclone_install_snippet()}
echo "Preparing Google Drive target {remote_target}" >&2
rclone mkdir {quoted_target} --drive-acknowledge-abuse
echo "Uploading archive to {remote_path}" >&2
rclone copyto {quoted_archive} {quoted_remote_path} --drive-acknowledge-abuse --stats 30s
if [ -f {quoted_checksum} ]; then
  echo "Uploading checksum to {remote_path}.sha256" >&2
  rclone copyto {quoted_checksum} {shlex.quote(remote_path + ".sha256")} --drive-acknowledge-abuse
fi
"""
    job_id = uuid.uuid4().hex
    job_dir = backup_jobs_root() / f"upload-{job_id}"
    job_dir.mkdir(parents=True, exist_ok=True)
    status_path = job_dir / "status.json"
    script_path = job_dir / "upload.sh"
    runner_path = job_dir / "runner.py"
    stdout_path = job_dir / "stdout.log"
    stderr_path = job_dir / "stderr.log"
    started_at = datetime.now(timezone.utc).isoformat()
    initial = {
        "jobId": job_id,
        "status": "RUNNING",
        "archivePath": str(archive),
        "remoteTarget": remote_target,
        "remotePath": remote_path,
        "startedAt": started_at,
        "finishedAt": None,
        "result": {"dryRun": False, "returncode": None, "stdout": "", "stderr": ""},
    }
    if not settings.allow_live_backup:
        initial["status"] = "FAILED"
        initial["finishedAt"] = datetime.now(timezone.utc).isoformat()
        initial["result"] = {
            "dryRun": True,
            "liveCommandsDisabled": True,
            "returncode": 0,
            "stdout": "",
            "stderr": "ALLOW_LIVE_BACKUP=false. Set ALLOW_LIVE_BACKUP=true and restart vps-panel-sysagent plus vps-panel-workers.",
        }
        write_json_atomic(status_path, initial)
        return initial
    script_path.write_text(script, encoding="utf-8")
    os.chmod(script_path, 0o700)
    write_json_atomic(status_path, initial)
    runner = f"""
import json
import os
import signal
import subprocess
from datetime import datetime, timezone
from pathlib import Path

status_path = Path({str(status_path)!r})
script_path = Path({str(script_path)!r})
stdout_path = Path({str(stdout_path)!r})
stderr_path = Path({str(stderr_path)!r})
job_id = {job_id!r}
archive_path = {str(archive)!r}
remote_target = {remote_target!r}
remote_path = {remote_path!r}
started_at = {started_at!r}
timeout = 7200

def read_tail(path, limit=20000):
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return ""
    return data[-limit:].decode("utf-8", errors="replace")

def write_status(value):
    tmp = status_path.with_suffix(status_path.suffix + ".tmp")
    tmp.write_text(json.dumps(value), encoding="utf-8")
    tmp.replace(status_path)

def status(state, returncode=None, timed_out=False):
    return {{
        "jobId": job_id,
        "status": state,
        "archivePath": archive_path,
        "remoteTarget": remote_target,
        "remotePath": remote_path,
        "startedAt": started_at,
        "finishedAt": datetime.now(timezone.utc).isoformat() if state != "RUNNING" else None,
        "result": {{
            "dryRun": False,
            "returncode": returncode,
            "stdout": read_tail(stdout_path),
            "stderr": ("Command timed out after " + str(timeout) + " seconds\\n" if timed_out else "") + read_tail(stderr_path),
        }},
    }}

with stdout_path.open("w", encoding="utf-8") as stdout, stderr_path.open("w", encoding="utf-8") as stderr:
    process = subprocess.Popen(
        ["bash", str(script_path)],
        stdout=stdout,
        stderr=stderr,
        text=True,
        env={{**os.environ, **{env!r}}},
        start_new_session=True,
    )
    try:
        returncode = process.wait(timeout=timeout)
        write_status(status("SUCCEEDED" if returncode == 0 else "FAILED", returncode))
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except ProcessLookupError:
            process.kill()
        process.wait()
        write_status(status("FAILED", 124, timed_out=True))
"""
    runner_path.write_text(runner, encoding="utf-8")
    os.chmod(runner_path, 0o700)
    subprocess.Popen(
        [sys.executable, str(runner_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )
    return initial


@router.get("/upload-jobs/{job_id}")
def upload_job_status(job_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        raise HTTPException(status_code=400, detail="Invalid upload job id")
    status_path = backup_jobs_root() / f"upload-{job_id}" / "status.json"
    if not status_path.exists():
        raise HTTPException(status_code=404, detail="Upload job not found")
    return json.loads(status_path.read_text(encoding="utf-8"))


@router.post("/download-remote")
def download_remote(body: RemoteDownloadRequest) -> dict[str, Any]:
    local = Path(body.local_path)
    root = Path(settings.backup_root).resolve()
    try:
        local.resolve().relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Downloaded archive must be under backup root") from exc
    local.parent.mkdir(parents=True, exist_ok=True)
    if local.exists() and local.stat().st_size > 0:
        return {
            "archivePath": str(local),
            "remotePath": body.remote_path,
            "skipped": True,
            "result": {"dryRun": False, "returncode": 0, "stdout": "Local archive already exists; skipping download.", "stderr": ""},
        }
    partial = Path(str(local) + ".part")
    setup, env = rclone_env_and_setup(body.google_drive, body.remote_path)
    script = f"""
set -Eeuo pipefail
{setup}
command -v rclone >/dev/null 2>&1
rm -f {shlex.quote(str(partial))}
rclone copyto {shlex.quote(body.remote_path)} {shlex.quote(str(partial))}
mv {shlex.quote(str(partial))} {shlex.quote(str(local))}
rclone copyto {shlex.quote(body.remote_path + ".sha256")} {shlex.quote(str(local) + ".sha256")} || true
"""
    result = run_command(["bash", "-lc", script], env=env, allow_live=settings.allow_live_backup, timeout=7200)
    return {"archivePath": str(local), "remotePath": body.remote_path, "skipped": False, "result": result}


@router.post("/prune-remote")
def prune_remote(body: RemotePruneRequest) -> dict[str, Any]:
    remote_target = body.remote_target.rstrip("/")
    quoted_target = shlex.quote(remote_target)
    setup, env = rclone_env_and_setup(body.google_drive, remote_target)
    list_result = run_command(
        ["bash", "-lc", f'set -Eeuo pipefail\n{setup}rclone lsf --format "tp" {quoted_target} | grep -E "\\.tar\\.gz(\\.gpg)?$" | sort -r'],
        env=env,
        allow_live=settings.allow_live_backup,
        timeout=900,
    )
    names = [line.split(";", 1)[1] for line in list_result.get("stdout", "").splitlines() if ";" in line]
    removable = names[body.keep_last:]
    script = "\n".join([
        f"rclone deletefile {shlex.quote(remote_target + '/' + name)}; rclone deletefile {shlex.quote(remote_target + '/' + name + '.sha256')} || true"
        for name in removable
    ]) or "true"
    result = run_command(["bash", "-lc", f"set -Eeuo pipefail\n{setup}{script}"], env=env, allow_live=settings.allow_live_backup, timeout=1800)
    return {"remoteTarget": remote_target, "kept": names[:body.keep_last], "removed": removable, "result": result}


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
