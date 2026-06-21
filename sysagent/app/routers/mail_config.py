from __future__ import annotations

from pathlib import Path
from email.message import EmailMessage
from email import policy
from email.parser import BytesParser
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import shutil
import smtplib
import socket
import ssl
import stat as stat_module
import tempfile
import threading
import time
import uuid
from functools import wraps

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
    selector: str = Field(default="mail", pattern=r"^[a-z0-9][a-z0-9_-]{0,30}$")
    pop3Enabled: bool = False


class MailboxRequest(BaseModel):
    email: str
    quotaMb: int = Field(default=1024, ge=128)
    passwordHash: str | None = None
    enabled: bool = True
    smtpSuspended: bool = False
    dailySendLimit: int = Field(default=500, ge=1, le=100000)
    minuteSendLimit: int = Field(default=60, ge=1, le=10000)


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


class MailStackInstallRequest(BaseModel):
    enableRspamd: bool = False


class MailboxMessagesRequest(BaseModel):
    email: str
    maxMessages: int = Field(default=250, ge=1, le=1000)


class MailQueueActionRequest(BaseModel):
    action: str = Field(pattern=r"^(flush|retry|delete)$")
    queueId: str | None = Field(default=None, pattern=r"^[A-Fa-f0-9*!]{5,30}$")


class MailBackupRestoreRequest(BaseModel):
    archivePath: str


class ReputationRequest(BaseModel):
    domains: list[str]
    publicIp: str | None = None


VMAILBOX = Path("/etc/postfix/vmailbox")
VMAILDOMAINS = Path("/etc/postfix/vmaildomains")
VIRTUAL_ALIASES = Path("/etc/postfix/virtual")
SMTP_SUSPENDED = Path("/etc/postfix/smtp_suspended")
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
RSPAMD_ACTIONS_CONFIG = Path("/etc/rspamd/local.d/actions.conf")
RSPAMD_GREYLIST_CONFIG = Path("/etc/rspamd/local.d/greylist.conf")
RSPAMD_MILTER_HEADERS_CONFIG = Path("/etc/rspamd/local.d/milter_headers.conf")
RSPAMD_RATELIMIT_CONFIG = Path("/etc/rspamd/local.d/ratelimit.conf")
MAIL_POLICY_CONFIG = Path("/etc/vps-panel/mail-policy.json")
MAIL_POLICY_STATE = Path("/var/lib/vps-panel/mail-policy-state.json")
MAIL_POLICY_SCRIPT = Path("/usr/local/bin/vps-panel-mail-policy.py")
MAIL_POLICY_SERVICE = Path("/etc/systemd/system/vps-panel-mail-policy.service")
MAIL_BACKUP_ROOT = Path("/var/backups/vps-panel/mail")
CONFIG_LOCK = threading.RLock()


def mail_config_transaction(function):
    tracked = [
        Path("/etc/postfix/main.cf"),
        Path("/etc/postfix/master.cf"),
        VMAILDOMAINS,
        SMTP_SUSPENDED,
        DOVECOT_PANEL_AUTH,
        DOVECOT_PANEL_MAIL,
        DOVECOT_PANEL_SSL,
        DOVECOT_USERS,
        CERTBOT_MAIL_DEPLOY_HOOK,
    ]

    @wraps(function)
    def wrapped(*args, **kwargs):
        if not settings.allow_live_system_commands:
            return function(*args, **kwargs)
        with CONFIG_LOCK:
            snapshots = {path: (path.exists(), path.read_text(encoding="utf-8") if path.exists() else "") for path in tracked}
            try:
                return function(*args, **kwargs)
            except Exception:
                for path, (existed, content) in snapshots.items():
                    try:
                        if existed:
                            dry_write(path, content)
                        elif path.exists():
                            path.unlink()
                    except OSError:
                        pass
                run_command(["postmap", str(VMAILDOMAINS)])
                raise

    return wrapped


def dry_write(path: Path, content: str) -> dict:
    if not settings.allow_live_system_commands:
        return {
            "dryRun": True,
            "liveCommandsDisabled": True,
            "path": str(path),
            "content": content,
            "returncode": 0,
        }
    with CONFIG_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        previous = path.stat() if path.exists() else None
        descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            if previous:
                os.chmod(temporary, stat_module.S_IMODE(previous.st_mode))
                os.chown(temporary, previous.st_uid, previous.st_gid)
            else:
                os.chmod(temporary, 0o644)
            os.replace(temporary, path)
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
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
    with CONFIG_LOCK:
        existing = path.read_text(encoding="utf-8") if path.exists() else ""
        lines = [item for item in existing.splitlines() if not item.startswith(f"{key} ")]
        if line:
            lines.append(line)
        return dry_write(path, "\n".join(lines).strip() + "\n")


def merge_dovecot_user(email: str, password_hash: str | None, maildir: Path, quota_mb: int, enabled: bool) -> dict:
    with CONFIG_LOCK:
        existing = DOVECOT_USERS.read_text(encoding="utf-8") if DOVECOT_USERS.exists() else ""
        lines = [item for item in existing.splitlines() if not item.startswith(f"{email}:")]
        if enabled and password_hash:
            lines.append(dovecot_user_line(email, password_hash, str(maildir), quota_mb))
        result = dry_write(DOVECOT_USERS, "\n".join(lines).strip() + "\n")
    if settings.allow_live_system_commands:
        try:
            os.chmod(DOVECOT_USERS, 0o640)
        except OSError:
            pass
    return result


