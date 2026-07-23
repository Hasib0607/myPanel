from __future__ import annotations
import shlex
import re
import json
import base64
import time
import shutil
import os
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psutil
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.command import constrained_runtime_env, deployment_resource_limits, run_command, run_install_plan
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
from app.deployment_commands import laravel_has_public_web_root, laravel_public_permission_commands, normalize_laravel_start_command, parse_deployment_command, resolve_laravel_public_root
from app.laravel_nginx import laravel_fpm_pool_name, laravel_fpm_socket, nginx_app_locations
from app.laravel_fpm import (
    laravel_fpm_config_path,
    php_fpm_executable,
    php_fpm_service,
    render_laravel_fpm_pool,
)
from app.deployment_health import backend_only_laravel_health, curl_health_probe
from app.platform import runtime_tool_install_plan
from app.nginx_paths import nginx_sites_available, nginx_sites_enabled
from app.nginx_manager import (
    ROUTE_OWNERSHIP_HEADER,
    acme_location,
    letsencrypt_certificate_exists,
    loaded_conflicting_config_files,
    nginx_listen_directives,
    publish_nginx_config,
    probe_host_for_server_name,
    remove_conflicting_configs,
    remove_insecure_port443_configs,
    route_ownership_config_seen,
    route_ownership_header,
    route_ownership_header_seen,
    safe_letsencrypt_path,
    safe_nginx_path,
    safe_web_root,
    server_name_directive_tokens,
    server_name_has_wildcard,
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
    resourceLimits: dict[str, int] | None = None


class CommandRequest(BaseModel):
    rootPath: str
    command: str | None = None
    packageManager: str | None = None
    env: dict[str, str] | None = None
    resourceLimits: dict[str, int] | None = None
    timeoutSeconds: int | None = Field(default=360, ge=10, le=1800)


class ResourceSnapshotRequest(BaseModel):
    rootPath: str | None = None


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
    framework: str | None = None
    resourceLimits: dict[str, int] | None = None
    restartDelayMs: int | None = Field(default=None, ge=500, le=60000)


class LaravelWorkersRequest(BaseModel):
    name: str
    rootPath: str
    action: str = Field(default="apply", pattern="^(apply|status|stop)$")
    desiredWorkers: int = Field(default=1, ge=0, le=64)
    queueCommand: str = "php artisan queue:work --sleep=3 --tries=3 --timeout=90"
    env: dict[str, str] | None = None
    logDir: str | None = None
    logPrefix: str = Field(default="worker", pattern="^[a-zA-Z0-9_.-]+$")
    resourceLimits: dict[str, int] | None = None


class CronJobRequest(BaseModel):
    id: str = Field(pattern="^[a-zA-Z0-9_.-]+$")
    name: str = Field(min_length=1, max_length=80)
    command: str = Field(min_length=1, max_length=1000)
    minute: str = Field(default="*", pattern="^[a-zA-Z0-9*,/\\-]+$")
    hour: str = Field(default="*", pattern="^[a-zA-Z0-9*,/\\-]+$")
    dayOfMonth: str = Field(default="*", pattern="^[a-zA-Z0-9*,/\\-?LW#]+$")
    month: str = Field(default="*", pattern="^[a-zA-Z0-9*,/\\-]+$")
    dayOfWeek: str = Field(default="*", pattern="^[a-zA-Z0-9*,/\\-?LW#]+$")
    enabled: bool = True


class CronApplyRequest(BaseModel):
    deploymentId: str = Field(pattern="^[a-zA-Z0-9_.-]+$")
    name: str = Field(pattern="^[a-zA-Z0-9_.-]+$")
    rootPath: str
    logDir: str | None = None
    jobs: list[CronJobRequest] = Field(default_factory=list, max_length=100)


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


class LaravelRuntimeRequest(BaseModel):
    deploymentId: str
    name: str
    rootPath: str
    serverName: str | None = None
    upstreamPort: int | None = Field(default=None, ge=1, le=65535)
    processManager: str | None = None
    startCommand: str | None = None
    logDir: str | None = None


class LaravelTimingRequest(BaseModel):
    url: str
    samples: int = Field(default=5, ge=1, le=10)


class RetireNginxRouteRequest(BaseModel):
    deploymentId: str
    serverName: str | None = None


class HealthRequest(BaseModel):
    deploymentId: str
    port: int = Field(ge=1, le=65535)
    healthUrl: str | None = None
    processName: str | None = None
    processManager: str | None = None
    rootPath: str | None = None
    framework: str | None = None
    logDir: str | None = None
    strictHealth: bool = False


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
    resourceLimits: dict[str, int] | None = None


class RuntimeLogsRequest(BaseModel):
    name: str
    logDir: str | None = None
    rootPath: str | None = None
    lines: int = Field(default=300, ge=1, le=2000)


class DeploymentMetricsRequest(BaseModel):
    deploymentId: str
    name: str
    rootPath: str
    port: int | None = Field(default=None, ge=1, le=65535)
    framework: str | None = None
    processManager: str | None = None
    logDir: str | None = None
    dbType: str | None = None
    dbName: str | None = None
    serverNames: list[str] = Field(default_factory=list, max_length=50)
    logLines: int = Field(default=300, ge=1, le=2000)
    processOnly: bool = False


class RuntimeToolsRequest(BaseModel):
    tools: list[str] = Field(default_factory=list, max_length=50)


class NginxInspectRequest(BaseModel):
    deploymentId: str
    serverName: str | None = None
    upstreamPort: int = Field(ge=1, le=65535)
    rootPath: str


class RuntimeInstallRequest(BaseModel):
    tool: str = Field(pattern="^(pnpm|yarn|composer|uv|go|php|php82|php83|php-mbstring|php-xml|php-curl|php-zip|php-gd|php-redis|php-sodium|php-soap|php-bcmath|php-intl|php-swoole|php-mysql|php-pgsql|python|python311|nodejs|supervisor|pm2|redis|postfix)$")


class PermissionRepairRequest(BaseModel):
    rootPath: str
    logDir: str | None = None


class SupervisorRepairRequest(BaseModel):
    name: str


class LaravelWritablePathsRequest(BaseModel):
    rootPath: str


class PythonRuntimeRepairRequest(BaseModel):
    rootPath: str
    startCommand: str | None = None


class SyncEnvFileRequest(BaseModel):
    rootPath: str
    port: int | None = Field(default=None, ge=1, le=65535)
    env: dict[str, str] | None = None


class LaravelProductionEnvRequest(BaseModel):
    rootPath: str
    values: dict[str, str]


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


def cron_file_path(deployment_id: str) -> Path:
    safe_id = re.sub(r"[^a-zA-Z0-9_.-]+", "-", deployment_id).strip("-") or "deployment"
    return Path("/etc/cron.d") / f"vps-panel-{safe_id}"


def cron_shell_fragment(value: str) -> str:
    return value.replace("\n", " ").replace("\r", " ").strip()


def render_deployment_cron(body: CronApplyRequest, root_path: Path, log_dir: Path) -> str:
    lines = [
        "# Managed by vps-panel. Do not edit manually.",
        f"# Deployment: {body.name} ({body.deploymentId})",
        "SHELL=/bin/bash",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "",
    ]
    for job in body.jobs:
        if not job.enabled:
            continue
        command = cron_shell_fragment(job.command)
        if not command:
            continue
        log_file = log_dir / f"cron-{re.sub(r'[^a-zA-Z0-9_.-]+', '-', job.id)}.log"
        schedule = f"{job.minute} {job.hour} {job.dayOfMonth} {job.month} {job.dayOfWeek}"
        wrapped = f"cd {shlex.quote(str(root_path))} && {command} >> {shlex.quote(str(log_file))} 2>&1"
        lines.append(f"# {job.name}")
        lines.append(f"{schedule} root /bin/bash -lc {shlex.quote(wrapped)}")
    return "\n".join(lines).rstrip() + "\n"


def apply_deployment_cron_file(body: CronApplyRequest) -> dict:
    info = path_info(body.rootPath)
    path = cron_file_path(body.deploymentId)
    enabled_jobs = [job for job in body.jobs if job.enabled]
    command = ["write-file", str(path)]
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", command, info)
    if not settings.allow_live_system_commands:
        return {
            "dryRun": True,
            "command": command,
            "path": info,
            "cronPath": str(path),
            "stdout": "",
            "stderr": "ALLOW_LIVE_SYSTEM_COMMANDS=false. Cron file was not changed.",
            "returncode": 0,
        }

    try:
        if not enabled_jobs:
            try:
                path.unlink()
                removed = True
            except FileNotFoundError:
                removed = False
            return {
                "dryRun": False,
                "command": ["rm", "-f", str(path)],
                "path": info,
                "cronPath": str(path),
                "removed": removed,
                "stdout": "Cron file removed." if removed else "No cron file existed.",
                "stderr": "",
                "returncode": 0,
            }

        root_path = Path(body.rootPath).resolve()
        log_dir = Path(body.logDir or settings.deployment_log_root).resolve()
        log_dir.mkdir(parents=True, exist_ok=True)
        rendered = render_deployment_cron(body, root_path, log_dir)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(rendered, encoding="utf-8")
        os.chmod(tmp, 0o644)
        tmp.replace(path)
        return {
            "dryRun": False,
            "command": command,
            "path": info,
            "cronPath": str(path),
            "enabledJobs": len(enabled_jobs),
            "stdout": rendered,
            "stderr": "",
            "returncode": 0,
        }
    except Exception as exc:
        return {
            "dryRun": False,
            "command": command,
            "path": info,
            "cronPath": str(path),
            "stdout": "",
            "stderr": str(exc),
            "returncode": 1,
        }


def effective_resource_limits(resource_limits: dict[str, int] | None = None) -> dict[str, int] | None:
    return resource_limits if resource_limits is not None else deployment_resource_limits()


def clamp_worker_count(value: int) -> int:
    return max(0, min(value, max(1, settings.deployment_worker_max)))


def guarded_command(root_path: str, command: list[str], cwd: str | None = None, resource_limits: dict[str, int] | None = None, timeout: int | None = None) -> dict:
    info = path_info(root_path)
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", command, info)
    result = run_command(command, cwd=cwd, allow_live=DEPLOYMENT_COMMANDS_LIVE, timeout=timeout, resource_limits=resource_limits)
    result["path"] = info
    return result


def guarded_command_with_env(root_path: str, command: list[str], cwd: str | None = None, env: dict[str, str] | None = None, resource_limits: dict[str, int] | None = None, timeout: int | None = None) -> dict:
    info = path_info(root_path)
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", command, info)
    result = run_command(command, cwd=cwd, env=env, allow_live=DEPLOYMENT_COMMANDS_LIVE, timeout=timeout, resource_limits=resource_limits)
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


def git_command_with_safe_directory(root_path: str, target: Path, command: list[str], env: dict[str, str] | None = None, resource_limits: dict[str, int] | None = None) -> dict:
    result = guarded_command_with_env(root_path, command, env=env, resource_limits=effective_resource_limits(resource_limits))
    text = f"{result.get('stderr') or ''}\n{result.get('stdout') or ''}".lower()
    if result.get("returncode") == 128 and "dubious ownership" in text:
        safe = git_safe_directory(root_path, target)
        retry = guarded_command_with_env(root_path, command, env=env, resource_limits=effective_resource_limits(resource_limits)) if safe.get("returncode") == 0 else {
            "returncode": 1,
            "stderr": "Skipped because safe.directory repair failed",
            "safeDirectory": safe,
        }
        retry["safeDirectory"] = safe
        return retry
    return result


def git_commit_info(root_path: str, target: Path, env: dict[str, str] | None = None) -> dict:
    sha = git_command_with_safe_directory(root_path, target, ["git", "-C", str(target), "rev-parse", "HEAD"], env=env)
    message = git_command_with_safe_directory(root_path, target, ["git", "-C", str(target), "log", "-1", "--pretty=%s"], env=env)
    author = git_command_with_safe_directory(root_path, target, ["git", "-C", str(target), "log", "-1", "--pretty=%an"], env=env)
    return {
        "sha": (sha.get("stdout") or "").strip() if sha.get("returncode") == 0 else None,
        "message": (message.get("stdout") or "").strip() if message.get("returncode") == 0 else None,
        "author": (author.get("stdout") or "").strip() if author.get("returncode") == 0 else None,
        "commands": {
            "sha": sha,
            "message": message,
            "author": author,
        },
    }


def git_success(result: dict | None) -> bool:
    return bool(result and result.get("returncode") == 0 and not result.get("dryRun"))


def git_sha_matches(left: str | None, right: str | None) -> bool:
    if not left or not right:
        return False
    a = left.strip().lower()
    b = right.strip().lower()
    return a == b or a.startswith(b) or b.startswith(a)


def git_rev_parse(root_path: str, target: Path, revision: str, env: dict[str, str] | None = None, resource_limits: dict[str, int] | None = None) -> dict:
    return git_command_with_safe_directory(
        root_path,
        target,
        ["git", "-C", str(target), "rev-parse", revision],
        env=env,
        resource_limits=resource_limits,
    )


def git_commit_available(root_path: str, target: Path, commit_sha: str, env: dict[str, str] | None = None, resource_limits: dict[str, int] | None = None) -> dict:
    return git_command_with_safe_directory(
        root_path,
        target,
        ["git", "-C", str(target), "cat-file", "-e", f"{commit_sha}^{{commit}}"],
        env=env,
        resource_limits=resource_limits,
    )


def git_sync_verify_result(expected_sha: str | None, commit: dict) -> dict:
    actual_sha = commit.get("sha")
    ok = git_sha_matches(str(actual_sha) if actual_sha else None, expected_sha)
    return {
        "dryRun": False,
        "command": ["git", "verify-head", expected_sha or ""],
        "stdout": f"HEAD {actual_sha} matches expected {expected_sha}" if ok else "",
        "stderr": "" if ok else f"Git sync ended at {actual_sha or 'unknown'}, expected {expected_sha or 'unknown'}",
        "returncode": 0 if ok else 1,
        "expectedSha": expected_sha,
        "actualSha": actual_sha,
    }


def deployment_cwd(root_path: str) -> str:
    return str(Path(root_path).resolve())


def nginx_config_name(deployment_id: str, server_name: str) -> str:
    primary = server_name.split()[0] if server_name else deployment_id
    primary = re.sub(r"^\*\.", "wildcard.", primary)
    safe_name = re.sub(r"[^a-zA-Z0-9_.-]+", "-", primary).strip("-") or deployment_id
    return f"domain-{safe_name}"


def guarded_deployment_command(root_path: str, command: str, env: dict[str, str] | None = None, resource_limits: dict[str, int] | None = None, timeout: int | None = None) -> dict:
    info = path_info(root_path)
    try:
        parsed = parse_deployment_command(command)
    except ValueError as error:
        return blocked_command(str(error), [command], info)
    effective_env = dict(env or {})
    if parsed and parsed[0] == "composer":
        effective_env = composer_git_env(root_path, effective_env)
    return guarded_command_with_env(root_path, parsed, cwd=deployment_cwd(root_path), env=effective_env or None, resource_limits=effective_resource_limits(resource_limits), timeout=timeout)


def pm2_env(port: int | None) -> dict[str, str]:
    env = {}
    if port:
        env["PORT"] = str(port)
    return env


def scrub_node_host_runtime_env(env: dict[str, str], framework: str | None) -> dict[str, str]:
    if (framework or "").upper() not in {"NEXTJS", "NODEJS"}:
        return env
    cleaned = dict(env)
    for key in ("HOST", "HOSTNAME", "VERCEL_URL", "NEXT_PUBLIC_HOST", "NEXT_PUBLIC_HOSTNAME"):
        value = str(cleaned.get(key) or "").strip().lower()
        if value and value not in {"127.0.0.1", "localhost", "0.0.0.0"}:
            cleaned.pop(key, None)
    return cleaned


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


def directory_size_bytes(root_path: str) -> int:
    root = Path(root_path).resolve()
    info = path_info(str(root))
    if not info["allowed"] or not root.exists():
        return 0
    total = 0
    for current, dirs, files in os.walk(root):
        dirs[:] = [name for name in dirs if name not in {".git"}]
        for filename in files:
            try:
                total += (Path(current) / filename).stat().st_size
            except OSError:
                continue
    return total


def process_matches(proc: psutil.Process, root_path: str, name: str, port_pids: set[int]) -> bool:
    if proc.pid in port_pids:
        return True
    root = str(Path(root_path).resolve())
    try:
        cwd = proc.cwd()
        if cwd == root or cwd.startswith(f"{root}{os.sep}"):
            return True
    except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
        pass
    try:
        text = " ".join(proc.cmdline())
        return root in text or name in text
    except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
        return False


def deployment_process_metrics(root_path: str, name: str, port: int | None, deployment_id: str | None = None, framework: str | None = None) -> dict:
    port_pids: set[int] = set()
    if port:
        try:
            for conn in psutil.net_connections(kind="inet"):
                if conn.laddr and conn.laddr.port == port and conn.pid:
                    port_pids.add(conn.pid)
        except (psutil.AccessDenied, OSError):
            port_pids = set()

    matched_pids: set[int] = set(port_pids)
    processes = []
    cpu_percent = 0.0
    memory_bytes = 0
    candidates = list(psutil.process_iter(["pid", "ppid", "name", "status", "memory_info", "cpu_percent"]))
    for proc in candidates:
        try:
            if process_matches(proc, root_path, name, port_pids):
                matched_pids.add(proc.pid)
                for child in proc.children(recursive=True):
                    matched_pids.add(child.pid)
        except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
            continue

    if deployment_id and str(framework or "").upper() == "LARAVEL":
        pool_name = laravel_fpm_pool_name(deployment_id)
        for item in _laravel_fpm_processes(pool_name):
            pid = int(item.get("pid") or 0)
            if pid:
                matched_pids.add(pid)

    for proc in candidates:
        try:
            if proc.pid not in matched_pids:
                continue
            memory = proc.info.get("memory_info")
            rss = int(getattr(memory, "rss", 0) or 0)
            cpu = float(proc.info.get("cpu_percent") or 0.0)
            memory_bytes += rss
            cpu_percent += cpu
            processes.append({
                "pid": proc.pid,
                "name": proc.info.get("name"),
                "status": proc.info.get("status"),
                "cpuPercent": cpu,
                "memoryBytes": rss,
            })
        except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
            continue
    matched_pids = {int(process.get("pid") or 0) for process in processes if process.get("pid")}
    try:
        pm2_list = json.loads(pm2_processes(root_path).get("stdout") or "[]")
    except (json.JSONDecodeError, TypeError, ValueError):
        pm2_list = []
    root_text = str(Path(root_path).resolve())
    for item in (pm2_list if isinstance(pm2_list, list) else []):
        pm2_env = item.get("pm2_env") if isinstance(item, dict) else {}
        pm2_env = pm2_env if isinstance(pm2_env, dict) else {}
        pm2_inner_env = pm2_env.get("env") if isinstance(pm2_env.get("env"), dict) else {}
        pm2_name = str(item.get("name") or "")
        pm2_text = " ".join([
            pm2_name,
            str(pm2_env.get("pm_cwd") or ""),
            str(pm2_env.get("cwd") or ""),
            str(pm2_inner_env.get("PWD") or ""),
            str(pm2_env.get("pm_exec_path") or ""),
            json.dumps(pm2_env.get("args") or ""),
            json.dumps(pm2_inner_env),
        ])
        if pm2_name != name and root_text not in pm2_text:
            continue
        pid = int(item.get("pid") or 0)
        if pid and pid in matched_pids:
            continue
        monit = item.get("monit") if isinstance(item.get("monit"), dict) else {}
        memory = int(monit.get("memory") or 0)
        cpu = float(monit.get("cpu") or 0.0)
        memory_bytes += memory
        cpu_percent += cpu
        if pid:
            matched_pids.add(pid)
        processes.append({
            "pid": pid,
            "name": pm2_name,
            "status": pm2_env.get("status"),
            "cpuPercent": cpu,
            "memoryBytes": memory,
        })
    return {
        "cpuPercent": round(cpu_percent, 2),
        "memoryBytes": memory_bytes,
        "processes": processes[:20],
        "processCount": len(processes),
    }


def deployment_resource_process_snapshot(current_root_path: str | None = None) -> dict:
    file_root = str(Path(settings.file_manager_root).resolve())
    current_root = str(Path(current_root_path).resolve()) if current_root_path else None
    processes = []
    memory_bytes = 0
    cpu_percent = 0.0
    for proc in psutil.process_iter(["pid", "name", "status", "memory_info", "cpu_percent"]):
        try:
            cwd = ""
            cmdline = " ".join(proc.cmdline())
            try:
                cwd = proc.cwd()
            except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
                cwd = ""
            text = f"{cwd} {cmdline}"
            if file_root not in text:
                continue
            memory = proc.info.get("memory_info")
            rss = int(getattr(memory, "rss", 0) or 0)
            cpu = float(proc.info.get("cpu_percent") or 0.0)
            memory_bytes += rss
            cpu_percent += cpu
            processes.append({
                "pid": proc.pid,
                "name": proc.info.get("name"),
                "status": proc.info.get("status"),
                "cpuPercent": cpu,
                "memoryBytes": rss,
                "cwd": cwd,
                "currentDeployment": bool(current_root and current_root in text),
            })
        except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
            continue
    processes.sort(key=lambda item: int(item.get("memoryBytes") or 0), reverse=True)
    return {
        "memoryBytes": memory_bytes,
        "cpuPercent": round(cpu_percent, 2),
        "processCount": len(processes),
        "processes": processes[:20],
    }


def metrics_history_path(deployment_name: str) -> Path:
    safe_name = re.sub(r"[^a-zA-Z0-9_.-]+", "-", deployment_name).strip("-") or "deployment"
    return Path("/var/log/vps-panel/deployments") / safe_name / "metrics-history.json"


def update_metrics_history(deployment_name: str, process: dict) -> list[dict]:
    path = metrics_history_path(deployment_name)
    cutoff = datetime.now(timezone.utc) - timedelta(days=1)
    history: list[dict] = []
    try:
        if path.is_file():
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                history = [item for item in raw if isinstance(item, dict)]
    except (OSError, json.JSONDecodeError):
        history = []

    filtered: list[dict] = []
    for item in history:
        timestamp = str(item.get("timestamp") or "")
        try:
            parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        except ValueError:
            continue
        if parsed >= cutoff:
            filtered.append({
                "timestamp": parsed.isoformat(),
                "cpuPercent": float(item.get("cpuPercent") or 0),
                "memoryBytes": int(item.get("memoryBytes") or 0),
                "processCount": int(item.get("processCount") or 0),
            })

    now = datetime.now(timezone.utc)
    sample = {
        "timestamp": now.isoformat(),
        "cpuPercent": float(process.get("cpuPercent") or 0),
        "memoryBytes": int(process.get("memoryBytes") or 0),
        "processCount": int(process.get("processCount") or 0),
    }
    if not filtered or (now - datetime.fromisoformat(str(filtered[-1]["timestamp"]))).total_seconds() >= 55:
        filtered.append(sample)
    else:
        filtered[-1] = sample

    filtered = filtered[-1440:]
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(filtered), encoding="utf-8")
    except OSError:
        pass
    return filtered


