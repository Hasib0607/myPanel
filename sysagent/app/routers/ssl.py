from __future__ import annotations
import re
import secrets
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.command import run_command
from app.config import settings
from app.routers.dns import effective_dns_paths, safe_zone_path
from app.nginx_manager import acme_root_for_server_name, letsencrypt_certificate_exists, run_live_step, safe_web_root

router = APIRouter()
LETSENCRYPT_LIVE_DIR = Path("/etc/letsencrypt/live")


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
    certName: str | None = Field(default=None, pattern=r"^[a-zA-Z0-9_.-]+$")


class DnsCertificateRequest(BaseModel):
    domain: str = Field(pattern=r"^(\*\.)?[a-zA-Z0-9.-]+$")
    parentDomain: str = Field(pattern=r"^[a-zA-Z0-9.-]+$")
    email: str
    certName: str = Field(pattern=r"^[a-zA-Z0-9_.-]+$")
    propagationSeconds: int = Field(default=120, ge=0, le=300)
    zoneDir: str = "/etc/bind/zones"
    namedConfLocal: str = "/etc/bind/named.conf.local"
    namedConfOptions: str = "/etc/bind/named.conf.options"


class CertificatePreflightRequest(BaseModel):
    domain: str = Field(pattern=r"^[a-zA-Z0-9.-]+$")
    webRoot: str
    includeWww: bool = True


class EnsureAcmeWebrootRequest(BaseModel):
    domain: str = Field(pattern=r"^[a-zA-Z0-9.-]+$")
    webRoot: str | None = None


class KillSslProcessRequest(BaseModel):
    domain: str = Field(pattern=r"^(\*\.)?[a-zA-Z0-9.-]+$")
    certName: str | None = Field(default=None, pattern=r"^[a-zA-Z0-9_.-]+$")


def safe_cert_lookup_name(value: str) -> str:
    primary = value.split()[0].strip()
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+", primary):
        raise HTTPException(status_code=400, detail="Invalid certificate name")
    return primary


@router.get("/certificate-exists/{domain}")
def certificate_exists(domain: str) -> dict:
    primary = safe_cert_lookup_name(domain)
    return {
        "domain": primary,
        "exists": letsencrypt_certificate_exists(primary),
        "certificate": f"/etc/letsencrypt/live/{primary}/fullchain.pem",
        "privateKey": f"/etc/letsencrypt/live/{primary}/privkey.pem",
    }


