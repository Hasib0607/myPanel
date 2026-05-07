from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.command import run_command
from app.config import settings

router = APIRouter()


class CertificateRequest(BaseModel):
    domain: str = Field(pattern=r"^[a-zA-Z0-9.-]+$")
    email: str
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


def safe_web_root(root_path: str) -> Path:
    root = Path(settings.file_manager_root).resolve()
    target = Path(root_path).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(status_code=400, detail="Certbot webroot escapes file manager root")
    return target
