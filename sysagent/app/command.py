import subprocess
import os
import signal
from typing import Sequence

from app.config import settings


def signal_name(returncode: int) -> str | None:
    if returncode >= 0:
        return None
    try:
        return signal.Signals(-returncode).name
    except ValueError:
        return f"signal {-returncode}"


def run_command(command: Sequence[str], cwd: str | None = None, env: dict[str, str] | None = None, allow_live: bool | None = None, timeout: int | None = None) -> dict:
    live = settings.allow_live_system_commands if allow_live is None else allow_live
    if not live:
        return {
            "dryRun": True,
            "command": list(command),
            "cwd": cwd,
            "stdout": "",
            "stderr": "",
            "returncode": 0,
        }

    try:
        command_env = {
            **os.environ,
            "CI": os.environ.get("CI", "false"),
            "NEXT_TELEMETRY_DISABLED": os.environ.get("NEXT_TELEMETRY_DISABLED", "1"),
            **(env or {}),
        }
        completed = subprocess.run(
            command,
            cwd=cwd,
            env=command_env,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout or settings.deployment_command_timeout_seconds,
        )
    except FileNotFoundError as error:
        return {
            "dryRun": False,
            "command": list(command),
            "cwd": cwd,
            "stdout": "",
            "stderr": str(error),
            "returncode": 127,
        }
    except subprocess.TimeoutExpired as error:
        return {
            "dryRun": False,
            "command": list(command),
            "cwd": cwd,
            "stdout": error.stdout or "",
            "stderr": f"Command timed out after {timeout or settings.deployment_command_timeout_seconds} seconds",
            "returncode": 124,
        }
    detail = signal_name(completed.returncode)
    return {
        "dryRun": False,
        "command": list(command),
        "cwd": cwd,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "returncode": completed.returncode,
        **({"signal": detail} if detail else {}),
    }
