import shlex
import re
import json
import base64
import time
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.command import run_command
from app.config import settings
from app.nginx_manager import acme_location, publish_nginx_config, safe_letsencrypt_path

router = APIRouter()

ALLOWED_DEPLOY_EXECUTABLES = {
    "./app",
    "composer",
    "go",
    "node",
    "next",
    "npm",
    "npx",
    "php",
    "pip",
    "pip3",
    "pnpm",
    "python",
    "python3",
    "serve",
    "true",
    "uv",
    "uvicorn",
    "yarn",
}

SHELL_METACHARS = {"|", "||", "&", "&&", ";", ">", ">>", "<", "$(", "`"}


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


class NginxRequest(BaseModel):
    deploymentId: str
    serverName: str | None = None
    upstreamPort: int = Field(ge=1, le=65535)
    rootPath: str
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


class RuntimeLogsRequest(BaseModel):
    name: str
    logDir: str | None = None
    lines: int = Field(default=300, ge=1, le=2000)


def path_info(root_path: str) -> dict:
    root = Path(settings.file_manager_root).resolve()
    target = Path(root_path).resolve()
    allowed = target == root or root in target.parents
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
        "reason": reason,
        "command": command,
        "stdout": "",
        "stderr": "",
        "returncode": 1,
    }
    if info is not None:
        result["path"] = info
    return result


def guarded_command(root_path: str, command: list[str], cwd: str | None = None) -> dict:
    info = path_info(root_path)
    if not info["allowed"] and settings.allow_live_system_commands:
        return blocked_command("Path escapes configured file manager root", command, info)
    result = run_command(command, cwd=cwd)
    result["path"] = info
    return result


def guarded_command_with_env(root_path: str, command: list[str], cwd: str | None = None, env: dict[str, str] | None = None) -> dict:
    info = path_info(root_path)
    if not info["allowed"] and settings.allow_live_system_commands:
        return blocked_command("Path escapes configured file manager root", command, info)
    result = run_command(command, cwd=cwd, env=env)
    result["path"] = info
    return result


def git_auth_env(token: str | None) -> dict[str, str] | None:
    if not token:
        return None
    basic = base64.b64encode(f"x-access-token:{token}".encode("utf-8")).decode("ascii")
    return {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
        "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {basic}",
        "GIT_TERMINAL_PROMPT": "0",
    }


def deployment_cwd(root_path: str) -> str:
    return str(Path(root_path).resolve())


def parse_deployment_command(command: str) -> list[str]:
    try:
        parsed = shlex.split(command)
    except ValueError as error:
        raise ValueError(f"Invalid deployment command: {error}") from error
    if not parsed:
        raise ValueError("Deployment command cannot be empty")
    if parsed[0] not in ALLOWED_DEPLOY_EXECUTABLES:
        raise ValueError(f"Unsupported deployment executable: {parsed[0]}")
    if any(token in SHELL_METACHARS or any(marker in token for marker in ("$(", "`")) for token in parsed):
        raise ValueError("Shell operators are not allowed in deployment commands")
    return parsed


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
    return guarded_command_with_env(root_path, parsed, cwd=deployment_cwd(root_path), env=env)


def pm2_env(port: int | None) -> dict[str, str]:
    env = {"HOST": "127.0.0.1", "HOSTNAME": "127.0.0.1"}
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
        (log_dir / filename).write_text("", encoding="utf-8")


def combine_pm2_results(root_path: str, steps: dict[str, dict], required: list[str]) -> dict:
    info = path_info(root_path)
    failed = [
        name for name in required
        if steps.get(name, {}).get("returncode", 0) != 0 or steps.get(name, {}).get("blocked")
    ]
    return {
        "dryRun": any(step.get("dryRun") for step in steps.values()),
        "command": ["pm2", "managed-lifecycle"],
        "cwd": deployment_cwd(root_path),
        "stdout": "",
        "stderr": "; ".join(f"{name}: {steps[name].get('stderr') or steps[name].get('reason') or 'failed'}" for name in failed),
        "returncode": 1 if failed else 0,
        "path": info,
        **steps,
    }


