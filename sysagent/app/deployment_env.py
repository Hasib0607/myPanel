from __future__ import annotations

import re
import shlex
import subprocess
from pathlib import Path

VALID_ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Runtime env files are sourced by bash; keep only shell-boring token chars unquoted.
UNQUOTED_DOTENV_VALUE = re.compile(r"^[A-Za-z0-9_./:@%+=,-]+$")
LARAVEL_APP_KEY = re.compile(r"^base64:[A-Za-z0-9+/]{43}=$")


def normalize_process_env(port: int | None, env: dict[str, str] | None) -> dict[str, str]:
    merged: dict[str, str] = {}
    if port:
        merged["PORT"] = str(port)
    if env:
        for key, value in env.items():
            if VALID_ENV_KEY.match(key):
                merged[key] = str(value)
    return merged


def is_valid_laravel_app_key(value: str | None) -> bool:
    if not value or not str(value).strip():
        return False
    return bool(LARAVEL_APP_KEY.fullmatch(str(value).strip()))


def php_redis_extension_loaded() -> bool:
    try:
        proc = subprocess.run(
            ["php", "-r", "echo class_exists('Redis') ? '1' : '0';"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        return proc.stdout.strip() == "1"
    except (OSError, subprocess.TimeoutExpired):
        return False


def normalize_laravel_redis_env(process_env: dict[str, str], *, redis_loaded: bool | None = None) -> dict[str, str]:
    """Use file/sync drivers when the PHP redis extension is not available."""
    if redis_loaded if redis_loaded is not None else php_redis_extension_loaded():
        return process_env

    redis_values = {"redis", "phpredis"}
    driver_defaults = {
        "CACHE_DRIVER": "file",
        "CACHE_STORE": "file",
        "SESSION_DRIVER": "file",
        "QUEUE_CONNECTION": "sync",
        "BROADCAST_DRIVER": "log",
    }
    for key, fallback in driver_defaults.items():
        if (process_env.get(key) or "").strip().lower() in redis_values:
            process_env[key] = fallback
    return process_env


def normalize_database_charset_env(process_env: dict[str, str]) -> dict[str, str]:
    """Laravel MySQL uses utf8mb4; PostgreSQL client_encoding must be UTF8, not utf8mb4."""
    connection = (process_env.get("DB_CONNECTION") or "").strip().lower()
    database_url = (process_env.get("DATABASE_URL") or "").strip().lower()
    is_postgres = connection in {"pgsql", "postgres", "postgresql"} or database_url.startswith(
        ("postgres://", "postgresql://")
    )
    is_mysql = connection in {"mysql", "mariadb"} or database_url.startswith(("mysql://", "mariadb://"))

    if is_postgres:
        if (process_env.get("DB_CHARSET") or "").lower() in {"", "utf8mb4"}:
            process_env["DB_CHARSET"] = "utf8"
        if process_env.get("DB_COLLATION"):
            process_env["DB_COLLATION"] = ""
    elif is_mysql:
        if (process_env.get("DB_CHARSET") or "").lower() in {"", "utf8"}:
            process_env["DB_CHARSET"] = "utf8mb4"
        if not process_env.get("DB_COLLATION"):
            process_env["DB_COLLATION"] = "utf8mb4_unicode_ci"
    return process_env


def normalize_laravel_https_env(process_env: dict[str, str]) -> dict[str, str]:
    """Align session/proxy env with APP_URL so HTTPS logins work behind nginx."""
    app_url = (process_env.get("APP_URL") or "").strip()
    lower = app_url.lower()
    if lower.startswith("https://"):
        process_env["SESSION_SECURE_COOKIE"] = "true"
        if not (process_env.get("SESSION_SAME_SITE") or "").strip():
            process_env["SESSION_SAME_SITE"] = "lax"
        host = app_url.split("://", 1)[1].split("/")[0].strip()
        if host and not (process_env.get("SANCTUM_STATEFUL_DOMAINS") or "").strip():
            process_env["SANCTUM_STATEFUL_DOMAINS"] = host
        if not (process_env.get("TRUSTED_PROXIES") or "").strip():
            process_env["TRUSTED_PROXIES"] = "*"
    elif lower.startswith("http://"):
        process_env["SESSION_SECURE_COOKIE"] = "false"
    return process_env


def finalize_laravel_process_env(process_env: dict[str, str]) -> dict[str, str]:
    return normalize_laravel_https_env(normalize_laravel_redis_env(normalize_database_charset_env(process_env)))


def resolve_laravel_app_key(process_env: dict[str, str], existing: dict[str, str]) -> str | None:
    for candidate in (process_env.get("APP_KEY"), existing.get("APP_KEY")):
        if is_valid_laravel_app_key(candidate):
            return str(candidate).strip()
    return None


def prepare_laravel_env_for_sync(
    root_path: str,
    port: int | None,
    env: dict[str, str] | None,
) -> tuple[dict[str, str], bool]:
    env_path = Path(root_path).resolve() / ".env"
    process_env = normalize_process_env(port, env)
    existing = read_existing_env_values(env_path)

    panel_key = process_env.get("APP_KEY", "")
    if panel_key and not is_valid_laravel_app_key(panel_key):
        process_env.pop("APP_KEY", None)

    resolved = resolve_laravel_app_key(process_env, existing)
    if resolved:
        process_env["APP_KEY"] = resolved
        return finalize_laravel_process_env(process_env), False
    return finalize_laravel_process_env(process_env), True


def format_dotenv_line(key: str, value: str) -> str:
    """Format one KEY=VALUE line for Laravel phpdotenv and bash source."""
    if not VALID_ENV_KEY.match(key):
        raise ValueError(f"invalid env key: {key}")
    if value == "":
        return f"{key}="
    if "\n" in value or "\r" in value:
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'{key}="{escaped}"'
    if UNQUOTED_DOTENV_VALUE.fullmatch(value):
        return f"{key}={value}"
    if "'" not in value:
        return f"{key}='{value}'"
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'{key}="{escaped}"'


def write_env_file(path: Path, env: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [format_dotenv_line(key, env[key]) for key in sorted(env)]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def read_existing_env_values(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not VALID_ENV_KEY.match(key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value
    return values


def write_laravel_env_bundle(root_path: str, process_env: dict[str, str]) -> Path:
    root = Path(root_path).resolve()
    env_path = root / ".env"
    runtime_env = root / ".panel" / "runtime.env"
    write_env_file(env_path, process_env)
    write_env_file(runtime_env, process_env)
    return env_path


def clear_laravel_bootstrap_config_cache(root_path: str) -> None:
    cache_dir = Path(root_path).resolve() / "bootstrap" / "cache"
    if not cache_dir.is_dir():
        return
    for name in ("config.php", "routes-v7.php", "packages.php", "services.php"):
        cached = cache_dir / name
        if cached.is_file():
            cached.unlink()


def sync_laravel_env_file(root_path: str, port: int | None, env: dict[str, str] | None) -> tuple[Path, str | None, bool]:
    process_env, needs_key_generate = prepare_laravel_env_for_sync(root_path, port, env)
    env_path = Path(root_path).resolve() / ".env"
    if not needs_key_generate:
        env_path = write_laravel_env_bundle(root_path, process_env)
    return env_path, process_env.get("APP_KEY"), needs_key_generate


def is_laravel_artisan_command(start_command: list[str]) -> bool:
    return len(start_command) >= 2 and start_command[0] == "php" and start_command[1] == "artisan"


def write_supervisor_wrapper(wrapper_path: Path, env_path: Path, cwd: str, start_command: list[str]) -> None:
    command = shlex.join(start_command)
    script = (
        "#!/bin/bash\n"
        "set -euo pipefail\n"
        "set -a\n"
        f"source {shlex.quote(str(env_path))}\n"
        "set +a\n"
        f"cd {shlex.quote(cwd)}\n"
        f"exec {command}\n"
    )
    wrapper_path.parent.mkdir(parents=True, exist_ok=True)
    wrapper_path.write_text(script, encoding="utf-8")
    wrapper_path.chmod(0o755)


def prepare_supervisor_runtime(
    root_path: str,
    start_command: list[str],
    port: int | None,
    env: dict[str, str] | None,
) -> tuple[Path, Path, Path | None]:
    cwd = Path(root_path).resolve()
    panel_dir = cwd / ".panel"
    runtime_env = panel_dir / "runtime.env"
    wrapper = panel_dir / "run.sh"
    process_env, needs_key_generate = prepare_laravel_env_for_sync(str(cwd), port, env)
    if needs_key_generate:
        raise ValueError("Laravel APP_KEY is missing or invalid; sync Laravel env before starting the process")
    laravel_env_path = write_laravel_env_bundle(str(cwd), process_env)
    write_supervisor_wrapper(wrapper, runtime_env, str(cwd), start_command)
    return wrapper, runtime_env, laravel_env_path
