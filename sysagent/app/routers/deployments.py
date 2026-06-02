from __future__ import annotations
import shlex
import re
import json
import base64
import time
import shutil
import os
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.command import run_command, run_install_plan
from app.config import DEPLOYMENT_COMMANDS_LIVE, settings
from app.deployment_env import (
    clear_laravel_bootstrap_config_cache,
    generate_laravel_app_key,
    is_laravel_artisan_command,
    is_valid_laravel_app_key,
    prepare_laravel_env_for_sync,
    prepare_supervisor_runtime,
    read_existing_env_values,
    sync_laravel_env_file,
    write_env_file,
    write_laravel_env_bundle,
)
from app.deployment_commands import normalize_laravel_start_command, parse_deployment_command, resolve_laravel_public_root
from app.laravel_nginx import nginx_app_locations
from app.deployment_health import curl_health_probe
from app.platform import runtime_tool_install_plan
from app.nginx_paths import nginx_sites_available, nginx_sites_enabled
from app.nginx_manager import (
    acme_location,
    letsencrypt_certificate_exists,
    publish_nginx_config,
    remove_conflicting_configs,
    remove_insecure_port443_configs,
    safe_letsencrypt_path,
    safe_web_root,
    server_name_tokens,
    _config_has_insecure_port443,
    _config_has_server_name,
)
from app.supervisor_utils import (
    ensure_supervisord_running,
    format_supervisor_step_error,
    remove_stale_supervisor_program_configs,
    run_supervisorctl,
    supervisor_config_dir,
    supervisor_program_path,
    supervisorctl_command,
)

router = APIRouter()


class GitSyncRequest(BaseModel):
    rootPath: str
    gitUrl: str | None = None
    branch: str = "main"
    commitSha: str | None = None
    gitToken: str | None = None


class CommandRequest(BaseModel):
    rootPath: str
    command: str | None = None
    packageManager: str | None = None
    env: dict[str, str] | None = None


class ProcessRequest(BaseModel):
    deploymentId: str
    name: str
    rootPath: str
    action: str
    processManager: str | None = None
    startCommand: str | None = None
    port: int | None = Field(default=None, ge=1, le=65535)
    env: dict[str, str] | None = None
    logDir: str | None = None


def normalize_process_root(body: ProcessRequest) -> ProcessRequest:
    root = Path(body.rootPath).resolve()
    parent = root.parent
    if root.name == "public" and not root.exists() and (parent / "artisan").is_file():
        return body.model_copy(update={"rootPath": str(parent)})
    if root.name == "public" and not (root / "artisan").is_file() and (parent / "artisan").is_file():
        return body.model_copy(update={"rootPath": str(parent)})
    return body


class NginxRequest(BaseModel):
    deploymentId: str
    serverName: str | None = None
    upstreamPort: int = Field(ge=1, le=65535)
    rootPath: str
    framework: str | None = None
    loopbackProxyHost: bool = False
    publicDirectory: str | None = "public"
    fallbackRootPath: str | None = None
    forceSsl: bool = True
    sslCertificate: str | None = None
    sslCertificateKey: str | None = None
    requireSsl: bool = False


class HealthRequest(BaseModel):
    deploymentId: str
    port: int = Field(ge=1, le=65535)
    healthUrl: str | None = None
    processName: str | None = None
    processManager: str | None = None
    rootPath: str | None = None
    framework: str | None = None


class PortStatusRequest(BaseModel):
    rootPath: str
    port: int = Field(ge=1, le=65535)
    processName: str | None = None
    processManager: str | None = None


class PublicRouteRequest(BaseModel):
    serverName: str
    path: str = "/"
    rootPath: str | None = None
    framework: str | None = None
    requireHttps: bool = False


class GuardianRepairRequest(BaseModel):
    rootPath: str
    framework: str | None = None
    env: dict[str, str] | None = None


class RuntimeLogsRequest(BaseModel):
    name: str
    logDir: str | None = None
    rootPath: str | None = None
    lines: int = Field(default=300, ge=1, le=2000)


class RuntimeToolsRequest(BaseModel):
    tools: list[str] = Field(default_factory=list, max_length=50)


class NginxInspectRequest(BaseModel):
    deploymentId: str
    serverName: str | None = None
    upstreamPort: int = Field(ge=1, le=65535)
    rootPath: str


class RuntimeInstallRequest(BaseModel):
    tool: str = Field(pattern="^(pnpm|yarn|composer|uv|go|php|php82|php-mbstring|php-xml|php-curl|php-zip|php-gd|php-redis|php-soap|php-mysql|php-pgsql|python|python311|nodejs|supervisor|pm2)$")


class PermissionRepairRequest(BaseModel):
    rootPath: str
    logDir: str | None = None


class SupervisorRepairRequest(BaseModel):
    name: str


class LaravelWritablePathsRequest(BaseModel):
    rootPath: str


class PythonRuntimeRepairRequest(BaseModel):
    rootPath: str


class SyncEnvFileRequest(BaseModel):
    rootPath: str
    port: int | None = Field(default=None, ge=1, le=65535)
    env: dict[str, str] | None = None


LARAVEL_PUBLIC_INDEX = """<?php

use Illuminate\\Contracts\\Http\\Kernel;
use Illuminate\\Http\\Request;

define('LARAVEL_START', microtime(true));

if (file_exists($maintenance = __DIR__.'/../storage/framework/maintenance.php')) {
    require $maintenance;
}

require __DIR__.'/../vendor/autoload.php';

$app = require_once __DIR__.'/../bootstrap/app.php';

if (method_exists($app, 'handleRequest')) {
    $app->handleRequest(Request::capture());
    return;
}

$kernel = $app->make(Kernel::class);

$response = $kernel->handle(
    $request = Request::capture()
)->send();

$kernel->terminate($request, $response);
"""


def path_is_within(root: Path, target: Path) -> bool:
    try:
        target.relative_to(root)
        return True
    except ValueError:
        return False


def path_info(root_path: str) -> dict:
    root = Path(settings.file_manager_root).resolve()
    target = Path(root_path).resolve()
    allowed = target == root or path_is_within(root, target)
    return {
        "root": str(root),
        "target": str(target),
        "allowed": allowed,
        "liveAllowed": allowed and settings.allow_live_system_commands,
    }


def blocked_command(reason: str, command: list[str], info: dict | None = None) -> dict:
    result = {
        "dryRun": True,
        "blocked": True,
        "liveCommandsDisabled": False,
        "reason": reason,
        "command": command,
        "stdout": "",
        "stderr": reason,
        "returncode": 1,
    }
    if info is not None:
        result["path"] = info
    return result


def guarded_command(root_path: str, command: list[str], cwd: str | None = None) -> dict:
    info = path_info(root_path)
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", command, info)
    result = run_command(command, cwd=cwd, allow_live=DEPLOYMENT_COMMANDS_LIVE)
    result["path"] = info
    return result


def guarded_command_with_env(root_path: str, command: list[str], cwd: str | None = None, env: dict[str, str] | None = None) -> dict:
    info = path_info(root_path)
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", command, info)
    result = run_command(command, cwd=cwd, env=env, allow_live=DEPLOYMENT_COMMANDS_LIVE)
    result["path"] = info
    return result


def git_base_env() -> dict[str, str]:
    home = os.environ.get("HOME") or "/tmp/vps-panel-git-home"
    return {
        "HOME": home,
        "XDG_CONFIG_HOME": os.environ.get("XDG_CONFIG_HOME") or f"{home}/.config",
        "GIT_TERMINAL_PROMPT": "0",
    }


def composer_git_env(root_path: str, env: dict[str, str] | None = None) -> dict[str, str]:
    effective = {**git_base_env(), **(env or {})}
    effective.setdefault("COMPOSER_ALLOW_SUPERUSER", "1")

    extra_count = 0
    try:
        extra_count = int(effective.get("GIT_CONFIG_COUNT", "0"))
    except ValueError:
        extra_count = 0

    target = str(Path(root_path).resolve())
    for index in range(extra_count):
        key = effective.get(f"GIT_CONFIG_KEY_{index}")
        value = effective.get(f"GIT_CONFIG_VALUE_{index}")
        if key == "safe.directory" and value == target:
            ensure_git_runtime_paths(effective)
            return effective

    effective["GIT_CONFIG_COUNT"] = str(extra_count + 1)
    effective[f"GIT_CONFIG_KEY_{extra_count}"] = "safe.directory"
    effective[f"GIT_CONFIG_VALUE_{extra_count}"] = target
    ensure_git_runtime_paths(effective)
    return effective


def ensure_git_runtime_paths(env: dict[str, str]) -> None:
    home = env.get("HOME")
    xdg_config_home = env.get("XDG_CONFIG_HOME")
    if home:
        Path(home).mkdir(parents=True, exist_ok=True)
    if xdg_config_home:
        Path(xdg_config_home).mkdir(parents=True, exist_ok=True)


