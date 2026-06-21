from __future__ import annotations

from pathlib import Path
from email.message import EmailMessage
from email import policy
from email.parser import BytesParser
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
import hashlib
import os
import re
import shutil
import smtplib
import socket
import ssl
import stat as stat_module
import time
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.command import run_command, run_install_plan
from app.config import settings
from app.firewall_backend import apply_rule_command, list_rules_command
from app.mail_utils import dovecot_user_line, mail_milter_settings, mail_security_postfix_settings, mail_security_profile, smtp_settings
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
    domain: str
    mailboxes: list[MailboxRequest]


class AliasRequest(BaseModel):
    source: str
    target: str


class AliasDeleteRequest(BaseModel):
    source: str


class MailboxDeleteRequest(BaseModel):
    email: str


class SmtpHealthRequest(BaseModel):
    hostname: str
    username: str
    password: str = Field(min_length=1)
    recipient: str
    port: int = Field(default=587, ge=1, le=65535)


class IncomingHealthRequest(BaseModel):
    domain: str
    email: str


class MailSecurityRequest(BaseModel):
    enableClamav: bool = False


class MailboxMessagesRequest(BaseModel):
    email: str
    maxMessages: int = Field(default=250, ge=1, le=1000)


VMAILBOX = Path("/etc/postfix/vmailbox")
VMAILDOMAINS = Path("/etc/postfix/vmaildomains")
VIRTUAL_ALIASES = Path("/etc/postfix/virtual")
DOVECOT_USERS = Path("/etc/dovecot/users")
DOVECOT_PANEL_AUTH = Path("/etc/dovecot/conf.d/10-vps-panel-auth.conf")
DOVECOT_PANEL_MAIL = Path("/etc/dovecot/conf.d/10-vps-panel-mail.conf")
DOVECOT_PANEL_SSL = Path("/etc/dovecot/conf.d/10-vps-panel-ssl.conf")
CERTBOT_MAIL_DEPLOY_HOOK = Path("/etc/letsencrypt/renewal-hooks/deploy/vps-panel-mail-reload.sh")
OPENDKIM_CONFIG = Path("/etc/opendkim.conf")
OPENDKIM_KEY_TABLE = Path("/etc/opendkim/KeyTable")
OPENDKIM_SIGNING_TABLE = Path("/etc/opendkim/SigningTable")
OPENDKIM_TRUSTED_HOSTS = Path("/etc/opendkim/TrustedHosts")
FAIL2BAN_MAIL_JAIL = Path("/etc/fail2ban/jail.d/vps-panel-mail.conf")
RSPAMD_MILTER_CONFIG = Path("/etc/rspamd/local.d/worker-proxy.inc")
RSPAMD_ANTIVIRUS_CONFIG = Path("/etc/rspamd/local.d/antivirus.conf")


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


def safe_domain(domain: str) -> str:
    normalized = domain.strip().lower()
    if not re.match(r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$", normalized):
        raise ValueError("Invalid mail domain")
    return normalized


def maildir_for(user: str, domain: str) -> Path:
    return Path("/var/mail/vhosts") / domain / user


def message_text(message, subtype: str) -> str | None:
    part = message.get_body(preferencelist=(subtype,)) if message.is_multipart() else message
    if part is None or part.get_content_maintype() != "text":
        return None
    try:
        return str(part.get_content())[:200_000]
    except (LookupError, UnicodeError):
        return part.get_payload(decode=True).decode("utf-8", errors="replace")[:200_000]


def parse_maildir_message(path: Path) -> dict | None:
    try:
        raw = path.read_bytes()
        message = BytesParser(policy=policy.default).parsebytes(raw)
        raw_message_id = str(message.get("Message-ID", "")).strip().strip("<>")
        message_id = raw_message_id or f"maildir-{hashlib.sha256(raw).hexdigest()}"
        try:
            received = parsedate_to_datetime(str(message.get("Date", "")))
            if received.tzinfo is None:
                received = received.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError, OverflowError):
            received = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        return {
            "messageId": message_id[:998],
            "fromAddress": str(message.get("From", "unknown@localhost"))[:998],
            "toAddress": str(message.get("To", ""))[:998],
            "subject": str(message.get("Subject", "(no subject)"))[:998],
            "bodyText": message_text(message, "plain"),
            "bodyHtml": message_text(message, "html"),
            "receivedAt": received.astimezone(timezone.utc).isoformat(),
        }
    except (OSError, ValueError):
        return None


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


