import secrets

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.command import run_command
from app.config import settings
from app.nginx_manager import acme_root_for_server_name, letsencrypt_certificate_exists, run_live_step, safe_web_root

router = APIRouter()


def certbot_should_include_www(domain: str, include_www: bool) -> bool:
    if not include_www:
        return False
    labels = [part for part in domain.split(".") if part]
    return len(labels) <= 2


class CertificateRequest(BaseModel):
    domain: str = Field(pattern=r"^[a-zA-Z0-9.-]+$")
    email: str
    webRoot: str
    includeWww: bool = True


class CertificatePreflightRequest(BaseModel):
    domain: str = Field(pattern=r"^[a-zA-Z0-9.-]+$")
    webRoot: str
    includeWww: bool = True


class EnsureAcmeWebrootRequest(BaseModel):
    domain: str = Field(pattern=r"^[a-zA-Z0-9.-]+$")
    webRoot: str | None = None


@router.get("/certificate-exists/{domain}")
def certificate_exists(domain: str) -> dict:
    primary = domain.split()[0].strip()
    return {
        "domain": primary,
        "exists": letsencrypt_certificate_exists(primary),
        "certificate": f"/etc/letsencrypt/live/{primary}/fullchain.pem",
        "privateKey": f"/etc/letsencrypt/live/{primary}/privkey.pem",
    }


@router.post("/ensure-acme-webroot")
def ensure_acme_webroot(body: EnsureAcmeWebrootRequest) -> dict:
    primary = body.domain.split()[0].strip()
    web_root = safe_web_root(body.webRoot) if body.webRoot else acme_root_for_server_name(primary)
    challenge_dir = web_root / ".well-known" / "acme-challenge"
    if settings.allow_live_ssl:
        run_live_step("ACME webroot create", lambda: challenge_dir.mkdir(parents=True, exist_ok=True))
    return {
        "dryRun": not settings.allow_live_ssl,
        "returncode": 0,
        "webRoot": str(web_root),
        "challengeDir": str(challenge_dir),
        "domain": primary,
    }


@router.post("/issue")
def issue_certificate(payload: CertificateRequest) -> dict:
    ensure_acme_webroot(EnsureAcmeWebrootRequest(domain=payload.domain, webRoot=payload.webRoot))
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
    if certbot_should_include_www(payload.domain, payload.includeWww):
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