def git_auth_env(token: str | None) -> dict[str, str]:
    env = git_base_env()
    ensure_git_runtime_paths(env)
    if not token:
        return env
    basic = base64.b64encode(f"x-access-token:{token}".encode("utf-8")).decode("ascii")
    env.update({
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
        "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {basic}",
    })
    return env


def git_safe_directory(root_path: str, target: Path) -> dict:
    env = git_base_env()
    ensure_git_runtime_paths(env)
    return guarded_command_with_env(
        root_path,
        ["git", "config", "--global", "--add", "safe.directory", str(target.resolve())],
        env=env,
    )


def git_command_with_safe_directory(root_path: str, target: Path, command: list[str], env: dict[str, str] | None = None) -> dict:
    result = guarded_command_with_env(root_path, command, env=env)
    text = f"{result.get('stderr') or ''}\n{result.get('stdout') or ''}".lower()
    if result.get("returncode") == 128 and "dubious ownership" in text:
        safe = git_safe_directory(root_path, target)
        retry = guarded_command_with_env(root_path, command, env=env) if safe.get("returncode") == 0 else {
            "returncode": 1,
            "stderr": "Skipped because safe.directory repair failed",
            "safeDirectory": safe,
        }
        retry["safeDirectory"] = safe
        return retry
    return result


def deployment_cwd(root_path: str) -> str:
    return str(Path(root_path).resolve())


def nginx_config_name(deployment_id: str, server_name: str) -> str:
    primary = server_name.split()[0] if server_name else deployment_id
    safe_name = re.sub(r"[^a-zA-Z0-9_.-]+", "-", primary).strip("-") or deployment_id
    return f"domain-{safe_name}"


def guarded_deployment_command(root_path: str, command: str, env: dict[str, str] | None = None) -> dict:
    info = path_info(root_path)
    try:
        parsed = parse_deployment_command(command)
    except ValueError as error:
        return blocked_command(str(error), [command], info)
    effective_env = dict(env or {})
    if parsed and parsed[0] == "composer":
        effective_env = composer_git_env(root_path, effective_env)
    return guarded_command_with_env(root_path, parsed, cwd=deployment_cwd(root_path), env=effective_env or None)


def pm2_env(port: int | None) -> dict[str, str]:
    env = {}
    if port:
        env["PORT"] = str(port)
    return env


def pm2_processes(root_path: str) -> dict:
    return guarded_command(root_path, ["pm2", "jlist"], cwd=deployment_cwd(root_path))


def pm2_process_state(jlist: dict, name: str) -> str | None:
    try:
        processes = json.loads(jlist.get("stdout") or "[]")
    except json.JSONDecodeError:
        return None
    for process in processes:
        if process.get("name") == name:
            return process.get("pm2_env", {}).get("status")
    return None


def summarize_pm2_processes(jlist: dict, name: str) -> dict:
    try:
        processes = json.loads(jlist.get("stdout") or "[]")
    except json.JSONDecodeError:
        return jlist
    matches = []
    for process in processes:
        if process.get("name") != name:
            continue
        pm2_env = process.get("pm2_env", {})
        matches.append({
            "name": process.get("name"),
            "pid": process.get("pid"),
            "pm_id": process.get("pm_id"),
            "status": pm2_env.get("status"),
            "cwd": pm2_env.get("pm_cwd") or pm2_env.get("cwd"),
            "args": pm2_env.get("args"),
            "restarts": pm2_env.get("restart_time", 0),
            "outLog": pm2_env.get("pm_out_log_path"),
            "errorLog": pm2_env.get("pm_err_log_path"),
        })
    return {
        **jlist,
        "stdout": json.dumps(matches, separators=(",", ":")),
    }


def safe_log_dir(name: str, log_dir: str | None = None) -> Path:
    root = Path(settings.deployment_log_root).resolve()
    if log_dir:
        target = Path(log_dir).resolve()
    else:
        safe_name = re.sub(r"[^a-zA-Z0-9_.-]+", "-", name).strip("-") or "deployment"
        target = (root / safe_name).resolve()
    if target != root and root not in target.parents:
        raise ValueError("Deployment log directory escapes configured log root")
    return target


def prune_project_logs(log_dir: Path) -> None:
    cutoff = time.time() - 86400
    if not log_dir.exists():
        return
    for file_path in log_dir.iterdir():
        if file_path.is_file() and file_path.stat().st_mtime < cutoff:
            file_path.unlink(missing_ok=True)


def reset_runtime_logs(log_dir: Path) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    prune_project_logs(log_dir)
    for filename in ("running-out.log", "running-error.log"):
        file_path = log_dir / filename
        file_path.write_text("", encoding="utf-8")
        file_path.chmod(0o664)
    make_panel_owned(log_dir)


def make_panel_owned(path: Path) -> None:
    paths = [path]
    if path.is_dir():
        paths.extend(path.rglob("*"))
    for item in paths:
        try:
            shutil.chown(item, user="panel", group="panel")
        except (LookupError, OSError):
            continue
        try:
            if item.is_dir():
                item.chmod(0o775)
            elif item.suffix in {".sh", ""} and item.name == "run.sh":
                item.chmod(0o755)
            else:
                item.chmod(0o664)
        except OSError:
            continue


def combine_pm2_results(root_path: str, steps: dict[str, dict], required: list[str]) -> dict:
    info = path_info(root_path)
    failed = [
        name for name in required
        if steps.get(name, {}).get("returncode", 0) != 0 or steps.get(name, {}).get("blocked")
    ]
    blocked = next((steps[name].get("reason") for name in required if steps.get(name, {}).get("blocked")), None)
    return {
        "dryRun": any(step.get("dryRun") for step in steps.values()),
        "blocked": any(step.get("blocked") for step in steps.values()),
        "liveCommandsDisabled": any(step.get("liveCommandsDisabled") for step in steps.values()),
        "reason": blocked,
        "command": ["pm2", "managed-lifecycle"],
        "cwd": deployment_cwd(root_path),
        "stdout": "",
        "stderr": "; ".join(f"{name}: {steps[name].get('stderr') or steps[name].get('reason') or 'failed'}" for name in failed),
        "returncode": 1 if failed else 0,
        "path": info,
        **steps,
    }


def supervisor_program_config(body: ProcessRequest, wrapper_path: Path, log_dir: Path) -> str:
    cwd = deployment_cwd(body.rootPath)
    lines = [
        f"[program:{body.name}]",
        f"directory={cwd}",
        f"command={wrapper_path}",
        "user=panel",
        "autostart=true",
        "autorestart=true",
        "startsecs=3",
        "startretries=3",
        "stopasgroup=true",
        "killasgroup=true",
        f"stdout_logfile={log_dir / 'running-out.log'}",
        f"stderr_logfile={log_dir / 'running-error.log'}",
        "redirect_stderr=false",
    ]
    return "\n".join(lines) + "\n"


def supervisor_start(body: ProcessRequest, start_command: list[str]) -> dict:
    info = path_info(body.rootPath)
    try:
        log_dir = safe_log_dir(body.name, body.logDir)
    except ValueError as error:
        return blocked_command(str(error), ["supervisorctl", "start", body.name], info)

    config_dir = supervisor_config_dir()
    config_path = supervisor_program_path(body.name)
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", ["supervisorctl", "start", body.name], info)

    if is_laravel_artisan_command(start_command):
        ensure = _ensure_laravel_env(body.rootPath, body.port, body.env)
        if ensure.get("returncode") != 0:
            return ensure
        writable = repair_laravel_writable_paths(LaravelWritablePathsRequest(rootPath=body.rootPath))
        if writable.get("returncode") != 0:
            return writable

    reset_runtime_logs(log_dir)
    config_dir.mkdir(parents=True, exist_ok=True)
    service = ensure_supervisord_running()
    write = {
        "dryRun": False,
        "command": ["write-file", str(config_path)],
        "cwd": None,
        "stdout": "",
        "stderr": "",
        "returncode": 0,
    }
    wrapper_path: Path | None = None
    try:
        wrapper_path, runtime_env_path, laravel_env_path = prepare_supervisor_runtime(
            body.rootPath,
            start_command,
            body.port,
            body.env,
        )
        make_panel_owned(wrapper_path.parent)
        remove_stale_supervisor_program_configs(body.name, config_path)
        config_path.write_text(supervisor_program_config(body, wrapper_path, log_dir), encoding="utf-8")
        write["stdout"] = f"runtimeEnv={runtime_env_path}"
        if laravel_env_path is not None:
            write["stdout"] += f", laravelEnv={laravel_env_path}"
    except (OSError, ValueError) as error:
        write["stderr"] = str(error)
        write["returncode"] = 1

    if write["returncode"] == 0 and not service.get("running"):
        write["returncode"] = 1
        write["stderr"] = "supervisord is not running and could not be started"

    reread = run_supervisorctl("reread") if write["returncode"] == 0 else {"returncode": 1, "stderr": "Skipped because config write failed"}
    update = run_supervisorctl("update") if reread.get("returncode") == 0 else {"returncode": 1, "stderr": "Skipped because reread failed"}
    stop = run_supervisorctl("stop", body.name) if update.get("returncode") == 0 else {"returncode": 1, "stderr": "Skipped because update failed"}
    if "no such process" in (stop.get("stderr") or "").lower() or "not running" in (stop.get("stderr") or "").lower():
        stop["returncode"] = 0
    start = run_supervisorctl("start", body.name) if stop.get("returncode") == 0 else {"returncode": 1, "stderr": "Skipped because stop failed"}
    status = run_supervisorctl("status", body.name) if start.get("returncode") == 0 else {"returncode": 1, "stderr": "Skipped because start failed"}
    post_status = run_supervisorctl("status", body.name) if start.get("returncode") != 0 else status
    logs = runtime_logs(RuntimeLogsRequest(name=body.name, logDir=body.logDir, lines=120))
    steps = {"service": service, "write": write, "reread": reread, "update": update, "stop": stop, "start": start, "status": status}
    failed = [name for name, step in steps.items() if step.get("returncode", 0) != 0]
    return {
        "dryRun": any(step.get("dryRun") for step in steps.values() if isinstance(step, dict)),
        "blocked": any(step.get("blocked") for step in steps.values() if isinstance(step, dict)),
        "liveCommandsDisabled": any(step.get("liveCommandsDisabled") for step in steps.values() if isinstance(step, dict)),
        "command": supervisorctl_command("start", body.name),
        "cwd": deployment_cwd(body.rootPath),
        "stdout": status.get("stdout") or "",
        "stderr": "; ".join(f"{name}: {format_supervisor_step_error(steps[name])}" for name in failed),
        "returncode": 1 if failed else 0,
        "path": info,
        "configPath": str(config_path),
        "wrapperPath": str(wrapper_path) if wrapper_path else None,
        "postStatus": post_status,
        "logs": logs,
        **steps,
    }


