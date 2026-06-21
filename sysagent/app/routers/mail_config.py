from pathlib import Path
import os
import re
import shutil

from fastapi import APIRouter
from pydantic import BaseModel

from app.command import run_command
from app.config import settings

router = APIRouter()


class MailDomain(BaseModel):
    domain: str
    hostname: str | None = None
    certificatePath: str | None = None
    keyPath: str | None = None
    messageRateLimit: str = "60/minute"


class MailboxRequest(BaseModel):
    email: str
    quotaMb: int = 1024
    passwordHash: str | None = None


class AliasRequest(BaseModel):
    source: str
    target: str


VMAILBOX = Path("/etc/postfix/vmailbox")
VMAILDOMAINS = Path("/etc/postfix/vmaildomains")
DOVECOT_USERS = Path("/etc/dovecot/users")
DOVECOT_PANEL_AUTH = Path("/etc/dovecot/conf.d/10-vps-panel-auth.conf")
DOVECOT_PANEL_MAIL = Path("/etc/dovecot/conf.d/10-vps-panel-mail.conf")
DOVECOT_PANEL_SSL = Path("/etc/dovecot/conf.d/10-vps-panel-ssl.conf")


def dry_write(path: Path, content: str) -> dict:
    if not settings.allow_live_system_commands:
        return {
            "dryRun": True,
            "liveCommandsDisabled": True,
            "path": str(path),
            "content": content,
            "returncode": 0,
        }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return {"dryRun": False, "path": str(path), "returncode": 0}


def safe_email(email: str) -> tuple[str, str, str]:
    normalized = email.strip().lower()
    if not re.match(r"^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}$", normalized):
        raise ValueError("Invalid mailbox email")
    user, domain = normalized.split("@", 1)
    return normalized, user, domain


def maildir_for(user: str, domain: str) -> Path:
    return Path("/var/mail/vhosts") / domain / user


def merge_key_value_line(path: Path, key: str, line: str) -> dict:
    existing = ""
    if path.exists():
        existing = path.read_text(encoding="utf-8")
    lines = [item for item in existing.splitlines() if not item.startswith(f"{key} ")]
    lines.append(line)
    content = "\n".join(lines).strip() + "\n"
    return dry_write(path, content)


def merge_dovecot_user(email: str, password_hash: str, maildir: Path) -> dict:
    existing = ""
    if DOVECOT_USERS.exists():
        existing = DOVECOT_USERS.read_text(encoding="utf-8")
    lines = [item for item in existing.splitlines() if not item.startswith(f"{email}:")]
    hash_value = password_hash if password_hash.startswith("{") else f"{{BLF-CRYPT}}{password_hash}"
    lines.append(f"{email}:{hash_value}:5000:5000::/var/mail/vhosts::userdb_mail=maildir:{maildir}")
    content = "\n".join(lines).strip() + "\n"
    result = dry_write(DOVECOT_USERS, content)
    if settings.allow_live_system_commands:
        try:
            os.chmod(DOVECOT_USERS, 0o640)
        except OSError:
            pass
    return result


def smtp_settings(hostname: str, certificate_path: str | None, key_path: str | None, message_rate_limit: str) -> list[tuple[str, str]]:
    settings_map = [
        ("smtpd_sasl_type", "dovecot"),
        ("smtpd_sasl_path", "private/auth"),
        ("smtpd_sasl_auth_enable", "yes"),
        ("smtpd_tls_security_level", "may"),
        ("smtpd_tls_auth_only", "yes"),
        ("smtpd_recipient_restrictions", "permit_sasl_authenticated,reject_unauth_destination"),
        ("virtual_mailbox_domains", "hash:/etc/postfix/vmaildomains"),
        ("virtual_mailbox_maps", "hash:/etc/postfix/vmailbox"),
        ("virtual_transport", "lmtp:unix:private/dovecot-lmtp"),
        ("message_size_limit", "52428800"),
        ("smtpd_client_message_rate_limit", message_rate_limit),
        ("myhostname", hostname),
    ]
    if certificate_path and key_path:
        settings_map.extend([
            ("smtpd_tls_cert_file", certificate_path),
            ("smtpd_tls_key_file", key_path),
        ])
    return settings_map


@router.post("/dkim")
def setup_dkim(payload: MailDomain) -> dict:
    domain = payload.domain.strip().lower()
    key_dir = Path("/etc/opendkim/keys") / domain
    if settings.allow_live_system_commands:
        key_dir.mkdir(parents=True, exist_ok=True)
    result = run_command(["opendkim-genkey", "-b", "2048", "-d", domain, "-D", str(key_dir), "-s", "mail"])
    txt_path = key_dir / "mail.txt"
    txt_value = None
    if txt_path.exists():
        raw = txt_path.read_text(encoding="utf-8")
        parts = re.findall(r'"([^"]+)"', raw)
        txt_value = "".join(parts) if parts else None
    return {
        "result": result,
        "selector": "mail",
        "recordName": "mail._domainkey",
        "recordValue": txt_value,
        "txtPath": str(txt_path),
        "chown": run_command(["chown", "-R", "opendkim:opendkim", str(key_dir)]),
        "reload": run_command(["systemctl", "reload", "opendkim"]),
    }


