from __future__ import annotations

from pathlib import Path
import re
import secrets
import stat

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.command import run_command
from app.config import settings
from app.nginx_paths import nginx_sites_available, nginx_sites_enabled
from app.nginx_manager import (
    acme_location,
    make_web_root_readable,
    publish_nginx_config,
    run_live_step,
    safe_letsencrypt_path,
    safe_nginx_path,
    safe_web_root,
)

router = APIRouter()
PHP_FPM_POOL_GLOBS = ["/etc/php-fpm.d/*.conf", "/etc/php/*/fpm/pool.d/*.conf"]
PHP_INI_GLOBS = ["/etc/php.ini", "/etc/php/*/fpm/php.ini", "/etc/php/*/cli/php.ini", "/etc/opt/remi/php*/php.ini"]
PHP_FPM_POOL_TUNING = {
    "pm": "dynamic",
    "pm.max_children": "120",
    "pm.start_servers": "10",
    "pm.min_spare_servers": "10",
    "pm.max_spare_servers": "30",
    "pm.status_path": "/fpm-status",
    "slowlog": "/var/log/php-fpm/www-slow.log",
    "request_slowlog_timeout": "5s",
    "request_terminate_timeout": "30s",
}
PHP_INI_TUNING = {
    "max_execution_time": "30",
    "memory_limit": "512M",
    "opcache.enable": "1",
    "opcache.enable_cli": "1",
    "opcache.memory_consumption": "256",
    "opcache.max_accelerated_files": "20000",
    "opcache.validate_timestamps": "0",
}


def make_acme_probe_readable(root_path: Path, challenge_dir: Path, probe_file: Path) -> dict:
    permissions = make_web_root_readable(root_path)
    changed = list(permissions.get("changed") or [])

    def chmod_or(path: Path, bits: int) -> None:
        mode = path.stat().st_mode
        next_mode = mode | bits
        if next_mode != mode:
            path.chmod(stat.S_IMODE(next_mode))
            changed.append(str(path))

    well_known = challenge_dir.parent
    for directory in [well_known, challenge_dir]:
        if directory.exists():
            chmod_or(directory, stat.S_IROTH | stat.S_IXOTH)
    if probe_file.exists():
        chmod_or(probe_file, stat.S_IROTH)
    return {**permissions, "changed": changed, "challengeDir": str(challenge_dir), "probeFile": str(probe_file)}


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
    serverName: str = Field(pattern=r"^[a-zA-Z0-9_*.-]+( [a-zA-Z0-9_*.-]+)*$")
    rootPath: str
    forceHttps: bool = False
    sslCertificate: str | None = None
    sslCertificateKey: str | None = None
    requireSsl: bool = False
    sitesAvailable: str = ""
    sitesEnabled: str = ""