def pm2_start(body: ProcessRequest, start_command: list[str]) -> dict:
    cwd = deployment_cwd(body.rootPath)
    try:
        log_dir = safe_log_dir(body.name, body.logDir)
    except ValueError as error:
        return blocked_command(str(error), ["pm2", "start", body.name], path_info(body.rootPath))

    if is_laravel_artisan_command(start_command):
        ensure = _ensure_laravel_env(body.rootPath, body.port, body.env)
        if ensure.get("returncode") != 0:
            return ensure

    reset_runtime_logs(log_dir)
    delete = guarded_command(body.rootPath, ["pm2", "delete", body.name], cwd=cwd)
    if "not found" in (delete.get("stderr") or "").lower() or "not found" in (delete.get("stdout") or "").lower():
        delete["returncode"] = 0

    command = [
        "pm2",
        "start",
        start_command[0],
        "--name",
        body.name,
        "--cwd",
        cwd,
        "--update-env",
        "--output",
        str(log_dir / "running-out.log"),
        "--error",
        str(log_dir / "running-error.log"),
        "--merge-logs",
        # 3 s between crash-restarts so port is released before PM2 retries, preventing
        # a tight loop that exhausts the restart counter and leaves the app permanently down.
        "--restart-delay",
        "3000",
        "--",
        *start_command[1:],
    ]
    # Merge: default PM2 host/port vars first, then user-defined env vars (user wins on conflict).
    process_env = {**pm2_env(body.port), **(body.env or {})}
    start = guarded_command_with_env(body.rootPath, command, cwd=cwd, env=process_env)
    save = guarded_command(body.rootPath, ["pm2", "save"], cwd=cwd) if start.get("returncode") == 0 else {
        "dryRun": start.get("dryRun", False),
        "command": ["pm2", "save"],
        "cwd": cwd,
        "stdout": "",
        "stderr": "Skipped because pm2 start failed",
        "returncode": 1,
    }
    jlist = pm2_processes(body.rootPath) if start.get("returncode") == 0 else {
        "dryRun": start.get("dryRun", False),
        "command": ["pm2", "jlist"],
        "cwd": cwd,
        "stdout": "[]",
        "stderr": "Skipped because pm2 start failed",
        "returncode": 1,
    }
    status = pm2_process_state(jlist, body.name)
    jlist = summarize_pm2_processes(jlist, body.name)
    verify = {
        "dryRun": jlist.get("dryRun", False),
        "command": ["pm2", "verify-online", body.name],
        "cwd": cwd,
        "stdout": status or "",
        "stderr": "" if status == "online" or jlist.get("dryRun") else f"PM2 process {body.name} is {status or 'missing'}",
        "returncode": 0 if status == "online" or jlist.get("dryRun") else 1,
    }
    return combine_pm2_results(body.rootPath, {"delete": delete, "start": start, "save": save, "jlist": jlist, "verify": verify}, ["delete", "start", "save", "jlist", "verify"])


def pm2_stop(body: ProcessRequest) -> dict:
    cwd = deployment_cwd(body.rootPath)
    stop = guarded_command(body.rootPath, ["pm2", "stop", body.name], cwd=cwd)
    if "not found" in (stop.get("stderr") or "").lower() or "not found" in (stop.get("stdout") or "").lower():
        stop["returncode"] = 0
    save = guarded_command(body.rootPath, ["pm2", "save"], cwd=cwd) if stop.get("returncode") == 0 else {
        "dryRun": stop.get("dryRun", False),
        "command": ["pm2", "save"],
        "cwd": cwd,
        "stdout": "",
        "stderr": "Skipped because pm2 stop failed",
        "returncode": 1,
    }
    return combine_pm2_results(body.rootPath, {"stop": stop, "save": save}, ["stop", "save"])


@router.post("/runtime-logs")
def runtime_logs(body: RuntimeLogsRequest) -> dict:
    try:
        log_dir = safe_log_dir(body.name, body.logDir)
    except ValueError as error:
        return {"ok": False, "error": str(error), "stdout": "", "stderr": "", "text": str(error)}
    prune_project_logs(log_dir)

    def tail(path: Path) -> str:
        if not path.exists():
            return ""
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join(lines[-body.lines:])

    stdout = tail(log_dir / "running-out.log")
    stderr = tail(log_dir / "running-error.log")
    laravel = ""
    if body.rootPath:
        root = Path(body.rootPath).resolve()
        info = path_info(str(root))
        if info["allowed"]:
            laravel = tail(root / "storage" / "logs" / "laravel.log")
    text = "\n".join([
        f"== STDOUT ({log_dir / 'running-out.log'}) ==",
        stdout or "(empty)",
        "",
        f"== STDERR ({log_dir / 'running-error.log'}) ==",
        stderr or "(empty)",
        "",
        f"== LARAVEL ({Path(body.rootPath).resolve() / 'storage' / 'logs' / 'laravel.log' if body.rootPath else 'not requested'}) ==",
        laravel or "(empty)",
    ])
    return {"ok": True, "logDir": str(log_dir), "stdout": stdout, "stderr": stderr, "laravel": laravel, "text": text}


def guarded_write_file(root_path: str, target_path: str, content: str) -> dict:
    info = path_info(root_path)
    command = ["write-file", target_path]
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", command, info)
    Path(target_path).write_text(content, encoding="utf-8")
    result = {
        "dryRun": False,
        "command": command,
        "stdout": "",
        "stderr": "",
        "returncode": 0,
    }
    result["path"] = info
    return result


@router.post("/git-sync")
def git_sync(body: GitSyncRequest) -> dict:
    target = Path(body.rootPath)
    env = git_auth_env(body.gitToken)
    safe = git_safe_directory(body.rootPath, target)
    if target.joinpath(".git").exists():
        remote = git_command_with_safe_directory(body.rootPath, target, ["git", "-C", str(target), "remote", "set-url", "origin", body.gitUrl], env=env) if body.gitUrl else None
        fetch = git_command_with_safe_directory(body.rootPath, target, ["git", "-C", str(target), "fetch", "origin", body.branch, "--prune"], env=env)
        checkout = git_command_with_safe_directory(body.rootPath, target, ["git", "-C", str(target), "checkout", body.commitSha or body.branch], env=env)
        pull = None if body.commitSha else git_command_with_safe_directory(body.rootPath, target, ["git", "-C", str(target), "pull", "--ff-only", "origin", body.branch], env=env)
        return {"safeDirectory": safe, "remote": remote, "sync": fetch, "checkout": checkout, "pull": pull}
    if body.gitUrl:
        command = ["git", "clone", "--branch", body.branch, body.gitUrl, str(target)]
    else:
        command = ["git", "-C", str(target), "fetch", "--all", "--prune"]
    result = git_command_with_safe_directory(body.rootPath, target, command, env=env)
    checkout = None
    if body.commitSha:
        checkout = git_command_with_safe_directory(body.rootPath, target, ["git", "-C", str(target), "checkout", body.commitSha], env=env)
    elif not body.gitUrl:
        checkout = git_command_with_safe_directory(body.rootPath, target, ["git", "-C", str(target), "checkout", body.branch], env=env)
    return {"safeDirectory": safe, "sync": result, "checkout": checkout}


