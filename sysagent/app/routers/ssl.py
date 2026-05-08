import secrets

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.command import run_command
from app.config import settings
from app.nginx_manager import run_live_step, safe_web_root

router = APIRouter()


class CertificateRequest(BaseModel):
    domain: str = Field(pattern=r"^[a-zA-Z0-9.-]+$")
    email: str
    webRoot: str
    includeWww: bool = True


class CertificatePreflightRequest(BaseModel):
    domain: str = Field(pattern=r"^[a-zA-Z0-9.-]+$")
    webRoot: str
    includeWww: bool = True


@router.post("/issue")
def issue_certificate(payload: CertificateRequest) -> dict:
    web_root = safe_web_root(payload.webRoot)
    command = [
        "certbot",
        "certonly",
        "--webroot",
        "-w",
        str(web_root),
        "--non-interactive",
        "--agree-tos",
        "--keep-until-expiring",
        "-m",
        payload.email,
        "-d",
        payload.domain,
    ]
    if payload.includeWww:
        command.extend(["-d", f"www.{payload.domain}"])

    return run_command(command, allow_live=settings.allow_live_ssl)


@router.post("/renew/{domain}")
def renew_certificate(domain: str) -> dict:
    return run_command(["certbot", "renew", "--cert-name", domain], allow_live=settings.allow_live_ssl)


@router.get("/certbot")
def certbot_status() -> dict:
    return run_command(["certbot", "--version"], allow_live=settings.allow_live_ssl)


@router.post("/preflight")
def preflight(payload: CertificatePreflightRequest) -> dict:
    web_root = safe_web_root(payload.webRoot, "Certbot webroot escapes file manager root")
    certbot = certbot_status()
    challenge_dir = web_root / ".well-known" / "acme-challenge"
    token = f"vps-panel-{secrets.token_hex(12)}"
    expected = f"ok-{token}"
    challenge_file = challenge_dir / token

    write = {
        "dryRun": not settings.allow_live_ssl,
        "command": ["write-file", str(challenge_file)],
        "stdout": "",
        "stderr": "",
        "returncode": 0,
    }
    if settings.allow_live_ssl:
        run_live_step("ACME challenge directory create", lambda: challenge_dir.mkdir(parents=True, exist_ok=True))
        run_live_step("ACME challenge write", lambda: challenge_file.write_text(expected, encoding="utf-8"))

    hosts = [payload.domain]
    if payload.includeWww:
        hosts.append(f"www.{payload.domain}")
    checks = []
    for host in hosts:
        checks.append(run_command([
            "curl",
            "-fsS",
            "--max-time",
            "10",
            f"http://{host}/.well-known/acme-challenge/{token}",
        ], allow_live=settings.allow_live_ssl))

    if settings.allow_live_ssl:
        run_live_step("ACME challenge cleanup", lambda: challenge_file.unlink(missing_ok=True))

    return {
        "certbot": certbot,
        "write": write,
        "checks": checks,
        "webRoot": str(web_root),
    }