def prune_domain_mailboxes(domain: str, wanted: set[str]) -> dict:
    vmailbox_lines = VMAILBOX.read_text(encoding="utf-8").splitlines() if VMAILBOX.exists() else []
    kept_vmailbox = [line for line in vmailbox_lines if not line.strip() or line.split()[0].split("@")[-1].lower() != domain or line.split()[0].lower() in wanted]
    dovecot_lines = DOVECOT_USERS.read_text(encoding="utf-8").splitlines() if DOVECOT_USERS.exists() else []
    kept_dovecot = [line for line in dovecot_lines if not line.strip() or line.split(":", 1)[0].split("@")[-1].lower() != domain or line.split(":", 1)[0].lower() in wanted]
    return {
        "vmailbox": dry_write(VMAILBOX, "\n".join(kept_vmailbox).strip() + "\n"),
        "dovecotUsers": dry_write(DOVECOT_USERS, "\n".join(kept_dovecot).strip() + "\n"),
    }


def require_command_success(*results: dict) -> None:
    if settings.allow_live_system_commands and any(result.get("returncode") != 0 for result in results):
        detail = "; ".join(result.get("stderr", "command failed").strip() for result in results if result.get("returncode") != 0)
        raise HTTPException(status_code=500, detail=detail or "Mail configuration command failed")


def health_check(key: str, label: str, ok: bool, detail: str) -> dict:
    return {"key": key, "label": label, "ok": ok, "detail": detail}


def relay_abuse_check() -> dict:
    if not settings.allow_live_system_commands:
        return health_check("relay", "Unauthenticated relay", True, "Dry run: RCPT relay rejection will be tested on the live server.")
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 53))
            server_ip = probe.getsockname()[0]
        if server_ip.startswith("127."):
            return health_check("relay", "Unauthenticated relay", False, "No non-loopback server IP was available for a trustworthy relay test.")
        with smtplib.SMTP(server_ip, 25, timeout=10) as client:
            client.ehlo_or_helo_if_needed()
            client.mail("probe@localhost")
            code, response = client.rcpt("probe@invalid.example")
        rejected = code >= 500
        return health_check("relay", "Unauthenticated relay", rejected, f"Unauthenticated test via {server_ip}: RCPT returned {code}: {response.decode(errors='replace')}")
    except Exception as error:
        return health_check("relay", "Unauthenticated relay", False, f"Could not test localhost SMTP: {error}")


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
    postfix = [
        run_command(["postconf", "-e", f"{key}={value}"])
        for key, value in mail_milter_settings(include_rspamd=shutil.which("rspamd") is not None)
    ]
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


@router.post("/mailbox/messages")
def mailbox_messages(payload: MailboxMessagesRequest) -> dict:
    email, user, domain = safe_email(payload.email)
    maildir = maildir_for(user, domain)
    files = []
    for folder in (maildir / "new", maildir / "cur"):
        if folder.is_dir():
            files.extend(item for item in folder.iterdir() if item.is_file())
    files.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    messages = [message for path in files[:payload.maxMessages] if (message := parse_maildir_message(path)) is not None]
    return {"email": email, "messages": messages}


@router.post("/mailboxes/sync")
def sync_mailboxes(payload: MailboxSyncRequest) -> dict:
    domain = safe_domain(payload.domain)
    if any(safe_email(mailbox.email)[2] != domain for mailbox in payload.mailboxes):
        raise HTTPException(status_code=400, detail="All mailboxes must belong to the requested domain")
    vmail = ensure_vmail_user()
    results = [sync_mailbox(mailbox) for mailbox in payload.mailboxes]
    wanted = {safe_email(mailbox.email)[0] for mailbox in payload.mailboxes if mailbox.enabled}
    pruned = prune_domain_mailboxes(domain, wanted)
    postmap_domains = run_command(["postmap", str(VMAILDOMAINS)])
    postmap = run_command(["postmap", str(VMAILBOX)])
    reload_result = reload_mail_services()
    require_command_success(postmap_domains, postmap, *reload_result.values())
    return {"ok": True, "synced": len(results), "vmail": vmail, "mailboxes": results, "pruned": pruned, "postmapDomains": postmap_domains, "postmap": postmap, "reload": reload_result}


