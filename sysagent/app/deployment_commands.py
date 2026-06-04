from __future__ import annotations
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
    "sleep",
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


def laravel_has_public_web_root(root_path: str | None) -> bool:
    if not root_path:
        return True
    root = Path(root_path).resolve()
    if root.name == "public" and (root.parent / "artisan").is_file():
        root = root.parent
    return (root / "public").is_dir() and (root / "public" / "index.php").is_file()


def normalize_laravel_start_command(command: str | None, port: int | None, root_path: str | None = None) -> str:
    cleaned = (command or "").strip()
    lowered = cleaned.lower()
    legacy_laravel_start = not cleaned or lowered == "php-fpm" or (lowered.endswith("-fpm") and lowered.startswith("php"))
    artisan_serve = lowered.startswith("php artisan serve")
    if (legacy_laravel_start or artisan_serve) and not laravel_has_public_web_root(root_path):
        return "sleep infinity"
    if legacy_laravel_start:
        effective_port = port or 8000
        return f"php artisan serve --host=127.0.0.1 --port {effective_port}"
    if port is not None:
        return cleaned.replace("{PORT}", str(port)).replace("$PORT", str(port))
    return cleaned


def resolve_laravel_public_root(root_path: str, public_directory: str | None = "public") -> str:
    root = Path(root_path).resolve()
    pub = (public_directory or "public").strip().strip("/")
    if pub in {"", "."}:
        return str(root)
    candidate = root / pub
    if candidate.is_dir():
        return str(candidate)
    default_public = root / "public"
    return str(default_public if default_public.is_dir() else root)


def laravel_public_permission_commands(root_path: str) -> tuple[list[str], list[str]]:
    root = str(Path(root_path).resolve())
    return ["chmod", "-R", "a+rX", f"{root}/public"], ["chmod", "o+x", root]


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
