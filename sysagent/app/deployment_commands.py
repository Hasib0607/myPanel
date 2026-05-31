import re
import shlex
from pathlib import Path

ALLOWED_DEPLOY_EXECUTABLES = {
    "./app",
    "artisan",
    "composer",
    "flask",
    "go",
    "gunicorn",
    "node",
    "next",
    "npm",
    "npx",
    "php",
    "php-fpm",
    "pip",
    "pip3",
    "pnpm",
    "python",
    "python3",
    "react-scripts",
    "serve",
    "true",
    "uv",
    "uvicorn",
    "vite",
    "yarn",
}

SHELL_METACHARS = {"|", "||", "&", "&&", ";", ">", ">>", "<", "$(", "`"}


def is_allowed_deploy_executable(executable: str) -> bool:
    if executable in ALLOWED_DEPLOY_EXECUTABLES:
        return True
    return bool(re.fullmatch(r"php(\d+(?:\.\d+)?)?-fpm", executable))


def normalize_laravel_start_command(command: str | None, port: int | None) -> str:
    cleaned = (command or "").strip()
    lowered = cleaned.lower()
    if not cleaned or lowered == "php-fpm" or (lowered.endswith("-fpm") and lowered.startswith("php")):
        effective_port = port or 8000
        return f"php artisan serve --host=127.0.0.1 --port {effective_port}"
    if port is not None:
        return cleaned.replace("{PORT}", str(port)).replace("$PORT", str(port))
    return cleaned


def deployment_path_allowed(root_path: str, file_manager_root: str) -> bool:
    root = Path(file_manager_root).resolve()
    target = Path(root_path).resolve()
    if target == root:
        return True
    try:
        target.relative_to(root)
        return True
    except ValueError:
        return False


def parse_deployment_command(command: str) -> list[str]:
    try:
        parsed = shlex.split(command)
    except ValueError as error:
        raise ValueError(f"Invalid deployment command: {error}") from error
    if not parsed:
        raise ValueError("Deployment command cannot be empty")
    if not is_allowed_deploy_executable(parsed[0]):
        raise ValueError(f"Unsupported deployment executable: {parsed[0]}")
    if any(token in SHELL_METACHARS or any(marker in token for marker in ("$(", "`")) for token in parsed):
        raise ValueError("Shell operators are not allowed in deployment commands")
    return parsed