@router.delete("/mailbox")
def delete_mailbox(payload: MailboxDeleteRequest) -> dict:
    email, user, domain = safe_email(payload.email)
    vmailbox = merge_key_value_line(VMAILBOX, email, None)
    dovecot_user = merge_dovecot_user(email, None, maildir_for(user, domain), 1024, False)
    postmap = run_command(["postmap", str(VMAILBOX)])
    reload_result = reload_mail_services()
    require_command_success(postmap, *reload_result.values())
    return {"ok": True, "email": email, "maildirRetained": True, "vmailbox": vmailbox, "dovecotUser": dovecot_user, "postmap": postmap, "reload": reload_result}


@router.post("/alias")
def update_alias(payload: AliasRequest) -> dict:
    source, _, _ = safe_email(payload.source)
    target, _, _ = safe_email(payload.target)
    config = merge_key_value_line(VIRTUAL_ALIASES, source, f"{source} {target}")
    postmap = run_command(["postmap", str(VIRTUAL_ALIASES)])
    postconf = run_command(["postconf", "-e", f"virtual_alias_maps=hash:{VIRTUAL_ALIASES}"])
    reload_result = run_command(["systemctl", "reload", "postfix"])
    require_command_success(postmap, postconf, reload_result)
    return {"ok": True, "source": source, "target": target, "config": config, "postmap": postmap, "postconf": postconf, "reload": reload_result}


@router.delete("/alias")
def delete_alias(payload: AliasDeleteRequest) -> dict:
    source, _, _ = safe_email(payload.source)
    config = merge_key_value_line(VIRTUAL_ALIASES, source, None)
    postmap = run_command(["postmap", str(VIRTUAL_ALIASES)])
    reload_result = run_command(["systemctl", "reload", "postfix"])
    require_command_success(postmap, reload_result)
    return {"ok": True, "source": source, "config": config, "postmap": postmap, "reload": reload_result}


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


@router.post("/health/smtp")
def smtp_health_test(payload: SmtpHealthRequest) -> dict:
    username, _, _ = safe_email(payload.username)
    recipient, _, _ = safe_email(payload.recipient)
    hostname = payload.hostname.strip().lower()
    if not re.match(r"^[a-z0-9.-]+$", hostname):
        raise ValueError("Invalid SMTP hostname")
    if not settings.allow_live_system_commands:
        return {"ok": True, "dryRun": True, "checks": [
            health_check("connect", "SMTP connection", True, f"Would connect to {hostname}:{payload.port}"),
            health_check("starttls", "STARTTLS", True, "Would negotiate and validate TLS"),
            health_check("auth", "Mailbox login", True, f"Would authenticate {username}"),
            health_check("send", "Test message", True, f"Would send to {recipient}"),
        ]}
    checks = []
    try:
        context = ssl.create_default_context()
        with smtplib.SMTP(hostname, payload.port, timeout=20) as client:
            client.ehlo()
            checks.append(health_check("connect", "SMTP connection", True, f"Connected to {hostname}:{payload.port}"))
            client.starttls(context=context)
            client.ehlo()
            checks.append(health_check("starttls", "STARTTLS", True, "TLS negotiation and certificate validation passed"))
            client.login(username, payload.password)
            checks.append(health_check("auth", "Mailbox login", True, f"Authenticated as {username}"))
            message = EmailMessage()
            message["From"] = username
            message["To"] = recipient
            message["Subject"] = "VPS Panel SMTP health test"
            message.set_content(f"SMTP health test completed at {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}.")
            client.send_message(message)
            checks.append(health_check("send", "Test message", True, f"Accepted for delivery to {recipient}"))
    except Exception as error:
        failed_key = "connect" if not checks else "starttls" if len(checks) == 1 else "auth" if len(checks) == 2 else "send"
        checks.append(health_check(failed_key, {"connect": "SMTP connection", "starttls": "STARTTLS", "auth": "Mailbox login", "send": "Test message"}[failed_key], False, str(error)))
    return {"ok": all(check["ok"] for check in checks) and len(checks) == 4, "checks": checks}


