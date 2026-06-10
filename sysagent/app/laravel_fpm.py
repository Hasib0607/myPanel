from __future__ import annotations

import shutil
from pathlib import Path

from app.laravel_nginx import laravel_fpm_pool_name, laravel_fpm_socket


def php_fpm_config_dir() -> Path:
    candidates = [
        Path("/etc/php-fpm.d"),
        *sorted(Path("/etc/php").glob("*/fpm/pool.d")),
    ]
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return candidates[0]


def php_fpm_executable() -> str | None:
    direct = shutil.which("php-fpm")
    if direct:
        return direct
    for candidate in sorted([*Path("/usr/sbin").glob("php*-fpm"), *Path("/usr/bin").glob("php*-fpm")]):
        if candidate.is_file():
            return str(candidate)
    return None


def php_fpm_service() -> str | None:
    for name in ("php-fpm", "php8.3-fpm", "php8.2-fpm", "php82-php-fpm", "php83-php-fpm"):
        if any(
            Path(base, f"{name}.service").exists()
            for base in ("/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system")
        ):
            return name
    return None


def nginx_runtime_user() -> str:
    for name in ("nginx", "www-data"):
        try:
            import pwd

            pwd.getpwnam(name)
            return name
        except KeyError:
            continue
    return "nginx"


def laravel_fpm_config_path(deployment_id: str) -> Path:
    return php_fpm_config_dir() / f"{laravel_fpm_pool_name(deployment_id)}.conf"


def render_laravel_fpm_pool(
    deployment_id: str,
    root_path: str,
    *,
    memory_limit_mb: int = 512,
    max_children: int = 20,
) -> str:
    root = Path(root_path).resolve()
    web_user = nginx_runtime_user()
    slowlog_dir = Path("/var/log/php-fpm")
    if not slowlog_dir.exists():
        slowlog_dir = Path("/var/log")
    return "\n".join(
        [
            f"[{laravel_fpm_pool_name(deployment_id)}]",
            "user = panel",
            "group = panel",
            f"listen = {laravel_fpm_socket(deployment_id)}",
            f"listen.owner = {web_user}",
            f"listen.group = {web_user}",
            "listen.mode = 0660",
            "pm = dynamic",
            f"pm.max_children = {max_children}",
            "pm.start_servers = 4",
            "pm.min_spare_servers = 4",
            f"pm.max_spare_servers = {min(10, max_children)}",
            "pm.max_requests = 500",
            "pm.status_path = /fpm-status",
            "ping.path = /fpm-ping",
            "ping.response = pong",
            "request_slowlog_timeout = 5s",
            f"slowlog = {slowlog_dir / f'{laravel_fpm_pool_name(deployment_id)}-slow.log'}",
            "request_terminate_timeout = 60s",
            "catch_workers_output = yes",
            "clear_env = no",
            f"chdir = {root}",
            f"php_admin_value[memory_limit] = {memory_limit_mb}M",
            "php_admin_value[max_execution_time] = 60",
            "",
        ]
    )