@router.post("/install")
def install(body: CommandRequest) -> dict:
    command = body.command or {
        "NPM": "npm install",
        "PNPM": "pnpm install",
        "YARN": "yarn install",
        "COMPOSER": "composer install --no-dev --optimize-autoloader --no-interaction --no-scripts",
        "PIP": "pip3 install -r requirements.txt",
        "UV": "uv sync",
        "GO": "go mod download",
        "NONE": "true",
    }.get((body.packageManager or "NONE").upper(), "true")
    env = dict(body.env or {})
    if (body.packageManager or "").upper() == "COMPOSER":
        env.setdefault("COMPOSER_ALLOW_SUPERUSER", "1")
    return guarded_deployment_command(body.rootPath, command, env=env or None)


@router.post("/build")
def build(body: CommandRequest) -> dict:
    command = body.command or "true"
    return guarded_deployment_command(body.rootPath, command, env=body.env)


@router.post("/migrate")
def migrate(body: CommandRequest) -> dict:
    command = body.command or "true"
    return guarded_deployment_command(body.rootPath, command, env=body.env)


@router.post("/process")
def process(body: ProcessRequest) -> dict:
    body = normalize_process_root(body)
    manager = (body.processManager or "NONE").upper()
    if manager == "PM2":
        if body.action in {"start", "restart"}:
            try:
                start_command = parse_deployment_command(
                    normalize_laravel_start_command(body.startCommand, body.port) or "npm run start"
                )
            except ValueError as error:
                return blocked_command(str(error), [body.startCommand or "npm run start"], path_info(body.rootPath))
            return pm2_start(body, start_command)
        elif body.action == "stop":
            return pm2_stop(body)
        else:
            command = ["pm2", body.action, body.name]
    elif manager == "SUPERVISOR":
        if body.action in {"start", "restart"}:
            try:
                start_command = parse_deployment_command(
                    normalize_laravel_start_command(body.startCommand, body.port) or "true"
                )
            except ValueError as error:
                return blocked_command(str(error), [body.startCommand or "true"], path_info(body.rootPath))
            return supervisor_start(body, start_command)
        command = ["supervisorctl", body.action, body.name]
    elif manager == "SYSTEMD":
        command = ["systemctl", body.action, body.name]
    else:
        return guarded_deployment_command(body.rootPath, body.startCommand or "true")
    return guarded_command(body.rootPath, command)


def _nginx_scan_dirs() -> list[str]:
    scan_dirs = [nginx_sites_enabled()]
    conf_d = Path("/etc/nginx/conf.d")
    if conf_d.is_dir():
        scan_dirs.append(str(conf_d))
    available_dir = Path(nginx_sites_available())
    if available_dir.is_dir():
        scan_dirs.append(str(available_dir))
    return scan_dirs


def _scrub_hostname_nginx_configs(config_name: str, server_name: str) -> dict:
    scan_dirs = _nginx_scan_dirs()
    return {
        "removedConflicts": remove_conflicting_configs(config_name, server_name, *scan_dirs),
        "removedInsecurePort443": remove_insecure_port443_configs(config_name, server_name, *scan_dirs),
    }


@router.post("/nginx")
def nginx(body: NginxRequest) -> dict:
    try:
        if not body.serverName:
            return {
                "skipped": True,
                "reason": "No domain/serverName linked to deployment",
                "serverName": None,
            }

        server_name = body.serverName
        config_name = nginx_config_name(body.deploymentId, server_name)
        scrubbed = _scrub_hostname_nginx_configs(config_name, server_name) if settings.allow_live_nginx else {"removedConflicts": [], "removedInsecurePort443": []}
        public_root = resolve_laravel_public_root(body.rootPath, body.publicDirectory)
        fallback_root = safe_web_root(body.fallbackRootPath) if body.fallbackRootPath else None
        ssl_certificate = safe_letsencrypt_path(body.sslCertificate) if body.sslCertificate else None
        ssl_certificate_key = safe_letsencrypt_path(body.sslCertificateKey) if body.sslCertificateKey else None
        has_ssl = (
            ssl_certificate is not None
            and ssl_certificate_key is not None
            and letsencrypt_certificate_exists(server_name.split()[0])
        )

        if has_ssl and settings.allow_live_nginx and (not ssl_certificate.exists() or not ssl_certificate_key.exists()):
            if body.requireSsl:
                return blocked_command("SSL certificate files do not exist yet", ["write-nginx", config_name], path_info(body.rootPath))
            has_ssl = False

        fallback_location = ""
        fallback_error_page = ""
        if fallback_root:
            fallback_error_page = "        proxy_intercept_errors on;\n        error_page 502 503 504 = @public_fallback;\n"
            fallback_location = (
                "\n"
                "    location @public_fallback {\n"
                f"        root {fallback_root};\n"
                "        try_files $uri $uri/ /index.html =404;\n"
                "    }\n"
            )

        app_locations = nginx_app_locations(
            framework=body.framework,
            public_root=public_root,
            upstream_port=body.upstreamPort,
            fallback_error_page=fallback_error_page,
            fallback_location=fallback_location,
            loopback_proxy_host=body.loopbackProxyHost,
        )
        if body.forceSsl and has_ssl:
            http_location = (
                f"{acme_location(server_name, public_root)}"
                "    location / {\n"
                "        return 301 https://$host$request_uri;\n"
                "    }\n"
            )
        else:
            http_location = f"{acme_location(server_name, public_root)}{app_locations}"

        config = f"""
server {{
    listen 80;
    server_name {server_name};

{http_location}}}
""".lstrip()
        if has_ssl:
            config += f"""

server {{
    listen 443 ssl http2;
    server_name {server_name};
    ssl_certificate {ssl_certificate};
    ssl_certificate_key {ssl_certificate_key};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

{acme_location(server_name, public_root)}{app_locations}
}}
"""
        info = path_info(body.rootPath)
        if not info["allowed"] and settings.allow_live_nginx:
            return blocked_command("Path escapes configured file manager root", ["write-nginx", config_name], info)
        result = publish_nginx_config(
            config_name,
            config,
            nginx_sites_available(),
            nginx_sites_enabled(),
            server_name=server_name,
        )
        return {
            **result,
            "path": info,
            "serverName": server_name,
            "scrubbed": scrubbed,
        }
    except HTTPException:
        raise
    except Exception as error:
        return blocked_command(f"Nginx deployment vhost failed: {error}", ["write-nginx", body.serverName or body.deploymentId], path_info(body.rootPath))


@router.post("/public-access-diagnose")
def public_access_diagnose(body: PublicRouteRequest) -> dict:
    primary = body.serverName.split()[0].strip()
    tokens = server_name_tokens(body.serverName)
    claiming: list[dict] = []
    for scan_dir in _nginx_scan_dirs():
        enabled_dir = Path(scan_dir)
        if not enabled_dir.is_dir():
            continue
        for conf_path in enabled_dir.iterdir():
            try:
                target = conf_path.resolve() if conf_path.is_symlink() else conf_path
                if not any(_config_has_server_name(target, token) for token in tokens):
                    continue
                claiming.append({
                    "file": conf_path.name,
                    "path": str(conf_path),
                    "insecurePort443": _config_has_insecure_port443(target),
                })
            except OSError:
                continue
    cert_exists = letsencrypt_certificate_exists(primary)
    port443 = run_command(["ss", "-ltnp"], allow_live=DEPLOYMENT_COMMANDS_LIVE)
    http_probe = _curl_public_route(body.serverName, body.path, body.rootPath, body.framework, require_https=False)
    https_probe = _curl_public_route(body.serverName, body.path, body.rootPath, body.framework, require_https=True)
    return {
        "domain": primary,
        "certificateExists": cert_exists,
        "claimingConfigs": claiming,
        "port443Listeners": port443.get("stdout", ""),
        "httpProbe": http_probe,
        "httpsProbe": https_probe,
    }


@router.post("/public-access-repair")
def public_access_repair(body: NginxRequest) -> dict:
    if not body.serverName:
        return {"skipped": True, "reason": "No serverName provided"}
    config_name = nginx_config_name(body.deploymentId, body.serverName)
    scrubbed = _scrub_hostname_nginx_configs(config_name, body.serverName)
    primary = body.serverName.split()[0].strip()
    has_cert = letsencrypt_certificate_exists(primary)
    repaired = nginx(body.model_copy(update={"forceSsl": has_cert and body.forceSsl}))
    return {
        **repaired,
        "scrubbed": scrubbed,
        "certificateExists": has_cert,
    }


def _curl_once(url: str, *, accept_http_errors: bool = False) -> dict:
    return curl_health_probe(url, accept_http_errors=accept_http_errors)


def _tail_text(path: Path, lines: int = 25) -> str:
    if not path.exists():
        return ""
    all_lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    if not all_lines:
        return ""
    return "\n".join(all_lines[-lines:])