def certificate_expiry(domain: str) -> str | None:
    cert_name = safe_cert_lookup_name(domain)
    cert_path = LETSENCRYPT_LIVE_DIR / cert_name / "fullchain.pem"
    if not cert_path.exists():
        return None
    result = subprocess.run(
        ["openssl", "x509", "-in", str(cert_path), "-noout", "-enddate"],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    line = result.stdout.strip()
    if not line.startswith("notAfter="):
        return None
    parsed = datetime.strptime(line.removeprefix("notAfter="), "%b %d %H:%M:%S %Y %Z")
    return parsed.replace(tzinfo=timezone.utc).isoformat()


@router.get("/certificate-status/{domain}")
def certificate_status(domain: str) -> dict:
    primary = safe_cert_lookup_name(domain)
    expiry = certificate_expiry(primary)
    return {
        "domain": primary,
        "exists": letsencrypt_certificate_exists(primary),
        "expiry": expiry,
        "certificate": f"/etc/letsencrypt/live/{primary}/fullchain.pem",
        "privateKey": f"/etc/letsencrypt/live/{primary}/privkey.pem",
    }


def reusable_certificate_candidates(requested: str) -> list[dict]:
    base = safe_cert_lookup_name(requested)
    if not LETSENCRYPT_LIVE_DIR.exists():
        return []

    duplicate_pattern = re.compile(rf"^{re.escape(base)}-\d+$")
    candidates: list[dict] = []
    for item in LETSENCRYPT_LIVE_DIR.iterdir():
        if not item.is_dir():
            continue
        cert_name = item.name
        if cert_name != base and not duplicate_pattern.fullmatch(cert_name):
            continue
        expiry = certificate_expiry(cert_name)
        exists = letsencrypt_certificate_exists(cert_name)
        if not exists:
            continue
        candidates.append({
            "domain": cert_name,
            "exists": exists,
            "expiry": expiry,
            "certificate": str(item / "fullchain.pem"),
            "privateKey": str(item / "privkey.pem"),
        })
    return sorted(candidates, key=lambda item: item.get("expiry") or "", reverse=True)


@router.get("/certificate-reusable/{domain}")
def certificate_reusable(domain: str) -> dict:
    primary = safe_cert_lookup_name(domain)
    candidates = reusable_certificate_candidates(primary)
    if candidates:
        selected = candidates[0]
        return {
            "requested": primary,
            "exists": True,
            **selected,
            "candidates": candidates,
        }
    return {
        "requested": primary,
        "domain": primary,
        "exists": False,
        "expiry": None,
        "certificate": f"/etc/letsencrypt/live/{primary}/fullchain.pem",
        "privateKey": f"/etc/letsencrypt/live/{primary}/privkey.pem",
        "candidates": [],
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


@router.post("/kill")
def kill_ssl_process(body: KillSslProcessRequest) -> dict:
    terms = [body.domain]
    if body.certName:
        terms.append(body.certName)
    pattern = "certbot.*(" + "|".join(re.escape(term) for term in terms) + ")"
    result = run_command(["pkill", "-TERM", "-f", pattern], allow_live=settings.allow_live_ssl)
    if result.get("returncode") == 1:
        result = {
            **result,
            "stdout": result.get("stdout") or "No matching certbot process was running.",
            "stderr": "",
            "returncode": 0,
        }
    return {
        **result,
        "domain": body.domain,
        "certName": body.certName,
        "pattern": pattern,
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
    if payload.certName:
        command.extend(["--cert-name", payload.certName])
    if certbot_should_include_www(payload.domain, payload.includeWww):
        command.extend(["-d", f"www.{payload.domain}"])

    return run_command(command, allow_live=settings.allow_live_ssl, timeout=settings.ssl_certbot_timeout_seconds)


def dns_hook_script(zone_path: Path, zone_dir: Path, named_conf_local: Path, parent_domain: str, action: str, propagation_seconds: int) -> str:
    return f"""#!/usr/bin/env python3
from __future__ import annotations
import os
import grp
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path

zone_path = Path({str(zone_path)!r})
zone_dir = Path({str(zone_dir)!r})
named_conf_local = Path({str(named_conf_local)!r})
parent_domain = {parent_domain!r}.rstrip(".")
action = {action!r}
propagation_seconds = {propagation_seconds}


def relative_challenge_name(certbot_domain: str) -> str:
    domain = certbot_domain.strip().lower().rstrip(".")
    if domain.startswith("*."):
        domain = domain[2:]
    suffix = "." + parent_domain
    if domain == parent_domain:
        return "_acme-challenge"
    if domain.endswith(suffix):
        label = domain[:-len(suffix)]
        return f"_acme-challenge.{{label}}"
    return "_acme-challenge"


def bump_serial(text: str) -> str:
    today = datetime.utcnow().strftime("%Y%m%d")

    def repl(match):
        current = match.group(2)
        next_serial = int(current) + 1
        if not current.startswith(today):
            next_serial = int(today + "01")
        return f"{{match.group(1)}}{{next_serial}}{{match.group(3)}}"

    return re.sub(r"(\\n\\s*)(\\d{{10}})(\\s*;\\s*serial)", repl, text, count=1, flags=re.IGNORECASE)


def command_output(command: list[str]) -> str:
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    return "\\n".join([result.stdout, result.stderr]).strip()


def command_result(command: list[str]):
    return subprocess.run(command, text=True, capture_output=True, check=False)


def apply_bind_file_permissions(path: Path, zone_file: bool) -> None:
    try:
        named_gid = grp.getgrnam("named").gr_gid
    except KeyError:
        named_gid = -1
    if named_gid >= 0:
        os.chown(path, 0, named_gid)
    path.chmod(0o640)
    context_type = "named_zone_t" if zone_file else "named_conf_t"
    subprocess.run(["chcon", "-t", context_type, str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def is_live_zone_file(path: Path) -> bool:
    suffixes = path.name.split(".")
    ignored_parts = {{"bak", "rollback", "check", "tmp"}}
    return path.name.startswith("db.") and not any(part in ignored_parts for part in suffixes)


def zone_declaration_file_path(path: Path) -> str:
    return path.name if str(path).startswith("/var/named/") else str(path)


def rebuild_zone_declarations() -> None:
    zone_files = sorted(path for path in zone_dir.glob("db.*") if path.is_file() and is_live_zone_file(path))
    blocks = ["// Managed by vps-panel. Rebuilt from existing zone files."]
    for item in zone_files:
        domain = item.name.removeprefix("db.")
        bind_file = zone_declaration_file_path(item)
        blocks.append(
            '\\nzone "' + domain + '" {{\\n'
            "    type master;\\n"
            '    file "' + bind_file + '";\\n'
            "    allow-transfer {{ none; }};\\n"
            "}};"
        )
    named_conf_local.write_text("\\n".join(blocks).rstrip() + "\\n", encoding="utf-8")
    apply_bind_file_permissions(named_conf_local, zone_file=False)


def bind_service() -> str:
    named = command_result(["systemctl", "list-unit-files", "named.service", "--no-legend"])
    return "named" if named.returncode == 0 and named.stdout.strip() else "bind9"


def reload_bind_zone() -> None:
    reconfig = command_result(["rndc", "reconfig"])
    reload = command_result(["rndc", "reload", parent_domain]) if reconfig.returncode == 0 else None
    if reconfig.returncode == 0 and reload and reload.returncode == 0:
        return

    service = bind_service()
    restart = command_result(["systemctl", "restart", service])
    if restart.returncode != 0:
        details = [
            "rndc reload failed and BIND service restart failed.",
            reconfig.stderr.strip(),
            reload.stderr.strip() if reload else "",
            restart.stderr.strip(),
            restart.stdout.strip(),
        ]
        raise SystemExit("\\n".join(item for item in details if item))
    print(f"rndc reload failed; restarted {{service}} so BIND loads {{parent_domain}}")


def txt_visible(hostname: str, expected: str) -> tuple[bool, str]:
    local_checks = [
        ["dig", "@127.0.0.1", "+short", "TXT", hostname],
    ]
    public_checks = [
        ["dig", "@1.1.1.1", "+short", "TXT", hostname],
        ["dig", "@8.8.8.8", "+short", "TXT", hostname],
        ["dig", "@9.9.9.9", "+short", "TXT", hostname],
    ]
    outputs = []
    local_visible = False
    public_visible = False
    for command in local_checks + public_checks:
        try:
            output = command_output(command)
        except FileNotFoundError:
            return True, "dig not installed; relying on configured propagation sleep"
        outputs.append("$ " + " ".join(command) + "\\n" + (output or "(no answer)"))
        if expected in output:
            if command in public_checks:
                public_visible = True
            else:
                local_visible = True
    if local_visible and public_visible:
        return True, "\\n".join(outputs)
    return False, "\\n".join(outputs)


def wait_for_txt(hostname: str, expected: str, seconds: int) -> None:
    deadline = time.time() + max(seconds, 1)
    last_output = ""
    while time.time() <= deadline:
        visible, output = txt_visible(hostname, expected)
        last_output = output
        if visible:
            print(f"TXT visible for {{hostname}}")
            if output:
                print(output)
            return
        time.sleep(5)
    raise SystemExit(
        "DNS TXT record was written locally but is not visible to public resolvers yet for "
        f"{{hostname}}. Waited {{seconds}} seconds. Confirm this VPS is authoritative for the "
        f"domain and BIND port 53 is reachable. Last checks:\\n{{last_output}}"
    )


validation = os.environ.get("CERTBOT_VALIDATION", "").strip()
certbot_domain = os.environ.get("CERTBOT_DOMAIN", "").strip()
if not validation or not certbot_domain:
    raise SystemExit("CERTBOT_DOMAIN/CERTBOT_VALIDATION missing")

name = relative_challenge_name(certbot_domain)
fqdn = f"{{name}}.{{parent_domain}}".replace("..", ".").rstrip(".")
line = f'{{name}} 60 IN TXT "{{validation}}"'
text = zone_path.read_text(encoding="utf-8") if zone_path.exists() else ""
lines = text.splitlines()
if action == "auth":
    if line not in lines:
        lines.append(line)
elif action == "cleanup":
    lines = [item for item in lines if validation not in item]
else:
    raise SystemExit(f"Unsupported action: {{action}}")

next_text = bump_serial("\\n".join(lines).rstrip() + "\\n")
zone_path.write_text(next_text, encoding="utf-8")
apply_bind_file_permissions(zone_path, zone_file=True)
rebuild_zone_declarations()
subprocess.run(["named-checkzone", parent_domain, str(zone_path)], check=True)
reload_bind_zone()
if action == "auth" and propagation_seconds > 0:
    wait_for_txt(fqdn, validation, propagation_seconds)
"""


@router.post("/issue-dns")
def issue_dns_certificate(payload: DnsCertificateRequest) -> dict:
    zone_dir, named_conf_local, _named_conf_options = effective_dns_paths(payload)
    zone_path = safe_zone_path(zone_dir, payload.parentDomain.lower().rstrip("."))
    if not settings.allow_live_ssl or not settings.allow_live_dns:
        return {
            "dryRun": True,
            "command": ["certbot", "certonly", "--manual", "-d", payload.domain, "--cert-name", payload.certName],
            "stdout": "",
            "stderr": "Set ALLOW_LIVE_SSL=true and ALLOW_LIVE_DNS=true to issue wildcard DNS-01 certificates.",
            "returncode": 1,
        }

    with tempfile.TemporaryDirectory(prefix="vps-panel-certbot-dns-") as tmp:
        auth_path = Path(tmp) / "auth.py"
        cleanup_path = Path(tmp) / "cleanup.py"
        auth_path.write_text(dns_hook_script(zone_path, Path(zone_dir), Path(named_conf_local), payload.parentDomain, "auth", payload.propagationSeconds), encoding="utf-8")
        cleanup_path.write_text(dns_hook_script(zone_path, Path(zone_dir), Path(named_conf_local), payload.parentDomain, "cleanup", 0), encoding="utf-8")
        auth_path.chmod(0o700)
        cleanup_path.chmod(0o700)
        command = [
            "certbot",
            "certonly",
            "--manual",
            "--preferred-challenges",
            "dns",
            "--manual-auth-hook",
            str(auth_path),
            "--manual-cleanup-hook",
            str(cleanup_path),
            "--non-interactive",
            "--agree-tos",
            "--keep-until-expiring",
            "--cert-name",
            payload.certName,
            "-m",
            payload.email,
            "-d",
            payload.domain,
        ]
        return run_command(command, allow_live=True, timeout=settings.ssl_certbot_timeout_seconds)


@router.post("/renew/{domain}")
def renew_certificate(domain: str) -> dict:
    return run_command([
        "certbot",
        "renew",
        "--cert-name",
        domain,
        "--deploy-hook",
        "systemctl reload nginx >/dev/null 2>&1 || systemctl restart nginx >/dev/null 2>&1 || true",
    ], allow_live=settings.allow_live_ssl, timeout=settings.ssl_certbot_timeout_seconds)


@router.post("/renew-all")
def renew_all_certificates() -> dict:
    return run_command([
        "certbot",
        "renew",
        "--deploy-hook",
        "systemctl reload nginx >/dev/null 2>&1 || systemctl restart nginx >/dev/null 2>&1 || true",
    ], allow_live=settings.allow_live_ssl, timeout=settings.ssl_certbot_timeout_seconds)


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
    local_checks = []
    public_checks = []
    for host in hosts:
        local_checks.append(run_command([
            "curl",
            "-fsS",
            "--max-time",
            "10",
            "-H",
            f"Host: {host}",
            f"http://127.0.0.1/.well-known/acme-challenge/{token}",
        ], allow_live=settings.allow_live_ssl))
        public_checks.append(run_command([
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
        "checks": public_checks,
        "localChecks": local_checks,
        "publicChecks": public_checks,
        "webRoot": str(web_root),
    }
