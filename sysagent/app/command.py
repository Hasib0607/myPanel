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

    effective_timeout = timeout or settings.deployment_command_timeout_seconds
    try:
        command_env = {
            **os.environ,
            "CI": os.environ.get("CI", "false"),
            "NEXT_TELEMETRY_DISABLED": os.environ.get("NEXT_TELEMETRY_DISABLED", "1"),
            **(env or {}),
        }
        # start_new_session=True isolates the child process in its own process group
        # so that SIGTERM sent to sysagent (e.g. by systemd during a panel update)
        # does not propagate to a running build/install subprocess.
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=command_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=effective_timeout)
        except subprocess.TimeoutExpired:
            # Kill the entire new process group (catches child processes spawned by npm/node).
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except ProcessLookupError:
                process.kill()
            process.wait()
            return {
                "dryRun": False,
                "command": list(command),
                "cwd": cwd,
                "stdout": "",
                "stderr": f"Command timed out after {effective_timeout} seconds",
                "returncode": 124,
            }
    except FileNotFoundError as error:
        return {
            "dryRun": False,
            "command": list(command),
            "cwd": cwd,
            "stdout": "",
            "stderr": str(error),
            "returncode": 127,
        }
    detail = signal_name(process.returncode)
    return {
        "dryRun": False,
        "command": list(command),
        "cwd": cwd,
        "stdout": stdout,
        "stderr": stderr,
        "returncode": process.returncode,
        **({"signal": detail} if detail else {}),
    }