def _nginx_forbidden_response(stdout: str) -> bool:
    lower = stdout.lower()
    return "403 forbidden" in lower and "nginx" in lower


def attach_laravel_diagnostics(result: dict, root_path: str | None, framework: str | None = None) -> dict:
    if (framework or "").upper() != "LARAVEL" or not root_path:
        return result
    root = Path(root_path).resolve()
    info = path_info(str(root))
    if not info["allowed"]:
        return result
    laravel_log = root / "storage" / "logs" / "laravel.log"
    response_body = (result.get("stdout") or "").strip()
    nginx_forbidden = _nginx_forbidden_response(response_body)
    tail_text = "" if nginx_forbidden else _tail_text(laravel_log)
    if len(response_body) > 1200:
        response_body = response_body[:1200] + "\n…"
    extras: list[str] = []
    if response_body:
        extras.append(f"HTTP response body:\n{response_body}")
    if nginx_forbidden:
        if (framework or "").upper() in {"NODEJS", "NEXTJS", "STATIC"}:
            extras.append(
                "Nginx returned 403 before the request reached the app process (wrong static root or vhost). "
                "Redeploy to refresh the proxy vhost."
            )
        else:
            extras.append(
                "Nginx returned 403 before the request reached Laravel (static root / try_files). "
                "Redeploy to refresh the vhost."
            )
    if tail_text:
        result["laravelLogPath"] = str(laravel_log)
        result["laravelLogTail"] = tail_text
        extras.append(f"Laravel log tail ({laravel_log}):\n{tail_text}")
    if not extras:
        return result
    suffix = "\n\n" + "\n\n".join(extras)
    result["stderr"] = f"{result.get('stderr') or ''}{suffix}".strip()
    return result


def _server_primary_ip() -> str | None:
    result = run_command(["hostname", "-I"], allow_live=DEPLOYMENT_COMMANDS_LIVE)
    if result.get("returncode") != 0:
        return None
    for token in (result.get("stdout") or "").split():
        if token and not token.startswith("127."):
            return token
    return None


def _curl_public_route(server_name: str, path: str = "/", root_path: str | None = None, framework: str | None = None, require_https: bool = False) -> dict:
    primary = server_name.split()[0].strip()
    clean_path = path if path.startswith("/") else f"/{path}"
    is_laravel = (framework or "").upper() == "LARAVEL"
    use_https = require_https and letsencrypt_certificate_exists(primary)

    def probe(url: str, *, accept_http_errors: bool, loopback: bool, insecure_tls: bool = False) -> dict:
        command = [
            "curl",
            "-sS",
            "-H", "Accept-Language: en-US,en;q=0.9,bn;q=0.8",
            "-H", "User-Agent: VPS-Panel-Healthcheck/1.0",
            "-H", f"Host: {primary}",
            "-H", f"X-Forwarded-Host: {primary}",
            "-H", "X-Forwarded-Proto: https",
            "--retry", "5",
            "--retry-delay", "2",
            "--retry-connrefused",
            "--connect-timeout", "5",
            "--max-time", "30",
            "-w", "\n__http_code=%{http_code}\n__effective_url=%{url_effective}",
            url,
        ]
        if insecure_tls:
            command[1:1] = ["-k"]
        if loopback:
            command[1:1] = [
                "--resolve", f"{primary}:80:127.0.0.1",
                "--resolve", f"{primary}:443:127.0.0.1",
            ]
        raw = run_command(command, allow_live=DEPLOYMENT_COMMANDS_LIVE)
        stdout = raw.get("stdout") or ""
        http_code = 0
        effective_url = ""
        if "__http_code=" in stdout:
            body, _, trailer = stdout.partition("\n__http_code=")
            code_part, _, effective_part = trailer.partition("\n__effective_url=")
            try:
                http_code = int(code_part.strip())
            except ValueError:
                http_code = 0
            effective_url = effective_part.strip()
            raw["stdout"] = body
        raw["httpCode"] = http_code
        raw["effectiveUrl"] = effective_url
        raw["probeMode"] = "loopback" if loopback else "dns"
        if raw.get("returncode") != 0:
            return raw
        if http_code >= 400 and accept_http_errors:
            raw["degraded"] = True
            raw["returncode"] = 0
            raw["stderr"] = f"HTTP {http_code} from {url}"
        elif http_code >= 400:
            raw["returncode"] = 22
            raw["stderr"] = f"HTTP {http_code} from {url}"
        return raw

    scheme = "https" if use_https else "http"
    result = probe(f"{scheme}://{primary}{clean_path}", accept_http_errors=is_laravel, loopback=True)

    # curl 35: SSL handshake failed (e.g. HTTP on 443 or broken cert paths in nginx).
    if use_https and result.get("returncode") == 35:
        http_result = probe(f"http://{primary}{clean_path}", accept_http_errors=is_laravel, loopback=True)
        if http_result.get("returncode") == 0:
            http_result["degraded"] = True
            http_result["stderr"] = (
                "HTTPS handshake failed (invalid SSL response on port 443). "
                f"HTTP probe succeeded at http://{primary}{clean_path}. Redeploy to refresh nginx SSL or issue a certificate."
            )
            return attach_laravel_diagnostics(http_result, root_path, framework)
        result = http_result

    if use_https and result.get("returncode") == 7:
        http_result = probe(f"http://{primary}{clean_path}", accept_http_errors=is_laravel, loopback=True)
        if http_result.get("returncode") == 0:
            http_result["degraded"] = True
            http_result["stderr"] = (
                "HTTPS is not listening on port 443 (SSL certificate missing or nginx not configured). "
                f"HTTP probe succeeded at http://{primary}{clean_path}. Redeploy or issue SSL from the panel."
            )
            return attach_laravel_diagnostics(http_result, root_path, framework)
        result = http_result

    if result.get("httpCode") in {301, 302, 307, 308} and result.get("effectiveUrl", "").startswith("https://"):
        result = probe(result["effectiveUrl"], accept_http_errors=is_laravel, loopback=True)

    effective_url = result.get("effectiveUrl") or ""
    if effective_url and re.search(r"https?://(localhost|127\.0\.0\.1)(:\d+)?(/|$)", effective_url):
        result["returncode"] = 1
        result["stderr"] = (
            f"Public route resolved to internal URL {effective_url}. "
            "The app is generating localhost redirects; redeploy after clearing HOST/HOSTNAME env or set the app public URL to the domain."
        )
    if result.get("returncode") != 0 or result.get("degraded"):
        return attach_laravel_diagnostics(result, root_path, framework)

    if use_https and result.get("returncode") == 0:
        dns_probe = probe(f"https://{primary}{clean_path}", accept_http_errors=is_laravel, loopback=False)
        server_ip = _server_primary_ip()
        ip_probe = None
        if server_ip:
            ip_probe = probe(
                f"https://{server_ip}{clean_path}",
                accept_http_errors=is_laravel,
                loopback=False,
                insecure_tls=True,
            )
        result["loopbackProbe"] = {"httpCode": result.get("httpCode"), "returncode": result.get("returncode")}
        result["dnsProbe"] = {
            "httpCode": dns_probe.get("httpCode"),
            "returncode": dns_probe.get("returncode"),
            "stderr": dns_probe.get("stderr"),
        }
        if server_ip:
            result["serverIpProbe"] = {
                "serverIp": server_ip,
                "httpCode": ip_probe.get("httpCode") if ip_probe else None,
                "returncode": ip_probe.get("returncode") if ip_probe else None,
                "stderr": ip_probe.get("stderr") if ip_probe else None,
            }
        dns_failed_ssl = dns_probe.get("returncode") == 35
        ip_failed_ssl = bool(ip_probe and ip_probe.get("returncode") == 35)
        if dns_failed_ssl or ip_failed_ssl:
            result["degraded"] = True
            result["returncode"] = 0
            hints = [
                "Local nginx HTTPS on 127.0.0.1:443 works, but the public internet path does not.",
                "Point DNS A record for this hostname to this VPS IP"
                + (f" ({server_ip})" if server_ip else "")
                + ", set Cloudflare to DNS only (grey cloud) or SSL Full, and disable browser VPN while testing.",
            ]
            if dns_failed_ssl and not ip_failed_ssl and server_ip:
                hints.append(
                    f"DNS may not point to this server yet (public DNS SSL failed; direct VPS IP probe returncode={ip_probe.get('returncode')})."
                )
            elif ip_failed_ssl:
                hints.append(
                    "Port 443 on this server's public IP is not serving valid TLS (another service may own 443, or nginx is not listening on the public interface)."
                )
            result["stderr"] = " ".join(hints)
            return attach_laravel_diagnostics(result, root_path, framework)
        if dns_probe.get("returncode") not in {0, None} and dns_probe.get("httpCode", 0) >= 400:
            result["degraded"] = True
            result["stderr"] = (
                f"Public DNS HTTPS check returned HTTP {dns_probe.get('httpCode')} "
                f"(local loopback check was {result.get('httpCode')})."
            )

    return result


