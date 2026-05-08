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
    forceHttps: bool = False
    sslCertificate: str | None = None
    sslCertificateKey: str | None = None
    requireSsl: bool = False
    sitesAvailable: str = "/etc/nginx/sites-available"
    sitesEnabled: str = "/etc/nginx/sites-enabled"


def safe_nginx_path(root: str, name: str) -> Path:
    directory = Path(root).resolve()
    target = directory / f"{name}.conf"
    if target.parent != directory:
        raise ValueError("Nginx config path escapes target directory")
    return target


def safe_web_root(root_path: str) -> Path:
    root = Path(settings.file_manager_root).resolve()
    target = Path(root_path).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(status_code=400, detail="Website root escapes file manager root")
    return target


def safe_letsencrypt_path(path: str) -> Path:
    root = Path("/etc/letsencrypt/live")
    target = Path(path)
    if not target.is_absolute():
        raise HTTPException(status_code=400, detail="SSL certificate path must be absolute")
    try:
        target.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="SSL certificate path escapes /etc/letsencrypt/live")
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


def test_and_reload_or_rollback(enabled: Path) -> tuple[dict, dict]:
    test = run_command(["nginx", "-t"], allow_live=settings.allow_live_nginx)
    if test.get("returncode") != 0 and settings.allow_live_nginx:
        run_live_step("vhost rollback", lambda: enabled.unlink(missing_ok=True))
        return test, {
            "dryRun": False,
            "command": ["systemctl", "reload", "nginx"],
            "stdout": "",
            "stderr": "Skipped because nginx -t failed; site symlink was rolled back",
            "returncode": 1,
        }

    return test, run_command(["systemctl", "reload", "nginx"], allow_live=settings.allow_live_nginx)


@router.post("/vhost")
def write_vhost(body: VhostRequest) -> dict:
    available = safe_nginx_path(body.sitesAvailable, body.name)
    enabled = safe_nginx_path(body.sitesEnabled, body.name)
    config = (
        "server {\n"
        "    listen 80;\n"
        f"    server_name {body.serverName};\n"
        "\n"
        "    location / {\n"
        f"        proxy_pass http://127.0.0.1:{body.upstreamPort};\n"
        "        proxy_http_version 1.1;\n"
        "        proxy_set_header Host $host;\n"
        "        proxy_set_header X-Real-IP $remote_addr;\n"
        "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
        "        proxy_set_header X-Forwarded-Proto $scheme;\n"
        "        proxy_set_header Upgrade $http_upgrade;\n"
        "        proxy_set_header Connection \"upgrade\";\n"
        "    }\n"
        "}\n"
    )
    if settings.allow_live_nginx:
        run_live_step("vhost write", lambda: available.parent.mkdir(parents=True, exist_ok=True))
        run_live_step("vhost write", lambda: available.write_text(config, encoding="utf-8"))
        run_live_step("vhost enable", lambda: enabled.parent.mkdir(parents=True, exist_ok=True))
        run_live_step("vhost enable", lambda: enable_site(available, enabled))
    test, reload = test_and_reload_or_rollback(enabled)
    return {
        "write": {"dryRun": not settings.allow_live_nginx, "command": ["write-file", str(available)], "returncode": 0},
        "enable": {"dryRun": not settings.allow_live_nginx, "command": ["symlink", str(available), str(enabled)], "returncode": 0},
        "test": test,
        "reload": reload,
        "configPath": str(available),
    }


@router.post("/static-vhost")
def write_static_vhost(body: StaticVhostRequest) -> dict:
    available = safe_nginx_path(body.sitesAvailable, body.name)
    enabled = safe_nginx_path(body.sitesEnabled, body.name)
    root_path = safe_web_root(body.rootPath)
    ssl_certificate = safe_letsencrypt_path(body.sslCertificate) if body.sslCertificate else None
    ssl_certificate_key = safe_letsencrypt_path(body.sslCertificateKey) if body.sslCertificateKey else None
    has_ssl = ssl_certificate is not None and ssl_certificate_key is not None

    if has_ssl and settings.allow_live_nginx and (not ssl_certificate.exists() or not ssl_certificate_key.exists()):
        if body.requireSsl:
            raise HTTPException(status_code=409, detail="SSL certificate files do not exist yet")
        has_ssl = False

    if (body.forceHttps or has_ssl) and not has_ssl:
        body.forceHttps = False

    http_location = (
        "    location / {\n"
        "        try_files $uri $uri/ =404;\n"
        "    }\n"
    )
    if body.forceHttps and has_ssl:
        http_location = "    return 301 https://$host$request_uri;\n"

    config = (
        "server {\n"
        "    listen 80;\n"
        f"    server_name {body.serverName};\n"
        f"    root {root_path};\n"
        "    index index.html index.htm index.php;\n"
        "    client_max_body_size 100M;\n"
        "\n"
        f"{http_location}"
        "}\n"
    )

    if has_ssl:
        config += (
            "\n"
            "server {\n"
            "    listen 443 ssl http2;\n"
            f"    server_name {body.serverName};\n"
            f"    root {root_path};\n"
            "    index index.html index.htm index.php;\n"
            "    client_max_body_size 100M;\n"
            f"    ssl_certificate {ssl_certificate};\n"
            f"    ssl_certificate_key {ssl_certificate_key};\n"
            "    ssl_protocols TLSv1.2 TLSv1.3;\n"
            "    ssl_prefer_server_ciphers off;\n"
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
    test, reload = test_and_reload_or_rollback(enabled)

    return {
        "write": {"dryRun": not settings.allow_live_nginx, "command": ["write-file", str(available)], "returncode": 0},
        "enable": {"dryRun": not settings.allow_live_nginx, "command": ["symlink", str(available), str(enabled)], "returncode": 0},
        "test": test,
        "reload": reload,
        "configPath": str(available),
        "rootPath": str(root_path),
        "sslEnabled": has_ssl,
        "forceHttps": body.forceHttps,
    }