def merge_opendkim_config(directives: dict[str, str]) -> dict:
    with CONFIG_LOCK:
        existing = OPENDKIM_CONFIG.read_text(encoding="utf-8") if OPENDKIM_CONFIG.exists() else ""
        keys = {key.lower() for key in directives}
        lines = [line for line in existing.splitlines() if not (line.strip() and not line.lstrip().startswith("#") and line.split()[0].lower() in keys)]
        lines.extend(f"{key:<22} {value}" for key, value in directives.items())
        return dry_write(OPENDKIM_CONFIG, "\n".join(lines).strip() + "\n")


def merge_unique_lines(path: Path, required: list[str]) -> dict:
    with CONFIG_LOCK:
        existing = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
        content = "\n".join(dict.fromkeys([line.strip() for line in existing if line.strip()] + required)) + "\n"
        return dry_write(path, content)


def ensure_vmail_user() -> dict:
    group = run_command(["groupadd", "-f", "vmail"])
    user = run_command(["id", "-u", "vmail"])
    if user.get("returncode") not in (0, None):
        user = run_command(["useradd", "-r", "-g", "vmail", "-u", "5000", "-d", "/var/mail/vhosts", "-s", "/usr/sbin/nologin", "vmail"])
    return {"group": group, "user": user}


def policy_script_source() -> str:
    return f"""#!/usr/bin/env python3
import datetime
import json
import socketserver
from pathlib import Path

CONFIG = Path("{MAIL_POLICY_CONFIG}")
STATE = Path("{MAIL_POLICY_STATE}")


def load_json(path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def save_state(state):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        request = {{}}
        while True:
            line = self.rfile.readline().decode("utf-8", errors="replace").strip()
            if not line:
                break
            if "=" in line:
                key, value = line.split("=", 1)
                request[key] = value
        user = (request.get("sasl_username") or request.get("sender") or "").lower()
        config = load_json(CONFIG, {{"users": {{}}}})
        rule = config.get("users", {{}}).get(user)
        if not rule:
            self.wfile.write(b"action=OK\\n\\n")
            return
        if not rule.get("enabled", True) or rule.get("smtpSuspended", False):
            self.wfile.write(b"action=REJECT SMTP sending suspended for this mailbox\\n\\n")
            return
        now = datetime.datetime.utcnow()
        today = now.strftime("%Y-%m-%d")
        minute = now.strftime("%Y-%m-%dT%H:%M")
        state = load_json(STATE, {{"users": {{}}}})
        item = state.setdefault("users", {{}}).setdefault(user, {{"day": today, "dayCount": 0, "minute": minute, "minuteCount": 0}})
        if item.get("day") != today:
            item["day"] = today
            item["dayCount"] = 0
        if item.get("minute") != minute:
            item["minute"] = minute
            item["minuteCount"] = 0
        daily = int(rule.get("dailySendLimit") or 500)
        per_minute = int(rule.get("minuteSendLimit") or 60)
        if item["dayCount"] >= daily:
            self.wfile.write(f"action=DEFER_IF_PERMIT Daily SMTP limit reached for {{user}}\\n\\n".encode())
            return
        if item["minuteCount"] >= per_minute:
            self.wfile.write(f"action=DEFER_IF_PERMIT Per-minute SMTP limit reached for {{user}}\\n\\n".encode())
            return
        item["dayCount"] += 1
        item["minuteCount"] += 1
        save_state(state)
        self.wfile.write(b"action=OK\\n\\n")


with socketserver.ThreadingTCPServer(("127.0.0.1", 10031), Handler) as server:
    server.allow_reuse_address = True
    server.serve_forever()
"""


def mail_policy_service_unit() -> str:
    return f"""[Unit]
Description=VPS Panel per-mailbox SMTP policy service
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/env python3 {MAIL_POLICY_SCRIPT}
Restart=always
RestartSec=2
User=root

[Install]
WantedBy=multi-user.target
"""


def policy_config_from_mailboxes(mailboxes: list[MailboxRequest]) -> dict:
    users = {}
    for mailbox in mailboxes:
        email, _, _ = safe_email(mailbox.email)
        users[email] = {
            "enabled": mailbox.enabled,
            "smtpSuspended": mailbox.smtpSuspended,
            "dailySendLimit": mailbox.dailySendLimit,
            "minuteSendLimit": mailbox.minuteSendLimit,
        }
    return {"users": users}