def _pm2_restart_count(process_name: str) -> int | None:
    """Return the PM2 restart count for process_name, or None if not found / error."""
    proc = _pm2_process(process_name)
    if proc is None:
        return None
    try:
        return int(proc.get("pm2_env", {}).get("restart_time", 0))
    except (ValueError, AttributeError):
        return None


def _pm2_process(process_name: str) -> dict | None:
    result = run_command(["pm2", "jlist"], allow_live=DEPLOYMENT_COMMANDS_LIVE)
    if result.get("returncode") != 0:
        return None
    try:
        processes = json.loads(result.get("stdout") or "[]")
        for proc in processes:
            if proc.get("name") == process_name:
                return proc
    except (json.JSONDecodeError, AttributeError):
        pass
    return None


def _pm2_process_port(proc: dict) -> str | None:
    pm2_env = proc.get("pm2_env", {})
    env_port = (pm2_env.get("env") or {}).get("PORT") or pm2_env.get("PORT")
    if env_port is not None:
        return str(env_port)
    args = pm2_env.get("args") or []
    if not isinstance(args, list):
        return None
    for index, arg in enumerate(args):
        if arg in {"-p", "--port"} and index + 1 < len(args):
            return str(args[index + 1])
        if isinstance(arg, str) and arg.startswith("--port="):
            return arg.split("=", 1)[1]
    return None


def _pm2_owner_for_port(port: int) -> dict | None:
    result = run_command(["pm2", "jlist"], allow_live=DEPLOYMENT_COMMANDS_LIVE)
    if result.get("returncode") != 0:
        return None
    try:
        processes = json.loads(result.get("stdout") or "[]")
    except (json.JSONDecodeError, AttributeError):
        return None
    for proc in processes:
        if _pm2_process_port(proc) == str(port):
            pm2_env = proc.get("pm2_env", {})
            return {
                "name": proc.get("name"),
                "pid": proc.get("pid"),
                "pm_id": proc.get("pm_id"),
                "status": pm2_env.get("status"),
                "cwd": pm2_env.get("pm_cwd") or (pm2_env.get("env") or {}).get("PWD"),
                "port": port,
            }
    return None


def _pm2_process_mismatch(body: HealthRequest) -> str | None:
    if not body.processName or (body.processManager or "").upper() != "PM2":
        return None
    proc = _pm2_process(body.processName)
    if proc is None:
        return f"PM2 process '{body.processName}' was not found after start."

    pm2_env = proc.get("pm2_env", {})
    status = pm2_env.get("status")
    if status and status != "online":
        return f"PM2 process '{body.processName}' is {status}, not online."

    env_port = (pm2_env.get("env") or {}).get("PORT") or pm2_env.get("PORT")
    if env_port is not None and str(env_port) != str(body.port):
        return f"PM2 process '{body.processName}' is bound to PORT={env_port}, expected {body.port}."

    if body.rootPath:
        expected = str(Path(body.rootPath).resolve())
        actual_raw = pm2_env.get("pm_cwd") or (pm2_env.get("env") or {}).get("PWD")
        if actual_raw and str(Path(str(actual_raw)).resolve()) != expected:
            return f"PM2 process '{body.processName}' cwd is {actual_raw}, expected {expected}."

    return None


def _supervisor_process_mismatch(body: HealthRequest) -> str | None:
    if not body.processName or (body.processManager or "").upper() != "SUPERVISOR":
        return None
    result = run_supervisorctl("status", body.processName)
    if result.get("dryRun"):
        return None
    if result.get("returncode") != 0:
        return result.get("stderr") or result.get("stdout") or f"Supervisor process '{body.processName}' was not found."
    stdout = result.get("stdout") or ""
    if "RUNNING" not in stdout:
        return f"Supervisor process '{body.processName}' is not RUNNING: {stdout.strip()}"
    return None


@router.post("/runtime-tools")
def runtime_tools(body: RuntimeToolsRequest) -> dict:
    names = []
    for tool in body.tools:
        cleaned = re.sub(r"[^a-zA-Z0-9_.+-]+", "", tool).strip()
        if cleaned and cleaned not in names:
            names.append(cleaned)
    items = []
    for name in names:
        items.append(inspect_runtime_tool(name))
    return {"items": items}


def _run_probe(command: list[str], timeout: int = 15) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None


def _php_modules() -> set[str]:
    result = _run_probe(["php", "-m"])
    if not result or result.returncode != 0:
        return set()
    return {line.strip().lower() for line in result.stdout.splitlines() if line.strip() and not line.startswith("[")}


def _php_extension_installed(extension: str) -> bool:
    modules = _php_modules()
    aliases = {
        "mysql": {"mysqli", "pdo_mysql", "mysqlnd"},
        "pgsql": {"pgsql", "pdo_pgsql"},
        "xml": {"xml", "libxml", "simplexml", "xmlreader", "xmlwriter"},
    }
    expected = aliases.get(extension, {extension})
    return any(item.lower() in modules for item in expected)


def _python_executable_version(executable: str) -> tuple[int, int] | None:
    result = _run_probe([
        executable,
        "-c",
        "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
    ])
    if not result or result.returncode != 0:
        return None
    return _version_tuple(result.stdout)


def _python_at_least(major: int, minor: int) -> tuple[bool, str | None]:
    for executable in ("python3.12", "python3.11", "python3.10", "python3"):
        path = shutil.which(executable)
        if not path:
            continue
        version = _python_executable_version(executable)
        if version and version >= (major, minor):
            return True, path
    return False, None


def _python_venv_available() -> tuple[bool, str | None]:
    for executable in ("python3.12", "python3.11", "python3.10", "python3"):
        path = shutil.which(executable)
        if not path:
            continue
        result = _run_probe([executable, "-m", "venv", "--help"])
        if result and result.returncode == 0:
            return True, path
    return False, None


def _php_fpm_path() -> str | None:
    path = shutil.which("php-fpm")
    if path:
        return path
    for candidate in sorted([*Path("/usr/sbin").glob("php*-fpm"), *Path("/usr/bin").glob("php*-fpm")]):
        if candidate.is_file():
            return str(candidate)
    return None


def inspect_runtime_tool(name: str) -> dict:
    if name.startswith("php-ext-"):
        extension = name.removeprefix("php-ext-").lower()
        installed = _php_extension_installed(extension)
        return {"name": name, "installed": installed, "path": f"php -m:{extension}" if installed else None}

    if name == "php-fpm":
        path = _php_fpm_path()
        return {"name": name, "installed": bool(path), "path": path}

    if name == "python3.10+":
        installed, path = _python_at_least(3, 10)
        return {"name": name, "installed": installed, "path": path}

    if name == "python-venv":
        installed, path = _python_venv_available()
        return {"name": name, "installed": installed, "path": path}

    path = shutil.which(name)
    return {"name": name, "installed": bool(path), "path": path}


def _python_version(root_path: str, executable: str) -> dict:
    return guarded_command(
        root_path,
        [
            executable,
            "-c",
            "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
        ],
        cwd=deployment_cwd(root_path),
    )


def _version_tuple(raw: str) -> tuple[int, int] | None:
    match = re.search(r"(\d+)\.(\d+)", raw or "")
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def _modern_python(root_path: str) -> tuple[str | None, dict[str, dict]]:
    checks: dict[str, dict] = {}
    for executable in ("python3.12", "python3.11", "python3.10", "python3"):
        path = shutil.which(executable)
        if not path:
            checks[executable] = {"returncode": 127, "stderr": "not found"}
            continue
        result = _python_version(root_path, executable)
        checks[executable] = result
        if result.get("returncode") == 0:
            version = _version_tuple(result.get("stdout") or "")
            if version and version >= (3, 10):
                return executable, checks
    return None, checks


@router.post("/python/repair-runtime")
def repair_python_runtime(body: PythonRuntimeRepairRequest) -> dict:
    root = Path(body.rootPath).resolve()
    info = path_info(str(root))
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", ["python-runtime-repair", str(root)], info)

    executable, checks = _modern_python(str(root))
    if not executable:
        return {
            "dryRun": False,
            "command": ["python-runtime-repair", str(root)],
            "cwd": str(root),
            "stdout": "",
            "stderr": "Python 3.10+ is required but no python3.10/python3.11/python3.12 executable is installed",
            "returncode": 1,
            "path": info,
            "checks": checks,
        }

    venv = guarded_command(str(root), [executable, "-m", "venv", ".venv"], cwd=str(root))
    if venv.get("returncode") != 0:
        return {
            "dryRun": venv.get("dryRun", False),
            "command": ["python-runtime-repair", str(root)],
            "cwd": str(root),
            "stdout": "",
            "stderr": venv.get("stderr") or f"Could not create .venv with {executable}",
            "returncode": 1,
            "path": info,
            "checks": checks,
            "venv": venv,
        }

    venv_python = str(root / ".venv" / "bin" / "python")
    install_steps: dict[str, dict] = {}
    if (root / "requirements.txt").is_file():
        install_steps["requirements"] = guarded_command(str(root), [venv_python, "-m", "pip", "install", "-r", "requirements.txt"], cwd=str(root))
    elif (root / "pyproject.toml").is_file():
        install_steps["project"] = guarded_command(str(root), [venv_python, "-m", "pip", "install", "."], cwd=str(root))
    else:
        install_steps["dependencies"] = {
            "returncode": 0,
            "stdout": "No requirements.txt or pyproject.toml found; created .venv only",
            "stderr": "",
        }

    failed = [name for name, step in install_steps.items() if step.get("returncode", 0) != 0]
    return {
        "dryRun": venv.get("dryRun", False) or any(step.get("dryRun") for step in install_steps.values()),
        "command": ["python-runtime-repair", str(root)],
        "cwd": str(root),
        "stdout": f"Prepared .venv with {executable}",
        "stderr": "; ".join(f"{name}: {install_steps[name].get('stderr')}" for name in failed),
        "returncode": 1 if failed else 0,
        "path": info,
        "python": executable,
        "checks": checks,
        "venv": venv,
        "install": install_steps,
    }