def deployment_nginx_log_path(deployment_id: str, server_name: str) -> Path:
    config_name = nginx_config_name(deployment_id, server_name)
    return Path("/var/log/nginx") / f"vps-panel-{config_name}.access.log"


def parse_nginx_log_time(value: str) -> datetime | None:
    try:
        return datetime.strptime(value, "%d/%b/%Y:%H:%M:%S %z")
    except ValueError:
        return None


def parse_nginx_traffic_line(line: str, cutoff: datetime) -> dict | None:
    match = re.search(r"^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+\"([^\"]*)\"\s+(\d{3})\s+(\d+|-)(.*)$", line)
    if not match:
        return None
    timestamp = parse_nginx_log_time(match.group(2))
    if timestamp is None or timestamp < cutoff:
        return None
    ip = match.group(1)
    request_line = match.group(3)
    status = int(match.group(4))
    sent = 0 if match.group(5) == "-" else int(match.group(5))
    tail = match.group(6)
    user_agent_match = re.findall(r"\"([^\"]*)\"", tail)
    user_agent = user_agent_match[-1] if user_agent_match else ""
    unquoted_tail = re.sub(r"\"[^\"]*\"", "", tail)
    tail_numbers = [int(value) for value in re.findall(r"(?<![\w.])(\d{2,})(?![\w.])", unquoted_tail)]
    request_length = tail_numbers[-1] if tail_numbers else 0
    incoming = request_length if request_length > len(request_line) else 0
    parts = request_line.split()
    method = parts[0] if parts else ""
    path = parts[1].split("?", 1)[0] if len(parts) > 1 else request_line
    return {
        "ip": ip,
        "method": method,
        "path": path,
        "status": status,
        "userAgent": user_agent,
        "incoming": incoming,
        "outgoing": sent,
        "requests": 1,
    }


