from __future__ import annotations
import os
import re
import shutil
import base64
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import settings

router = APIRouter()


class DeleteRequest(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=100)


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
    subdomain: str = Field(pattern=r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$")


class AccountScaffoldRequest(BaseModel):
    username: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{2,31}$")


DEFAULT_DOMAIN_FOLDERS = [
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
DEFAULT_SUBDOMAIN_FOLDERS = [
    "public_html",
]


def assert_safe_name(name: str) -> None:
    if not name or name in {".", ".."} or "/" in name or "\\" in name or re.search(r'[<>:"|?*\x00-\x1f]', name):
        raise HTTPException(status_code=400, detail="Unsafe file or folder name")


def root_path() -> Path:
    return Path(settings.file_manager_root).resolve()


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
    fqdn = f"{subdomain}.{domain}"
    subdomain_root = safe_path(f"{domain}/subdomains/{subdomain}")
    if not settings.allow_live_file_manager:
        return dry_run(["subdomain-scaffold", str(subdomain_root)], subdomain_root)

    subdomain_root.mkdir(parents=True, exist_ok=True)
    for folder in DEFAULT_SUBDOMAIN_FOLDERS:
        (subdomain_root / folder).mkdir(parents=True, exist_ok=True)
    (subdomain_root / "public_html" / ".well-known" / "acme-challenge").mkdir(parents=True, exist_ok=True)

    return {
        "ok": True,
        "domain": domain,
        "subdomain": subdomain,
        "fqdn": fqdn,
        "root": str(subdomain_root),
        "relativeRoot": f"{domain}/subdomains/{subdomain}",
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
