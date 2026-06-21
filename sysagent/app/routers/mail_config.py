from pathlib import Path
import os
import re
import shutil

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.command import run_command, run_install_plan
from app.config import settings
from app.firewall_backend import apply_rule_command, list_rules_command
from app.mail_utils import dovecot_user_line, smtp_settings
from app.platform import current_os, install_plan_for

router = APIRouter()


class MailDomain(BaseModel):
    domain: str
    hostname: str | None = None
    certificatePath: str | None = None
    keyPath: str | None = None
    messageRateLimit: int = Field(default=60, ge=1, le=10000)


class MailboxRequest(BaseModel):
    email: str
    quotaMb: int = Field(default=1024, ge=128)
    passwordHash: str | None = None
    enabled: bool = True


class MailboxSyncRequest(BaseModel):
    mailboxes: list[MailboxRequest]


class AliasRequest(BaseModel):
    source: str
    target: str


VMAILBOX = Path("/etc/postfix/vmailbox")
VMAILDOMAINS = Path("/etc/postfix/vmaildomains")
DOVECOT_USERS = Path("/etc/dovecot/users")
DOVECOT_PANEL_AUTH = Path("/etc/dovecot/conf.d/10-vps-panel-auth.conf")
DOVECOT_PANEL_MAIL = Path("/etc/dovecot/conf.d/10-vps-panel-mail.conf")
DOVECOT_PANEL_SSL = Path("/etc/dovecot/conf.d/10-vps-panel-ssl.conf")
CERTBOT_MAIL_DEPLOY_HOOK = Path("/etc/letsencrypt/renewal-hooks/deploy/vps-panel-mail-reload.sh")
OPENDKIM_CONFIG = Path("/etc/opendkim.conf")
OPENDKIM_KEY_TABLE = Path("/etc/opendkim/KeyTable")
OPENDKIM_SIGNING_TABLE = Path("/etc/opendkim/SigningTable")
OPENDKIM_TRUSTED_HOSTS = Path("/etc/opendkim/TrustedHosts")


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


def merge_key_value_line(path: Path, key: str, line: str | None) -> dict:
    existing = ""
    if path.exists():
        existing = path.read_text(encoding="utf-8")
    lines = [item for item in existing.splitlines() if not item.startswith(f"{key} ")]
    if line:
        lines.append(line)
    content = "\n".join(lines).strip() + "\n"
    return dry_write(path, content)


def merge_dovecot_user(email: str, password_hash: str | None, maildir: Path, quota_mb: int, enabled: bool) -> dict:
    existing = ""
    if DOVECOT_USERS.exists():
        existing = DOVECOT_USERS.read_text(encoding="utf-8")
    lines = [item for item in existing.splitlines() if not item.startswith(f"{email}:")]
    if enabled and password_hash:
        lines.append(dovecot_user_line(email, password_hash, str(maildir), quota_mb))
    content = "\n".join(lines).strip() + "\n"
    result = dry_write(DOVECOT_USERS, content)
    if settings.allow_live_system_commands:
        try:
            os.chmod(DOVECOT_USERS, 0o640)
        except OSError:
            pass
    return result


def merge_opendkim_config(directives: dict[str, str]) -> dict:
    existing = OPENDKIM_CONFIG.read_text(encoding="utf-8") if OPENDKIM_CONFIG.exists() else ""
    keys = {key.lower() for key in directives}
    lines = [line for line in existing.splitlines() if not (line.strip() and not line.lstrip().startswith("#") and line.split()[0].lower() in keys)]
    lines.extend(f"{key:<22} {value}" for key, value in directives.items())
    return dry_write(OPENDKIM_CONFIG, "\n".join(lines).strip() + "\n")


def merge_unique_lines(path: Path, required: list[str]) -> dict:
    existing = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    content = "\n".join(dict.fromkeys([line.strip() for line in existing if line.strip()] + required)) + "\n"
    return dry_write(path, content)


def ensure_vmail_user() -> dict:
    group = run_command(["groupadd", "-f", "vmail"])
    user = run_command(["id", "-u", "vmail"])
    if user.get("returncode") not in (0, None):
        user = run_command(["useradd", "-r", "-g", "vmail", "-u", "5000", "-d", "/var/mail/vhosts", "-s", "/usr/sbin/nologin", "vmail"])
    return {"group": group, "user": user}