def nginx_log_candidates(deployment_id: str, server_names: list[str]) -> tuple[list[tuple[Path, bool]], list[str]]:
    nginx_dir = Path("/var/log/nginx")
    candidates: list[tuple[Path, bool]] = []
    server_tokens: list[str] = []
    hosts: list[str] = []
    for value in server_names:
        for token in str(value or "").split():
            host = token.strip().lower()
            if not host:
                continue
            server_tokens.append(host)
            hosts.append(host[2:] if host.startswith("*.") else host)
    for server_name in server_tokens:
        path = deployment_nginx_log_path(deployment_id, server_name)
        candidates.extend([(path, False), (path.with_suffix(path.suffix + ".1"), False)])
        safe_pattern_name = server_name.replace("*.", "wildcard.")
        for pattern in (f"*{safe_pattern_name}*.access.log", f"*{safe_pattern_name}*.log", f"*{safe_pattern_name}*.access.log.1", f"*{safe_pattern_name}*.log.1"):
            try:
                candidates.extend((item, False) for item in nginx_dir.glob(pattern))
            except OSError:
                continue
    candidates.extend([
        (nginx_dir / "access.log", True),
        (nginx_dir / "access.log.1", True),
    ])
    return candidates, hosts


def read_recent_log_text(path: Path, max_bytes: int = 50 * 1024 * 1024) -> str:
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - max_bytes), os.SEEK_SET)
            return handle.read().decode("utf-8", errors="ignore")
    except OSError:
        return ""


def deployment_traffic_metrics(deployment_id: str, server_names: list[str]) -> dict:
    cutoff = datetime.now(timezone.utc) - timedelta(days=1)
    candidates, hosts = nginx_log_candidates(deployment_id, server_names)

    seen: set[Path] = set()
    incoming = 0
    outgoing = 0
    requests = 0
    sources = []
    ip_counts: dict[str, int] = {}
    path_counts: dict[str, int] = {}
    bot_counts: dict[str, int] = {}
    bad_bot_patterns = re.compile(r"bot|crawler|spider|scrapy|python-requests|curl|wget|semrush|ahrefs|mj12|bytespider|petalbot|headless", re.IGNORECASE)
    for path, require_host_match in candidates:
        if path in seen or not path.is_file():
            continue
        seen.add(path)
        source_requests = 0
        for line in read_recent_log_text(path).splitlines():
            if require_host_match and (not hosts or not any(host in line.lower() for host in hosts)):
                continue
            parsed = parse_nginx_traffic_line(line, cutoff)
            if parsed is None:
                continue
            received = int(parsed.get("incoming") or 0)
            sent = int(parsed.get("outgoing") or 0)
            count = int(parsed.get("requests") or 1)
            incoming += received
            outgoing += sent
            requests += count
            source_requests += count
            ip = str(parsed.get("ip") or "")
            request_path = str(parsed.get("path") or "")
            user_agent = str(parsed.get("userAgent") or "")
            if ip:
                ip_counts[ip] = ip_counts.get(ip, 0) + count
            if request_path:
                path_counts[request_path] = path_counts.get(request_path, 0) + count
            if user_agent and bad_bot_patterns.search(user_agent):
                bot_counts[user_agent[:160]] = bot_counts.get(user_agent[:160], 0) + count
        if source_requests:
            sources.append(str(path))
    top_ips = [{"ip": key, "requests": value} for key, value in sorted(ip_counts.items(), key=lambda item: item[1], reverse=True)[:20]]
    top_paths = [{"path": key, "requests": value} for key, value in sorted(path_counts.items(), key=lambda item: item[1], reverse=True)[:20]]
    bot_suspects = [{"userAgent": key, "requests": value} for key, value in sorted(bot_counts.items(), key=lambda item: item[1], reverse=True)[:20]]
    return {
        "incomingBytes": incoming,
        "outgoingBytes": outgoing,
        "bandwidthBytes": incoming + outgoing,
        "requests": requests,
        "topIps": top_ips,
        "topPaths": top_paths,
        "botSuspects": bot_suspects,
        "sources": sources,
        "windowHours": 24,
        "note": None if sources else "No matching Nginx traffic was found for this project's domains in the last 24h.",
    }


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


def supervisor_laravel_worker_config(body: LaravelWorkersRequest, wrapper_path: Path, log_dir: Path) -> str:
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
        f"numprocs={body.desiredWorkers}",
        "process_name=%(program_name)s_%(process_num)02d",
        f"stdout_logfile={log_dir / f'{body.logPrefix}-out.log'}",
        f"stderr_logfile={log_dir / f'{body.logPrefix}-error.log'}",
        "redirect_stderr=false",
    ]
    return "\n".join(lines) + "\n"


def _supervisor_group_status(name: str) -> dict:
    status = run_supervisorctl("status", f"{name}:*")
    text = f"{status.get('stdout') or ''}\n{status.get('stderr') or ''}"
    processes = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or not stripped.startswith(f"{name}:"):
            continue
        parts = stripped.split(None, 2)
        process_name = parts[0]
        state = parts[1] if len(parts) > 1 else "UNKNOWN"
        detail = parts[2] if len(parts) > 2 else ""
        processes.append({"name": process_name, "state": state, "detail": detail})
    if not processes and "no such process" in text.lower():
        status["returncode"] = 0
    return {
        **status,
        "processes": processes,
        "running": sum(1 for item in processes if item["state"] == "RUNNING"),
        "configured": len(processes),
    }


def _remove_supervisor_program(name: str) -> dict:
    config_path = supervisor_program_path(name)
    stop = run_supervisorctl("stop", f"{name}:*")
    if "no such process" in (stop.get("stderr") or "").lower() or "not running" in (stop.get("stderr") or "").lower():
        stop["returncode"] = 0
    removed = False
    try:
        if config_path.exists():
            config_path.unlink()
            removed = True
    except OSError as error:
        return {"stop": stop, "remove": {"returncode": 1, "stderr": str(error), "configPath": str(config_path)}}
    reread = run_supervisorctl("reread")
    update = run_supervisorctl("update") if reread.get("returncode") == 0 else {"returncode": 1, "stderr": "Skipped because reread failed"}
    return {"stop": stop, "remove": {"returncode": 0, "removed": removed, "configPath": str(config_path)}, "reread": reread, "update": update}


