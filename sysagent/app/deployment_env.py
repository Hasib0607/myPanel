from __future__ import annotations

import re
import shlex
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
        return process_env, False
    return process_env, True


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


def sync_laravel_env_file(root_path: str, port: int | None, env: dict[str, str] | None) -> tuple[Path, str | None, bool]:
    env_path = Path(root_path).resolve() / ".env"
    process_env, needs_key_generate = prepare_laravel_env_for_sync(root_path, port, env)
    write_env_file(env_path, process_env)
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
    process_env, _needs_key_generate = prepare_laravel_env_for_sync(str(cwd), port, env)
    write_env_file(runtime_env, process_env)
    write_supervisor_wrapper(wrapper, runtime_env, str(cwd), start_command)
    laravel_env_path = None
    if is_laravel_artisan_command(start_command):
        laravel_env_path, _, _ = sync_laravel_env_file(str(cwd), port, env)
    return wrapper, runtime_env, laravel_env_path
