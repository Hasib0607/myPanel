import shlex
import re
import json
import base64
import time
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.command import run_command, run_install_plan
from app.config import settings
from app.platform import runtime_tool_install_plan
from app.nginx_paths import nginx_sites_available, nginx_sites_enabled
from app.nginx_manager import acme_location, publish_nginx_config, safe_letsencrypt_path, safe_web_root

router = APIRouter()

ALLOWED_DEPLOY_EXECUTABLES = {
    "./app",
    "composer",
    "flask",
    "go",
    "gunicorn",
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
    "react-scripts",
    "serve",
    "true",
    "uv",
    "uvicorn",
    "vite",
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


class PortStatusRequest(BaseModel):
    rootPath: str
    port: int = Field(ge=1, le=65535)
    processName: str | None = None
    processManager: str | None = None


class PublicRouteRequest(BaseModel):
    serverName: str
    path: str = "/"


class RuntimeLogsRequest(BaseModel):
    name: str
    logDir: str | None = None
    lines: int = Field(default=300, ge=1, le=2000)


class RuntimeToolsRequest(BaseModel):
    tools: list[str] = Field(default_factory=list, max_length=50)


class NginxInspectRequest(BaseModel):
    deploymentId: str
    serverName: str | None = None
    upstreamPort: int = Field(ge=1, le=65535)
    rootPath: str


class RuntimeInstallRequest(BaseModel):
    tool: str = Field(pattern="^(pnpm|yarn|composer|uv|go|php|php82|php-gd|python|nodejs|supervisor|pm2)$")


class PermissionRepairRequest(BaseModel):
    rootPath: str
    logDir: str | None = None


class SupervisorRepairRequest(BaseModel):
    name: str


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
    effective_env = dict(env or {})
    if parsed and parsed[0] == "composer":
        effective_env.setdefault("COMPOSER_ALLOW_SUPERUSER", "1")
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
    try:
        if not body.serverName:
            return {
                "skipped": True,
                "reason": "No domain/serverName linked to deployment",
                "serverName": None,
            }

        server_name = body.serverName
        config_name = nginx_config_name(body.deploymentId, server_name)
        fallback_root = safe_web_root(body.fallbackRootPath) if body.fallbackRootPath else None
        ssl_certificate = safe_letsencrypt_path(body.sslCertificate) if body.sslCertificate else None
        ssl_certificate_key = safe_letsencrypt_path(body.sslCertificateKey) if body.sslCertificateKey else None
        has_ssl = ssl_certificate is not None and ssl_certificate_key is not None

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

        http_location = (
            f"{acme_location(server_name)}"
            "    location / {\n"
            f"        proxy_pass http://127.0.0.1:{body.upstreamPort};\n"
            "        proxy_http_version 1.1;\n"
            "        proxy_set_header Host $http_host;\n"
            "        proxy_set_header X-Forwarded-Host $host;\n"
            "        proxy_set_header X-Forwarded-Port $server_port;\n"
            "        proxy_set_header Forwarded \"proto=$scheme;host=$http_host\";\n"
            "        proxy_set_header X-Real-IP $remote_addr;\n"
            "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
            "        proxy_set_header X-Forwarded-Proto $scheme;\n"
            "        proxy_set_header Upgrade $http_upgrade;\n"
            "        proxy_set_header Connection \"upgrade\";\n"
            "        proxy_connect_timeout 10s;\n"
            "        proxy_send_timeout 60s;\n"
            "        proxy_read_timeout 60s;\n"
            f"        proxy_redirect http://localhost:{body.upstreamPort}/ $scheme://$host/;\n"
            f"        proxy_redirect https://localhost:{body.upstreamPort}/ https://$host/;\n"
            f"        proxy_redirect http://127.0.0.1:{body.upstreamPort}/ $scheme://$host/;\n"
            f"        proxy_redirect https://127.0.0.1:{body.upstreamPort}/ https://$host/;\n"
            f"{fallback_error_page}"
            "    }\n"
            f"{fallback_location}"
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
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_set_header Forwarded "proto=$scheme;host=$http_host";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 10s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        proxy_redirect http://localhost:{body.upstreamPort}/ $scheme://$host/;
        proxy_redirect https://localhost:{body.upstreamPort}/ https://$host/;
        proxy_redirect http://127.0.0.1:{body.upstreamPort}/ $scheme://$host/;
        proxy_redirect https://127.0.0.1:{body.upstreamPort}/ https://$host/;
{fallback_error_page.rstrip()}
    }}
{fallback_location}
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
        }
    except HTTPException:
        raise
    except Exception as error:
        return blocked_command(f"Nginx deployment vhost failed: {error}", ["write-nginx", body.serverName or body.deploymentId], path_info(body.rootPath))


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