@router.post("/runtime-tools/install")
def install_runtime_tool(body: RuntimeInstallRequest) -> dict:
    try:
        plan = runtime_tool_install_plan(body.tool)
    except KeyError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return run_install_plan(plan, timeout=300, allow_live=DEPLOYMENT_COMMANDS_LIVE)


@router.post("/repair-permissions")
def repair_permissions(body: PermissionRepairRequest) -> dict:
    targets = [body.rootPath]
    if body.logDir:
        targets.append(body.logDir)
    steps = {}
    for target in targets:
        info = path_info(target)
        if not info["allowed"] and not str(Path(target).resolve()).startswith(str(Path(settings.deployment_log_root).resolve())):
            steps[target] = blocked_command("Path escapes deployment roots", ["chown", "-R", "panel:panel", target], info)
            continue
        steps[target] = run_command(["chown", "-R", "panel:panel", target], timeout=120, allow_live=DEPLOYMENT_COMMANDS_LIVE)
    failed = [target for target, result in steps.items() if result.get("returncode") != 0]
    return {"dryRun": any(result.get("dryRun") for result in steps.values()), "returncode": 1 if failed else 0, "steps": steps}


def _ensure_laravel_env(root_path: str, port: int | None, env: dict[str, str] | None) -> dict:
    info = path_info(root_path)
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", ["ensure-laravel-env", root_path], info)

    artisan = Path(root_path) / "artisan"
    if not artisan.is_file():
        return {
            "dryRun": False,
            "command": ["skipped", "ensure-laravel-env"],
            "cwd": deployment_cwd(root_path),
            "stdout": "Skipped Laravel env sync: no artisan file in deployment root",
            "stderr": "",
            "returncode": 0,
            "path": info,
            "skipped": True,
        }

    try:
        env_path, app_key, needs_key_generate = sync_laravel_env_file(root_path, port, env)
    except (OSError, ValueError) as error:
        return {
            "dryRun": False,
            "command": ["write-file", str(Path(root_path) / ".env")],
            "cwd": deployment_cwd(root_path),
            "stdout": "",
            "stderr": str(error),
            "returncode": 1,
            "path": info,
        }

    key_generate: dict | None = None
    key_generated_by_panel = False
    if needs_key_generate:
        if not env_path.is_file():
            stub_env = {"APP_ENV": (env or {}).get("APP_ENV", "production")}
            write_env_file(env_path, stub_env)
        runtime_env = read_existing_env_values(env_path)
        key_generate = guarded_deployment_command(
            root_path,
            "php artisan key:generate --force",
            env=runtime_env or None,
        )
        env_path, app_key, _ = sync_laravel_env_file(root_path, port, env)
        if not is_valid_laravel_app_key(app_key):
            app_key = generate_laravel_app_key()
            key_generated_by_panel = True
            next_env = dict(env or {})
            next_env["APP_KEY"] = app_key
            env_path, app_key, _ = sync_laravel_env_file(root_path, port, next_env)

    process_env, _ = prepare_laravel_env_for_sync(root_path, port, env)
    if app_key:
        process_env["APP_KEY"] = app_key
    env_path = write_laravel_env_bundle(root_path, process_env)
    clear_laravel_bootstrap_config_cache(root_path)
    config_clear = guarded_deployment_command(
        root_path,
        "php artisan config:clear",
        env=process_env or None,
    )
    if not is_valid_laravel_app_key(app_key):
        return {
            "dryRun": False,
            "command": ["verify-app-key", str(env_path)],
            "cwd": deployment_cwd(root_path),
            "stdout": "",
            "stderr": "Laravel APP_KEY is missing or invalid after env sync",
            "returncode": 1,
            "path": info,
            "envPath": str(env_path),
            "appKey": app_key,
            "configClear": config_clear,
        }

    return {
        "dryRun": False,
        "command": ["write-file", str(env_path)],
        "cwd": deployment_cwd(root_path),
        "stdout": f"Synced {env_path}",
        "stderr": (config_clear.get("stderr") or "").strip(),
        "returncode": 0,
        "path": info,
        "envPath": str(env_path),
        "runtimeEnvPath": str(Path(root_path).resolve() / ".panel" / "runtime.env"),
        "appKey": app_key,
        "keyGenerated": bool(needs_key_generate and ((key_generate and key_generate.get("returncode") == 0) or key_generated_by_panel)),
        "keyGeneratedByPanel": key_generated_by_panel,
        "keyGenerate": key_generate,
        "configClear": config_clear,
    }


@router.post("/laravel/sync-env-file")
def sync_laravel_env(body: SyncEnvFileRequest) -> dict:
    return _ensure_laravel_env(body.rootPath, body.port, body.env)


def ensure_laravel_public_index(root_path: str) -> dict:
    root = Path(root_path).resolve()
    index_path = root / "public" / "index.php"
    if not (root / "artisan").is_file():
        return {
            "dryRun": False,
            "command": ["skipped", "laravel-public-index"],
            "stdout": "Skipped public/index.php repair: no artisan file in deployment root",
            "stderr": "",
            "returncode": 0,
            "skipped": True,
        }
    if index_path.is_file():
        return {
            "dryRun": False,
            "command": ["verify-file", str(index_path)],
            "stdout": "Laravel public/index.php already exists",
            "stderr": "",
            "returncode": 0,
            "created": False,
        }
    try:
        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_path.write_text(LARAVEL_PUBLIC_INDEX, encoding="utf-8")
        index_path.chmod(0o664)
        make_panel_owned(index_path)
        return {
            "dryRun": False,
            "command": ["write-file", str(index_path)],
            "stdout": f"Created missing Laravel front controller at {index_path}",
            "stderr": "",
            "returncode": 0,
            "created": True,
        }
    except OSError as error:
        return {
            "dryRun": False,
            "command": ["write-file", str(index_path)],
            "stdout": "",
            "stderr": str(error),
            "returncode": 1,
        }


@router.post("/laravel/repair-writable-paths")
def repair_laravel_writable_paths(body: LaravelWritablePathsRequest) -> dict:
    root = str(Path(body.rootPath).resolve())
    info = path_info(root)
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", ["laravel-repair", root], info)

    paths = [
        f"{root}/bootstrap/cache",
        f"{root}/storage",
        f"{root}/storage/app",
        f"{root}/storage/app/public",
        f"{root}/storage/framework",
        f"{root}/storage/framework/cache",
        f"{root}/storage/framework/cache/data",
        f"{root}/storage/framework/sessions",
        f"{root}/storage/framework/testing",
        f"{root}/storage/framework/views",
        f"{root}/storage/logs",
    ]

    mkdir = run_command(["mkdir", "-p", *paths], timeout=120, allow_live=DEPLOYMENT_COMMANDS_LIVE)
    public_root = Path(root) / "public"
    should_repair_public = public_root.is_dir() or (public_root / "index.php").is_file()
    public_index = (
        ensure_laravel_public_index(root)
        if mkdir.get("returncode") == 0 and should_repair_public
        else {
            "dryRun": False,
            "command": ["skipped", "laravel-public-index"],
            "stdout": "Skipped public/index.php repair: deployment has no public web root",
            "stderr": "",
            "returncode": 0,
            "skipped": True,
        }
    )
    chown_paths = [f"{root}/storage", f"{root}/bootstrap/cache"]
    chmod_paths = [f"{root}/storage", f"{root}/bootstrap/cache"]
    if should_repair_public:
        chown_paths.append(f"{root}/public")
        chmod_paths.append(f"{root}/public")
    chown = run_command(["chown", "-R", "panel:panel", *chown_paths], timeout=120, allow_live=DEPLOYMENT_COMMANDS_LIVE) if mkdir.get("returncode") == 0 else {"returncode": 1, "stderr": "Skipped because directory creation failed"}
    chmod = run_command(["chmod", "-R", "ug+rwX", *chmod_paths], timeout=120, allow_live=DEPLOYMENT_COMMANDS_LIVE) if mkdir.get("returncode") == 0 else {"returncode": 1, "stderr": "Skipped because directory creation failed"}
    failed = any(step.get("returncode") != 0 for step in [mkdir, public_index, chown, chmod])
    return {
        "dryRun": any(step.get("dryRun") for step in [mkdir, public_index, chown, chmod]),
        "returncode": 1 if failed else 0,
        "paths": paths,
        "publicRootRepair": should_repair_public,
        "mkdir": mkdir,
        "publicIndex": public_index,
        "chown": chown,
        "chmod": chmod,
    }


