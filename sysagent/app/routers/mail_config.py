from fastapi import APIRouter
from pydantic import BaseModel

from app.command import run_command

router = APIRouter()


class MailDomain(BaseModel):
    domain: str


class MailboxRequest(BaseModel):
    email: str
    quotaMb: int = 1024


class AliasRequest(BaseModel):
    source: str
    target: str


@router.post("/dkim")
def setup_dkim(payload: MailDomain) -> dict:
    return run_command(["opendkim-genkey", "-b", "2048", "-d", payload.domain, "-s", "mail"])


@router.post("/mailbox")
def create_mailbox(payload: MailboxRequest) -> dict:
    return run_command(["maildirmake.dovecot", f"/var/mail/vhosts/{payload.email}"])


@router.post("/alias")
def update_alias(payload: AliasRequest) -> dict:
    return run_command(["postmap", "/etc/postfix/virtual"])


@router.post("/reload")
def reload_mail_services() -> dict:
    return {
        "postfix": run_command(["systemctl", "reload", "postfix"]),
        "dovecot": run_command(["systemctl", "reload", "dovecot"]),
        "opendkim": run_command(["systemctl", "reload", "opendkim"]),
    }