@router.post("/health/incoming")
def incoming_health_test(payload: IncomingHealthRequest) -> dict:
    email, user, email_domain = safe_email(payload.email)
    domain = payload.domain.strip().lower()
    if domain != email_domain:
        raise ValueError("Mailbox does not belong to the requested domain")
    maildir = maildir_for(user, domain)
    mx = run_command(["dig", "+short", "MX", domain])
    mx_output = mx.get("stdout", "").strip()
    expected_mx = f"mail.{domain}."
    map_check = run_command(["postmap", "-q", email, "hash:/etc/postfix/vmailbox"])
    lmtp_socket = Path("/var/spool/postfix/private/dovecot-lmtp")
    dovecot_config = run_command(["doveconf", "-n"])
    dry_run = not settings.allow_live_system_commands
    checks = [
        health_check("mx", "Public MX", dry_run or (mx.get("returncode") == 0 and expected_mx in mx_output.lower()), mx_output or (f"Dry run: would verify MX points to {expected_mx}" if dry_run else mx.get("stderr", "No MX record returned"))),
        health_check("postfix_map", "Postfix mailbox map", dry_run or (map_check.get("returncode") == 0 and bool(map_check.get("stdout", "").strip())), map_check.get("stdout", "").strip() or ("Dry run: would query vmailbox map" if dry_run else "Mailbox is missing from vmailbox map")),
        health_check("lmtp", "Dovecot LMTP socket", dry_run or (lmtp_socket.exists() and stat_module.S_ISSOCK(lmtp_socket.stat().st_mode) and "protocol lmtp" in dovecot_config.get("stdout", "")), str(lmtp_socket) if dry_run or lmtp_socket.exists() else "LMTP socket is missing"),
    ]
    if settings.allow_live_system_commands:
        try:
            directories = [maildir, maildir / "cur", maildir / "new", maildir / "tmp"]
            stats = [(directory, directory.stat()) for directory in directories]
            permissions_ok = all(item.st_uid == 5000 and item.st_gid == 5000 and (item.st_mode & 0o700) == 0o700 for _directory, item in stats)
            detail = ", ".join(f"{directory.name or user}:uid={item.st_uid}/gid={item.st_gid}/{oct(item.st_mode & 0o777)}" for directory, item in stats)
        except OSError as error:
            permissions_ok, detail = False, str(error)
    else:
        permissions_ok, detail = True, f"Dry run: would inspect {maildir}"
    checks.append(health_check("permissions", "Maildir permissions", permissions_ok, detail))

    token = f"vps-panel-{uuid.uuid4().hex}"
    delivered = False
    delivery_detail = "Dry run: would inject a unique message through localhost Postfix and poll Maildir."
    if settings.allow_live_system_commands and all(check["ok"] for check in checks[1:]):
        try:
            message = EmailMessage()
            message["From"] = f"healthcheck@{domain}"
            message["To"] = email
            message["Subject"] = "VPS Panel inbound delivery test"
            message["Message-ID"] = f"<{token}@{domain}>"
            message.set_content(f"Inbound delivery probe {token}")
            with smtplib.SMTP("127.0.0.1", 25, timeout=15) as client:
                client.send_message(message)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and not delivered:
                for folder in (maildir / "new", maildir / "cur"):
                    for item in folder.glob("*"):
                        try:
                            if token.encode() in item.read_bytes():
                                delivered = True
                                delivery_detail = f"Probe arrived in {item.parent.name}/{item.name}"
                                break
                        except OSError:
                            continue
                    if delivered:
                        break
                if not delivered:
                    time.sleep(0.5)
            if not delivered:
                delivery_detail = "Postfix accepted the probe, but it did not appear in Maildir within 10 seconds."
        except Exception as error:
            delivery_detail = str(error)
    checks.append(health_check("delivery", "Postfix to LMTP delivery", delivered if settings.allow_live_system_commands else True, delivery_detail))
    return {"ok": all(check["ok"] for check in checks), "mailbox": email, "checks": checks}


