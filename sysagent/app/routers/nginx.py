from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import settings
from app.nginx_paths import nginx_sites_available, nginx_sites_enabled
from app.nginx_manager import (
    acme_location,
    publish_nginx_config,
    run_live_step,
    safe_letsencrypt_path,
    safe_nginx_path,
    safe_web_root,
)

router = APIRouter()


class VhostRequest(BaseModel):
    name: str = Field(pattern=r"^[a-zA-Z0-9_.-]+$")
    serverName: str
    upstreamPort: int = Field(ge=1, le=65535)
    sitesAvailable: str = ""
    sitesEnabled: str = ""


def _resolve_sites(body: VhostRequest | StaticVhostRequest | RedirectVhostRequest) -> tuple[str, str]:
    return (
        body.sitesAvailable or nginx_sites_available(),
        body.sitesEnabled or nginx_sites_enabled(),
    )


class StaticVhostRequest(BaseModel):
    name: str = Field(pattern=r"^[a-zA-Z0-9_.-]+$")
    serverName: str = Field(pattern=r"^[a-zA-Z0-9_. -]+$")
    rootPath: str
    forceHttps: bool = False
    sslCertificate: str | None = None
    sslCertificateKey: str | None = None
    requireSsl: bool = False
    sitesAvailable: str = ""
    sitesEnabled: str = ""


class RedirectVhostRequest(BaseModel):
    name: str = Field(pattern=r"^[a-zA-Z0-9_.-]+$")
    serverName: str = Field(pattern=r"^[a-zA-Z0-9_. -]+$")
    redirectUrl: str
    sslCertificate: str | None = None
    sslCertificateKey: str | None = None
    requireSsl: bool = False
    sitesAvailable: str = ""
    sitesEnabled: str = ""


@router.post("/vhost")
def write_vhost(body: VhostRequest) -> dict:
    config = (
        "server {\n"
        "    listen 80;\n"
        f"    server_name {body.serverName};\n"
        "\n"
        f"{acme_location(body.serverName)}"
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
    return publish_nginx_config(body.name, config, *_resolve_sites(body))


@router.post("/static-vhost")
def write_static_vhost(body: StaticVhostRequest) -> dict:
    sites_available, sites_enabled = _resolve_sites(body)
    safe_nginx_path(sites_available, body.name)
    safe_nginx_path(sites_enabled, body.name)
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
        f"{acme_location(body.serverName)}"
        "    location / {\n"
        "        try_files $uri $uri/ =404;\n"
        "    }\n"
    )
    if body.forceHttps and has_ssl:
        http_location = (
            f"{acme_location(body.serverName)}"
            "    location / {\n"
            "        return 301 https://$host$request_uri;\n"
            "    }\n"
        )

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
            f"{acme_location(body.serverName)}"
            "    location / {\n"
            "        try_files $uri $uri/ =404;\n"
            "    }\n"
            "}\n"
        )

    if settings.allow_live_nginx:
        run_live_step("website root create", lambda: root_path.mkdir(parents=True, exist_ok=True))
    result = publish_nginx_config(body.name, config, sites_available, sites_enabled)
    return {
        **result,
        "rootPath": str(root_path),
        "sslEnabled": has_ssl,
        "forceHttps": body.forceHttps,
    }


@router.post("/redirect-vhost")
def write_redirect_vhost(body: RedirectVhostRequest) -> dict:
    if not body.redirectUrl.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Redirect URL must start with http:// or https://")
    ssl_certificate = safe_letsencrypt_path(body.sslCertificate) if body.sslCertificate else None
    ssl_certificate_key = safe_letsencrypt_path(body.sslCertificateKey) if body.sslCertificateKey else None
    has_ssl = ssl_certificate is not None and ssl_certificate_key is not None

    if has_ssl and settings.allow_live_nginx and (not ssl_certificate.exists() or not ssl_certificate_key.exists()):
        if body.requireSsl:
            raise HTTPException(status_code=409, detail="SSL certificate files do not exist yet")
        has_ssl = False

    config = (
        "server {\n"
        "    listen 80;\n"
        f"    server_name {body.serverName};\n"
        "\n"
        f"{acme_location(body.serverName)}"
        "    location / {\n"
        f"        return 301 {body.redirectUrl}$request_uri;\n"
        "    }\n"
        "}\n"
    )
    if has_ssl:
        config += (
            "\n"
            "server {\n"
            "    listen 443 ssl http2;\n"
            f"    server_name {body.serverName};\n"
            f"    ssl_certificate {ssl_certificate};\n"
            f"    ssl_certificate_key {ssl_certificate_key};\n"
            "    ssl_protocols TLSv1.2 TLSv1.3;\n"
            "    ssl_prefer_server_ciphers off;\n"
            "\n"
            "    location / {\n"
            f"        return 301 {body.redirectUrl}$request_uri;\n"
            "    }\n"
            "}\n"
        )
    result = publish_nginx_config(body.name, config, sites_available, sites_enabled)
    return {
        **result,
        "redirectUrl": body.redirectUrl,
        "sslEnabled": has_ssl,
    }
