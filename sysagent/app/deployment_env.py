from __future__ import annotations

import re
import shlex
from pathlib import Path

VALID_ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# Unquoted dotenv values cannot contain whitespace, #, or quotes.
UNQUOTED_DOTENV_VALUE = re.compile(r"^[^\s#'\"]+$")


def normalize_process_env(port: int | None, env: dict[str, str] | None) -> dict[str, str]:
    merged: dict[str, str] = {}
    if port:
        merged["PORT"] = str(port)
    if env:
        for key, value in env.items():
            if VALID_ENV_KEY.match(key):
                merged[key] = str(value)
    return merged


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


def sync_laravel_env_file(root_path: str, port: int | None, env: dict[str, str] | None) -> Path:
    env_path = Path(root_path).resolve() / ".env"
    write_env_file(env_path, normalize_process_env(port, env))
    return env_path


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
    process_env = normalize_process_env(port, env)
    write_env_file(runtime_env, process_env)
    write_supervisor_wrapper(wrapper, runtime_env, str(cwd), start_command)
    laravel_env_path = None
    if is_laravel_artisan_command(start_command):
        laravel_env_path = sync_laravel_env_file(str(cwd), port, env)
    return wrapper, runtime_env, laravel_env_path
