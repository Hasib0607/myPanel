import subprocess
from typing import Sequence

from app.config import settings


def run_command(command: Sequence[str], cwd: str | None = None) -> dict:
    if not settings.allow_live_system_commands:
        return {
            "dryRun": True,
            "command": list(command),
            "cwd": cwd,
            "stdout": "",
            "stderr": "",
            "returncode": 0,
        }

    completed = subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=False)
    return {
        "dryRun": False,
        "command": list(command),
        "cwd": cwd,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "returncode": completed.returncode,
    }