def sync_mailbox(payload: MailboxRequest) -> dict:
    email, user, domain = safe_email(payload.email)
    maildir = maildir_for(user, domain)
    mkdir = run_command(["install", "-d", "-o", "vmail", "-g", "vmail", str(maildir / "cur"), str(maildir / "new"), str(maildir / "tmp")]) if payload.enabled else {"skipped": True, "reason": "mailbox disabled"}
    vdomains = merge_key_value_line(VMAILDOMAINS, domain, f"{domain} OK")
    vmailbox = merge_key_value_line(VMAILBOX, email, f"{email} {domain}/{user}/" if payload.enabled else None)
    dovecot_user = merge_dovecot_user(email, payload.passwordHash, maildir, payload.quotaMb, payload.enabled)
    return {"email": email, "enabled": payload.enabled, "maildir": str(maildir), "mkdir": mkdir, "vdomains": vdomains, "vmailbox": vmailbox, "dovecotUser": dovecot_user}


@router.get("/stack/status")
def mail_stack_status() -> dict:
    return {
        "platform": current_os().pretty_name,
        "commands": {
            "postfix": shutil.which("postfix") is not None,
            "dovecot": shutil.which("dovecot") is not None,
            "opendkim": shutil.which("opendkim") is not None,
            "certbot": shutil.which("certbot") is not None,
        },
        "services": {
            service: run_command(["systemctl", "is-active", service])
            for service in ["postfix", "dovecot", "opendkim"]
        },
        "ports": run_command(["ss", "-ltn"]),
        "liveCommandsEnabled": settings.allow_live_system_commands,
    }


@router.post("/stack/install")
def install_mail_stack() -> dict:
    plan = install_plan_for("mail_stack", current_os())
    return run_install_plan(plan, timeout=1800)


@router.get("/firewall/status")
def mail_firewall_status() -> dict:
    return {
        "requiredPorts": [25, 143, 465, 587, 993],
        "rules": run_command(list_rules_command()),
        "listeners": run_command(["ss", "-ltn"]),
    }


@router.post("/firewall/apply")
def apply_mail_firewall() -> dict:
    ports = [25, 143, 465, 587, 993]
    return {
        "ports": ports,
        "results": [
            run_command(apply_rule_command(action="ALLOW", port=port, protocol="tcp", source_ip=None))
            for port in ports
        ],
        "rules": run_command(list_rules_command()),
    }


@router.post("/dkim")
def setup_dkim(payload: MailDomain) -> dict:
    domain = payload.domain.strip().lower()
    key_dir = Path("/etc/opendkim/keys") / domain
    if settings.allow_live_system_commands:
        key_dir.mkdir(parents=True, exist_ok=True)
    private_key = key_dir / "mail.private"
    result = {"skipped": True, "reason": "existing key retained", "returncode": 0} if private_key.exists() else run_command(["opendkim-genkey", "-b", "2048", "-d", domain, "-D", str(key_dir), "-s", "mail"])
    txt_path = key_dir / "mail.txt"
    txt_value = None
    if txt_path.exists():
        raw = txt_path.read_text(encoding="utf-8")
        parts = re.findall(r'"([^"]+)"', raw)
        txt_value = "".join(parts) if parts else None
    config = merge_opendkim_config({
        "Mode": "sv",
        "Canonicalization": "relaxed/simple",
        "OversignHeaders": "From",
        "Socket": "inet:8891@localhost",
        "UserID": "opendkim",
        "UMask": "007",
        "KeyTable": f"refile:{OPENDKIM_KEY_TABLE}",
        "SigningTable": f"refile:{OPENDKIM_SIGNING_TABLE}",
        "ExternalIgnoreList": f"refile:{OPENDKIM_TRUSTED_HOSTS}",
        "InternalHosts": f"refile:{OPENDKIM_TRUSTED_HOSTS}",
    })
    key_table = merge_key_value_line(OPENDKIM_KEY_TABLE, f"mail._domainkey.{domain}", f"mail._domainkey.{domain} {domain}:mail:{private_key}")
    signing_table = merge_key_value_line(OPENDKIM_SIGNING_TABLE, f"*@{domain}", f"*@{domain} mail._domainkey.{domain}")
    trusted_hosts = merge_unique_lines(OPENDKIM_TRUSTED_HOSTS, ["127.0.0.1", "localhost", "::1", domain, f"*.{domain}"])
    postfix = [run_command(["postconf", "-e", f"{key}={value}"]) for key, value in [
        ("milter_default_action", "accept"),
        ("milter_protocol", "6"),
        ("smtpd_milters", "inet:127.0.0.1:8891"),
        ("non_smtpd_milters", "inet:127.0.0.1:8891"),
    ]]
    permissions = [
        run_command(["chown", "-R", "opendkim:opendkim", str(key_dir), str(OPENDKIM_KEY_TABLE), str(OPENDKIM_SIGNING_TABLE), str(OPENDKIM_TRUSTED_HOSTS)]),
        run_command(["chmod", "600", str(private_key)]),
        run_command(["chmod", "640", str(OPENDKIM_KEY_TABLE), str(OPENDKIM_SIGNING_TABLE), str(OPENDKIM_TRUSTED_HOSTS)]),
    ]
    restart = run_command(["systemctl", "restart", "opendkim"])
    return {
        "result": result,
        "selector": "mail",
        "recordName": "mail._domainkey",
        "recordValue": txt_value,
        "txtPath": str(txt_path),
        "config": config,
        "tables": {"key": key_table, "signing": signing_table, "trustedHosts": trusted_hosts},
        "postfix": postfix,
        "permissions": permissions,
        "restart": restart,
        "postfixReload": run_command(["systemctl", "reload", "postfix"]),
        "keyCheck": run_command(["opendkim-testkey", "-d", domain, "-s", "mail", "-vvv"]),
    }


