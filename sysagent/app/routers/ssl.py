from fastapi import APIRouter
from pydantic import BaseModel

from app.command import run_command

router = APIRouter()


class CertificateRequest(BaseModel):
    domain: str
    email: str


@router.post("/issue")
def issue_certificate(payload: CertificateRequest) -> dict:
    return run_command([
        "certbot",
        "--nginx",
        "-d",
        payload.domain,
        "--non-interactive",
        "--agree-tos",
        "-m",
        payload.email,
    ])


@router.post("/renew/{domain}")
def renew_certificate(domain: str) -> dict:
    return run_command(["certbot", "renew", "--cert-name", domain])
