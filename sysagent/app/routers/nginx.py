from pathlib import Path
from typing import Callable, TypeVar

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.command import run_command
from app.config import settings

router = APIRouter()
T = TypeVar("T")


class VhostRequest(BaseModel):
    name: str = Field(pattern=r"^[a-zA-Z0-9_.-]+$")
    serverName: str
    upstreamPort: int = Field(ge=1, le=65535)
    sitesAvailable: str = "/etc/nginx/sites-available"
    sitesEnabled: str = "/etc/nginx/sites-enabled"


class StaticVhostRequest(BaseModel):
    name: str = Field(pattern=r"^[a-zA-Z0-9_.-]+$")
    serverName: str = Field(pattern=r"^[a-zA-Z0-9_. -]+$")
    rootPath: str
    sitesAvailable: str = "/etc/nginx/sites-available"
    sitesEnabled: str = "/etc/nginx/sites-enabled"


def safe_nginx_path(root: str, name: str) -> Path:
    directory = Path(root).resolve()
    target = (directory / f"{name}.conf").resolve()
    if target.parent != directory:
        raise ValueError("Nginx config path escapes target directory")
    return target


def safe_web_root(root_path: str) -> Path:
    root = Path(settings.file_manager_root).resolve()
    target = Path(root_path).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(status_code=400, detail="Website root escapes file manager root")
    return target


def run_live_step(action: str, fn: Callable[[], T]) -> T:
    try:
        return fn()
    except PermissionError as error:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Nginx {action} permission denied: {error}. "
                "Run vps-panel-sysagent as root, then restart vps-panel-sysagent and vps-panel-api."
            ),
        ) from error
    except OSError as error:
        raise HTTPException(status_code=500, detail=f"Nginx {action} failed: {error}") from error


def enable_site(available: Path, enabled: Path) -> None:
    if enabled.is_symlink():
        if enabled.resolve() == available:
            return
        enabled.unlink()
    elif enabled.exists():
        enabled.unlink()
    enabled.symlink_to(available)


@router.post("/vhost")
def write_vhost(body: VhostRequest) -> dict:
    available = safe_nginx_path(body.sitesAvailable, body.name)
    enabled = safe_nginx_path(body.sitesEnabled, body.name)
    config = (
        f"server {{ listen 80; server_name {body.serverName}; "
        f"location / {{ proxy_pass http://127.0.0.1:{body.upstreamPort}; "
        "proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }} }"
    )
    if settings.allow_live_nginx:
        run_live_step("vhost write", lambda: available.parent.mkdir(parents=True, exist_ok=True))
        run_live_step("vhost write", lambda: available.write_text(config, encoding="utf-8"))
        run_live_step("vhost enable", lambda: enabled.parent.mkdir(parents=True, exist_ok=True))
        run_live_step("vhost enable", lambda: enable_site(available, enabled))
    return {
        "write": {"dryRun": not settings.allow_live_nginx, "command": ["write-file", str(available)], "returncode": 0},
        "enable": {"dryRun": not settings.allow_live_nginx, "command": ["symlink", str(available), str(enabled)], "returncode": 0},
        "test": run_command(["nginx", "-t"], allow_live=settings.allow_live_nginx),
        "reload": run_command(["systemctl", "reload", "nginx"], allow_live=settings.allow_live_nginx),
        "configPath": str(available),
    }


@router.post("/static-vhost")
def write_static_vhost(body: StaticVhostRequest) -> dict:
    available = safe_nginx_path(body.sitesAvailable, body.name)
    enabled = safe_nginx_path(body.sitesEnabled, body.name)
    root_path = safe_web_root(body.rootPath)
    config = (
        "server {\n"
        "    listen 80;\n"
        f"    server_name {body.serverName};\n"
        f"    root {root_path};\n"
        "    index index.html index.htm index.php;\n"
        "    client_max_body_size 100M;\n"
        "\n"
        "    location / {\n"
        "        try_files $uri $uri/ =404;\n"
        "    }\n"
        "}\n"
    )

    if settings.allow_live_nginx:
        run_live_step("static vhost write", lambda: available.parent.mkdir(parents=True, exist_ok=True))
        run_live_step("static vhost enable", lambda: enabled.parent.mkdir(parents=True, exist_ok=True))
        run_live_step("website root create", lambda: root_path.mkdir(parents=True, exist_ok=True))
        run_live_step("static vhost write", lambda: available.write_text(config, encoding="utf-8"))
        run_live_step("static vhost enable", lambda: enable_site(available, enabled))

    return {
        "write": {"dryRun": not settings.allow_live_nginx, "command": ["write-file", str(available)], "returncode": 0},
        "enable": {"dryRun": not settings.allow_live_nginx, "command": ["symlink", str(available), str(enabled)], "returncode": 0},
        "test": run_command(["nginx", "-t"], allow_live=settings.allow_live_nginx),
        "reload": run_command(["systemctl", "reload", "nginx"], allow_live=settings.allow_live_nginx),
        "configPath": str(available),
        "rootPath": str(root_path),
    }