def merge_policy_mailbox(payload: MailboxRequest) -> dict:
    email, _, _ = safe_email(payload.email)
    existing = {"users": {}}
    if MAIL_POLICY_CONFIG.exists():
        try:
            existing = json.loads(MAIL_POLICY_CONFIG.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            existing = {"users": {}}
    users = existing.setdefault("users", {})
    users[email] = {
        "enabled": payload.enabled,
        "smtpSuspended": payload.smtpSuspended,
        "dailySendLimit": payload.dailySendLimit,
        "minuteSendLimit": payload.minuteSendLimit,
    }
    return dry_write(MAIL_POLICY_CONFIG, json.dumps(existing, indent=2, sort_keys=True) + "\n")


def prune_policy_domain(domain: str, wanted: set[str]) -> dict:
    if not MAIL_POLICY_CONFIG.exists():
        return dry_write(MAIL_POLICY_CONFIG, json.dumps({"users": {}}, indent=2) + "\n")
    try:
        existing = json.loads(MAIL_POLICY_CONFIG.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        existing = {"users": {}}
    existing["users"] = {
        email: rule
        for email, rule in existing.get("users", {}).items()
        if email.split("@")[-1].lower() != domain or email.lower() in wanted
    }
    return dry_write(MAIL_POLICY_CONFIG, json.dumps(existing, indent=2, sort_keys=True) + "\n")


def remove_policy_mailbox(email: str) -> dict:
    existing = {"users": {}}
    if MAIL_POLICY_CONFIG.exists():
        try:
            existing = json.loads(MAIL_POLICY_CONFIG.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            existing = {"users": {}}
    existing.setdefault("users", {}).pop(email.lower(), None)
    return dry_write(MAIL_POLICY_CONFIG, json.dumps(existing, indent=2, sort_keys=True) + "\n")


def ensure_mail_policy_service() -> dict:
    script = dry_write(MAIL_POLICY_SCRIPT, policy_script_source())
    unit = dry_write(MAIL_POLICY_SERVICE, mail_policy_service_unit())
    if settings.allow_live_system_commands:
        try:
            os.chmod(MAIL_POLICY_SCRIPT, 0o755)
        except OSError:
            pass
    daemon = run_command(["systemctl", "daemon-reload"])
    service = run_command(["systemctl", "enable", "--now", "vps-panel-mail-policy"])
    return {"script": script, "unit": unit, "daemonReload": daemon, "service": service}


def policy_restriction() -> str:
    return "check_policy_service inet:127.0.0.1:10031,permit_sasl_authenticated,reject"


def sync_mailbox(payload: MailboxRequest) -> dict:
    email, user, domain = safe_email(payload.email)
    maildir = maildir_for(user, domain)
    mkdir = run_command(["install", "-d", "-o", "vmail", "-g", "vmail", str(maildir / "cur"), str(maildir / "new"), str(maildir / "tmp")]) if payload.enabled else {"skipped": True, "reason": "mailbox disabled"}
    vdomains = merge_key_value_line(VMAILDOMAINS, domain, f"{domain} OK")
    vmailbox = merge_key_value_line(VMAILBOX, email, f"{email} {domain}/{user}/" if payload.enabled else None)
    dovecot_user = merge_dovecot_user(email, payload.passwordHash, maildir, payload.quotaMb, payload.enabled)
    smtp_access = merge_key_value_line(SMTP_SUSPENDED, email, f"{email} REJECT SMTP sending suspended by administrator" if payload.smtpSuspended else None)
    policy = merge_policy_mailbox(payload)
    return {"email": email, "enabled": payload.enabled, "smtpSuspended": payload.smtpSuspended, "dailySendLimit": payload.dailySendLimit, "minuteSendLimit": payload.minuteSendLimit, "maildir": str(maildir), "mkdir": mkdir, "vdomains": vdomains, "vmailbox": vmailbox, "dovecotUser": dovecot_user, "smtpAccess": smtp_access, "policy": policy}


def prune_domain_mailboxes(domain: str, wanted: set[str]) -> dict:
    vmailbox_lines = VMAILBOX.read_text(encoding="utf-8").splitlines() if VMAILBOX.exists() else []
    kept_vmailbox = [line for line in vmailbox_lines if not line.strip() or line.split()[0].split("@")[-1].lower() != domain or line.split()[0].lower() in wanted]
    dovecot_lines = DOVECOT_USERS.read_text(encoding="utf-8").splitlines() if DOVECOT_USERS.exists() else []
    kept_dovecot = [line for line in dovecot_lines if not line.strip() or line.split(":", 1)[0].split("@")[-1].lower() != domain or line.split(":", 1)[0].lower() in wanted]
    suspended_lines = SMTP_SUSPENDED.read_text(encoding="utf-8").splitlines() if SMTP_SUSPENDED.exists() else []
    kept_suspended = [line for line in suspended_lines if not line.strip() or line.split()[0].split("@")[-1].lower() != domain or line.split()[0].lower() in wanted]
    return {
        "vmailbox": dry_write(VMAILBOX, "\n".join(kept_vmailbox).strip() + "\n"),
        "dovecotUsers": dry_write(DOVECOT_USERS, "\n".join(kept_dovecot).strip() + "\n"),
        "smtpSuspended": dry_write(SMTP_SUSPENDED, "\n".join(kept_suspended).strip() + "\n"),
        "policy": prune_policy_domain(domain, wanted),
    }


def require_command_success(*results: dict) -> None:
    if settings.allow_live_system_commands and any(result.get("returncode") != 0 for result in results):
        detail = "; ".join(result.get("stderr", "command failed").strip() for result in results if result.get("returncode") != 0)
        raise HTTPException(status_code=500, detail=detail or "Mail configuration command failed")


def health_check(key: str, label: str, ok: bool, detail: str) -> dict:
    return {"key": key, "label": label, "ok": ok, "detail": detail}


def relay_abuse_check() -> dict:
    if not settings.allow_live_system_commands:
        return health_check("relay", "Unauthenticated relay", False, "Not tested: live system commands are disabled.")
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


def public_ip() -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 53))
            return probe.getsockname()[0]
    except OSError:
        return None


def reverse_ip(ip: str) -> str:
    return ".".join(reversed(ip.split(".")))


def dnsbl_checks(ip: str | None) -> list[dict]:
    if not ip or not re.match(r"^\d{1,3}(?:\.\d{1,3}){3}$", ip):
        return []
    zones = ["zen.spamhaus.org", "bl.spamcop.net", "b.barracudacentral.org"]
    checks = []
    reversed_ip = reverse_ip(ip)
    for zone in zones:
        query = f"{reversed_ip}.{zone}"
        result = run_command(["dig", "+short", query])
        listed = settings.allow_live_system_commands and bool(result.get("stdout", "").strip())
        checks.append({"zone": zone, "listed": listed, "query": query, "result": result})
    return checks


def ptr_check(ip: str | None, expected: str) -> dict:
    if not ip:
        return {"ok": False, "expected": expected, "current": "", "detail": "Could not determine the public IP."}
    result = run_command(["dig", "+short", "-x", ip])
    current = result.get("stdout", "").strip().rstrip(".")
    expected_clean = expected.strip().lower().rstrip(".")
    current_values = [item.strip().lower().rstrip(".") for item in result.get("stdout", "").splitlines() if item.strip()]
    ok = settings.allow_live_system_commands and expected_clean in current_values
    return {"ok": ok, "ip": ip, "expected": expected_clean, "current": current, "result": result, "detail": current or f"Set rDNS/PTR at the VPS provider to {expected_clean}"}


@router.get("/stack/status")
def mail_stack_status() -> dict:
    return {
        "platform": current_os().pretty_name,
        "commands": {
            "postfix": shutil.which("postfix") is not None,
            "dovecot": shutil.which("dovecot") is not None,
            "opendkim": shutil.which("opendkim") is not None,
            "certbot": shutil.which("certbot") is not None,
            "policy": MAIL_POLICY_SCRIPT.exists(),
        },
        "services": {
            service: run_command(["systemctl", "is-active", service])
            for service in ["postfix", "dovecot", "opendkim", "vps-panel-mail-policy"]
        },
        "ports": run_command(["ss", "-ltn"]),
        "liveCommandsEnabled": settings.allow_live_system_commands,
    }


@router.get("/backup")
def mail_backups() -> dict:
    items = []
    if MAIL_BACKUP_ROOT.exists():
        for item in MAIL_BACKUP_ROOT.glob("mail-*.tar.gz"):
            stat = item.stat()
            items.append({"path": str(item), "name": item.name, "sizeBytes": stat.st_size, "modifiedAt": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()})
    items.sort(key=lambda item: item["modifiedAt"], reverse=True)
    return {"ok": True, "backupRoot": str(MAIL_BACKUP_ROOT), "items": items}


@router.post("/backup")
def create_mail_backup() -> dict:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    archive = MAIL_BACKUP_ROOT / f"mail-{stamp}.tar.gz"
    includes = [
        "/var/mail/vhosts",
        str(DOVECOT_USERS),
        str(VMAILBOX),
        str(VMAILDOMAINS),
        str(VIRTUAL_ALIASES),
        str(SMTP_SUSPENDED),
        str(MAIL_POLICY_CONFIG),
        "/etc/postfix/main.cf",
        "/etc/postfix/master.cf",
        str(DOVECOT_PANEL_AUTH),
        str(DOVECOT_PANEL_MAIL),
        str(DOVECOT_PANEL_SSL),
        "/etc/opendkim.conf",
        "/etc/opendkim",
        "/etc/rspamd/local.d",
    ]
    if settings.allow_live_system_commands:
        MAIL_BACKUP_ROOT.mkdir(parents=True, exist_ok=True)
    existing = [path for path in includes if Path(path).exists()]
    result = run_command(["tar", "-czf", str(archive), *existing], timeout=1800)
    return {"ok": settings.allow_live_system_commands and result.get("returncode") == 0, "dryRun": not settings.allow_live_system_commands, "archivePath": str(archive), "includes": existing, "result": result}


@router.post("/restore")
def restore_mail_backup(payload: MailBackupRestoreRequest) -> dict:
    archive = Path(payload.archivePath)
    if not str(archive).startswith(str(MAIL_BACKUP_ROOT)) or archive.suffixes[-2:] != [".tar", ".gz"]:
        raise HTTPException(status_code=400, detail="Restore is limited to mail backup archives created by the panel")
    rollback = create_mail_backup()
    result = run_command(["tar", "-xzf", str(archive), "-C", "/"], timeout=1800)
    maps = [run_command(["postmap", str(path)]) for path in (VMAILBOX, VMAILDOMAINS, VIRTUAL_ALIASES, SMTP_SUSPENDED) if path.exists()]
    reload_result = reload_mail_services()
    require_command_success(result, *maps, *reload_result.values())
    return {"ok": settings.allow_live_system_commands, "dryRun": not settings.allow_live_system_commands, "archivePath": str(archive), "rollbackBackup": rollback, "result": result, "postmaps": maps, "reload": reload_result}


@router.post("/reputation")
def reputation(payload: ReputationRequest) -> dict:
    ip = payload.publicIp or public_ip()
    domains = [safe_domain(domain) for domain in payload.domains]
    ptr = {domain: ptr_check(ip, f"mail.{domain}") for domain in domains}
    return {
        "ok": settings.allow_live_system_commands,
        "dryRun": not settings.allow_live_system_commands,
        "publicIp": ip,
        "domains": [{"domain": domain, "expectedPtr": f"mail.{domain}", "ptr": ptr[domain]} for domain in domains],
        "dnsbl": dnsbl_checks(ip),
        "providerChecklist": [
            "Set rDNS/PTR at the VPS provider to the primary mail hostname.",
            "Keep one consistent HELO hostname for the shared IP.",
            "Check Google Postmaster Tools and Microsoft SNDS externally for reputation trends.",
        ],
    }


@router.post("/stack/install")
def install_mail_stack(payload: MailStackInstallRequest = MailStackInstallRequest()) -> dict:
    plan = install_plan_for("mail_stack", current_os())
    stack = run_install_plan(plan, timeout=1800)
    security = configure_mail_security(MailSecurityRequest(enableClamav=False)) if payload.enableRspamd and settings.allow_live_system_commands else None
    return {"ok": settings.allow_live_system_commands and stack.get("returncode") == 0 and (security is None or security.get("ok") is True), "dryRun": not settings.allow_live_system_commands, "stack": stack, "rspamd": security}


@router.get("/firewall/status")
def mail_firewall_status() -> dict:
    return {
        "requiredPorts": [25, 143, 465, 587, 993, 995],
        "rules": run_command(list_rules_command()),
        "listeners": run_command(["ss", "-ltn"]),
    }


@router.post("/firewall/apply")
def apply_mail_firewall() -> dict:
    ports = [25, 143, 465, 587, 993, 995]
    results = [run_command(apply_rule_command(action="ALLOW", port=port, protocol="tcp", source_ip=None)) for port in ports]
    return {
        "ok": settings.allow_live_system_commands and all(result.get("returncode") == 0 for result in results),
        "dryRun": not settings.allow_live_system_commands,
        "ports": ports,
        "results": results,
        "rules": run_command(list_rules_command()),
    }


@router.post("/dkim")
def setup_dkim(payload: MailDomain) -> dict:
    domain = payload.domain.strip().lower()
    selector = payload.selector.strip().lower()
    key_dir = Path("/etc/opendkim/keys") / domain
    if settings.allow_live_system_commands:
        key_dir.mkdir(parents=True, exist_ok=True)
    private_key = key_dir / f"{selector}.private"
    result = {"skipped": True, "reason": "existing key retained", "returncode": 0} if private_key.exists() else run_command(["opendkim-genkey", "-b", "2048", "-d", domain, "-D", str(key_dir), "-s", selector])
    txt_path = key_dir / f"{selector}.txt"
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
    key_table = merge_key_value_line(OPENDKIM_KEY_TABLE, f"{selector}._domainkey.{domain}", f"{selector}._domainkey.{domain} {domain}:{selector}:{private_key}")
    signing_table = merge_key_value_line(OPENDKIM_SIGNING_TABLE, f"*@{domain}", f"*@{domain} {selector}._domainkey.{domain}")
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
    postfix_reload = run_command(["systemctl", "reload", "postfix"])
    key_check = run_command(["opendkim-testkey", "-d", domain, "-s", selector, "-vvv"])
    require_command_success(result, *postfix, *permissions, restart, postfix_reload)
    return {
        "ok": settings.allow_live_system_commands,
        "dryRun": not settings.allow_live_system_commands,
        "result": result,
        "selector": selector,
        "recordName": f"{selector}._domainkey",
        "recordValue": txt_value,
        "txtPath": str(txt_path),
        "config": config,
        "tables": {"key": key_table, "signing": signing_table, "trustedHosts": trusted_hosts},
        "postfix": postfix,
        "permissions": permissions,
        "restart": restart,
        "postfixReload": postfix_reload,
        "keyCheck": key_check,
    }


@router.post("/mailbox")
def create_mailbox(payload: MailboxRequest) -> dict:
    vmail = ensure_vmail_user()
    synced = sync_mailbox(payload)
    postmap_domains = run_command(["postmap", str(VMAILDOMAINS)])
    postmap = run_command(["postmap", str(VMAILBOX)])
    postmap_suspended = run_command(["postmap", str(SMTP_SUSPENDED)])
    sasl_access = run_command(["postconf", "-e", f"smtpd_sender_restrictions=check_sasl_access hash:{SMTP_SUSPENDED},reject_non_fqdn_sender,reject_unknown_sender_domain"])
    policy_service = ensure_mail_policy_service()
    reload_result = reload_mail_services()
    require_command_success(postmap_domains, postmap, postmap_suspended, sasl_access, policy_service["daemonReload"], policy_service["service"], *reload_result.values())
    return {**synced, "ok": settings.allow_live_system_commands, "dryRun": not settings.allow_live_system_commands, "vmail": vmail, "postmapDomains": postmap_domains, "postmap": postmap, "postmapSuspended": postmap_suspended, "saslAccess": sasl_access, "policyService": policy_service, "reload": reload_result}


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
    postmap_suspended = run_command(["postmap", str(SMTP_SUSPENDED)])
    sasl_access = run_command(["postconf", "-e", f"smtpd_sender_restrictions=check_sasl_access hash:{SMTP_SUSPENDED},reject_non_fqdn_sender,reject_unknown_sender_domain"])
    policy_service = ensure_mail_policy_service()
    reload_result = reload_mail_services()
    require_command_success(postmap_domains, postmap, postmap_suspended, sasl_access, policy_service["daemonReload"], policy_service["service"], *reload_result.values())
    return {"ok": settings.allow_live_system_commands, "dryRun": not settings.allow_live_system_commands, "synced": len(results), "vmail": vmail, "mailboxes": results, "pruned": pruned, "postmapDomains": postmap_domains, "postmap": postmap, "postmapSuspended": postmap_suspended, "saslAccess": sasl_access, "policyService": policy_service, "reload": reload_result}


@router.delete("/mailbox")
def delete_mailbox(payload: MailboxDeleteRequest) -> dict:
    email, user, domain = safe_email(payload.email)
    vmailbox = merge_key_value_line(VMAILBOX, email, None)
    dovecot_user = merge_dovecot_user(email, None, maildir_for(user, domain), 1024, False)
    smtp_access = merge_key_value_line(SMTP_SUSPENDED, email, None)
    policy = remove_policy_mailbox(email)
    postmap = run_command(["postmap", str(VMAILBOX)])
    postmap_suspended = run_command(["postmap", str(SMTP_SUSPENDED)])
    reload_result = reload_mail_services()
    require_command_success(postmap, postmap_suspended, *reload_result.values())
    return {"ok": settings.allow_live_system_commands, "dryRun": not settings.allow_live_system_commands, "email": email, "maildirRetained": True, "vmailbox": vmailbox, "dovecotUser": dovecot_user, "smtpAccess": smtp_access, "policy": policy, "postmap": postmap, "postmapSuspended": postmap_suspended, "reload": reload_result}


@router.post("/alias")
def update_alias(payload: AliasRequest) -> dict:
    source, _, _ = safe_email(payload.source)
    target, _, _ = safe_email(payload.target)
    config = merge_key_value_line(VIRTUAL_ALIASES, source, f"{source} {target}")
    postmap = run_command(["postmap", str(VIRTUAL_ALIASES)])
    postconf = run_command(["postconf", "-e", f"virtual_alias_maps=hash:{VIRTUAL_ALIASES}"])
    reload_result = run_command(["systemctl", "reload", "postfix"])
    require_command_success(postmap, postconf, reload_result)
    return {"ok": settings.allow_live_system_commands, "dryRun": not settings.allow_live_system_commands, "source": source, "target": target, "config": config, "postmap": postmap, "postconf": postconf, "reload": reload_result}


@router.delete("/alias")
def delete_alias(payload: AliasDeleteRequest) -> dict:
    source, _, _ = safe_email(payload.source)
    config = merge_key_value_line(VIRTUAL_ALIASES, source, None)
    postmap = run_command(["postmap", str(VIRTUAL_ALIASES)])
    reload_result = run_command(["systemctl", "reload", "postfix"])
    require_command_success(postmap, reload_result)
    return {"ok": settings.allow_live_system_commands, "dryRun": not settings.allow_live_system_commands, "source": source, "config": config, "postmap": postmap, "reload": reload_result}


@router.post("/smtp/configure")
@mail_config_transaction
def configure_smtp(payload: MailDomain) -> dict:
    domain = payload.domain.strip().lower()
    hostname = (payload.hostname or f"mail.{domain}").strip().lower()
    certificate_path = payload.certificatePath or f"/etc/letsencrypt/live/{hostname}/fullchain.pem"
    key_path = payload.keyPath or f"/etc/letsencrypt/live/{hostname}/privkey.pem"
    tls_available = Path(certificate_path).exists() and Path(key_path).exists()
    effective_cert = certificate_path if tls_available else None
    effective_key = key_path if tls_available else None

    service_start = [
        run_command(["systemctl", "enable", "--now", "postfix"]),
        run_command(["systemctl", "enable", "--now", "dovecot"]),
    ]
    firewall = [run_command(apply_rule_command(action="ALLOW", port=port, protocol="tcp", source_ip=None)) for port in (25, 465, 587, 993, *([995] if payload.pop3Enabled else []))]
    postfix = [
        run_command(["postconf", "-e", f"{key}={value}"])
        for key, value in smtp_settings(hostname, effective_cert, effective_key, payload.messageRateLimit)
    ]
    vdomains = merge_key_value_line(VMAILDOMAINS, domain, f"{domain} OK")
    postmap_domains = run_command(["postmap", str(VMAILDOMAINS)])
    smtp_suspended = dry_write(SMTP_SUSPENDED, SMTP_SUSPENDED.read_text(encoding="utf-8") if SMTP_SUSPENDED.exists() else "")
    postmap_suspended = run_command(["postmap", str(SMTP_SUSPENDED)])
    sasl_access = run_command(["postconf", "-e", f"smtpd_sender_restrictions=check_sasl_access hash:{SMTP_SUSPENDED},reject_non_fqdn_sender,reject_unknown_sender_domain"])
    submission = run_command(["postconf", "-M", "submission/inet=submission inet n - y - - smtpd"])
    submission_tls = run_command(["postconf", "-P", "submission/inet/syslog_name=postfix/submission"])
    submission_auth = run_command(["postconf", "-P", "submission/inet/smtpd_sasl_auth_enable=yes"])
    submission_relay = run_command(["postconf", "-P", f"submission/inet/smtpd_recipient_restrictions={policy_restriction()}"])
    submission_tls_only = run_command(["postconf", "-P", "submission/inet/smtpd_tls_security_level=encrypt"])
    submission_rate = [
        run_command(["postconf", "-P", f"submission/inet/smtpd_client_message_rate_limit={payload.messageRateLimit}"]),
        run_command(["postconf", "-P", f"submission/inet/smtpd_client_recipient_rate_limit={payload.messageRateLimit * 10}"]),
        run_command(["postconf", "-P", f"submission/inet/smtpd_client_connection_rate_limit={max(10, payload.messageRateLimit // 2)}"]),
    ]
    smtps = run_command(["postconf", "-M", "smtps/inet=smtps inet n - y - - smtpd"])
    smtps_settings = [
        run_command(["postconf", "-P", "smtps/inet/syslog_name=postfix/smtps"]),
        run_command(["postconf", "-P", "smtps/inet/smtpd_tls_wrappermode=yes"]),
        run_command(["postconf", "-P", "smtps/inet/smtpd_sasl_auth_enable=yes"]),
        run_command(["postconf", "-P", f"smtps/inet/smtpd_recipient_restrictions={policy_restriction()}"]),
        run_command(["postconf", "-P", f"smtps/inet/smtpd_client_message_rate_limit={payload.messageRateLimit}"]),
        run_command(["postconf", "-P", f"smtps/inet/smtpd_client_recipient_rate_limit={payload.messageRateLimit * 10}"]),
        run_command(["postconf", "-P", f"smtps/inet/smtpd_client_connection_rate_limit={max(10, payload.messageRateLimit // 2)}"]),
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
    mail_conf = f"protocols = imap lmtp{' pop3' if payload.pop3Enabled else ''}\n" + """
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
        for path, mode in ((CERTBOT_MAIL_DEPLOY_HOOK, 0o750), (DOVECOT_USERS, 0o640)):
            try:
                os.chmod(path, mode)
            except OSError:
                pass
    certbot_timer = run_command(["sh", "-lc", "systemctl enable --now certbot.timer 2>/dev/null || true"])
    policy_service = ensure_mail_policy_service()
    pop3_package = None
    if payload.pop3Enabled:
        info = current_os()
        pop3_package = run_command(["apt-get", "install", "-y", "dovecot-pop3d"], env={"DEBIAN_FRONTEND": "noninteractive"}, timeout=900) if info.is_debian else run_command(["dnf", "install", "-y", "dovecot"], timeout=900)
    postfix_validation = run_command(["postfix", "check"])
    dovecot_validation = run_command(["doveconf", "-n"])
    require_command_success(
        *service_start,
        *firewall,
        *postfix,
        postmap_domains,
        postmap_suspended,
        sasl_access,
        submission,
        submission_tls,
        submission_auth,
        submission_relay,
        submission_tls_only,
        *submission_rate,
        smtps,
        *smtps_settings,
        policy_service["daemonReload"],
        policy_service["service"],
        postfix_validation,
        dovecot_validation,
        *([pop3_package] if pop3_package else []),
    )
    restart_result = {
        "postfix": run_command(["systemctl", "restart", "postfix"]),
        "dovecot": run_command(["systemctl", "restart", "dovecot"]),
        "opendkim": run_command(["systemctl", "reload", "opendkim"]),
    }
    require_command_success(*restart_result.values())
    listeners = run_command(["ss", "-ltn"])
    listener_text = listeners.get("stdout", "")
    missing_ports = [port for port in (587, 465) if f":{port} " not in listener_text and f":{port}\n" not in listener_text]
    if settings.allow_live_system_commands and missing_ports:
        raise HTTPException(status_code=500, detail=f"Postfix configured but submission listener(s) missing: {', '.join(str(port) for port in missing_ports)}")
    return {
        "ok": settings.allow_live_system_commands,
        "dryRun": not settings.allow_live_system_commands,
        "domain": domain,
        "hostname": hostname,
        "submissionPort": 587,
        "submissionPorts": [587, 465],
        "tlsAvailable": tls_available,
        "certificatePath": certificate_path,
        "keyPath": key_path,
        "serviceStart": service_start,
        "firewall": firewall,
        "postfix": postfix,
        "vdomains": vdomains,
        "postmapDomains": postmap_domains,
        "smtpSuspended": smtp_suspended,
        "postmapSuspended": postmap_suspended,
        "saslAccess": sasl_access,
        "submission": [submission, submission_tls, submission_auth, submission_relay, submission_tls_only, *submission_rate],
        "smtps": [smtps, *smtps_settings],
        "rateLimit": {"messagesPerClient": payload.messageRateLimit, "windowSeconds": 60, "recipientsPerClient": payload.messageRateLimit * 10, "connectionsPerClient": max(10, payload.messageRateLimit // 2)},
        "policyService": policy_service,
        "files": files,
        "certbotTimer": certbot_timer,
        "validation": {"postfix": postfix_validation, "dovecot": dovecot_validation},
        "pop3": {"enabled": payload.pop3Enabled, "package": pop3_package},
        "restart": restart_result,
        "listeners": listeners,
        "listenerCheck": {"ok": not missing_ports, "missingPorts": missing_ports},
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
        return {"ok": False, "dryRun": True, "checks": [
            health_check("connect", "SMTP connection", False, f"Not tested: would connect to {hostname}:{payload.port}"),
            health_check("starttls", "STARTTLS", False, "Not tested: live system commands are disabled"),
            health_check("auth", "Mailbox login", False, f"Not tested: would authenticate {username}"),
            health_check("send", "Test message", False, f"Not tested: would send to {recipient}"),
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
        health_check("mx", "Public MX", not dry_run and mx.get("returncode") == 0 and expected_mx in mx_output.lower(), mx_output or (f"Not tested: would verify MX points to {expected_mx}" if dry_run else mx.get("stderr", "No MX record returned"))),
        health_check("postfix_map", "Postfix mailbox map", not dry_run and map_check.get("returncode") == 0 and bool(map_check.get("stdout", "").strip()), map_check.get("stdout", "").strip() or ("Not tested: would query vmailbox map" if dry_run else "Mailbox is missing from vmailbox map")),
        health_check("lmtp", "Dovecot LMTP socket", not dry_run and lmtp_socket.exists() and stat_module.S_ISSOCK(lmtp_socket.stat().st_mode) and "protocol lmtp" in dovecot_config.get("stdout", ""), str(lmtp_socket) if not dry_run and lmtp_socket.exists() else ("Not tested: live system commands are disabled" if dry_run else "LMTP socket is missing")),
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
        permissions_ok, detail = False, f"Not tested: would inspect {maildir}"
    checks.append(health_check("permissions", "Maildir permissions", permissions_ok, detail))

    token = f"vps-panel-{uuid.uuid4().hex}"
    delivered = False
    delivery_detail = "Not tested: would inject a unique message through localhost Postfix and poll Maildir."
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
    checks.append(health_check("delivery", "Postfix to LMTP delivery", delivered, delivery_detail))
    return {"ok": all(check["ok"] for check in checks), "dryRun": dry_run, "mailbox": email, "checks": checks}


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
    actions = dry_write(RSPAMD_ACTIONS_CONFIG, """reject = 15;
add_header = 6;
greylist = 4;
""")
    greylist = dry_write(RSPAMD_GREYLIST_CONFIG, """enabled = true;
timeout = 5min;
expire = 1d;
message = "Try again later";
""")
    milter_headers = dry_write(RSPAMD_MILTER_HEADERS_CONFIG, """extended_spam_headers = true;
use = ["x-spamd-bar", "x-spam-level", "authentication-results"];
authenticated_headers = ["authentication-results"];
""")
    ratelimit = dry_write(RSPAMD_RATELIMIT_CONFIG, """rates {
  authenticated_user = {
    selector = "user";
    bucket = [
      {
        burst = 100;
        rate = "60 / 1min";
      },
      {
        burst = 1000;
        rate = "500 / 1d";
      }
    ]
  }
  ip = {
    selector = "ip";
    bucket = {
      burst = 120;
      rate = "120 / 1min";
    }
  }
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
    return {"ok": settings.allow_live_system_commands and all(result.get("returncode") == 0 for result in install + postfix + services) and all(result.get("returncode") == 0 for key, result in validation.items() if key != "relay") and validation["relay"]["ok"], "dryRun": not settings.allow_live_system_commands, "packages": packages, "install": install, "files": {"fail2ban": fail2ban, "rspamd": rspamd, "actions": actions, "greylist": greylist, "headers": milter_headers, "ratelimit": ratelimit, "antivirus": antivirus}, "postfix": postfix, "services": services, "validation": validation}


@router.post("/reload")
def reload_mail_services() -> dict:
    return {
        "postfix": run_command(["systemctl", "reload", "postfix"]),
        "dovecot": run_command(["systemctl", "reload", "dovecot"]),
        "opendkim": run_command(["systemctl", "reload", "opendkim"]),
    }


@router.post("/diagnostics")
def mail_diagnostics(payload: MailDomain) -> dict:
    hostname = (payload.hostname or f"mail.{payload.domain}").strip().lower()
    listeners = run_command(["ss", "-ltn"])
    listener_text = listeners.get("stdout", "")
    services = {name: run_command(["systemctl", "is-active", name]) for name in ("postfix", "dovecot", "opendkim")}
    certificate = Path(payload.certificatePath or f"/etc/letsencrypt/live/{hostname}/fullchain.pem")
    tls = run_command(["openssl", "x509", "-in", str(certificate), "-noout", "-checkend", "0", "-enddate"])
    fail2ban = run_command(["fail2ban-client", "status", "postfix-sasl"])
    auth_log = run_command(["journalctl", "--since", "24 hours ago", "-u", "postfix", "-u", "dovecot", "--no-pager", "-n", "500"])
    failed_lines = [line for line in auth_log.get("stdout", "").splitlines() if re.search(r"auth(?:entication)? failed|sasl.*fail|password mismatch", line, re.I)]
    live = settings.allow_live_system_commands
    checks = [
        *[health_check(f"service_{name}", f"{name.title()} running", live and result.get("returncode") == 0 and result.get("stdout", "").strip() == "active", result.get("stdout", "").strip() or result.get("stderr", "Not tested")) for name, result in services.items()],
        *[health_check(f"port_{port}", f"Port {port} listening", live and (f":{port} " in listener_text or f":{port}\n" in listener_text), "Listening" if live and f":{port}" in listener_text else "No live listener found") for port in (25, 465, 587, 993, *([995] if payload.pop3Enabled else []))],
        health_check("policy_service", "Per-mailbox SMTP policy", live and run_command(["systemctl", "is-active", "vps-panel-mail-policy"]).get("stdout", "").strip() == "active", "Postfix policy service on 127.0.0.1:10031"),
        health_check("pop3_config", "POP3 production validation", live and ((not payload.pop3Enabled) or " pop3" in run_command(["doveconf", "-n"]).get("stdout", "")), "POP3 disabled" if not payload.pop3Enabled else "Dovecot POP3 protocol and port 995 checked"),
        health_check("tls", "TLS certificate valid", live and tls.get("returncode") == 0, tls.get("stdout", "").strip() or tls.get("stderr", "Certificate unavailable")),
        health_check("fail2ban", "SMTP failed-login monitor", live and fail2ban.get("returncode") == 0, fail2ban.get("stdout", "").strip() or fail2ban.get("stderr", "Fail2Ban jail unavailable")),
        health_check("failed_logins", "Failed logins (24h)", live and auth_log.get("returncode") == 0, f"{len(failed_lines)} authentication failure(s) found in the last 24 hours" if live else "Not tested"),
    ]
    return {"ok": live and all(check["ok"] for check in checks), "dryRun": not live, "hostname": hostname, "checks": checks, "services": services, "listeners": listeners, "tls": tls, "fail2ban": fail2ban, "failedLoginCount": len(failed_lines), "failedLoginEvents": failed_lines[-20:]}


@router.get("/queue")
def mail_queue() -> dict:
    result = run_command(["postqueue", "-j"])
    items = []
    if result.get("returncode") == 0:
        for line in result.get("stdout", "").splitlines():
            try:
                entry = json.loads(line)
                items.append({
                    "queueId": entry.get("queue_id"),
                    "queueName": entry.get("queue_name", "unknown"),
                    "arrivalTime": entry.get("arrival_time"),
                    "messageSize": entry.get("message_size", 0),
                    "sender": entry.get("sender", ""),
                    "status": "bounced" if not entry.get("sender") else ("deferred" if entry.get("queue_name") == "deferred" else "queued"),
                    "recipients": entry.get("recipients", []),
                })
            except json.JSONDecodeError:
                continue
    return {"ok": settings.allow_live_system_commands and result.get("returncode") == 0, "dryRun": not settings.allow_live_system_commands, "items": items, "result": result}


@router.post("/queue/action")
def mail_queue_action(payload: MailQueueActionRequest) -> dict:
    if payload.action == "flush":
        result = run_command(["postqueue", "-f"])
    elif payload.action == "retry" and payload.queueId:
        result = run_command(["postsuper", "-r", payload.queueId])
    elif payload.action == "delete" and payload.queueId:
        result = run_command(["postsuper", "-d", payload.queueId])
    else:
        raise HTTPException(status_code=400, detail="A queue ID is required for retry and delete")
    require_command_success(result)
    flush = run_command(["postqueue", "-f"]) if payload.action == "retry" else None
    if flush:
        require_command_success(flush)
    return {"ok": settings.allow_live_system_commands, "dryRun": not settings.allow_live_system_commands, "action": payload.action, "queueId": payload.queueId, "result": result, "flush": flush}
