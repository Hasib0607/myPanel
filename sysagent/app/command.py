import subprocess
import os
from typing import Sequence

from app.config import settings


def run_command(command: Sequence[str], cwd: str | None = None, env: dict[str, str] | None = None, allow_live: bool | None = None) -> dict:
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

    completed = subprocess.run(command, cwd=cwd, env={**os.environ, **(env or {})}, capture_output=True, text=True, check=False)
    return {
        "dryRun": False,
        "command": list(command),
        "cwd": cwd,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "returncode": completed.returncode,
    }