@router.post("/mailbox")
def create_mailbox(payload: MailboxRequest) -> dict:
    vmail = ensure_vmail_user()
    synced = sync_mailbox(payload)
    postmap_domains = run_command(["postmap", str(VMAILDOMAINS)])
    postmap = run_command(["postmap", str(VMAILBOX)])
    reload_result = reload_mail_services()
    return {**synced, "vmail": vmail, "postmapDomains": postmap_domains, "postmap": postmap, "reload": reload_result}


@router.post("/mailboxes/sync")
def sync_mailboxes(payload: MailboxSyncRequest) -> dict:
    vmail = ensure_vmail_user()
    results = [sync_mailbox(mailbox) for mailbox in payload.mailboxes]
    postmap_domains = run_command(["postmap", str(VMAILDOMAINS)])
    postmap = run_command(["postmap", str(VMAILBOX)])
    reload_result = reload_mail_services()
    return {"ok": True, "synced": len(results), "vmail": vmail, "mailboxes": results, "postmapDomains": postmap_domains, "postmap": postmap, "reload": reload_result}


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
    submission_rate = [
        run_command(["postconf", "-P", f"submission/inet/smtpd_client_message_rate_limit={payload.messageRateLimit}"]),
        run_command(["postconf", "-P", f"submission/inet/smtpd_client_recipient_rate_limit={payload.messageRateLimit * 10}"]),
        run_command(["postconf", "-P", f"submission/inet/smtpd_client_connection_rate_limit={max(10, payload.messageRateLimit // 2)}"]),
    ]

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
mail_plugins = $mail_plugins quota
namespace inbox {
  inbox = yes
}
protocol lmtp {
  postmaster_address = postmaster@localhost
  mail_plugins = $mail_plugins quota
  quota_full_tempfail = yes
}
protocol imap {
  mail_plugins = $mail_plugins imap_quota
}
plugin {
  quota = maildir:User quota
  quota_rule = *:storage=1G
  quota_grace = 10%
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
        "certbotDeployHook": dry_write(
            CERTBOT_MAIL_DEPLOY_HOOK,
            "#!/usr/bin/env bash\nset -euo pipefail\nsystemctl reload postfix dovecot opendkim\n",
        ),
    }
    if settings.allow_live_system_commands:
        try:
            os.chmod(CERTBOT_MAIL_DEPLOY_HOOK, 0o750)
        except OSError:
            pass
    certbot_timer = run_command(["sh", "-lc", "systemctl enable --now certbot.timer 2>/dev/null || true"])
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
        "submission": [submission, submission_tls, submission_auth, submission_relay, submission_tls_only, *submission_rate],
        "rateLimit": {"messagesPerClient": payload.messageRateLimit, "windowSeconds": 60, "recipientsPerClient": payload.messageRateLimit * 10, "connectionsPerClient": max(10, payload.messageRateLimit // 2)},
        "files": files,
        "certbotTimer": certbot_timer,
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
