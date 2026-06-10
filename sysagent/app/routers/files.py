from __future__ import annotations
import heapq
import os
import re
import shutil
import base64
from datetime import datetime, timezone
from uuid import uuid4
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import settings
from app.command import run_command

router = APIRouter()


class DeleteRequest(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=100)


class LargestFilesRequest(BaseModel):
    limit: int = Field(default=40, ge=1, le=200)
    minBytes: int = Field(default=10 * 1024 * 1024, ge=0)


class DeleteLargeFileRequest(BaseModel):
    path: str


class ChmodRequest(BaseModel):
    path: str
    mode: str


class WriteRequest(BaseModel):
    path: str
    content: str


class CreateFileRequest(BaseModel):
    parentPath: str
    name: str
    content: str = ""
    contentBase64: str | None = None
    overwrite: bool = False


class CreateFolderRequest(BaseModel):
    parentPath: str
    name: str


class DomainScaffoldRequest(BaseModel):
    domain: str = Field(pattern=r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")


class SubdomainScaffoldRequest(BaseModel):
    domain: str = Field(pattern=r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")
    subdomain: str = Field(pattern=r"^(\*|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*)$")


class AccountScaffoldRequest(BaseModel):
    username: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{2,31}$")


class GitPathRequest(BaseModel):
    path: str = "."


DEFAULT_DOMAIN_FOLDERS = [
    "public_html",
    "subdomains",
]
LEGACY_DOMAIN_FOLDERS = [
    "public_ftp",
    "etc",
    "logs",
    "mail",
    "tmp",
    "ssl",
    "backups",
    "private",
]
DEFAULT_SUBDOMAIN_FOLDERS = [
]
LEGACY_SUBDOMAIN_FOLDERS = [
    "public_html",
    "public_ftp",
    "etc",
    "logs",
    "mail",
    "tmp",
    "ssl",
    "backups",
    "private",
]
SKIP_SCAN_DIRS = {
    ".cache",
    ".git",
    ".next/cache",
    ".npm",
    ".pnpm-store",
    "__pycache__",
    "node_modules",
}
PROTECTED_DELETE_NAMES = {
    ".env",
    "artisan",
    "composer.json",
    "composer.lock",
    "index.php",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
}
PROTECTED_DELETE_SUFFIXES = {
    ".cnf",
    ".conf",
    ".crt",
    ".key",
    ".pem",
    ".service",
    ".sock",
}


def iso_timestamp(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def assert_safe_name(name: str) -> None:
    if not name or name in {".", ".."} or "/" in name or "\\" in name or re.search(r'[<>:"|?*\x00-\x1f]', name):
        raise HTTPException(status_code=400, detail="Unsafe file or folder name")


def root_path() -> Path:
    return Path(settings.file_manager_root).resolve()


def largest_scan_roots() -> list[tuple[str, Path]]:
    candidates = [
        ("accounts", settings.file_manager_root),
        ("backups", settings.backup_root),
        ("panel logs", "/var/log/vps-panel"),
        ("temporary files", "/tmp"),
    ]
    roots: list[tuple[str, Path]] = []
    seen: set[Path] = set()
    for label, candidate in candidates:
        try:
            path = Path(candidate).resolve()
        except OSError:
            continue
        if path in seen or not path.exists() or not path.is_dir():
            continue
        seen.add(path)
        roots.append((label, path))
    return roots


def is_inside(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def delete_protection_reason(path: Path) -> str | None:
    if path.name in PROTECTED_DELETE_NAMES:
        return "Protected app/config file"
    if path.suffix in PROTECTED_DELETE_SUFFIXES:
        return "Protected server/config file type"
    if any(part in {".git", "vendor", "node_modules"} for part in path.parts):
        return "Dependency or git internals are protected"
    return None


def large_file_delete_allowed(path: Path) -> tuple[bool, str]:
    try:
        target = path.resolve()
    except OSError:
        return False, "Path is not accessible"
    if not target.exists():
        return False, "File no longer exists"
    if target.is_symlink():
        return False, "Symlink deletion is blocked"
    if not target.is_file():
        return False, "Only files can be deleted from this list"
    protection = delete_protection_reason(target)
    if protection:
        return False, protection

    allowed_roots = [root for _, root in largest_scan_roots()]
    if not any(is_inside(target, root) for root in allowed_roots):
        return False, "Path is outside managed cleanup roots"
    return True, "Allowed"


def should_skip_scan_dir(root: str, dirname: str) -> bool:
    if dirname in SKIP_SCAN_DIRS:
        return True
    relative = dirname.strip("/")
    return relative in SKIP_SCAN_DIRS or f"{Path(root).name}/{relative}" in SKIP_SCAN_DIRS


def collect_largest_files(limit: int, min_bytes: int) -> tuple[list[dict], list[str]]:
    heap: list[tuple[int, float, str, str]] = []
    scanned_roots: list[str] = []
    for label, scan_root in largest_scan_roots():
        scanned_roots.append(str(scan_root))
        for dirpath, dirnames, filenames in os.walk(scan_root, topdown=True, followlinks=False):
            dirnames[:] = [name for name in dirnames if not should_skip_scan_dir(dirpath, name)]
            for filename in filenames:
                path = Path(dirpath) / filename
                try:
                    stat = path.lstat()
                except OSError:
                    continue
                if not os.path.isfile(path) or os.path.islink(path):
                    continue
                size = int(stat.st_size)
                if size < min_bytes:
                    continue
                item = (size, float(stat.st_mtime), str(path), label)
                if len(heap) < limit:
                    heapq.heappush(heap, item)
                elif size > heap[0][0]:
                    heapq.heapreplace(heap, item)

    files: list[dict] = []
    for size, modified_at, path_text, label in sorted(heap, reverse=True):
        path = Path(path_text)
        deletable, delete_reason = large_file_delete_allowed(path)
        files.append({
            "path": path_text,
            "name": path.name,
            "root": label,
            "sizeBytes": size,
            "modifiedAt": iso_timestamp(modified_at),
            "deletable": deletable,
            "deleteReason": delete_reason,
        })
    return files, scanned_roots


def safe_path(input_path: str) -> Path:
    root = root_path()
    normalized = input_path.replace("\\", "/")
    resolved = (root / normalized).resolve()
    if resolved != root and root not in resolved.parents:
        raise HTTPException(status_code=400, detail="Path escapes file manager root")
    return resolved


def dry_run(command: list[str], path: Path) -> dict:
    return {
        "dryRun": True,
        "command": command,
        "path": str(path),
        "ok": True,
    }


@router.post("/largest")
def largest_files(body: LargestFilesRequest) -> dict:
    files, scanned_roots = collect_largest_files(body.limit, body.minBytes)
    return {
        "items": files,
        "scannedRoots": scanned_roots,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


@router.delete("/largest")
def delete_large_file(body: DeleteLargeFileRequest) -> dict:
    target = Path(body.path)
    deletable, reason = large_file_delete_allowed(target)
    if not deletable:
        raise HTTPException(status_code=400, detail=reason)
    size = target.stat().st_size
    if not settings.allow_live_file_manager:
        return dry_run(["delete-large-file", str(target)], target)
    target.unlink()
    return {
        "ok": True,
        "path": str(target),
        "removedBytes": size,
    }


def to_relative(target: Path) -> str:
    root = root_path()
    relative = target.relative_to(root).as_posix()
    return relative if relative else "."


def in_trash(relative_path: str) -> bool:
    return relative_path == ".trash" or relative_path.startswith(".trash/")


def ensure_git_repository(target: Path) -> None:
    if not target.exists() or not target.is_dir():
        raise HTTPException(status_code=400, detail="Git path must be an existing directory")
    result = run_command(["git", "-C", str(target), "rev-parse", "--is-inside-work-tree"])
    if result.get("returncode") != 0 or result.get("stdout", "").strip() != "true":
        raise HTTPException(status_code=400, detail="Selected folder is not a git repository")


@router.post("/domain-scaffold")
def create_domain_scaffold(body: DomainScaffoldRequest) -> dict:
    domain = body.domain.strip().lower()
    domain_root = safe_path(domain)
    if not settings.allow_live_file_manager:
        return dry_run(["domain-scaffold", str(domain_root)], domain_root)

    domain_root.mkdir(parents=True, exist_ok=True)
    for folder in DEFAULT_DOMAIN_FOLDERS:
        (domain_root / folder).mkdir(parents=True, exist_ok=True)
    (domain_root / "public_html" / ".well-known" / "acme-challenge").mkdir(parents=True, exist_ok=True)
    for folder in LEGACY_DOMAIN_FOLDERS:
        try:
            (domain_root / folder).rmdir()
        except OSError:
            pass

    return {
        "ok": True,
        "domain": domain,
        "root": str(domain_root),
        "relativeRoot": domain,
        "folders": DEFAULT_DOMAIN_FOLDERS,
    }


@router.post("/subdomain-scaffold")
def create_subdomain_scaffold(body: SubdomainScaffoldRequest) -> dict:
    domain = body.domain.strip().lower()
    subdomain = body.subdomain.strip().lower()
    folder_name = "_wildcard" if subdomain == "*" else subdomain
    fqdn = f"{subdomain}.{domain}"
    subdomain_root = safe_path(f"{domain}/subdomains/{folder_name}")
    if not settings.allow_live_file_manager:
        return dry_run(["subdomain-scaffold", str(subdomain_root)], subdomain_root)

    subdomain_root.mkdir(parents=True, exist_ok=True)
    for folder in DEFAULT_SUBDOMAIN_FOLDERS:
        (subdomain_root / folder).mkdir(parents=True, exist_ok=True)
    (subdomain_root / ".well-known" / "acme-challenge").mkdir(parents=True, exist_ok=True)
    for folder in LEGACY_SUBDOMAIN_FOLDERS:
        shutil.rmtree(subdomain_root / folder, ignore_errors=True)

    return {
        "ok": True,
        "domain": domain,
        "subdomain": subdomain,
        "fqdn": fqdn,
        "root": str(subdomain_root),
        "relativeRoot": f"{domain}/subdomains/{folder_name}",
        "folders": DEFAULT_SUBDOMAIN_FOLDERS,
    }


@router.post("/account-scaffold")
def create_account_scaffold(body: AccountScaffoldRequest) -> dict:
    username = body.username.strip().lower()
    account_root = safe_path(f"accounts/{username}")
    folders = ["public_html", "logs", "mail", "tmp", "ssl", "backups", "private"]
    if not settings.allow_live_file_manager:
        return dry_run(["account-scaffold", str(account_root)], account_root)

    account_root.mkdir(parents=True, exist_ok=True)
    for folder in folders:
        (account_root / folder).mkdir(parents=True, exist_ok=True)
    (account_root / "public_html" / ".well-known" / "acme-challenge").mkdir(parents=True, exist_ok=True)
    return {"ok": True, "username": username, "root": str(account_root), "relativeRoot": f"accounts/{username}", "folders": folders}


@router.post("/files")
def create_file(body: CreateFileRequest) -> dict:
    assert_safe_name(body.name)
    parent = safe_path(body.parentPath)
    target = safe_path(f"{body.parentPath.rstrip('/')}/{body.name}")
    if target.parent != parent:
        raise HTTPException(status_code=400, detail="Path escapes parent folder")
    if not settings.allow_live_file_manager:
        return dry_run(["write-file", str(target)], target)
    parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and not body.overwrite:
        raise HTTPException(status_code=409, detail="Target already exists")

    if body.contentBase64 is not None:
        target.write_bytes(base64.b64decode(body.contentBase64))
    else:
        target.write_text(body.content, encoding="utf-8")
    return {"ok": True, "path": str(target)}


@router.post("/folders")
def create_folder(body: CreateFolderRequest) -> dict:
    assert_safe_name(body.name)
    parent = safe_path(body.parentPath)
    target = safe_path(f"{body.parentPath.rstrip('/')}/{body.name}")
    if target.parent != parent:
        raise HTTPException(status_code=400, detail="Path escapes parent folder")
    if not settings.allow_live_file_manager:
        return dry_run(["mkdir", str(target)], target)

    parent.mkdir(parents=True, exist_ok=True)
    target.mkdir(parents=False, exist_ok=False)
    return {"ok": True, "path": str(target)}


@router.delete("/delete")
def delete_files(body: DeleteRequest) -> dict:
    removed: list[str] = []
    for item_path in body.paths:
        target = safe_path(item_path)
        if not settings.allow_live_file_manager:
            return dry_run(["rm", "-rf", str(target)], target)
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink(missing_ok=True)
        removed.append(item_path)

    return {"ok": True, "removed": removed}


@router.post("/trash")
def move_files_to_trash(body: DeleteRequest) -> dict:
    moved_to_trash: list[str] = []
    permanently_removed: list[str] = []
    trash_root = safe_path(".trash")
    for item_path in body.paths:
        target = safe_path(item_path)
        relative = to_relative(target)
        if relative == ".":
            raise HTTPException(status_code=400, detail="File manager root cannot be deleted")
        if relative == ".trash":
            raise HTTPException(status_code=400, detail="Trash root cannot be deleted directly")
        if not settings.allow_live_file_manager:
            return dry_run(["trash", str(target)], target)
        if in_trash(relative):
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            else:
                target.unlink(missing_ok=True)
            permanently_removed.append(item_path)
            continue

        trash_root.mkdir(parents=True, exist_ok=True)
        suffix = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        unique_name = f"{suffix}-{uuid4().hex[:8]}-{target.name}"
        trash_target = safe_path(f".trash/{unique_name}")
        shutil.move(str(target), str(trash_target))
        moved_to_trash.append(item_path)

    return {"ok": True, "movedToTrash": moved_to_trash, "permanentlyRemoved": permanently_removed}


@router.post("/git/status")
def git_status(body: GitPathRequest) -> dict:
    target = safe_path(body.path)
    ensure_git_repository(target)
    return {"ok": True, "path": to_relative(target), "isRepo": True}


@router.post("/git/pull")
def git_pull(body: GitPathRequest) -> dict:
    target = safe_path(body.path)
    ensure_git_repository(target)
    result = run_command(["git", "-C", str(target), "pull", "--ff-only"])
    if result.get("returncode") != 0:
        stderr = result.get("stderr", "").strip() or "git pull failed"
        raise HTTPException(status_code=400, detail=stderr)
    return {
        "ok": True,
        "path": to_relative(target),
        "stdout": result.get("stdout", ""),
        "stderr": result.get("stderr", ""),
        "returncode": result.get("returncode", 0),
    }


@router.post("/chmod")
def chmod_file(body: ChmodRequest) -> dict:
    if not re.fullmatch(r"[0-7]{3,4}", body.mode):
        raise HTTPException(status_code=400, detail="Invalid chmod mode")

    target = safe_path(body.path)
    mode = int(body.mode, 8)
    if not settings.allow_live_file_manager:
        return dry_run(["chmod", body.mode, str(target)], target)

    os.chmod(target, mode)
    return {"ok": True, "path": body.path, "mode": body.mode}


@router.put("/write")
def write_file(body: WriteRequest) -> dict:
    target = safe_path(body.path)
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")
    if not settings.allow_live_file_manager:
        return dry_run(["write-file", str(target)], target)

    target.write_text(body.content, encoding="utf-8")
    return {"ok": True, "path": body.path}
