import shlex
import re
import json
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.command import run_command
from app.config import settings

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


class CommandRequest(BaseModel):
    rootPath: str
    command: str | None = None
    packageManager: str | None = None


class ProcessRequest(BaseModel):
    deploymentId: str
    name: str
    rootPath: str
    action: str
    processManager: str | None = None
    startCommand: str | None = None
    port: int | None = Field(default=None, ge=1, le=65535)


class NginxRequest(BaseModel):
    deploymentId: str
    serverName: str | None = None
    upstreamPort: int = Field(ge=1, le=65535)
    rootPath: str
    forceSsl: bool = True


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


def guarded_deployment_command(root_path: str, command: str) -> dict:
    info = path_info(root_path)
    try:
        parsed = parse_deployment_command(command)
    except ValueError as error:
        return blocked_command(str(error), [command], info)
    return guarded_command(root_path, parsed, cwd=deployment_cwd(root_path))


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
        "--",
        *start_command[1:],
    ]
    start = guarded_command_with_env(body.rootPath, command, cwd=cwd, env=pm2_env(body.port))
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
    if body.gitUrl:
        command = ["git", "clone", "--branch", body.branch, body.gitUrl, str(target)]
    else:
        command = ["git", "-C", str(target), "fetch", "--all", "--prune"]
    result = guarded_command(body.rootPath, command)
    checkout = None
    if body.commitSha:
        checkout = guarded_command(body.rootPath, ["git", "-C", str(target), "checkout", body.commitSha])
    elif not body.gitUrl:
        checkout = guarded_command(body.rootPath, ["git", "-C", str(target), "checkout", body.branch])
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
    return guarded_deployment_command(body.rootPath, command)


@router.post("/build")
def build(body: CommandRequest) -> dict:
    command = body.command or "true"
    return guarded_deployment_command(body.rootPath, command)


@router.post("/migrate")
def migrate(body: CommandRequest) -> dict:
    command = body.command or "true"
    return guarded_deployment_command(body.rootPath, command)


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
    config_path = f"/etc/nginx/sites-available/{config_name}.conf"
    enabled_path = f"/etc/nginx/sites-enabled/{config_name}.conf"
    config = f"""
server {{
    listen 80;
    server_name {server_name};

    location / {{
        proxy_pass http://127.0.0.1:{body.upstreamPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }}
}}
""".lstrip()
    write = guarded_write_file(body.rootPath, config_path, config)
    enable = {"dryRun": True, "command": ["symlink", config_path, enabled_path], "returncode": 0, "stdout": "", "stderr": ""}
    if settings.allow_live_system_commands:
        enabled = Path(enabled_path)
        if enabled.exists() or enabled.is_symlink():
            enabled.unlink()
        enabled.symlink_to(config_path)
        enable = {"dryRun": False, "command": ["symlink", config_path, enabled_path], "returncode": 0, "stdout": "", "stderr": ""}
    test = run_command(["nginx", "-t"])
    if test.get("returncode") != 0 and settings.allow_live_system_commands:
        enabled = Path(enabled_path)
        if enabled.exists() or enabled.is_symlink():
            enabled.unlink()
    reload = run_command(["systemctl", "reload", "nginx"]) if test.get("returncode") == 0 else {
        "dryRun": False,
        "command": ["systemctl", "reload", "nginx"],
        "stdout": "",
        "stderr": "Skipped because nginx -t failed",
        "returncode": 1,
    }
    return {
        "write": write,
        "enable": enable,
        "test": test,
        "reload": reload,
        "configPath": config_path,
        "enabledPath": enabled_path,
        "serverName": server_name,
    }


@router.post("/health")
def health(body: HealthRequest) -> dict:
    url = body.healthUrl or f"http://127.0.0.1:{body.port}/"
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
