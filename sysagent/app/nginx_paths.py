"""Resolved Nginx config directory paths for sysagent."""

from __future__ import annotations

from app.config import settings
from app.platform import current_os, platform_paths


def nginx_sites_available() -> str:
    if settings.nginx_sites_available.strip():
        return settings.nginx_sites_available.strip()
    return platform_paths(current_os()).nginx_sites_available


def nginx_sites_enabled() -> str:
    if settings.nginx_sites_enabled.strip():
        return settings.nginx_sites_enabled.strip()
    return platform_paths(current_os()).nginx_sites_enabled
