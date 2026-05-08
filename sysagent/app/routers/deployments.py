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
    result = publish_nginx_config(config_name, config, "/etc/nginx/sites-available", "/etc/nginx/sites-enabled")
    return {
        **result,
        "path": info,
        "serverName": server_name,
    }


def _curl_once(url: str) -> dict:
    return run_command([
        "curl",
        "-fsS",
        "--retry",
        "10",
        "--retry-delay",
        "2",
        "--retry-connrefused",
        "--max-time",
        "5",
        url,
    ])


@router.post("/health")
def health(body: HealthRequest) -> dict:
    url = body.healthUrl or f"http://127.0.0.1:{body.port}/"

    # Phase 1: wait for the process to bind (with retries for connection refused).
    first = _curl_once(url)
    if first.get("returncode") != 0:
        return first

    # Phase 2: wait 3 s then verify the process is still up (catches immediate crashes).
    time.sleep(3)
    second = _curl_once(url)
    if second.get("returncode") != 0:
        second["stderr"] = (
            "App responded on first check but crashed within 3 s. "
            + (second.get("stderr") or "")
        ).strip()
    return second
