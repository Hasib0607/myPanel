from __future__ import annotations

from pathlib import Path

from app.command import run_command
from app.config import DEPLOYMENT_COMMANDS_LIVE


def supervisor_config_file() -> Path:
    for candidate in (Path("/etc/supervisord.conf"), Path("/etc/supervisor/supervisor.conf")):
        if candidate.is_file():
            return candidate
    return Path("/etc/supervisord.conf")


def supervisor_config_dir() -> Path:
    config_file = supervisor_config_file()
    if config_file.is_file():
        include_dir = _include_dir_from_config(config_file)
        if include_dir is not None:
            return include_dir

    for candidate in (Path("/etc/supervisord.d"), Path("/etc/supervisor/conf.d")):
        if candidate.is_dir():
            return candidate
    return Path("/etc/supervisord.d")


def _include_dir_from_config(config_file: Path) -> Path | None:
    include_dir: Path | None = None
    for raw_line in config_file.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("["):
            continue
        if line.lower().startswith("files"):
            _, _, value = line.partition("=")
            pattern = value.strip()
            if not pattern:
                continue
            # Use the directory from the first include glob, e.g. supervisord.d/*.ini
            glob_path = Path(pattern.split("*", 1)[0].rstrip("/"))
            if not glob_path.is_absolute():
                glob_path = config_file.parent / glob_path
            include_dir = glob_path
            break
    return include_dir


def supervisor_program_extension() -> str:
    include_dir = supervisor_config_dir()
    config_file = supervisor_config_file()
    if config_file.is_file():
        for raw_line in config_file.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = raw_line.strip()
            if line.lower().startswith("files") and "*." in line:
                return line.rsplit(".", 1)[-1].strip()
    return "ini" if include_dir.name == "supervisord.d" else "conf"


def supervisor_program_path(name: str) -> Path:
    safe_name = name.replace("/", "-").strip() or "deployment"
    return supervisor_config_dir() / f"{safe_name}.{supervisor_program_extension()}"


def supervisorctl_command(*args: str) -> list[str]:
    config_file = supervisor_config_file()
    if config_file.is_file():
        return ["supervisorctl", "-c", str(config_file), *args]
    return ["supervisorctl", *args]


def ensure_supervisord_running() -> dict:
    units = ("supervisord", "supervisor")
    attempts = []

    for unit in units:
        active = run_command(["systemctl", "is-active", unit], timeout=15, allow_live=DEPLOYMENT_COMMANDS_LIVE)
        attempts.append({"unit": unit, "action": "is-active", **active})
        if active.get("returncode") == 0 and (active.get("stdout") or "").strip() == "active":
            return {"running": True, "unit": unit, "attempts": attempts}

    for unit in units:
        enable = run_command(["systemctl", "enable", unit], timeout=30, allow_live=DEPLOYMENT_COMMANDS_LIVE)
        start = run_command(["systemctl", "start", unit], timeout=30, allow_live=DEPLOYMENT_COMMANDS_LIVE)
        attempts.append({"unit": unit, "action": "enable", **enable})
        attempts.append({"unit": unit, "action": "start", **start})
        active = run_command(["systemctl", "is-active", unit], timeout=15, allow_live=DEPLOYMENT_COMMANDS_LIVE)
        attempts.append({"unit": unit, "action": "recheck", **active})
        if active.get("returncode") == 0 and (active.get("stdout") or "").strip() == "active":
            return {"running": True, "unit": unit, "attempts": attempts}

    return {"running": False, "attempts": attempts}


def run_supervisorctl(*args: str, timeout: int = 60) -> dict:
    return run_command(supervisorctl_command(*args), timeout=timeout, allow_live=DEPLOYMENT_COMMANDS_LIVE)


def format_supervisor_step_error(step: dict) -> str:
    detail = (step.get("stderr") or step.get("stdout") or step.get("reason") or "failed").strip()
    return detail or "failed"