def _curl_public_route(server_name: str, path: str = "/") -> dict:
    primary = server_name.split()[0].strip()
    clean_path = path if path.startswith("/") else f"/{path}"
    result = run_command([
        "curl",
        "-fsSL",
        "-H", "Accept-Language: en-US,en;q=0.9,bn;q=0.8",
        "-H", "User-Agent: VPS-Panel-Healthcheck/1.0",
        "--retry", "5",
        "--retry-delay", "2",
        "--retry-connrefused",
        "--connect-timeout", "5",
        "--max-time", "30",
        "--resolve", f"{primary}:80:127.0.0.1",
        "--resolve", f"{primary}:443:127.0.0.1",
        "-w", "\n__effective_url=%{url_effective}",
        f"http://{primary}{clean_path}",
    ])
    stdout = result.get("stdout") or ""
    marker = "\n__effective_url="
    effective_url = stdout.rsplit(marker, 1)[1].strip() if marker in stdout else ""
    if effective_url and re.search(r"https?://(localhost|127\.0\.0\.1)(:\d+)?(/|$)", effective_url):
        result["returncode"] = 1
        result["stderr"] = (
            f"Public route resolved to internal URL {effective_url}. "
            "The app is generating localhost redirects; redeploy after clearing HOST/HOSTNAME env or set the app public URL to the domain."
        )
    result["effectiveUrl"] = effective_url
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
    result = run_command(["pm2", "jlist"])
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
    result = run_command(["pm2", "jlist"])
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
    result = run_command(["supervisorctl", "status", body.processName])
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
        path = shutil.which(name)
        items.append({"name": name, "installed": bool(path), "path": path})
    return {"items": items}


@router.post("/runtime-tools/install")
def install_runtime_tool(body: RuntimeInstallRequest) -> dict:
    try:
        plan = runtime_tool_install_plan(body.tool)
    except KeyError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return run_install_plan(plan, timeout=300)


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
        steps[target] = run_command(["chown", "-R", "panel:panel", target], timeout=120)
    failed = [target for target, result in steps.items() if result.get("returncode") != 0]
    return {"dryRun": any(result.get("dryRun") for result in steps.values()), "returncode": 1 if failed else 0, "steps": steps}


@router.post("/supervisor/repair")
def repair_supervisor(body: SupervisorRepairRequest) -> dict:
    reread = run_command(["supervisorctl", "reread"], timeout=60)
    update = run_command(["supervisorctl", "update"], timeout=60) if reread.get("returncode") == 0 else {"returncode": 1, "stderr": "Skipped because reread failed"}
    restart = run_command(["supervisorctl", "restart", body.name], timeout=60) if update.get("returncode") == 0 else {"returncode": 1, "stderr": "Skipped because update failed"}
    failed = any(step.get("returncode") != 0 for step in [reread, update, restart])
    return {"dryRun": any(step.get("dryRun") for step in [reread, update, restart]), "returncode": 1 if failed else 0, "reread": reread, "update": update, "restart": restart}


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
    if not info["allowed"] and settings.allow_live_system_commands:
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

    ss = run_command(["ss", "-ltnp", f"sport = :{body.port}"], allow_live=settings.allow_live_system_commands)
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


@router.post("/public-route")
def public_route(body: PublicRouteRequest) -> dict:
    return _curl_public_route(body.serverName, body.path)