@router.get("/security/status")
def mail_security_status() -> dict:
    services = ["fail2ban", "rspamd"]
    if shutil.which("clamd") or shutil.which("clamdscan"):
        services.append("clamav-daemon" if current_os().is_debian else "clamd@scan")
    return {
        "commands": {name: shutil.which(name) is not None for name in ["fail2ban-client", "rspamd", "clamdscan"]},
        "services": {service: run_command(["systemctl", "is-active", service]) for service in services},
        "postfix": run_command(["postconf", "-n"]),
        "relay": relay_abuse_check(),
    }


@router.post("/security/configure")
def configure_mail_security(payload: MailSecurityRequest) -> dict:
    info = current_os()
    if not info.is_debian and not info.is_rhel:
        return {"ok": False, "error": f"Mail security automation is not supported on {info.pretty_name}."}
    profile = mail_security_profile(info.is_debian, payload.enableClamav)
    packages = profile["packages"]
    if info.is_debian:
        install = [run_command(["apt-get", "update"], timeout=900), run_command(["apt-get", "install", "-y", *packages], env={"DEBIAN_FRONTEND": "noninteractive"}, timeout=1800)]
    else:
        install = [run_command(["dnf", "install", "-y", "epel-release"], timeout=900), run_command(["dnf", "install", "-y", *packages], timeout=1800)]
    redis_service = profile["redisService"]
    clam_service = profile["clamService"]
    clam_socket = profile["clamSocket"]

    fail2ban = dry_write(FAIL2BAN_MAIL_JAIL, """[postfix-sasl]
enabled = true
port = smtp,submission,465
filter = postfix[mode=auth]
maxretry = 5
findtime = 10m
bantime = 1h

[dovecot]
enabled = true
port = pop3,pop3s,imap,imaps,submission,465
maxretry = 5
findtime = 10m
bantime = 1h
""")
    rspamd = dry_write(RSPAMD_MILTER_CONFIG, """bind_socket = "127.0.0.1:11332";
milter = yes;
timeout = 120s;
upstream "local" {
  default = yes;
  self_scan = yes;
}
""")
    antivirus = dry_write(RSPAMD_ANTIVIRUS_CONFIG, f"""clamav {{
  type = "clamav";
  servers = "{clam_socket}";
  symbol = "CLAM_VIRUS";
  action = "reject";
}}
""") if payload.enableClamav else {"skipped": True, "reason": "ClamAV not requested"}

    postfix_values = mail_security_postfix_settings()
    postfix = [run_command(["postconf", "-e", f"{key}={value}"]) for key, value in postfix_values]
    services = [
        run_command(["systemctl", "enable", "--now", redis_service]),
        run_command(["systemctl", "enable", "--now", "rspamd"]),
        run_command(["systemctl", "enable", "--now", "fail2ban"]),
        *([run_command(["systemctl", "enable", "--now", clam_service])] if payload.enableClamav else []),
        run_command(["systemctl", "restart", "rspamd"]),
        run_command(["systemctl", "restart", "fail2ban"]),
        run_command(["systemctl", "reload", "postfix"]),
    ]
    validation = {
        "postfix": run_command(["postfix", "check"]),
        "rspamd": run_command(["rspamadm", "configtest"]),
        "fail2ban": run_command(["fail2ban-client", "-t"]),
        "relay": relay_abuse_check(),
    }
    return {"ok": all(result.get("returncode") == 0 for result in install + postfix + services) and all(result.get("returncode") == 0 for key, result in validation.items() if key != "relay") and validation["relay"]["ok"], "packages": packages, "install": install, "files": {"fail2ban": fail2ban, "rspamd": rspamd, "antivirus": antivirus}, "postfix": postfix, "services": services, "validation": validation}


@router.post("/reload")
def reload_mail_services() -> dict:
    return {
        "postfix": run_command(["systemctl", "reload", "postfix"]),
        "dovecot": run_command(["systemctl", "reload", "dovecot"]),
        "opendkim": run_command(["systemctl", "reload", "opendkim"]),
    }