@router.post("/guardian-repair")
def guardian_repair(body: GuardianRepairRequest) -> dict:
    framework = (body.framework or "").upper()
    steps: dict[str, dict] = {}

    if framework == "LARAVEL":
        root = Path(body.rootPath).resolve()
        port = None
        env = dict(body.env or {})
        port_raw = env.get("PORT")
        if port_raw and str(port_raw).isdigit():
            port = int(port_raw)
        vendor_autoload = root / "vendor" / "autoload.php"
        if not vendor_autoload.is_file():
            steps["vendorInstall"] = guarded_deployment_command(
                body.rootPath,
                "composer install --no-dev --optimize-autoloader --no-interaction",
                env=env or None,
            )
            if steps["vendorInstall"].get("returncode") != 0:
                failed = [name for name, step in steps.items() if step.get("returncode", 0) != 0]
                return {
                    "framework": framework,
                    "dryRun": any(step.get("dryRun") for step in steps.values()),
                    "returncode": 1 if failed else 0,
                    "steps": steps,
                    "failed": failed,
                    "appKey": None,
                }
        steps["env"] = _ensure_laravel_env(body.rootPath, port, env)
        if steps["env"].get("appKey"):
            env["APP_KEY"] = steps["env"]["appKey"]
        steps["writablePaths"] = repair_laravel_writable_paths(LaravelWritablePathsRequest(rootPath=body.rootPath))
        steps["optimizeClear"] = guarded_deployment_command(body.rootPath, "php artisan optimize:clear", env=env or None)
        steps["configClear"] = guarded_deployment_command(body.rootPath, "php artisan config:clear", env=env or None)
        steps["cacheClear"] = guarded_deployment_command(body.rootPath, "php artisan cache:clear", env=env or None)
        steps["routeClear"] = guarded_deployment_command(body.rootPath, "php artisan route:clear", env=env or None)
        steps["viewClear"] = guarded_deployment_command(body.rootPath, "php artisan view:clear", env=env or None)
        steps["storageLink"] = guarded_deployment_command(body.rootPath, "php artisan storage:link", env=env or None)
        if steps["storageLink"].get("returncode") != 0:
            stderr = (steps["storageLink"].get("stderr") or "").lower()
            if "already exists" in stderr or "exists" in stderr:
                steps["storageLink"]["returncode"] = 0

    failed = [name for name, step in steps.items() if step.get("returncode", 0) != 0]
    app_key = steps.get("env", {}).get("appKey") if framework == "LARAVEL" else None
    return {
        "framework": framework or None,
        "dryRun": any(step.get("dryRun") for step in steps.values()),
        "returncode": 1 if failed else 0,
        "steps": steps,
        "failed": failed,
        "appKey": app_key,
    }


@router.post("/supervisor/repair")
def repair_supervisor(body: SupervisorRepairRequest) -> dict:
    service = ensure_supervisord_running()
    reread = run_supervisorctl("reread")
    update = run_supervisorctl("update") if reread.get("returncode") == 0 else {"returncode": 1, "stderr": "Skipped because reread failed"}
    restart = run_supervisorctl("restart", body.name) if update.get("returncode") == 0 else {"returncode": 1, "stderr": "Skipped because update failed"}
    failed = [name for name, step in {"service": service, "reread": reread, "update": update, "restart": restart}.items() if step.get("returncode", 0) != 0]
    return {
        "dryRun": any(step.get("dryRun") for step in [reread, update, restart]),
        "returncode": 1 if failed else 0,
        "service": service,
        "reread": reread,
        "update": update,
        "restart": restart,
        "stderr": "; ".join(f"{name}: {format_supervisor_step_error(step)}" for name, step in {"service": service, "reread": reread, "update": update, "restart": restart}.items() if name in failed),
    }


@router.post("/nginx-inspect")
def nginx_inspect(body: NginxInspectRequest) -> dict:
    info = path_info(body.rootPath)
    server_name = body.serverName or body.deploymentId
    config_name = nginx_config_name(body.deploymentId, server_name)
    available = safe_nginx_path(nginx_sites_available(), config_name)
    enabled = safe_nginx_path(nginx_sites_enabled(), config_name)
    content = ""
    if available.exists():
        content = available.read_text(encoding="utf-8", errors="ignore")
    upstream = f"127.0.0.1:{body.upstreamPort}"
    return {
        "dryRun": False,
        "command": ["nginx-inspect", config_name],
        "returncode": 0 if available.exists() and upstream in content else 1,
        "stdout": "",
        "stderr": "" if available.exists() and upstream in content else "Generated Nginx config is missing or upstream port does not match",
        "path": info,
        "configName": config_name,
        "availablePath": str(available),
        "enabledPath": str(enabled),
        "exists": available.exists(),
        "enabled": enabled.exists(),
        "expectedUpstream": upstream,
        "containsExpectedUpstream": upstream in content,
        "serverName": server_name,
    }


@router.post("/port-status")
def port_status(body: PortStatusRequest) -> dict:
    info = path_info(body.rootPath)
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", ["port-status", str(body.port)], info)

    pm2_owner = _pm2_owner_for_port(body.port) if (body.processManager or "").upper() == "PM2" else None
    if pm2_owner:
        same_process = pm2_owner.get("name") == body.processName
        same_cwd = str(Path(str(pm2_owner.get("cwd") or "")).resolve()) == str(Path(body.rootPath).resolve()) if pm2_owner.get("cwd") else False
        return {
            "dryRun": False,
            "command": ["pm2", "jlist"],
            "cwd": None,
            "stdout": json.dumps(pm2_owner, separators=(",", ":")),
            "stderr": "",
            "returncode": 0,
            "path": info,
            "occupied": not (same_process and same_cwd),
            "reusable": same_process and same_cwd,
            "owner": pm2_owner,
        }

    ss = run_command(["ss", "-ltnp", f"sport = :{body.port}"], allow_live=DEPLOYMENT_COMMANDS_LIVE)
    stdout = ss.get("stdout") or ""
    occupied = f":{body.port}" in stdout
    return {
        **ss,
        "path": info,
        "occupied": occupied,
        "reusable": False,
        "owner": {"source": "ss", "detail": stdout.strip()} if occupied else None,
    }


@router.post("/health")
def health(body: HealthRequest) -> dict:
    url = body.healthUrl or f"http://127.0.0.1:{body.port}/"
    accept_http_errors = (body.framework or "").upper() == "LARAVEL"

    mismatch = _pm2_process_mismatch(body)
    if mismatch:
        return {
            "dryRun": False,
            "command": ["pm2", "verify", body.processName or ""],
            "returncode": 1,
            "stdout": "",
            "stderr": mismatch,
        }
    supervisor_mismatch = _supervisor_process_mismatch(body)
    if supervisor_mismatch:
        return {
            "dryRun": False,
            "command": ["supervisorctl", "status", body.processName or ""],
            "returncode": 1,
            "stdout": "",
            "stderr": supervisor_mismatch,
        }

    # Phase 1: wait for the process to bind (with retries for connection refused).
    first = _curl_once(url, accept_http_errors=accept_http_errors)
    if first.get("returncode") != 0:
        return attach_laravel_diagnostics(first, body.rootPath, body.framework)

    # Phase 2: wait 8 s then verify the process is still up (catches immediate crashes).
    time.sleep(8)
    second = _curl_once(url, accept_http_errors=accept_http_errors)
    if second.get("returncode") != 0:
        second["stderr"] = (
            "App responded on first check but crashed within 8 s. "
            + (second.get("stderr") or "")
        ).strip()
        return attach_laravel_diagnostics(second, body.rootPath, body.framework)

    # Phase 3: PM2 crash-loop detection.
    # If the process has already restarted since we started it, it is crash-looping
    # and will go down again shortly — fail the deployment now with a clear message.
    if body.processName and (body.processManager or "").upper() == "PM2":
        restarts = _pm2_restart_count(body.processName)
        if restarts is not None and restarts > 0:
            second["returncode"] = 1
            second["stderr"] = (
                f"PM2 process '{body.processName}' has already restarted {restarts} time(s) — "
                "the app is crash-looping. Run `pm2 logs {name}` on the server to see the error."
            ).replace("{name}", body.processName)
            return second

    return second


@router.post("/public-route")
def public_route(body: PublicRouteRequest) -> dict:
    return _curl_public_route(body.serverName, body.path, body.rootPath, body.framework, body.requireHttps)