def pm2_start(body: ProcessRequest, start_command: list[str]) -> dict:
    cwd = deployment_cwd(body.rootPath)
    try:
        log_dir = safe_log_dir(body.name, body.logDir)
    except ValueError as error:
        return blocked_command(str(error), ["pm2", "start", body.name], path_info(body.rootPath))
    if settings.allow_live_system_commands:
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
    text = "\n".join([
        f"== STDOUT ({log_dir / 'running-out.log'}) ==",
        stdout or "(empty)",
        "",
        f"== STDERR ({log_dir / 'running-error.log'}) ==",
        stderr or "(empty)",
    ])
    return {"ok": True, "logDir": str(log_dir), "stdout": stdout, "stderr": stderr, "text": text}


def guarded_write_file(root_path: str, target_path: str, content: str) -> dict:
    info = path_info(root_path)
    command = ["write-file", target_path]
    if not info["allowed"] and settings.allow_live_system_commands:
        return blocked_command("Path escapes configured file manager root", command, info)
    if not settings.allow_live_system_commands:
        result = {
            "dryRun": True,
            "command": command,
            "stdout": "",
            "stderr": "",
            "returncode": 0,
        }
    else:
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
    if target.joinpath(".git").exists():
        remote = guarded_command_with_env(body.rootPath, ["git", "-C", str(target), "remote", "set-url", "origin", body.gitUrl], env=env) if body.gitUrl else None
        fetch = guarded_command_with_env(body.rootPath, ["git", "-C", str(target), "fetch", "origin", body.branch, "--prune"], env=env)
        checkout = guarded_command_with_env(body.rootPath, ["git", "-C", str(target), "checkout", body.commitSha or body.branch], env=env)
        pull = None if body.commitSha else guarded_command_with_env(body.rootPath, ["git", "-C", str(target), "pull", "--ff-only", "origin", body.branch], env=env)
        return {"remote": remote, "sync": fetch, "checkout": checkout, "pull": pull}
    if body.gitUrl:
        command = ["git", "clone", "--branch", body.branch, body.gitUrl, str(target)]
    else:
        command = ["git", "-C", str(target), "fetch", "--all", "--prune"]
    result = guarded_command_with_env(body.rootPath, command, env=env)
    checkout = None
    if body.commitSha:
        checkout = guarded_command_with_env(body.rootPath, ["git", "-C", str(target), "checkout", body.commitSha], env=env)
    elif not body.gitUrl:
        checkout = guarded_command_with_env(body.rootPath, ["git", "-C", str(target), "checkout", body.branch], env=env)
    return {"sync": result, "checkout": checkout}


@router.post("/install")
def install(body: CommandRequest) -> dict:
    command = body.command or {
        "NPM": "npm install",
        "PNPM": "pnpm install",
        "YARN": "yarn install",
        "COMPOSER": "composer install --no-dev --optimize-autoloader",
        "PIP": "pip install -r requirements.txt",
        "UV": "uv sync",
        "GO": "go mod download",
        "NONE": "true",
    }.get((body.packageManager or "NONE").upper(), "true")
    return guarded_deployment_command(body.rootPath, command, env=body.env)


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
    manager = (body.processManager or "NONE").upper()
    if manager == "PM2":
        if body.action in {"start", "restart"}:
            try:
                start_command = parse_deployment_command(body.startCommand or "npm run start")
            except ValueError as error:
                return blocked_command(str(error), [body.startCommand or "npm run start"], path_info(body.rootPath))
            return pm2_start(body, start_command)
        elif body.action == "stop":
            return pm2_stop(body)
        else:
            command = ["pm2", body.action, body.name]
    elif manager == "SUPERVISOR":
        command = ["supervisorctl", body.action, body.name]
    elif manager == "SYSTEMD":
        command = ["systemctl", body.action, body.name]
    else:
        return guarded_deployment_command(body.rootPath, body.startCommand or "true")
    return guarded_command(body.rootPath, command)


