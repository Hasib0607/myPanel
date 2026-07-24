from __future__ import annotations

import subprocess
import os
import signal
import shutil
from pathlib import Path
from typing import Any, Sequence

from app.config import settings
from app.platform import PackageInstallPlan


def signal_name(returncode: int) -> str | None:
    if returncode >= 0:
        return None
    try:
        return signal.Signals(-returncode).name
    except ValueError:
        return f"signal {-returncode}"


def _limit_value(limits: dict[str, Any] | None, key: str, fallback: int | None = None) -> int | None:
    if not limits:
        return fallback
    value = limits.get(key, fallback)
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


def deployment_resource_limits() -> dict[str, int] | None:
    if not settings.deployment_resource_isolation_enabled:
        return None
    return {
        "memoryMaxMb": settings.deployment_memory_max_mb,
        "cpuQuotaPercent": settings.deployment_cpu_quota_percent,
        "tasksMax": settings.deployment_tasks_max,
        "nice": settings.deployment_nice,
        "ioWeight": settings.deployment_io_weight,
    }


def constrained_runtime_env(env: dict[str, str], limits: dict[str, Any] | None) -> dict[str, str]:
    memory_mb = _limit_value(limits, "memoryMaxMb")
    cpu_quota = _limit_value(limits, "cpuQuotaPercent")
    tasks_max = _limit_value(limits, "tasksMax")
    cpu_threads = max(1, min(8, (cpu_quota or 100) // 100))
    merged = dict(env)
    merged.setdefault("NODE_OPTIONS", f"--max-old-space-size={max(256, (memory_mb or 4096) - 512)}")
    merged.setdefault("UV_THREADPOOL_SIZE", str(min(32, max(4, cpu_threads * 2))))
    merged.setdefault("GOMAXPROCS", str(cpu_threads))
    merged.setdefault("COMPOSER_MEMORY_LIMIT", f"{memory_mb}M" if memory_mb else "-1")
    merged.setdefault("PIP_NO_CACHE_DIR", "1")
    merged.setdefault("MAKEFLAGS", f"-j{cpu_threads}")
    if tasks_max:
        merged.setdefault("OPENBLAS_NUM_THREADS", str(cpu_threads))
        merged.setdefault("OMP_NUM_THREADS", str(cpu_threads))
    return merged


def systemd_scope_command(command: Sequence[str], limits: dict[str, Any] | None) -> list[str] | None:
    if not limits or shutil.which("systemd-run") is None or not Path("/run/systemd/system").exists():
        return None
    memory_mb = _limit_value(limits, "memoryMaxMb")
    cpu_quota = _limit_value(limits, "cpuQuotaPercent")
    tasks_max = _limit_value(limits, "tasksMax")
    io_weight = _limit_value(limits, "ioWeight")
    args = ["systemd-run", "--scope", "--quiet", "--collect"]
    if memory_mb:
        args.extend(["-p", f"MemoryMax={memory_mb}M", "-p", "MemorySwapMax=0"])
    if cpu_quota:
        args.extend(["-p", f"CPUQuota={cpu_quota}%"])
    if tasks_max:
        args.extend(["-p", f"TasksMax={tasks_max}"])
    if io_weight:
        args.extend(["-p", f"IOWeight={io_weight}"])
    args.extend(command)
    return args


def prlimit_command(command: Sequence[str], limits: dict[str, Any] | None) -> list[str]:
    wrapped = list(command)
    if not limits:
        return wrapped
    memory_mb = _limit_value(limits, "memoryMaxMb")
    if shutil.which("prlimit") and memory_mb:
        args = ["prlimit"]
        memory_bytes = memory_mb * 1024 * 1024
        args.append(f"--as={memory_bytes}:{memory_bytes}")
        args.extend(["--", *wrapped])
        wrapped = args
    nice = _limit_value(limits, "nice")
    if nice and shutil.which("nice"):
        wrapped = ["nice", "-n", str(min(19, max(0, nice))), *wrapped]
    return wrapped


def limited_command(command: Sequence[str], limits: dict[str, Any] | None) -> tuple[list[str], str | None]:
    scoped = systemd_scope_command(command, limits)
    if scoped:
        return scoped, "systemd"
    if limits:
        return prlimit_command(command, limits), "prlimit"
    return list(command), None


def run_command(command: Sequence[str], cwd: str | None = None, env: dict[str, str] | None = None, allow_live: bool | None = None, timeout: int | None = None, resource_limits: dict[str, Any] | None = None) -> dict:
    live = settings.allow_live_system_commands if allow_live is None else allow_live
    if not live:
        return {
            "dryRun": True,
            "liveCommandsDisabled": True,
            "command": list(command),
            "cwd": cwd,
            "stdout": "",
            "stderr": "",
            "returncode": 0,
        }

    effective_timeout = timeout or settings.deployment_command_timeout_seconds
    try:
        home = os.environ.get("HOME") or "/tmp/vps-panel-home"
        composer_home = os.environ.get("COMPOSER_HOME") or f"{home}/.composer"
        xdg_config_home = os.environ.get("XDG_CONFIG_HOME") or f"{home}/.config"
        Path(home).mkdir(parents=True, exist_ok=True)
        Path(composer_home).mkdir(parents=True, exist_ok=True)
        Path(xdg_config_home).mkdir(parents=True, exist_ok=True)
        command_env = {
            **os.environ,
            "CI": os.environ.get("CI", "false"),
            "NEXT_TELEMETRY_DISABLED": os.environ.get("NEXT_TELEMETRY_DISABLED", "1"),
            "HOME": home,
            "COMPOSER_HOME": composer_home,
            "XDG_CONFIG_HOME": xdg_config_home,
            **(env or {}),
        }
        if command and command[0] == "pm2" and not command_env.get("PM2_HOME"):
            panel_pm2_home = Path("/tmp/vps-panel-home/.pm2")
            command_env["PM2_HOME"] = str(panel_pm2_home if panel_pm2_home.exists() else Path(home) / ".pm2")
        command_env = constrained_runtime_env(command_env, resource_limits)
        effective_command, isolation = limited_command(command, resource_limits)
        # start_new_session=True isolates the child process in its own process group
        # so that SIGTERM sent to sysagent (e.g. by systemd during a panel update)
        # does not propagate to a running build/install subprocess.
        process = subprocess.Popen(
            effective_command,
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
                "command": list(effective_command),
                "requestedCommand": list(command),
                "cwd": cwd,
                "stdout": "",
                "stderr": f"Command timed out after {effective_timeout} seconds",
                "returncode": 124,
                **({"resourceIsolation": isolation, "resourceLimits": resource_limits} if isolation else {}),
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
        "command": list(effective_command),
        "requestedCommand": list(command),
        "cwd": cwd,
        "stdout": stdout,
        "stderr": stderr,
        "returncode": process.returncode,
        **({"resourceIsolation": isolation, "resourceLimits": resource_limits} if isolation else {}),
        **({"signal": detail} if detail else {}),
    }


def run_install_plan(plan: PackageInstallPlan, *, timeout: int | None = None, allow_live: bool | None = None) -> dict:
    step_results: list[dict] = []
    success = True

    for step in plan.steps:
        if step.skip_if:
            check = run_command(list(step.skip_if), timeout=timeout, allow_live=allow_live)
            if check.get("returncode") == 0:
                step_results.append({
                    "description": step.description,
                    "onFailure": step.on_failure,
                    "skipped": True,
                    "skipReason": "already installed",
                    "check": check,
                    "dryRun": check.get("dryRun", False),
                    "command": list(step.command),
                    "stdout": check.get("stdout", ""),
                    "stderr": check.get("stderr", ""),
                    "returncode": 0,
                })
                continue
        result = run_command(list(step.command), env=step.env or None, timeout=timeout, allow_live=allow_live)
        entry = {
            "description": step.description,
            "onFailure": step.on_failure,
            **result,
        }
        step_results.append(entry)
        if result.get("returncode") != 0 and step.on_failure != "continue":
            success = False
            break

    if not success and plan.fallback_steps:
        for step in plan.fallback_steps:
            if step.skip_if:
                check = run_command(list(step.skip_if), timeout=timeout, allow_live=allow_live)
                if check.get("returncode") == 0:
                    step_results.append({
                        "description": step.description,
                        "onFailure": step.on_failure,
                        "fallback": True,
                        "skipped": True,
                        "skipReason": "already installed",
                        "check": check,
                        "dryRun": check.get("dryRun", False),
                        "command": list(step.command),
                        "stdout": check.get("stdout", ""),
                        "stderr": check.get("stderr", ""),
                        "returncode": 0,
                    })
                    success = True
                    break
            result = run_command(list(step.command), env=step.env or None, timeout=timeout, allow_live=allow_live)
            entry = {
                "description": step.description,
                "onFailure": step.on_failure,
                "fallback": True,
                **result,
            }
            step_results.append(entry)
            if result.get("returncode") == 0:
                success = True
                break

    payload: dict = {
        "dryRun": any(step.get("dryRun") for step in step_results),
        "returncode": 0 if success else 1,
        "planKey": plan.key,
        "packages": list(plan.packages),
        "notes": plan.notes,
        "steps": step_results,
    }
    if step_results:
        last = step_results[-1]
        payload.update({
            "command": last.get("command"),
            "stdout": last.get("stdout", ""),
            "stderr": last.get("stderr", ""),
        })
    return payload