def laravel_fpm_process(body: ProcessRequest) -> dict:
    info = path_info(body.rootPath)
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", ["php-fpm", body.action, body.name], info)

    executable = php_fpm_executable()
    service = php_fpm_service()
    if not executable or not service:
        return blocked_command("PHP-FPM is not installed or its systemd service was not found", ["php-fpm", body.action, body.name], info)

    config_path = laravel_fpm_config_path(body.deploymentId)
    socket_path = laravel_fpm_socket(body.deploymentId)
    steps: dict[str, dict] = {}

    if body.action == "status":
        ready = Path(socket_path).exists()
        return {
            "dryRun": False,
            "command": ["php-fpm", "socket-check", socket_path],
            "returncode": 0 if ready else 1,
            "stdout": f"Laravel PHP-FPM socket ready: {socket_path}" if ready else "",
            "stderr": "" if ready else f"Laravel PHP-FPM socket is missing: {socket_path}",
            "path": info,
            "runtime": "php-fpm",
            "socketPath": socket_path,
            "configPath": str(config_path),
        }

    if body.action == "stop":
        try:
            removed = config_path.exists()
            if removed:
                config_path.unlink()
            steps["config"] = {"returncode": 0, "removed": removed, "configPath": str(config_path)}
        except OSError as error:
            steps["config"] = {"returncode": 1, "stderr": str(error), "configPath": str(config_path)}
        steps["reload"] = run_command(["systemctl", "reload", service]) if steps["config"]["returncode"] == 0 else {"returncode": 1, "stderr": "Skipped because config removal failed"}
        if shutil.which("supervisorctl"):
            steps["retireSupervisor"] = {"returncode": 0, **_remove_supervisor_program(body.name)}
        failed = [name for name, step in steps.items() if step.get("returncode", 0) != 0]
        return {
            "dryRun": any(step.get("dryRun") for step in steps.values()),
            "command": ["systemctl", "reload", service],
            "returncode": 1 if failed else 0,
            "stderr": "; ".join(f"{name}: {step.get('stderr', '')}" for name, step in steps.items() if name in failed),
            "path": info,
            "runtime": "php-fpm",
            "socketPath": socket_path,
            **steps,
        }

    ensure = _ensure_laravel_env(body.rootPath, body.port, body.env)
    if ensure.get("returncode") != 0:
        return ensure
    writable = repair_laravel_writable_paths(LaravelWritablePathsRequest(rootPath=body.rootPath))
    if writable.get("returncode") != 0:
        return writable

    limits = effective_resource_limits(body.resourceLimits) or {}
    memory_limit_mb = min(1024, max(256, int(limits.get("memoryMaxMb", 512))))
    max_children = min(40, max(8, int(limits.get("memoryMaxMb", 2560)) // 128))
    try:
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(
            render_laravel_fpm_pool(
                body.deploymentId,
                body.rootPath,
                memory_limit_mb=memory_limit_mb,
                max_children=max_children,
            ),
            encoding="utf-8",
        )
        steps["config"] = {"returncode": 0, "configPath": str(config_path)}
    except OSError as error:
        steps["config"] = {"returncode": 1, "stderr": str(error), "configPath": str(config_path)}

    steps["test"] = run_command([executable, "-t"]) if steps["config"]["returncode"] == 0 else {"returncode": 1, "stderr": "Skipped because config write failed"}
    steps["reload"] = run_command(["systemctl", "reload", service]) if steps["test"].get("returncode") == 0 else {"returncode": 1, "stderr": "Skipped because PHP-FPM config test failed"}

    if shutil.which("supervisorctl"):
        stale = _remove_supervisor_program(body.name)
        steps["retireSupervisor"] = {
            # The web runtime is already healthy on PHP-FPM. Retiring a stale
            # Artisan Supervisor program is cleanup and must not fail deploys
            # when supervisord is absent or temporarily unavailable.
            "returncode": 0,
            **stale,
        }

    if steps["reload"].get("returncode") == 0 and not steps["reload"].get("dryRun"):
        for _ in range(30):
            if Path(socket_path).exists():
                break
            time.sleep(0.1)
        if not Path(socket_path).exists():
            steps["socket"] = {"returncode": 1, "stderr": f"PHP-FPM socket was not created: {socket_path}"}
        else:
            steps["socket"] = {"returncode": 0, "socketPath": socket_path}

    failed = [name for name, step in steps.items() if isinstance(step, dict) and step.get("returncode", 0) != 0]
    return {
        "dryRun": any(step.get("dryRun") for step in steps.values() if isinstance(step, dict)),
        "command": ["systemctl", "reload", service],
        "returncode": 1 if failed else 0,
        "stderr": "; ".join(f"{name}: {steps[name].get('stderr', '')}" for name in failed),
        "path": info,
        "runtime": "php-fpm",
        "socketPath": socket_path,
        "configPath": str(config_path),
        **steps,
    }


def _laravel_fpm_processes(pool_name: str) -> list[dict]:
    processes: list[dict] = []
    needle = f"pool {pool_name}"
    for proc in psutil.process_iter(["pid", "username", "name", "cmdline", "cpu_percent", "memory_info", "status"]):
        try:
            cmdline = " ".join(proc.info.get("cmdline") or [])
            name = proc.info.get("name") or ""
            if needle not in cmdline and needle not in name:
                continue
            mem = proc.info.get("memory_info")
            processes.append({
                "pid": proc.info["pid"],
                "user": proc.info.get("username"),
                "name": name,
                "status": proc.info.get("status"),
                "cpuPercent": float(proc.info.get("cpu_percent") or 0),
                "memoryBytes": int(getattr(mem, "rss", 0) or 0),
                "cmdline": cmdline,
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return processes


def _socket_queue(socket_path: str) -> dict:
    result = run_command(["ss", "-xln"], allow_live=DEPLOYMENT_COMMANDS_LIVE)
    stdout = result.get("stdout") or ""
    queue = {"recvQ": None, "sendQ": None, "raw": ""}
    for line in stdout.splitlines():
        if socket_path not in line:
            continue
        parts = line.split()
        if len(parts) >= 4:
            try:
                queue["recvQ"] = int(parts[2])
                queue["sendQ"] = int(parts[3])
            except ValueError:
                pass
        queue["raw"] = line.strip()
        break
    return {**queue, "result": result}


def _laravel_slowlog(pool_name: str, lines: int = 80) -> dict:
    candidates = [
        Path("/var/log/php-fpm") / f"{pool_name}-slow.log",
        Path("/var/log") / f"{pool_name}-slow.log",
    ]
    for path in candidates:
        if path.exists():
            stat = path.stat()
            return {
                "path": str(path),
                "exists": True,
                "sizeBytes": stat.st_size,
                "modifiedAt": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                "text": _tail_text(path, lines),
            }
    return {"path": str(candidates[0]), "exists": False, "sizeBytes": 0, "modifiedAt": None, "text": ""}


def _active_nginx_upstreams_for_server(server_name: str | None) -> list[dict]:
    if not server_name:
        return []
    tokens = server_name_tokens(server_name)
    upstreams: list[dict] = []
    for scan_dir in _nginx_scan_dirs():
        root = Path(scan_dir)
        if not root.is_dir():
            continue
        for conf_path in root.iterdir():
            try:
                target = conf_path.resolve() if conf_path.is_symlink() else conf_path
                text = target.read_text(encoding="utf-8", errors="ignore")
                claimed = server_name_directive_tokens(text)
                if not any(token in claimed for token in tokens):
                    continue
                for match in re.finditer(r"\b(?:fastcgi_pass|proxy_pass)\s+([^;]+);", text):
                    upstreams.append({"file": conf_path.name, "path": str(conf_path), "upstream": match.group(1).strip()})
            except OSError:
                continue
    return upstreams


def _stale_artisan_serve_processes(root_path: str, port: int | None) -> list[dict]:
    root = str(Path(root_path).resolve())
    processes: list[dict] = []
    for proc in psutil.process_iter(["pid", "username", "cmdline", "cpu_percent", "memory_info"]):
        try:
            cmdline = " ".join(proc.info.get("cmdline") or [])
            if "artisan serve" not in cmdline and "/server.php" not in cmdline:
                continue
            if root not in cmdline and (not port or f":{port}" not in cmdline and f"--port {port}" not in cmdline):
                continue
            mem = proc.info.get("memory_info")
            processes.append({
                "pid": proc.info["pid"],
                "user": proc.info.get("username"),
                "cpuPercent": float(proc.info.get("cpu_percent") or 0),
                "memoryBytes": int(getattr(mem, "rss", 0) or 0),
                "cmdline": cmdline,
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return processes


@router.post("/laravel/runtime-status")
def laravel_runtime_status(body: LaravelRuntimeRequest) -> dict:
    info = path_info(body.rootPath)
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", ["laravel-runtime-status", body.name], info)
    pool_name = laravel_fpm_pool_name(body.deploymentId)
    socket_path = laravel_fpm_socket(body.deploymentId)
    config_path = laravel_fpm_config_path(body.deploymentId)
    processes = _laravel_fpm_processes(pool_name)
    queue = _socket_queue(socket_path)
    nginx_upstreams = _active_nginx_upstreams_for_server(body.serverName)
    expected_upstream = f"unix:{socket_path}"
    active_socket = any(item.get("upstream") == expected_upstream for item in nginx_upstreams)
    stale_supervisor = supervisor_program_path(body.name).exists()
    stale_artisan = _stale_artisan_serve_processes(body.rootPath, body.upstreamPort)
    slowlog = _laravel_slowlog(pool_name)
    return {
        "dryRun": False,
        "returncode": 0 if Path(socket_path).exists() and active_socket else 1,
        "path": info,
        "poolName": pool_name,
        "socketPath": socket_path,
        "socketExists": Path(socket_path).exists(),
        "configPath": str(config_path),
        "configExists": config_path.exists(),
        "processCount": len(processes),
        "processes": processes,
        "queue": queue,
        "slowlog": slowlog,
        "nginx": {
            "serverName": body.serverName,
            "expectedUpstream": expected_upstream,
            "activeSocket": active_socket,
            "upstreams": nginx_upstreams,
        },
        "staleSupervisor": {
            "configured": stale_supervisor,
            "program": body.name,
            "configPath": str(supervisor_program_path(body.name)),
            "artisanServeProcesses": stale_artisan,
        },
    }


@router.post("/laravel/runtime-repair")
def laravel_runtime_repair(body: LaravelRuntimeRequest) -> dict:
    process_result = laravel_fpm_process(ProcessRequest(
        deploymentId=body.deploymentId,
        name=body.name,
        rootPath=body.rootPath,
        action="start",
        processManager=body.processManager,
        startCommand=body.startCommand or "php-fpm",
        port=body.upstreamPort,
        framework="LARAVEL",
        logDir=body.logDir,
    ))
    status = laravel_runtime_status(body)
    failed = process_result.get("returncode", 0) != 0 or status.get("returncode", 0) != 0
    return {
        "dryRun": bool(process_result.get("dryRun")),
        "returncode": 1 if failed else 0,
        "process": process_result,
        "status": status,
    }


@router.post("/laravel/timing")
def laravel_timing(body: LaravelTimingRequest) -> dict:
    samples: list[dict] = []
    for index in range(body.samples):
        result = run_command([
            "curl",
            "-sS",
            "-o", "/dev/null",
            "--max-time", "60",
            "-w", "code=%{http_code} start=%{time_starttransfer} total=%{time_total}",
            body.url,
        ], allow_live=DEPLOYMENT_COMMANDS_LIVE)
        stdout = result.get("stdout") or ""
        parsed = {"index": index + 1, "httpCode": 0, "startTransferSeconds": None, "totalSeconds": None, "result": result}
        for token in stdout.split():
            key, _, value = token.partition("=")
            if key == "code":
                try:
                    parsed["httpCode"] = int(value)
                except ValueError:
                    parsed["httpCode"] = 0
            if key == "start":
                try:
                    parsed["startTransferSeconds"] = float(value)
                except ValueError:
                    pass
            if key == "total":
                try:
                    parsed["totalSeconds"] = float(value)
                except ValueError:
                    pass
        samples.append(parsed)
        if index < body.samples - 1:
            time.sleep(0.25)
    totals = sorted(item["totalSeconds"] for item in samples if isinstance(item.get("totalSeconds"), float))
    p50 = totals[len(totals) // 2] if totals else None
    p95 = totals[min(len(totals) - 1, int(len(totals) * 0.95))] if totals else None
    return {
        "dryRun": any((item["result"] or {}).get("dryRun") for item in samples),
        "returncode": 0 if samples and all((item["result"] or {}).get("returncode", 0) == 0 for item in samples) else 1,
        "url": body.url,
        "samples": samples,
        "p50Seconds": p50,
        "p95Seconds": p95,
    }


def laravel_worker_status(body: LaravelWorkersRequest) -> dict:
    info = path_info(body.rootPath)
    return {
        "name": body.name,
        "desiredWorkers": body.desiredWorkers,
        "path": info,
        "status": _supervisor_group_status(body.name),
    }


def laravel_workers_apply(body: LaravelWorkersRequest) -> dict:
    info = path_info(body.rootPath)
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", ["supervisorctl", "restart", f"{body.name}:*"], info)
    try:
        log_dir = safe_log_dir(body.name, body.logDir)
    except ValueError as error:
        return blocked_command(str(error), ["supervisorctl", "restart", f"{body.name}:*"], info)

    if body.desiredWorkers <= 0 or body.action == "stop":
        removed = _remove_supervisor_program(body.name)
        return {
            "dryRun": any(step.get("dryRun") for step in removed.values() if isinstance(step, dict)),
            "command": ["supervisorctl", "stop", f"{body.name}:*"],
            "returncode": 1 if any(step.get("returncode", 0) != 0 for step in removed.values() if isinstance(step, dict)) else 0,
            "path": info,
            "desiredWorkers": 0,
            "runningWorkers": 0,
            **removed,
        }

    ensure = _ensure_laravel_env(body.rootPath, None, body.env)
    if ensure.get("returncode") != 0:
        return ensure
    writable = repair_laravel_writable_paths(LaravelWritablePathsRequest(rootPath=body.rootPath))
    if writable.get("returncode") != 0:
        return writable

    log_dir.mkdir(parents=True, exist_ok=True)
    make_panel_owned(log_dir)
    config_dir = supervisor_config_dir()
    config_path = supervisor_program_path(body.name)
    config_dir.mkdir(parents=True, exist_ok=True)
    service = ensure_supervisord_running()
    write = {"dryRun": False, "command": ["write-file", str(config_path)], "stdout": "", "stderr": "", "returncode": 0}
    wrapper_path: Path | None = None
    try:
        start_command = parse_deployment_command(body.queueCommand)
        wrapper_path, runtime_env_path, laravel_env_path = prepare_supervisor_runtime(
            body.rootPath,
            start_command,
            None,
            body.env,
            effective_resource_limits(body.resourceLimits),
        )
        make_panel_owned(wrapper_path.parent)
        remove_stale_supervisor_program_configs(body.name, config_path)
        config_path.write_text(supervisor_laravel_worker_config(body, wrapper_path, log_dir), encoding="utf-8")
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
    restart = run_supervisorctl("restart", f"{body.name}:*") if update.get("returncode") == 0 else {"returncode": 1, "stderr": "Skipped because update failed"}
    if "no such process" in (restart.get("stderr") or "").lower():
        restart = run_supervisorctl("start", f"{body.name}:*")
    status = _supervisor_group_status(body.name) if restart.get("returncode") == 0 else {"returncode": 1, "stderr": "Skipped because restart failed", "processes": [], "running": 0, "configured": 0}
    steps = {"service": service, "write": write, "reread": reread, "update": update, "restart": restart, "status": status}
    failed = [name for name, step in steps.items() if isinstance(step, dict) and step.get("returncode", 0) != 0]
    return {
        "dryRun": any(step.get("dryRun") for step in steps.values() if isinstance(step, dict)),
        "blocked": any(step.get("blocked") for step in steps.values() if isinstance(step, dict)),
        "liveCommandsDisabled": any(step.get("liveCommandsDisabled") for step in steps.values() if isinstance(step, dict)),
        "command": ["supervisorctl", "restart", f"{body.name}:*"],
        "cwd": deployment_cwd(body.rootPath),
        "stdout": json.dumps(status.get("processes", []), separators=(",", ":")),
        "stderr": "; ".join(f"{name}: {format_supervisor_step_error(steps[name])}" for name in failed),
        "returncode": 1 if failed else 0,
        "path": info,
        "configPath": str(config_path),
        "wrapperPath": str(wrapper_path) if wrapper_path else None,
        "desiredWorkers": body.desiredWorkers,
        "runningWorkers": status.get("running", 0),
        **steps,
    }


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
            effective_resource_limits(body.resourceLimits),
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
        "--max-memory-restart",
        f"{(effective_resource_limits(body.resourceLimits) or {}).get('memoryMaxMb', settings.deployment_memory_max_mb)}M",
        # 3 s between crash-restarts so port is released before PM2 retries, preventing
        # a tight loop that exhausts the restart counter and leaves the app permanently down.
        "--restart-delay",
        str(body.restartDelayMs or 3000),
        "--",
        *start_command[1:],
    ]
    # Runtime PORT must stay panel-owned so Nginx points at the process that actually starts.
    process_env = constrained_runtime_env({**scrub_node_host_runtime_env(body.env or {}, body.framework), **pm2_env(body.port)}, effective_resource_limits(body.resourceLimits))
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
    delete = guarded_command(body.rootPath, ["pm2", "delete", body.name], cwd=cwd) if stop.get("returncode") == 0 else {
        "dryRun": stop.get("dryRun", False),
        "command": ["pm2", "delete", body.name],
        "cwd": cwd,
        "stdout": "",
        "stderr": "Skipped because pm2 stop failed",
        "returncode": 1,
    }
    if "not found" in (delete.get("stderr") or "").lower() or "not found" in (delete.get("stdout") or "").lower():
        delete["returncode"] = 0
    save = guarded_command(body.rootPath, ["pm2", "save"], cwd=cwd) if delete.get("returncode") == 0 else {
        "dryRun": stop.get("dryRun", False),
        "command": ["pm2", "save"],
        "cwd": cwd,
        "stdout": "",
        "stderr": "Skipped because pm2 delete failed",
        "returncode": 1,
    }
    return combine_pm2_results(body.rootPath, {"stop": stop, "delete": delete, "save": save}, ["stop", "delete", "save"])


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
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            return "\n".join(lines[-body.lines:])
        except OSError as error:
            return f"(could not read: {error})"

    def log_section(label: str, path: Path, value: str | None = None) -> tuple[str, str]:
        content = value if value is not None else tail(path)
        return (f"== {label} ({path}) ==", content or "(empty)")

    def laravel_log_files(root: Path) -> list[Path]:
        logs_dir = root / "storage" / "logs"
        if not logs_dir.exists() or not logs_dir.is_dir():
            return [logs_dir / "laravel.log"]
        candidates = [
            path for path in logs_dir.glob("*.log")
            if path.is_file() and path.name.startswith(("laravel", "lumen"))
        ]
        if not candidates:
            return [logs_dir / "laravel.log"]

        def modified_at(path: Path) -> float:
            try:
                return path.stat().st_mtime
            except OSError:
                return 0

        return sorted(candidates, key=modified_at, reverse=True)[:5]

    stdout = tail(log_dir / "running-out.log")
    stderr = tail(log_dir / "running-error.log")
    sections = [
        log_section("STDOUT", log_dir / "running-out.log", stdout),
        log_section("STDERR", log_dir / "running-error.log", stderr),
    ]
    laravel_parts: list[str] = []
    if body.rootPath:
        root = Path(body.rootPath).resolve()
        info = path_info(str(root))
        if info["allowed"]:
            for path in laravel_log_files(root):
                content = tail(path)
                laravel_parts.append(content)
                sections.append(log_section("LARAVEL", path, content))
        else:
            sections.append(("== APPLICATION LOGS ==", "(root path is outside the allowed file root)"))
    else:
        sections.append(("== APPLICATION LOGS ==", "(root path not requested)"))

    text = "\n\n".join(f"{heading}\n{content}" for heading, content in sections)
    laravel = "\n\n".join(part for part in laravel_parts if part)
    return {"ok": True, "logDir": str(log_dir), "stdout": stdout, "stderr": stderr, "laravel": laravel, "text": text}


@router.post("/metrics")
def deployment_metrics(body: DeploymentMetricsRequest) -> dict:
    root = str(Path(body.rootPath).resolve())
    info = path_info(root)
    if not info["allowed"]:
        return {
            "ok": False,
            "path": info,
            "error": "Path escapes configured file manager root",
            "process": {"cpuPercent": 0, "memoryBytes": 0, "processes": [], "processCount": 0},
            "history": [],
            "storage": {"rootPath": root, "bytes": 0},
            "database": {"engine": body.dbType, "name": body.dbName, "sizeBytes": 0, "available": False},
            "traffic": {"incomingBytes": 0, "outgoingBytes": 0, "bandwidthBytes": 0, "requests": 0, "sources": [], "windowHours": 24},
            "logs": {"ok": False, "text": "", "stdout": "", "stderr": "", "laravel": ""},
        }

    if body.processOnly:
        process = deployment_process_metrics(root, body.name, body.port, body.deploymentId, body.framework)
        return {
            "ok": True,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "path": info,
            "process": process,
        }

    db_size = 0
    db_available = False
    if body.dbType and body.dbName:
        try:
            from app.routers.database import mysql_overview, postgres_overview
            overview = postgres_overview() if body.dbType.upper() == "POSTGRESQL" else mysql_overview()
            db_available = bool(overview.get("installed"))
            for database in overview.get("databases", []):
                if database.get("name") == body.dbName:
                    db_size = int(database.get("sizeBytes") or 0)
                    break
        except Exception:
            db_available = False

    process = deployment_process_metrics(root, body.name, body.port, body.deploymentId, body.framework)
    logs = runtime_logs(RuntimeLogsRequest(
        name=body.name,
        logDir=body.logDir,
        rootPath=root,
        lines=body.logLines,
    ))
    history = update_metrics_history(body.name, process)
    return {
        "ok": True,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "path": info,
        "process": process,
        "history": history,
        "storage": {"rootPath": root, "bytes": directory_size_bytes(root)},
        "database": {
            "engine": body.dbType,
            "name": body.dbName,
            "sizeBytes": db_size,
            "available": db_available,
        },
        "traffic": deployment_traffic_metrics(body.deploymentId, body.serverNames),
        "logs": logs,
    }


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
    info = path_info(body.rootPath)
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", ["git", "sync", str(target)], info)
    if settings.allow_live_system_commands:
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            return {
                "dryRun": False,
                "command": ["mkdir", "-p", str(target.parent)],
                "path": info,
                "stdout": "",
                "stderr": str(error),
                "returncode": 1,
            }
    env = git_auth_env(body.gitToken)
    safe = git_safe_directory(body.rootPath, target)
    if target.joinpath(".git").exists():
        remote = git_command_with_safe_directory(body.rootPath, target, ["git", "-C", str(target), "remote", "set-url", "origin", body.gitUrl], env=env, resource_limits=body.resourceLimits) if body.gitUrl else None
        fetch = git_command_with_safe_directory(body.rootPath, target, ["git", "-C", str(target), "fetch", "origin", body.branch, "--prune"], env=env, resource_limits=body.resourceLimits)
        fetch_commit = git_rev_parse(body.rootPath, target, "FETCH_HEAD", env=env, resource_limits=body.resourceLimits) if git_success(fetch) else None
        desired_sha = body.commitSha or ((fetch_commit.get("stdout") or "").strip() if fetch_commit else None)
        desired_available = None
        fetch_commit_sha = None
        if body.commitSha and git_success(fetch):
            desired_available = git_commit_available(body.rootPath, target, body.commitSha, env=env, resource_limits=body.resourceLimits)
            if not git_success(desired_available):
                fetch_commit_sha = git_command_with_safe_directory(body.rootPath, target, ["git", "-C", str(target), "fetch", "origin", body.commitSha], env=env, resource_limits=body.resourceLimits)
                desired_available = git_commit_available(body.rootPath, target, body.commitSha, env=env, resource_limits=body.resourceLimits)
        reset_target = desired_sha or "FETCH_HEAD"
        reset = git_command_with_safe_directory(body.rootPath, target, ["git", "-C", str(target), "reset", "--hard", reset_target], env=env, resource_limits=body.resourceLimits) if git_success(fetch) and (not body.commitSha or git_success(desired_available)) else {
            "dryRun": False,
            "command": ["git", "-C", str(target), "reset", "--hard", reset_target],
            "stdout": "",
            "stderr": "Skipped because git fetch failed or requested commit is not available locally.",
            "returncode": 1,
        }
        clean = git_command_with_safe_directory(body.rootPath, target, ["git", "-C", str(target), "clean", "-fd"], env=env, resource_limits=body.resourceLimits) if git_success(reset) else {
            "dryRun": False,
            "command": ["git", "-C", str(target), "clean", "-fd"],
            "stdout": "",
            "stderr": "Skipped because git reset failed.",
            "returncode": 1,
        }
        commit = git_commit_info(body.rootPath, target, env)
        verify = git_sync_verify_result(desired_sha, commit) if git_success(reset) and desired_sha else {
            "dryRun": False,
            "command": ["git", "verify-head", desired_sha or ""],
            "stdout": "",
            "stderr": "Skipped because no expected commit could be resolved.",
            "returncode": 1,
            "expectedSha": desired_sha,
            "actualSha": commit.get("sha"),
        }
        return {"safeDirectory": safe, "remote": remote, "sync": fetch, "fetchHead": fetch_commit, "fetchCommit": fetch_commit_sha, "commitAvailable": desired_available, "reset": reset, "clean": clean, "commit": commit, "verify": verify}
    if body.gitUrl:
        command = ["git", "clone", "--branch", body.branch, body.gitUrl, str(target)]
    else:
        command = ["git", "-C", str(target), "fetch", "--all", "--prune"]
    result = git_command_with_safe_directory(body.rootPath, target, command, env=env, resource_limits=body.resourceLimits)
    checkout = None
    desired_available = None
    if body.commitSha:
        desired_available = git_commit_available(body.rootPath, target, body.commitSha, env=env, resource_limits=body.resourceLimits) if git_success(result) else None
        if not git_success(desired_available):
            fetch_commit_sha = git_command_with_safe_directory(body.rootPath, target, ["git", "-C", str(target), "fetch", "origin", body.commitSha], env=env, resource_limits=body.resourceLimits) if target.joinpath(".git").exists() else None
            desired_available = git_commit_available(body.rootPath, target, body.commitSha, env=env, resource_limits=body.resourceLimits) if fetch_commit_sha else desired_available
        checkout = git_command_with_safe_directory(body.rootPath, target, ["git", "-C", str(target), "checkout", body.commitSha], env=env, resource_limits=body.resourceLimits) if git_success(desired_available) else {
            "dryRun": False,
            "command": ["git", "-C", str(target), "checkout", body.commitSha],
            "stdout": "",
            "stderr": "Skipped because requested commit is not available after clone/fetch.",
            "returncode": 1,
        }
    elif not body.gitUrl:
        checkout = git_command_with_safe_directory(body.rootPath, target, ["git", "-C", str(target), "checkout", body.branch], env=env, resource_limits=body.resourceLimits)
    commit = git_commit_info(body.rootPath, target, env) if target.joinpath(".git").exists() else None
    expected_sha = body.commitSha
    verify = git_sync_verify_result(expected_sha, commit) if expected_sha and commit else None
    return {"safeDirectory": safe, "sync": result, "commitAvailable": desired_available, "checkout": checkout, "commit": commit, "verify": verify}


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
    return guarded_deployment_command(body.rootPath, command, env=env or None, resource_limits=body.resourceLimits, timeout=body.timeoutSeconds)


@router.post("/build")
def build(body: CommandRequest) -> dict:
    command = body.command or "true"
    return guarded_deployment_command(body.rootPath, command, env=body.env, resource_limits=body.resourceLimits, timeout=body.timeoutSeconds)


@router.post("/migrate")
def migrate(body: CommandRequest) -> dict:
    command = body.command or "true"
    return guarded_deployment_command(body.rootPath, command, env=body.env, resource_limits=body.resourceLimits, timeout=body.timeoutSeconds)


@router.post("/process")
def process(body: ProcessRequest) -> dict:
    body = normalize_process_root(body)
    normalized_start = (body.startCommand or "").strip().lower()
    explicit_octane = "artisan octane:start" in normalized_start or "rr serve" in normalized_start or "roadrunner" in normalized_start
    if (body.framework or "").upper() == "LARAVEL" and not explicit_octane:
        return laravel_fpm_process(body)
    manager = (body.processManager or "NONE").upper()
    if manager == "PM2":
        if body.action in {"start", "restart"}:
            try:
                start_command = parse_deployment_command(
                    normalize_laravel_start_command(body.startCommand, body.port, body.rootPath) or "npm run start"
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
                    normalize_laravel_start_command(body.startCommand, body.port, body.rootPath) or "true"
                )
            except ValueError as error:
                return blocked_command(str(error), [body.startCommand or "true"], path_info(body.rootPath))
            return supervisor_start(body, start_command)
        command = ["supervisorctl", body.action, body.name]
    elif manager == "SYSTEMD":
        command = ["systemctl", body.action, body.name]
    else:
        return guarded_deployment_command(body.rootPath, body.startCommand or "true", resource_limits=body.resourceLimits)
    return guarded_command(body.rootPath, command)


@router.post("/laravel-workers")
def laravel_workers(body: LaravelWorkersRequest) -> dict:
    body.name = re.sub(r"[^a-zA-Z0-9_.-]+", "-", body.name).strip("-") or "laravel-queue"
    original_workers = body.desiredWorkers
    body.desiredWorkers = clamp_worker_count(body.desiredWorkers)
    if body.action == "status":
        return laravel_worker_status(body)
    if body.action == "stop":
        body.desiredWorkers = 0
    result = laravel_workers_apply(body)
    if original_workers != body.desiredWorkers:
        result["requestedWorkers"] = original_workers
        result["workerLimit"] = settings.deployment_worker_max
    return result


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


def _remove_managed_nginx_config(config_name: str) -> list[str]:
    removed: list[str] = []
    for root in [nginx_sites_enabled(), nginx_sites_available()]:
        try:
            target = safe_nginx_path(root, config_name)
            if target.exists() or target.is_symlink():
                target.unlink()
                removed.append(str(target))
        except OSError:
            pass
    return removed


def _public_route_upstream_failed(result: dict) -> bool:
    http_code = result.get("httpCode")
    detail = f"{result.get('stderr') or ''}\n{result.get('stdout') or ''}".lower()
    return http_code in {502, 503, 504} or any(
        token in detail
        for token in ("bad gateway", "upstream", "connect() failed", "connection refused")
    )


def _laravel_nginx_post_reload_check(server_name: str, public_root: str, framework: str | None, *, require_https: bool) -> dict:
    route = _curl_public_route(server_name, "/", public_root, framework, require_https=require_https)
    if not _public_route_upstream_failed(route):
        return {**route, "returncode": 0}
    return {
        **route,
        "returncode": 1,
        "stderr": route.get("stderr") or f"HTTP {route.get('httpCode')} after Nginx reload",
    }


def _nginx_route_ownership_probe(server_name: str, config_name: str, *, require_https: bool) -> dict:
    if server_name_has_wildcard(server_name):
        result = run_command(["nginx", "-T"], allow_live=True)
        output = f"{result.get('stdout') or ''}\n{result.get('stderr') or ''}"
        output_lower = output.lower()
        if (
            result.get("returncode") == 0
            and f"server_name {server_name.lower()};" in output_lower
            and route_ownership_config_seen(output, config_name)
        ):
            return result
        return {
            **result,
            "returncode": 1,
            "stderr": (
                f"Generated wildcard vhost {config_name!r} is not present in the active nginx config; "
                f"missing server_name {server_name!r} or {ROUTE_OWNERSHIP_HEADER} header."
            ),
        }

    primary = probe_host_for_server_name(server_name)
    scheme = "https" if require_https else "http"
    port = "443" if require_https else "80"
    command = [
        "curl",
        "-sS",
        "-i",
        "--http1.1",
        *(["-k"] if require_https else []),
        "--connect-to",
        f"{primary}:{port}:127.0.0.1:{port}",
        "--max-time",
        "10",
        "--noproxy",
        "*",
        f"{scheme}://{primary}/",
    ]
    result = run_command(command, allow_live=True)
    output = f"{result.get('stdout') or ''}\n{result.get('stderr') or ''}"
    if result.get("returncode") == 0 and route_ownership_header_seen(output, config_name):
        return result
    conflicts = loaded_conflicting_config_files(config_name, server_name)
    conflict_hint = f" Loaded conflicting nginx configs: {', '.join(conflicts)}." if conflicts else ""
    return {
        **result,
        "returncode": 1,
        "stderr": (
            f"Generated vhost {config_name!r} is not the active {scheme.upper()} route for {primary}; "
            f"missing {ROUTE_OWNERSHIP_HEADER} response header.{conflict_hint}"
        ),
    }


def _deployment_nginx_post_reload_check(server_name: str, config_name: str, public_root: str, framework: str | None, *, require_https: bool) -> dict:
    ownership = _nginx_route_ownership_probe(server_name, config_name, require_https=require_https)
    if (framework or "").upper() == "LARAVEL":
        route = _laravel_nginx_post_reload_check(server_name, public_root, framework, require_https=require_https)
    else:
        route = _curl_public_route(server_name, "/", public_root, framework, require_https=require_https)
        if _public_route_upstream_failed(route):
            route = {
                **route,
                "returncode": 1,
                "stderr": route.get("stderr") or f"HTTP {route.get('httpCode')} after Nginx reload",
            }

    if route.get("returncode") == 0 and not _public_route_upstream_failed(route):
        if ownership.get("returncode") != 0:
            route["ownershipWarning"] = {
                "stderr": ownership.get("stderr"),
                "returncode": ownership.get("returncode"),
                "command": ownership.get("command"),
            }
            route["stderr"] = (
                f"{route.get('stderr') or ''}\n"
                f"Route ownership header was not visible after reload, but public route returned HTTP {route.get('httpCode')}; keeping the new vhost active."
            ).strip()
        return {**route, "returncode": 0}

    if ownership.get("returncode") != 0:
        return ownership
    return ownership


@router.post("/nginx-retire")
def nginx_retire(body: RetireNginxRouteRequest) -> dict:
    try:
        if not body.serverName:
            return {
                "skipped": True,
                "reason": "No domain/serverName linked to deployment",
                "serverName": None,
            }

        server_name = body.serverName
        config_name = nginx_config_name(body.deploymentId, server_name)
        if not settings.allow_live_nginx:
            return {
                "dryRun": True,
                "serverName": server_name,
                "configName": config_name,
                "removedManaged": [],
                "scrubbed": {"removedConflicts": [], "removedInsecurePort443": []},
                "test": run_command(["nginx", "-t"], allow_live=False),
                "reload": run_command(["systemctl", "reload", "nginx"], allow_live=False),
            }

        removed_managed = run_live_step("remove retired deployment nginx config", lambda: _remove_managed_nginx_config(config_name))
        scrubbed = run_live_step("remove retired hostname nginx conflicts", lambda: _scrub_hostname_nginx_configs(config_name, server_name))
        test = run_command(["nginx", "-t"], allow_live=True)
        reload_result = (
            run_command(["systemctl", "reload", "nginx"], allow_live=True)
            if test.get("returncode") == 0
            else {"dryRun": False, "command": ["systemctl", "reload", "nginx"], "stdout": "", "stderr": "Skipped because nginx -t failed", "returncode": 1}
        )
        return {
            "dryRun": False,
            "serverName": server_name,
            "configName": config_name,
            "removedManaged": removed_managed,
            "scrubbed": scrubbed,
            "test": test,
            "reload": reload_result,
        }
    except HTTPException as error:
        return blocked_command(
            f"Nginx retire route blocked: {error.detail}",
            ["retire-nginx", body.serverName or body.deploymentId],
            None,
        )
    except Exception as error:
        return blocked_command(
            f"Nginx retire route failed: {error}",
            ["retire-nginx", body.serverName or body.deploymentId],
            None,
        )


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
        fpm_preflight = None
        if (body.framework or "").upper() == "LARAVEL" and not Path(laravel_fpm_socket(body.deploymentId)).exists():
            fpm_preflight = laravel_fpm_process(
                ProcessRequest(
                    deploymentId=body.deploymentId,
                    name=body.deploymentId,
                    rootPath=body.rootPath,
                    action="start",
                    processManager="SUPERVISOR",
                    startCommand="php-fpm",
                    port=body.upstreamPort,
                    framework="LARAVEL",
                )
            )
            if fpm_preflight.get("returncode", 0) != 0:
                return {
                    **blocked_command(
                        "Laravel PHP-FPM pool could not be prepared before publishing Nginx",
                        ["write-nginx", config_name],
                        path_info(body.rootPath),
                    ),
                    "fpmPreflight": fpm_preflight,
                }
        scrubbed = _scrub_hostname_nginx_configs(config_name, server_name) if settings.allow_live_nginx else {"removedConflicts": [], "removedInsecurePort443": []}
        public_root = resolve_laravel_public_root(body.rootPath, body.publicDirectory)
        fallback_root = safe_web_root(body.fallbackRootPath) if body.fallbackRootPath else None
        ssl_certificate = safe_letsencrypt_path(body.sslCertificate) if body.sslCertificate else None
        ssl_certificate_key = safe_letsencrypt_path(body.sslCertificateKey) if body.sslCertificateKey else None
        has_ssl = (
            ssl_certificate is not None
            and ssl_certificate_key is not None
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
            deployment_id=body.deploymentId,
            framework=body.framework,
            public_root=public_root,
            upstream_port=body.upstreamPort,
            fallback_error_page=fallback_error_page,
            fallback_location=fallback_location,
            loopback_proxy_host=body.loopbackProxyHost,
        )
        acme_root = fallback_root or public_root
        if body.forceSsl and has_ssl:
            http_location = (
                f"{acme_location(server_name, acme_root)}"
                "    location / {\n"
                "        return 301 https://$host$request_uri;\n"
                "    }\n"
            )
        else:
            http_location = f"{acme_location(server_name, acme_root)}{app_locations}"

        access_log = Path("/var/log/nginx") / f"vps-panel-{config_name}.access.log"
        error_log = Path("/var/log/nginx") / f"vps-panel-{config_name}.error.log"
        config = f"""
server {{
{nginx_listen_directives(80).rstrip()}
    server_name {server_name};
    access_log {access_log} combined;
    error_log {error_log} warn;
{route_ownership_header(config_name)}

{http_location}}}
""".lstrip()
        if has_ssl:
            config += f"""

server {{
{nginx_listen_directives(443, ssl=True, http2=True).rstrip()}
    server_name {server_name};
    access_log {access_log} combined;
    error_log {error_log} warn;
    ssl_certificate {ssl_certificate};
    ssl_certificate_key {ssl_certificate_key};
{route_ownership_header(config_name)}
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header Content-Security-Policy "upgrade-insecure-requests" always;

{acme_location(server_name, acme_root)}{app_locations}
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
            post_reload_check=lambda: _deployment_nginx_post_reload_check(
                server_name,
                config_name,
                str(public_root),
                body.framework,
                require_https=has_ssl and body.forceSsl,
            ),
            rollback_on_post_reload_failure=not (has_ssl and body.requireSsl),
        )
        return {
            **result,
            "path": info,
            "serverName": server_name,
            "scrubbed": scrubbed,
            "fpmPreflight": fpm_preflight,
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
    primary = probe_host_for_server_name(server_name)
    clean_path = path if path.startswith("/") else f"/{path}"
    is_laravel = (framework or "").upper() == "LARAVEL"
    use_https = require_https and letsencrypt_certificate_exists(server_name)

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
        dns_failed_ssl = dns_probe.get("returncode") in {35, 51, 60}
        ip_failed_ssl = bool(ip_probe and ip_probe.get("returncode") in {35, 51, 60})
        if dns_failed_ssl or ip_failed_ssl:
            result["degraded"] = True
            result["returncode"] = 0
            hints = [
                "Local nginx HTTPS on 127.0.0.1:443 works, but the public internet path does not serve a valid certificate for this hostname.",
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


def _cwd_belongs_to_deployment(cwd: str | None, root_path: str) -> bool:
    if not cwd:
        return False
    owner_cwd = Path(str(cwd)).resolve()
    expected_root = Path(root_path).resolve()
    if owner_cwd == expected_root:
        return True
    try:
        owner_cwd.relative_to(expected_root / ".panel-releases")
        return True
    except ValueError:
        return False


def _pids_from_ss_output(output: str) -> list[int]:
    return [int(value) for value in re.findall(r"pid=(\d+)", output)]


def _process_cwd(pid: int) -> str | None:
    try:
        return str(Path(f"/proc/{pid}/cwd").resolve())
    except OSError:
        return None


def _ss_owner_cwd_matches(output: str, root_path: str) -> tuple[bool, list[dict]]:
    owners = []
    for pid in _pids_from_ss_output(output):
        cwd = _process_cwd(pid)
        matches = _cwd_belongs_to_deployment(cwd, root_path)
        owners.append({"pid": pid, "cwd": cwd, "cwdMatches": matches})
        if matches:
            return True, owners
    return False, owners


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
    if (body.framework or "").upper() == "LARAVEL":
        return None
    if not body.processName or (body.processManager or "").upper() != "SUPERVISOR":
        return None
    if shutil.which("supervisorctl") is None:
        return "Supervisor is not installed. Approve the install-supervisor runtime tool action, then redeploy."
    result = run_supervisorctl("status", body.processName)
    if result.get("dryRun"):
        return None
    if result.get("returncode") != 0:
        return result.get("stderr") or result.get("stdout") or f"Supervisor process '{body.processName}' was not found."
    stdout = result.get("stdout") or ""
    if "RUNNING" not in stdout:
        return f"Supervisor process '{body.processName}' is not RUNNING: {stdout.strip()}"
    return None


def _health_runtime_logs(body: HealthRequest) -> dict | None:
    if not body.processName:
        return None
    logs = runtime_logs(RuntimeLogsRequest(name=body.processName, logDir=body.logDir, rootPath=body.rootPath, lines=120))
    return logs if logs.get("ok") else None


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
        "swoole": {"swoole", "openswoole"},
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
    result = {"name": name, "installed": bool(path), "path": path}
    if name == "php" and path:
        version = _run_probe(["php", "-r", "echo PHP_MAJOR_VERSION.'.'.PHP_MINOR_VERSION;"])
        result["version"] = version.stdout.strip() if version and version.returncode == 0 else None
    return result


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


def _python_launcher_packages(start_command: str | None) -> list[str]:
    if not start_command:
        return []
    try:
        parsed = parse_deployment_command(start_command)
    except ValueError:
        try:
            parsed = shlex.split(start_command)
        except ValueError:
            return []
    joined = " ".join(parsed).lower()
    packages: list[str] = []
    for package in ("uvicorn", "gunicorn", "flask"):
        executable_match = parsed and Path(parsed[0]).name.lower() == package
        module_match = f" -m {package}" in f" {joined}"
        if executable_match or module_match:
            packages.append(package)
    return packages


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
    launcher_packages = _python_launcher_packages(body.startCommand)
    if launcher_packages:
        install_steps["launchers"] = guarded_command(str(root), [venv_python, "-m", "pip", "install", *launcher_packages], cwd=str(root))

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


@router.post("/resource-snapshot")
def resource_snapshot(body: ResourceSnapshotRequest) -> dict:
    memory = psutil.virtual_memory()
    swap = psutil.swap_memory()
    cpu_count = psutil.cpu_count() or 1
    running_apps = deployment_resource_process_snapshot(body.rootPath)
    active_limits = deployment_resource_limits()
    return {
        "memory": {
            "totalBytes": memory.total,
            "availableBytes": memory.available,
            "usedBytes": memory.used,
            "percent": memory.percent,
        },
        "swap": {
            "totalBytes": swap.total,
            "freeBytes": swap.free,
            "usedBytes": swap.used,
            "percent": swap.percent,
        },
        "cpu": {
            "count": cpu_count,
            "percent": psutil.cpu_percent(interval=0.1),
            "loadAverage": psutil.getloadavg() if hasattr(psutil, "getloadavg") else [0, 0, 0],
        },
        "runningApps": running_apps,
        "defaults": {
            "resourceIsolationEnabled": settings.deployment_resource_isolation_enabled,
            "resourceLimits": active_limits,
        },
    }


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


@router.post("/laravel/production-env")
def patch_laravel_production_env(body: LaravelProductionEnvRequest) -> dict:
    info = path_info(body.rootPath)
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", ["patch-laravel-production-env", body.rootPath], info)

    root = Path(body.rootPath).resolve()
    env_path = root / ".env"
    if not (root / "artisan").is_file():
        return {
            "dryRun": False,
            "returncode": 1,
            "stdout": "",
            "stderr": "Laravel artisan file was not found",
            "path": info,
        }

    existing = read_existing_env_values(env_path)
    existing.update(body.values)
    if not is_valid_laravel_app_key(existing.get("APP_KEY")):
        return {
            "dryRun": False,
            "returncode": 1,
            "stdout": "",
            "stderr": "Laravel APP_KEY is missing or invalid; Guardian will not rotate it during production tuning",
            "path": info,
            "envPath": str(env_path),
        }
    write_laravel_env_bundle(str(root), existing)
    clear_laravel_bootstrap_config_cache(str(root))
    config_clear = guarded_deployment_command(
        str(root),
        "php artisan config:clear",
        env=existing,
    )
    config_cache = (
        guarded_deployment_command(str(root), "php artisan config:cache", env=existing)
        if config_clear.get("returncode") == 0
        else {"returncode": 1, "stderr": "Skipped because config:clear failed"}
    )
    return {
        "dryRun": False,
        "returncode": config_cache.get("returncode", 1),
        "stdout": f"Patched production keys in {env_path}",
        "stderr": config_cache.get("stderr") or config_clear.get("stderr") or "",
        "path": info,
        "envPath": str(env_path),
        "changedKeys": sorted(body.values),
        "configClear": config_clear,
        "configCache": config_cache,
    }


def verify_laravel_public_index(root_path: str) -> dict:
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
    return {
        "dryRun": False,
        "command": ["verify-file", str(index_path)],
        "stdout": "Skipped public/index.php repair: Laravel public directory exists but no front controller was found",
        "stderr": "",
        "returncode": 0,
        "skipped": True,
        "created": False,
    }


@router.post("/laravel/ensure-public-index")
def ensure_laravel_public_index(body: LaravelWritablePathsRequest) -> dict:
    root = Path(body.rootPath).resolve()
    info = path_info(str(root))
    if not info["allowed"]:
        return blocked_command("Path escapes configured file manager root", ["laravel-public-index", str(root)], info)

    artisan = root / "artisan"
    public = root / "public"
    index = public / "index.php"
    if not artisan.is_file():
        return {
            "dryRun": False,
            "command": ["skipped", "laravel-public-index", str(index)],
            "stdout": "Skipped public/index.php creation: no artisan file in deployment root",
            "stderr": "",
            "returncode": 0,
            "path": info,
            "skipped": True,
            "created": False,
        }
    if index.is_file():
        return {
            "dryRun": False,
            "command": ["verify-file", str(index)],
            "stdout": "Laravel public/index.php already exists",
            "stderr": "",
            "returncode": 0,
            "path": info,
            "created": False,
        }

    content = """<?php

use Illuminate\\Contracts\\Http\\Kernel;
use Illuminate\\Http\\Request;

define('LARAVEL_START', microtime(true));

if (file_exists($maintenance = __DIR__.'/../storage/framework/maintenance.php')) {
    require $maintenance;
}

require __DIR__.'/../vendor/autoload.php';

$app = require_once __DIR__.'/../bootstrap/app.php';

$kernel = $app->make(Kernel::class);

$response = $kernel->handle(
    $request = Request::capture()
)->send();

$kernel->terminate($request, $response);
"""

    if not DEPLOYMENT_COMMANDS_LIVE:
        return {
            "dryRun": True,
            "command": ["write-file", str(index)],
            "stdout": "Would create Laravel public/index.php",
            "stderr": "",
            "returncode": 0,
            "path": info,
            "created": False,
        }

    public.mkdir(parents=True, exist_ok=True)
    index.write_text(content, encoding="utf-8")
    try:
        make_panel_owned(public)
    except Exception:
        pass
    index.chmod(0o644)
    return {
        "dryRun": False,
        "command": ["write-file", str(index)],
        "stdout": f"Created Laravel public/index.php at {index}",
        "stderr": "",
        "returncode": 0,
        "path": info,
        "created": True,
        "indexPath": str(index),
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
    should_repair_public = (public_root / "index.php").is_file()
    public_index = (
        verify_laravel_public_index(root)
        if mkdir.get("returncode") == 0 and should_repair_public
        else {
            "dryRun": False,
            "command": ["skipped", "laravel-public-index"],
            "stdout": "Skipped public/index.php repair: deployment has no verified public web root",
            "stderr": "",
            "returncode": 0,
            "skipped": True,
        }
    )
    chown_paths = [f"{root}/storage", f"{root}/bootstrap/cache"]
    chmod_paths = [f"{root}/storage", f"{root}/bootstrap/cache"]
    if should_repair_public:
        chown_paths.append(f"{root}/public")
    chown = run_command(["chown", "-R", "panel:panel", *chown_paths], timeout=120, allow_live=DEPLOYMENT_COMMANDS_LIVE) if mkdir.get("returncode") == 0 else {"returncode": 1, "stderr": "Skipped because directory creation failed"}
    chmod = run_command(["chmod", "-R", "ug+rwX", *chmod_paths], timeout=120, allow_live=DEPLOYMENT_COMMANDS_LIVE) if mkdir.get("returncode") == 0 else {"returncode": 1, "stderr": "Skipped because directory creation failed"}
    public_chmod_command, root_chmod_command = laravel_public_permission_commands(root)
    public_chmod = (
        run_command(public_chmod_command, timeout=120, allow_live=DEPLOYMENT_COMMANDS_LIVE)
        if mkdir.get("returncode") == 0 and should_repair_public
        else {"returncode": 0, "stderr": "", "skipped": True}
    )
    root_chmod = (
        run_command(root_chmod_command, timeout=120, allow_live=DEPLOYMENT_COMMANDS_LIVE)
        if mkdir.get("returncode") == 0 and should_repair_public
        else {"returncode": 0, "stderr": "", "skipped": True}
    )
    failed = any(step.get("returncode") != 0 for step in [mkdir, public_index, chown, chmod, public_chmod, root_chmod])
    return {
        "dryRun": any(step.get("dryRun") for step in [mkdir, public_index, chown, chmod, public_chmod, root_chmod]),
        "returncode": 1 if failed else 0,
        "paths": paths,
        "publicRootRepair": should_repair_public,
        "mkdir": mkdir,
        "publicIndex": public_index,
        "chown": chown,
        "chmod": chmod,
        "publicChmod": public_chmod,
        "rootChmod": root_chmod,
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
                resource_limits=body.resourceLimits,
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
        steps["optimizeClear"] = guarded_deployment_command(body.rootPath, "php artisan optimize:clear", env=env or None, resource_limits=body.resourceLimits)
        steps["configClear"] = guarded_deployment_command(body.rootPath, "php artisan config:clear", env=env or None, resource_limits=body.resourceLimits)
        steps["cacheClear"] = guarded_deployment_command(body.rootPath, "php artisan cache:clear", env=env or None, resource_limits=body.resourceLimits)
        steps["routeClear"] = guarded_deployment_command(body.rootPath, "php artisan route:clear", env=env or None, resource_limits=body.resourceLimits)
        steps["viewClear"] = guarded_deployment_command(body.rootPath, "php artisan view:clear", env=env or None, resource_limits=body.resourceLimits)
        if laravel_has_public_web_root(body.rootPath):
            steps["storageLink"] = guarded_deployment_command(body.rootPath, "php artisan storage:link", env=env or None, resource_limits=body.resourceLimits)
            if steps["storageLink"].get("returncode") != 0:
                stderr = (steps["storageLink"].get("stderr") or "").lower()
                if "already exists" in stderr or "exists" in stderr:
                    steps["storageLink"]["returncode"] = 0
        else:
            steps["storageLink"] = {
                "dryRun": False,
                "command": ["skipped", "php", "artisan", "storage:link"],
                "cwd": deployment_cwd(body.rootPath),
                "stdout": "Skipped storage:link: backend-only Laravel deployment has no public/index.php",
                "stderr": "",
                "returncode": 0,
                "skipped": True,
            }

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
    laravel_fpm = laravel_has_public_web_root(body.rootPath)
    upstream = laravel_fpm_socket(body.deploymentId) if laravel_fpm else f"127.0.0.1:{body.upstreamPort}"
    tokens = server_name_tokens(server_name)
    claiming: list[dict] = []
    stale_static_claims: list[str] = []
    for scan_dir in _nginx_scan_dirs():
        enabled_dir = Path(scan_dir)
        if not enabled_dir.is_dir():
            continue
        for conf_path in enabled_dir.iterdir():
            try:
                target = conf_path.resolve() if conf_path.is_symlink() else conf_path
                if not any(_config_has_server_name(target, token) for token in tokens):
                    continue
                claim_text = target.read_text(encoding="utf-8", errors="ignore")
                has_expected_upstream = upstream in claim_text
                stale_static = bool(re.search(r"try_files\s+\$uri\s+\$uri/\s+=404;", claim_text))
                claiming.append({
                    "file": conf_path.name,
                    "path": str(conf_path),
                    "target": str(target),
                    "containsExpectedUpstream": has_expected_upstream,
                    "staleStaticRoot": stale_static,
                })
                if stale_static and not has_expected_upstream:
                    stale_static_claims.append(str(conf_path))
            except OSError:
                continue
    ok = available.exists() and upstream in content and not stale_static_claims
    if not available.exists():
        stderr = "Generated Nginx config is missing"
    elif upstream not in content:
        stderr = "Generated Nginx config upstream port does not match"
    elif stale_static_claims:
        stderr = f"Another Nginx config claims this hostname with a static try_files root: {', '.join(stale_static_claims)}"
    else:
        stderr = ""
    return {
        "dryRun": False,
        "command": ["nginx-inspect", config_name],
        "returncode": 0 if ok else 1,
        "stdout": "",
        "stderr": stderr,
        "path": info,
        "configName": config_name,
        "availablePath": str(available),
        "enabledPath": str(enabled),
        "exists": available.exists(),
        "enabled": enabled.exists(),
        "expectedUpstream": upstream,
        "containsExpectedUpstream": upstream in content,
        "claimingConfigs": claiming,
        "staleStaticClaims": stale_static_claims,
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
        same_cwd = _cwd_belongs_to_deployment(pm2_owner.get("cwd"), body.rootPath)
        reusable = same_process or same_cwd
        return {
            "dryRun": False,
            "command": ["pm2", "jlist"],
            "cwd": None,
            "stdout": json.dumps(pm2_owner, separators=(",", ":")),
            "stderr": "",
            "returncode": 0,
            "path": info,
            "occupied": not reusable,
            "reusable": reusable,
            "cwdMatches": same_cwd,
            "owner": pm2_owner,
        }

    ss = run_command(["ss", "-ltnp", f"sport = :{body.port}"], allow_live=DEPLOYMENT_COMMANDS_LIVE)
    stdout = ss.get("stdout") or ""
    occupied = f":{body.port}" in stdout
    cwd_matches, process_owners = _ss_owner_cwd_matches(stdout, body.rootPath) if occupied else (False, [])
    reusable = cwd_matches
    return {
        **ss,
        "path": info,
        "occupied": occupied and not reusable,
        "reusable": reusable,
        "cwdMatches": cwd_matches,
        "owner": {"source": "ss", "detail": stdout.strip(), "processes": process_owners} if occupied else None,
    }


@router.post("/health")
def health(body: HealthRequest) -> dict:
    url = body.healthUrl or f"http://127.0.0.1:{body.port}/"
    strict = bool(body.strictHealth)
    accept_http_errors = (body.framework or "").upper() == "LARAVEL" and not strict
    initial_restarts = _pm2_restart_count(body.processName) if body.processName and (body.processManager or "").upper() == "PM2" else None

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
        logs = _health_runtime_logs(body)
        return {
            "dryRun": False,
            "command": ["supervisorctl", "status", body.processName or ""],
            "returncode": 1,
            "stdout": "",
            "stderr": supervisor_mismatch + (f"\n\nRuntime logs:\n{logs.get('text')}" if logs and logs.get("text") else ""),
            "logs": logs,
        }
    if (body.framework or "").upper() == "LARAVEL" and not laravel_has_public_web_root(body.rootPath):
        return backend_only_laravel_health(body.processName)
    if (body.framework or "").upper() == "LARAVEL":
        socket_path = Path(laravel_fpm_socket(body.deploymentId))
        if socket_path.exists():
            return {
                "dryRun": False,
                "command": ["php-fpm", "socket-check", str(socket_path)],
                "returncode": 0,
                "stdout": f"Laravel PHP-FPM socket ready: {socket_path}",
                "stderr": "",
                "runtime": "php-fpm",
                "socketPath": str(socket_path),
            }
        return {
            "dryRun": False,
            "command": ["php-fpm", "socket-check", str(socket_path)],
            "returncode": 1,
            "stdout": "",
            "stderr": f"Laravel PHP-FPM socket is missing: {socket_path}",
            "runtime": "php-fpm",
            "socketPath": str(socket_path),
        }

    # Phase 1: wait for the process to bind (with retries for connection refused).
    first = _curl_once(url, accept_http_errors=accept_http_errors)
    if first.get("returncode") != 0:
        return attach_laravel_diagnostics(first, body.rootPath, body.framework)

    # Phase 2: verify the process stays healthy. Strict/P1 mode samples longer so
    # instant restarts and intermittent 5xx responses are caught before traffic moves.
    delay = 10 if strict else 8
    probes = 3 if strict else 1
    second = first
    for probe in range(probes):
        time.sleep(delay)
        second = _curl_once(url, accept_http_errors=accept_http_errors)
        if second.get("returncode") != 0:
            second["stderr"] = (
                f"App responded on first check but failed stability probe {probe + 1}/{probes} after {delay * (probe + 1)} s. "
                + (second.get("stderr") or "")
            ).strip()
            return attach_laravel_diagnostics(second, body.rootPath, body.framework)

    # Phase 3: PM2 crash-loop detection.
    # If the process has already restarted since we started it, it is crash-looping
    # and will go down again shortly — fail the deployment now with a clear message.
    if body.processName and (body.processManager or "").upper() == "PM2":
        restarts = _pm2_restart_count(body.processName)
        restart_delta = restarts - initial_restarts if restarts is not None and initial_restarts is not None else restarts
        if restart_delta is not None and restart_delta > 0:
            second["returncode"] = 1
            second["stderr"] = (
                f"PM2 process '{body.processName}' restarted during health verification ({restart_delta} new restart(s), {restarts} total) — "
                "the app is crash-looping. Run `pm2 logs {name}` on the server to see the error."
            ).replace("{name}", body.processName)
            return second

    if strict:
        second["strictHealth"] = True
        second["stdout"] = ((second.get("stdout") or "") + "\nStrict health passed: stable probes completed.").strip()
    return second


@router.post("/public-route")
def public_route(body: PublicRouteRequest) -> dict:
    return _curl_public_route(body.serverName, body.path, body.rootPath, body.framework, body.requireHttps)


@router.post("/cron")
def deployment_cron(body: CronApplyRequest) -> dict:
    return apply_deployment_cron_file(body)
