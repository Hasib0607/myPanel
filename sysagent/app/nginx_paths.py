from __future__ import annotations
"""Resolved Nginx config directory paths for sysagent."""


from pathlib import Path

from app.config import settings
from app.platform import current_os, platform_paths


def _nginx_includes_sites_enabled() -> bool:
    nginx_conf = Path("/etc/nginx/nginx.conf")
    try:
        text = nginx_conf.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False
    return "sites-enabled" in text


def _configured_path_or_platform(configured: str, platform_value: str) -> str:
    value = configured.strip()
    os_info = current_os()
    if os_info.is_rhel and value.startswith("/etc/nginx/sites-") and not _nginx_includes_sites_enabled():
        return platform_value
    return value or platform_value


def nginx_sites_available() -> str:
    paths = platform_paths(current_os())
    return _configured_path_or_platform(settings.nginx_sites_available, paths.nginx_sites_available)


def nginx_sites_enabled() -> str:
    paths = platform_paths(current_os())
    return _configured_path_or_platform(settings.nginx_sites_enabled, paths.nginx_sites_enabled)