class RedirectVhostRequest(BaseModel):
    name: str = Field(pattern=r"^[a-zA-Z0-9_.-]+$")
    serverName: str = Field(pattern=r"^[a-zA-Z0-9_*.-]+( [a-zA-Z0-9_*.-]+)*$")
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
        f"{acme_location(body.serverName, root_path)}"
        "    location / {\n"
        "        try_files $uri $uri/ =404;\n"
        "    }\n"
    )
    if body.forceHttps and has_ssl:
        http_location = (
            f"{acme_location(body.serverName, root_path)}"
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
        "    client_max_body_size 0;\n"
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
            "    client_max_body_size 0;\n"
            f"    ssl_certificate {ssl_certificate};\n"
            f"    ssl_certificate_key {ssl_certificate_key};\n"
            "    ssl_protocols TLSv1.2 TLSv1.3;\n"
            "    ssl_prefer_server_ciphers off;\n"
            "    add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\" always;\n"
            "    add_header Content-Security-Policy \"upgrade-insecure-requests\" always;\n"
            "\n"
            f"{acme_location(body.serverName, root_path)}"
            "    location / {\n"
            "        try_files $uri $uri/ =404;\n"
            "    }\n"
            "}\n"
        )

    permissions = {"changed": [], "webRoot": str(root_path)}
    if settings.allow_live_nginx:
        run_live_step("website root create", lambda: root_path.mkdir(parents=True, exist_ok=True))
        permissions = run_live_step("website root permissions", lambda: make_web_root_readable(root_path))

    probe_file: Path | None = None
    probe_expected = ""
    if settings.allow_live_nginx:
        probe_token = f"vps-panel-vhost-{secrets.token_hex(12)}"
        probe_expected = f"ok-{probe_token}"
        challenge_dir = root_path / ".well-known" / "acme-challenge"
        probe_file = challenge_dir / probe_token
        run_live_step("ACME vhost probe directory create", lambda: challenge_dir.mkdir(parents=True, exist_ok=True))
        run_live_step("ACME vhost probe write", lambda: probe_file.write_text(probe_expected, encoding="utf-8"))
        permissions = run_live_step(
            "ACME vhost probe permissions",
            lambda: make_acme_probe_readable(root_path, challenge_dir, probe_file),
        )

    def post_reload_check() -> dict:
        if not probe_file:
            return {"returncode": 0, "stdout": "", "stderr": "", "command": ["skip-acme-vhost-probe"]}
        primary_host = body.serverName.split()[0]
        result = run_command([
            "curl",
            "-fsS",
            "--max-time",
            "10",
            "--noproxy",
            "*",
            "-H",
            f"Host: {primary_host}",
            f"http://127.0.0.1/.well-known/acme-challenge/{probe_file.name}",
        ], allow_live=True)
        if result.get("returncode") != 0:
            debug = run_command([
                "curl",
                "-sS",
                "-i",
                "--max-time",
                "10",
                "--noproxy",
                "*",
                "-H",
                f"Host: {primary_host}",
                f"http://127.0.0.1/.well-known/acme-challenge/{probe_file.name}",
            ], allow_live=True)
            result = {
                **result,
                "stderr": (
                    f"{result.get('stderr') or ''}\n"
                    f"ACME vhost probe failed for serverName={body.serverName!r}, "
                    f"rootPath={str(root_path)!r}, probeFile={str(probe_file)!r}. "
                    f"Debug response: stdout={(debug.get('stdout') or '').strip()!r}; "
                    f"stderr={(debug.get('stderr') or '').strip()!r}; "
                    f"returncode={debug.get('returncode')}."
                ).strip(),
            }
        elif (result.get("stdout") or "").strip() != probe_expected:
            result = {
                **result,
                "returncode": 1,
                "stderr": (
                    f"ACME vhost probe returned unexpected body from local Nginx. "
                    f"Expected {probe_expected!r}, got {(result.get('stdout') or '').strip()!r}. "
                    f"serverName={body.serverName!r}, rootPath={str(root_path)!r}, probeFile={str(probe_file)!r}."
                ),
            }
        return result

    try:
        result = publish_nginx_config(
            body.name,
            config,
            sites_available,
            sites_enabled,
            server_name=body.serverName,
            post_reload_check=post_reload_check if settings.allow_live_nginx else None,
        )
    finally:
        if probe_file and settings.allow_live_nginx:
            run_live_step("ACME vhost probe cleanup", lambda: probe_file.unlink(missing_ok=True))
    return {
        **result,
        "rootPath": str(root_path),
        "permissions": permissions,
        "sslEnabled": has_ssl,
        "forceHttps": body.forceHttps,
    }


@router.post("/redirect-vhost")
def write_redirect_vhost(body: RedirectVhostRequest) -> dict:
    sites_available, sites_enabled = _resolve_sites(body)
    safe_nginx_path(sites_available, body.name)
    safe_nginx_path(sites_enabled, body.name)
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
            "    add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\" always;\n"
            "    add_header Content-Security-Policy \"upgrade-insecure-requests\" always;\n"
            "\n"
            "    location / {\n"
            f"        return 301 {body.redirectUrl}$request_uri;\n"
            "    }\n"
            "}\n"
        )
    result = publish_nginx_config(body.name, config, sites_available, sites_enabled, server_name=body.serverName)
    return {
        **result,
        "redirectUrl": body.redirectUrl,
        "sslEnabled": has_ssl,
    }