@router.post("/nginx")
def nginx(body: NginxRequest) -> dict:
    if not body.serverName:
        return {
            "skipped": True,
            "reason": "No domain/serverName linked to deployment",
            "serverName": None,
        }

    server_name = body.serverName
    config_name = nginx_config_name(body.deploymentId, server_name)
    ssl_certificate = safe_letsencrypt_path(body.sslCertificate) if body.sslCertificate else None
    ssl_certificate_key = safe_letsencrypt_path(body.sslCertificateKey) if body.sslCertificateKey else None
    has_ssl = ssl_certificate is not None and ssl_certificate_key is not None

    if has_ssl and settings.allow_live_nginx and (not ssl_certificate.exists() or not ssl_certificate_key.exists()):
        if body.requireSsl:
            return blocked_command("SSL certificate files do not exist yet", ["write-nginx", config_name], path_info(body.rootPath))
        has_ssl = False

    http_location = (
        f"{acme_location(server_name)}"
        "    location / {\n"
        f"        proxy_pass http://127.0.0.1:{body.upstreamPort};\n"
        "        proxy_http_version 1.1;\n"
        "        proxy_set_header Host $host;\n"
        "        proxy_set_header X-Real-IP $remote_addr;\n"
        "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
        "        proxy_set_header X-Forwarded-Proto $scheme;\n"
        "        proxy_set_header Upgrade $http_upgrade;\n"
        "        proxy_set_header Connection \"upgrade\";\n"
        "        proxy_connect_timeout 10s;\n"
        "        proxy_send_timeout 60s;\n"
        "        proxy_read_timeout 60s;\n"
        "    }\n"
    )
    if body.forceSsl and has_ssl:
        http_location = (
            f"{acme_location(server_name)}"
            "    location / {\n"
            "        return 301 https://$host$request_uri;\n"
            "    }\n"
        )

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

{acme_location(server_name)}    location / {{
        proxy_pass http://127.0.0.1:{body.upstreamPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 10s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }}
}}
"""
    info = path_info(body.rootPath)
    if not info["allowed"] and settings.allow_live_nginx:
        return blocked_command("Path escapes configured file manager root", ["write-nginx", config_name], info)
    result = publish_nginx_config(config_name, config, "/etc/nginx/sites-available", "/etc/nginx/sites-enabled", server_name=server_name)
    return {
        **result,
        "path": info,
        "serverName": server_name,
    }


def _curl_once(url: str) -> dict:
    # --connect-timeout: per-connection attempt limit (5 s)
    # --max-time: total wall-clock limit across all retries (90 s)
    # Without a large --max-time, curl exhausts the budget after 2-3 retries
    # even when --retry 10 is requested, because retry delays count against it.
    return run_command([
        "curl",
        "-fsS",
        "--retry", "10",
        "--retry-delay", "3",
        "--retry-connrefused",
        "--connect-timeout", "5",
        "--max-time", "90",
        url,
    ])


def _pm2_restart_count(process_name: str) -> int | None:
    """Return the PM2 restart count for process_name, or None if not found / error."""
    result = run_command(["pm2", "jlist"])
    if result.get("returncode") != 0:
        return None
    try:
        processes = json.loads(result.get("stdout") or "[]")
        for proc in processes:
            if proc.get("name") == process_name:
                return int(proc.get("pm2_env", {}).get("restart_time", 0))
    except (json.JSONDecodeError, ValueError, AttributeError):
        pass
    return None


@router.post("/health")
def health(body: HealthRequest) -> dict:
    url = body.healthUrl or f"http://127.0.0.1:{body.port}/"

    # Phase 1: wait for the process to bind (with retries for connection refused).
    first = _curl_once(url)
    if first.get("returncode") != 0:
        return first

    # Phase 2: wait 8 s then verify the process is still up (catches immediate crashes).
    time.sleep(8)
    second = _curl_once(url)
    if second.get("returncode") != 0:
        second["stderr"] = (
            "App responded on first check but crashed within 8 s. "
            + (second.get("stderr") or "")
        ).strip()
        return second

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