@router.post("/mailbox")
def create_mailbox(payload: MailboxRequest) -> dict:
    email, user, domain = safe_email(payload.email)
    maildir = maildir_for(user, domain)
    vmail_group = run_command(["groupadd", "-f", "vmail"])
    vmail_user = run_command(["id", "-u", "vmail"])
    if vmail_user.get("returncode") not in (0, None):
        vmail_user = run_command(["useradd", "-r", "-g", "vmail", "-u", "5000", "-d", "/var/mail/vhosts", "-s", "/usr/sbin/nologin", "vmail"])
    mkdir = run_command(["install", "-d", "-o", "vmail", "-g", "vmail", str(maildir / "cur"), str(maildir / "new"), str(maildir / "tmp")])
    vdomains = merge_key_value_line(VMAILDOMAINS, domain, f"{domain} OK")
    vmailbox = merge_key_value_line(VMAILBOX, email, f"{email} {domain}/{user}/")
    postmap_domains = run_command(["postmap", str(VMAILDOMAINS)])
    postmap = run_command(["postmap", str(VMAILBOX)])
    dovecot_user = merge_dovecot_user(email, payload.passwordHash, maildir) if payload.passwordHash else {"skipped": True, "reason": "passwordHash not provided"}
    reload_result = reload_mail_services()
    return {"maildir": str(maildir), "vmailGroup": vmail_group, "vmailUser": vmail_user, "mkdir": mkdir, "vdomains": vdomains, "vmailbox": vmailbox, "postmapDomains": postmap_domains, "postmap": postmap, "dovecotUser": dovecot_user, "reload": reload_result}


@router.post("/alias")
def update_alias(payload: AliasRequest) -> dict:
    return run_command(["postmap", "/etc/postfix/virtual"])


@router.post("/smtp/configure")
def configure_smtp(payload: MailDomain) -> dict:
    domain = payload.domain.strip().lower()
    hostname = (payload.hostname or f"mail.{domain}").strip().lower()
    certificate_path = payload.certificatePath or f"/etc/letsencrypt/live/{hostname}/fullchain.pem"
    key_path = payload.keyPath or f"/etc/letsencrypt/live/{hostname}/privkey.pem"
    tls_available = Path(certificate_path).exists() and Path(key_path).exists()
    effective_cert = certificate_path if tls_available else None
    effective_key = key_path if tls_available else None

    postfix = [
        run_command(["postconf", "-e", f"{key}={value}"])
        for key, value in smtp_settings(hostname, effective_cert, effective_key, payload.messageRateLimit)
    ]
    vdomains = merge_key_value_line(VMAILDOMAINS, domain, f"{domain} OK")
    postmap_domains = run_command(["postmap", str(VMAILDOMAINS)])
    submission = run_command(["postconf", "-M", "submission/inet=submission inet n - y - - smtpd"])
    submission_tls = run_command(["postconf", "-P", "submission/inet/syslog_name=postfix/submission"])
    submission_auth = run_command(["postconf", "-P", "submission/inet/smtpd_sasl_auth_enable=yes"])
    submission_relay = run_command(["postconf", "-P", "submission/inet/smtpd_recipient_restrictions=permit_sasl_authenticated,reject"])
    submission_tls_only = run_command(["postconf", "-P", "submission/inet/smtpd_tls_security_level=encrypt"])

    auth_conf = """
auth_mechanisms = plain login
passdb {
  driver = passwd-file
  args = scheme=BLF-CRYPT username_format=%u /etc/dovecot/users
}
userdb {
  driver = passwd-file
  args = username_format=%u /etc/dovecot/users
}
service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode = 0660
    user = postfix
    group = postfix
  }
}
""".lstrip()
    mail_conf = """
mail_location = maildir:/var/mail/vhosts/%d/%n
namespace inbox {
  inbox = yes
}
protocol lmtp {
  postmaster_address = postmaster@localhost
}
service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode = 0600
    user = postfix
    group = postfix
  }
}
""".lstrip()
    ssl_conf = f"""
ssl = required
ssl_cert = <{certificate_path}
ssl_key = <{key_path}
""".lstrip() if tls_available else "# TLS certificate for this mail hostname is not available yet.\nssl = yes\n"

    files = {
        "auth": dry_write(DOVECOT_PANEL_AUTH, auth_conf),
        "mail": dry_write(DOVECOT_PANEL_MAIL, mail_conf),
        "ssl": dry_write(DOVECOT_PANEL_SSL, ssl_conf),
        "users": dry_write(DOVECOT_USERS, DOVECOT_USERS.read_text(encoding="utf-8") if DOVECOT_USERS.exists() else ""),
    }
    reload_result = reload_mail_services()
    return {
        "domain": domain,
        "hostname": hostname,
        "submissionPort": 587,
        "tlsAvailable": tls_available,
        "certificatePath": certificate_path,
        "keyPath": key_path,
        "postfix": postfix,
        "vdomains": vdomains,
        "postmapDomains": postmap_domains,
        "submission": [submission, submission_tls, submission_auth, submission_relay, submission_tls_only],
        "files": files,
        "reload": reload_result,
        "commandsAvailable": {
            "postconf": shutil.which("postconf") is not None,
            "postmap": shutil.which("postmap") is not None,
            "dovecot": shutil.which("dovecot") is not None,
        },
    }


@router.post("/reload")
def reload_mail_services() -> dict:
    return {
        "postfix": run_command(["systemctl", "reload", "postfix"]),
        "dovecot": run_command(["systemctl", "reload", "dovecot"]),
        "opendkim": run_command(["systemctl", "reload", "opendkim"]),
    }