@router.post("/panel-upload-limits")
def ensure_panel_upload_limits() -> dict:
    app_dir = Path(__file__).resolve().parents[3]
    scripts = [
        app_dir / "scripts" / "maintenance" / "patch-panel-nginx-api-upload.sh",
        app_dir / "scripts" / "maintenance" / "fix-nginx-upload-size.sh",
        app_dir / "scripts" / "maintenance" / "fix-php-upload-limits.sh",
    ]
    results: list[dict] = []
    for script in scripts:
        if not script.exists():
            results.append({"script": str(script), "ok": False, "reason": "missing"})
            continue
        if not settings.allow_live_nginx:
            results.append({"script": str(script), "dryRun": True})
            continue
        result = run_command(["bash", str(script)], allow_live=True, timeout=120)
        results.append({"script": str(script), "result": result})
    return {"ok": True, "results": results}


def set_pool_directive(text: str, key: str, value: str) -> str:
    pattern = re.compile(rf"^\s*;?\s*{re.escape(key)}\s*=.*$", re.MULTILINE)
    line = f"{key} = {value}"
    if pattern.search(text):
        return pattern.sub(line, text, count=1)
    return f"{text.rstrip()}\n{line}\n"


def set_ini_directive(text: str, key: str, value: str) -> str:
    pattern = re.compile(rf"^\s*;?\s*{re.escape(key)}\s*=.*$", re.MULTILINE)
    line = f"{key} = {value}"
    if pattern.search(text):
        return pattern.sub(line, text, count=1)
    return f"{text.rstrip()}\n{line}\n"


def php_fpm_pool_paths() -> list[Path]:
    paths: list[Path] = []
    for glob in PHP_FPM_POOL_GLOBS:
        paths.extend(Path("/").glob(glob.lstrip("/")))
    return sorted(set(path for path in paths if path.is_file()))


def php_ini_paths() -> list[Path]:
    paths: list[Path] = []
    for glob in PHP_INI_GLOBS:
        paths.extend(Path("/").glob(glob.lstrip("/")))
    return sorted(set(path for path in paths if path.is_file()))


def reload_php_fpm() -> dict:
    return run_command([
        "sh",
        "-lc",
        "systemctl reload php-fpm 2>/dev/null || systemctl reload php8.3-fpm 2>/dev/null || systemctl reload php8.2-fpm 2>/dev/null || systemctl restart php-fpm 2>/dev/null || true"
    ], allow_live=True, timeout=60)


def write_text_if_changed(path: Path, content: str) -> bool:
    if path.exists() and path.read_text(encoding="utf-8", errors="ignore") == content:
        return False
    path.write_text(content, encoding="utf-8")
    return True


