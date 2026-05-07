import shlex
import re
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
    "npm",
    "php",
    "pip",
    "pip3",
    "pnpm",
    "python",
    "python3",
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
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", primary).strip("-") or deployment_id


def guarded_deployment_command(root_path: str, command: str) -> dict:
    info = path_info(root_path)
    try:
        parsed = parse_deployment_command(command)
    except ValueError as error:
        return blocked_command(str(error), [command], info)
    return guarded_command(root_path, parsed, cwd=deployment_cwd(root_path))


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
        if body.action == "start":
            try:
                start_command = parse_deployment_command(body.startCommand or "npm run start")
            except ValueError as error:
                return blocked_command(str(error), [body.startCommand or "npm run start"], path_info(body.rootPath))
            command = ["pm2", "start", start_command[0], "--name", body.name, "--", *start_command[1:]]
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
    server_name = body.serverName or f"{body.deploymentId}.local"
    config_name = nginx_config_name(body.deploymentId, server_name)
    config_path = f"/etc/nginx/sites-available/{config_name}.conf"
    enabled_path = f"/etc/nginx/sites-enabled/{config_name}.conf"
    config = (
        f"server {{ listen 80; server_name {server_name}; "
        f"location / {{ proxy_pass http://127.0.0.1:{body.upstreamPort}; "
        "proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; "
        "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; "
        "proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection \"upgrade\"; }} }"
    )
    write = guarded_write_file(body.rootPath, config_path, config)
    enable = {"dryRun": True, "command": ["symlink", config_path, enabled_path], "returncode": 0, "stdout": "", "stderr": ""}
    if settings.allow_live_system_commands:
        enabled = Path(enabled_path)
        if enabled.exists() or enabled.is_symlink():
            enabled.unlink()
        enabled.symlink_to(config_path)
        enable = {"dryRun": False, "command": ["symlink", config_path, enabled_path], "returncode": 0, "stdout": "", "stderr": ""}
    return {
        "write": write,
        "enable": enable,
        "test": run_command(["nginx", "-t"]),
        "reload": run_command(["systemctl", "reload", "nginx"]),
        "configPath": config_path,
        "enabledPath": enabled_path,
        "serverName": server_name,
    }


@router.post("/health")
def health(body: HealthRequest) -> dict:
    url = body.healthUrl or f"http://127.0.0.1:{body.port}/"
    return run_command(["curl", "-fsS", "--max-time", "5", url])