@router.post("/web-runtime-optimizations")
def ensure_web_runtime_optimizations() -> dict:
    compression_path = Path("/etc/nginx/conf.d/vps-panel-compression.conf")
    static_cache_path = Path("/etc/nginx/conf.d/vps-panel-static-cache.conf")
    compression_config = """gzip on;
gzip_vary on;
gzip_proxied any;
gzip_comp_level 5;
gzip_min_length 1024;
gzip_types
  text/plain
  text/css
  text/xml
  application/json
  application/javascript
  application/xml
  application/rss+xml
  image/svg+xml;
"""
    static_cache_config = """map $sent_http_content_type $vps_panel_static_cache_control {
    default "";
    "~*text/css" "public, max-age=31536000, immutable";
    "~*application/javascript" "public, max-age=31536000, immutable";
    "~*font/" "public, max-age=31536000, immutable";
    "~*image/" "public, max-age=31536000, immutable";
}

add_header Cache-Control $vps_panel_static_cache_control always;
"""
    results: dict[str, object] = {"dryRun": not settings.allow_live_nginx}

    if not settings.allow_live_nginx:
        results["nginx"] = {
            "compressionPath": str(compression_path),
            "staticCachePath": str(static_cache_path),
            "compressionConfig": compression_config,
            "staticCacheConfig": static_cache_config,
        }
    else:
        compression_path.parent.mkdir(parents=True, exist_ok=True)
        compression_changed = write_text_if_changed(compression_path, compression_config)
        static_cache_changed = write_text_if_changed(static_cache_path, static_cache_config)
        nginx_changed = compression_changed or static_cache_changed
        test = run_command(["nginx", "-t"], allow_live=True, timeout=30) if nginx_changed else None
        reload = (
            run_command(["systemctl", "reload", "nginx"], allow_live=True, timeout=30)
            if test and test.get("returncode") == 0
            else (
                {"returncode": 1, "stdout": "", "stderr": "Skipped because nginx -t failed", "command": ["systemctl", "reload", "nginx"]}
                if test
                else None
            )
        )
        results["nginx"] = {
            "compressionPath": str(compression_path),
            "staticCachePath": str(static_cache_path),
            "changed": nginx_changed,
            "test": test,
            "reload": reload,
        }

    pool_results = []
    pool_changed = False
    if not settings.web_runtime_php_tuning_enabled:
        pool_results.append({"skipped": True, "reason": "web runtime PHP tuning disabled"})
    elif not settings.allow_live_system_commands:
        pool_results.append({"dryRun": True, "reason": "live system commands disabled"})
    else:
        Path("/var/log/php-fpm").mkdir(parents=True, exist_ok=True)
        for pool_path in php_fpm_pool_paths():
            try:
                original = pool_path.read_text(encoding="utf-8", errors="ignore")
                updated = original
                for key, value in PHP_FPM_POOL_TUNING.items():
                    updated = set_pool_directive(updated, key, value)
                changed = updated != original
                if changed:
                    backup = pool_path.with_suffix(f"{pool_path.suffix}.vps-panel.bak")
                    if not backup.exists():
                        backup.write_text(original, encoding="utf-8")
                    pool_path.write_text(updated, encoding="utf-8")
                    pool_changed = True
                pool_results.append({"path": str(pool_path), "changed": changed})
            except OSError as error:
                pool_results.append({"path": str(pool_path), "error": str(error)})
    results["phpFpmPools"] = pool_results

    ini_results = []
    ini_changed = False
    if not settings.web_runtime_php_tuning_enabled:
        ini_results.append({"skipped": True, "reason": "web runtime PHP tuning disabled"})
    elif not settings.allow_live_system_commands:
        ini_results.append({"dryRun": True, "reason": "live system commands disabled"})
    else:
        for ini_path in php_ini_paths():
            try:
                original = ini_path.read_text(encoding="utf-8", errors="ignore")
                updated = original
                for key, value in PHP_INI_TUNING.items():
                    updated = set_ini_directive(updated, key, value)
                changed = updated != original
                if changed:
                    backup = ini_path.with_suffix(f"{ini_path.suffix}.vps-panel.bak")
                    if not backup.exists():
                        backup.write_text(original, encoding="utf-8")
                    ini_path.write_text(updated, encoding="utf-8")
                    ini_changed = True
                ini_results.append({"path": str(ini_path), "changed": changed})
            except OSError as error:
                ini_results.append({"path": str(ini_path), "error": str(error)})
    results["phpIni"] = ini_results
    results["phpFpmReload"] = reload_php_fpm() if settings.allow_live_system_commands and (pool_changed or ini_changed) else None
    return {"ok": True, "results": results}


@router.post("/web-runtime-optimizations/rollback-php")
def rollback_web_runtime_php_tuning() -> dict:
    if not settings.allow_live_system_commands:
        return {"ok": True, "dryRun": True, "reason": "live system commands disabled"}

    restored = []
    for path in [*php_fpm_pool_paths(), *php_ini_paths()]:
        backup = path.with_suffix(f"{path.suffix}.vps-panel.bak")
        if not backup.exists():
            restored.append({"path": str(path), "restored": False, "reason": "backup missing"})
            continue
        try:
            path.write_text(backup.read_text(encoding="utf-8", errors="ignore"), encoding="utf-8")
            restored.append({"path": str(path), "restored": True, "backup": str(backup)})
        except OSError as error:
            restored.append({"path": str(path), "restored": False, "error": str(error)})

    did_restore = any(item.get("restored") for item in restored)
    return {
        "ok": True,
        "restored": restored,
        "phpFpmReload": reload_php_fpm() if did_restore else None,
    }
