from __future__ import annotations
import os
import re
import stat
from pathlib import Path
from typing import Callable, TypeVar
from uuid import uuid4

from fastapi import HTTPException

from app.command import run_command
from app.config import DEPLOYMENT_COMMANDS_LIVE, settings

T = TypeVar("T")

MANAGED_CONFIG_PREFIXES = ("domain-", "deployment-")
PROTECTED_CONFIG_NAMES = {"default", "vps-panel", "panel", "vps_panel"}
STRICTLY_PROTECTED_CONFIG_NAMES = {"vps-panel", "panel", "vps_panel"}
ROUTE_OWNERSHIP_HEADER = "X-VPS-Panel-Route"
SERVER_NAMES_HASH_CONFIG = Path("/etc/nginx/conf.d/00-vps-panel-server-names-hash.conf")
SERVER_NAMES_HASH_CONFIG_TEXT = (
    "# Managed by VPS Panel. Keeps exact server_name routes reliable when many\n"
    "# customer domains and wildcard vhosts are installed.\n"
    "server_names_hash_bucket_size 128;\n"
    "server_names_hash_max_size 8192;\n"
)


def assert_managed_config_name(name: str) -> None:
    normalized = name.lower()
    if normalized in PROTECTED_CONFIG_NAMES or "vps-panel" in normalized:
        raise HTTPException(status_code=400, detail="Refusing to write protected panel Nginx config")
    if not normalized.startswith(MANAGED_CONFIG_PREFIXES):
        raise HTTPException(status_code=400, detail="Nginx config name must be domain-* or deployment-*")


def route_ownership_header(name: str) -> str:
    assert_managed_config_name(name)
    return f'    add_header {ROUTE_OWNERSHIP_HEADER} "{name}" always;\n'


def _valid_ipv4(value: str) -> str | None:
    token = value.strip()
    if not re.match(r"^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$", token):
        return None
    if token.startswith("127."):
        return None
    return token


def server_listen_ips() -> list[str]:
    if not settings.allow_live_nginx:
        return []
    ips: list[str] = []
    configured_ip = _valid_ipv4(getattr(settings, "vps_ip", "") or os.environ.get("VPS_IP", ""))
    if configured_ip:
        ips.append(configured_ip)
    result = run_command(["hostname", "-I"], allow_live=DEPLOYMENT_COMMANDS_LIVE)
    if result.get("returncode") != 0:
        return ips
    for token in (result.get("stdout") or "").split():
        ip = _valid_ipv4(token)
        if ip and ip not in ips:
            ips.append(ip)
    return ips


def nginx_listen_directives(port: int, *, ssl: bool = False, http2: bool = False) -> str:
    flags = []
    if ssl:
        flags.append("ssl")
    if http2:
        flags.append("http2")
    suffix = f" {' '.join(flags)}" if flags else ""
    return f"    listen {port}{suffix};\n"


def route_ownership_header_seen(output: str, name: str) -> bool:
    return f"{ROUTE_OWNERSHIP_HEADER.lower()}: {name.lower()}" in output.lower()


def route_ownership_config_seen(output: str, name: str) -> bool:
    return f'{ROUTE_OWNERSHIP_HEADER.lower()} "{name.lower()}"' in output.lower()


def safe_nginx_path(root: str, name: str) -> Path:
    assert_managed_config_name(name)
    directory = Path(root).resolve()
    # Do NOT resolve the target itself: if a symlink already exists here (e.g. from a
    # previous deploy in sites-enabled), resolve() would follow it to sites-available,
    # making target.parent != directory and raising a false-positive 400.
    target = directory / f"{name}.conf"
    if target.parent != directory:
        raise HTTPException(status_code=400, detail="Nginx config path escapes target directory")
    return target


def safe_web_root(root_path: str, detail: str = "Website root escapes file manager root") -> Path:
    root = Path(settings.file_manager_root).resolve()
    target = Path(root_path).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(status_code=400, detail=detail)
    return target


def certificate_name_for_server_name(server_name: str) -> str:
    primary = primary_server_name(server_name)
    if primary.startswith("*.") and len(primary) > 2:
        return f"wildcard.{primary[2:]}"
    return primary


def certificate_names_cover(requested: str, names: list[str]) -> bool:
    requested = requested.lower().rstrip(".")
    requested_labels = requested.split(".")
    for name in names:
        candidate = name.lower().rstrip(".")
        if candidate == requested:
            return True
        if not candidate.startswith("*."):
            continue
        parent = candidate[2:]
        parent_labels = parent.split(".")
        if requested.endswith(f".{parent}") and len(requested_labels) == len(parent_labels) + 1:
            return True
    return False


def certificate_dns_names(cert: Path) -> list[str]:
    result = run_command(
        ["openssl", "x509", "-in", str(cert), "-noout", "-ext", "subjectAltName"],
        allow_live=DEPLOYMENT_COMMANDS_LIVE,
    )
    if result.get("returncode") != 0:
        return []
    return sorted({name.lower() for name in re.findall(r"DNS:([^,\s]+)", result.get("stdout") or "", re.IGNORECASE)})


def certificate_names_cover_server_name(server_name: str, names: list[str]) -> bool:
    tokens = server_name_tokens(server_name)
    return bool(tokens) and all(certificate_names_cover(token, names) for token in tokens)


def certificate_file_covers_server_name(cert: Path, server_name: str) -> bool:
    if not cert.is_file():
        return False
    return certificate_names_cover_server_name(server_name, certificate_dns_names(cert))


def letsencrypt_certificate_exists(domain: str, *, require_name_match: bool = True) -> bool:
    primary = certificate_name_for_server_name(domain)
    cert = Path(f"/etc/letsencrypt/live/{primary}/fullchain.pem")
    key = Path(f"/etc/letsencrypt/live/{primary}/privkey.pem")
    if not cert.is_file() or not key.is_file():
        return False
    verify = run_command(
        ["openssl", "x509", "-in", str(cert), "-noout"],
        allow_live=DEPLOYMENT_COMMANDS_LIVE,
    )
    if verify.get("returncode") != 0:
        return False
    if not require_name_match:
        return True
    return certificate_names_cover(primary_server_name(domain), certificate_dns_names(cert))


def safe_letsencrypt_path(path: str) -> Path:
    root = Path("/etc/letsencrypt/live")
    target = Path(path)
    if not target.is_absolute():
        raise HTTPException(status_code=400, detail="SSL certificate path must be absolute")
    try:
        target.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="SSL certificate path escapes /etc/letsencrypt/live")
    return target


def primary_server_name(server_name: str) -> str:
    return server_name.split()[0].strip() if server_name else ""


def probe_host_for_server_name(server_name: str) -> str:
    primary = primary_server_name(server_name)
    if primary.startswith("*.") and len(primary) > 2:
        return f"vps-panel-wildcard-probe.{primary[2:]}"
    return primary


def acme_root_for_server_name(server_name: str) -> Path:
    primary = primary_server_name(server_name)
    if not primary:
        raise HTTPException(status_code=400, detail="Server name is required for ACME challenge root")
    return safe_web_root(str(Path(settings.file_manager_root) / primary / "public_html"))


def make_web_root_readable(web_root: Path) -> dict:
    """
    Nginx must be able to traverse account/domain parent paths before it can
    serve public files or ACME tokens from the web root.
    """
    file_root = Path(settings.file_manager_root).resolve()
    resolved_web_root = web_root.resolve()
    if resolved_web_root != file_root and file_root not in resolved_web_root.parents:
        raise HTTPException(status_code=400, detail="Website root escapes file manager root")

    changed: list[str] = []

    def chmod_or(path: Path, bits: int) -> None:
        mode = path.stat().st_mode
        next_mode = mode | bits
        if next_mode != mode:
            path.chmod(stat.S_IMODE(next_mode))
            changed.append(str(path))

    parent_dirs: list[Path] = []
    cursor = resolved_web_root
    while cursor != file_root:
        parent_dirs.append(cursor)
        cursor = cursor.parent
    parent_dirs.append(file_root)

    for directory in reversed(parent_dirs):
        chmod_or(directory, stat.S_IXOTH)
    chmod_or(resolved_web_root, stat.S_IROTH | stat.S_IXOTH)
    return {"changed": changed, "webRoot": str(resolved_web_root)}


def acme_location(server_name: str, web_root: Path | str | None = None) -> str:
    acme_root = safe_web_root(str(web_root)) if web_root else acme_root_for_server_name(server_name)
    return (
        "    location ^~ /.well-known/acme-challenge/ {\n"
        f"        root {acme_root};\n"
        "        try_files $uri =404;\n"
        "        default_type text/plain;\n"
        "    }\n"
        "\n"
    )


def run_live_step(action: str, fn: Callable[[], T]) -> T:
    try:
        return fn()
    except PermissionError as error:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Nginx {action} permission denied: {error}. "
                "Run vps-panel-sysagent as root, then restart vps-panel-sysagent and vps-panel-api."
            ),
        ) from error
    except OSError as error:
        raise HTTPException(status_code=500, detail=f"Nginx {action} failed: {error}") from error


def server_name_tokens(server_name: str) -> list[str]:
    return [part.strip() for part in server_name.split() if part.strip()]


def server_name_has_wildcard(server_name: str) -> bool:
    return any(token.startswith("*.") for token in server_name_tokens(server_name))


def server_name_directive_tokens(text: str) -> list[str]:
    tokens: list[str] = []
    for match in re.finditer(r"\bserver_name\b\s+([^;]+);", text):
        tokens.extend(part.strip() for part in match.group(1).split() if part.strip())
    return tokens


def _server_name_token_matches(claimed: str, requested: str) -> bool:
    claimed = claimed.strip().lower().rstrip(".")
    requested = requested.strip().lower().rstrip(".")
    if not claimed or not requested:
        return False
    return claimed == requested


def _wildcard_parent(token: str) -> str | None:
    token = token.strip().lower().rstrip(".")
    if token.startswith("*.") and len(token) > 2:
        return token[2:]
    return None


def _one_label_child_of(host: str, parent: str) -> bool:
    host = host.strip().lower().rstrip(".")
    parent = parent.strip().lower().rstrip(".")
    suffix = f".{parent}"
    if not host.endswith(suffix):
        return False
    left = host[: -len(suffix)]
    return bool(left) and left != "*" and "." not in left


def _server_name_token_conflicts(claimed: str, requested: str) -> bool:
    if _server_name_token_matches(claimed, requested):
        return True
    return False


def _server_name_tokens_conflict(claimed_tokens: list[str] | set[str], requested_tokens: list[str]) -> bool:
    claimed_normalized = {token.strip().lower().rstrip(".") for token in claimed_tokens if token.strip()}
    for requested_token in requested_tokens:
        requested_parent = _wildcard_parent(requested_token)
        for claimed_token in claimed_tokens:
            claimed_normalized_token = claimed_token.strip().lower().rstrip(".")
            if (
                requested_parent
                and claimed_normalized_token == f"www.{requested_parent}"
                and requested_parent in claimed_normalized
            ):
                continue
            if _server_name_token_conflicts(claimed_token, requested_token):
                return True
    return False


def _config_has_server_name(path: Path, server_name: str) -> bool:
    """Return True if an nginx config file contains a server_name directive for server_name."""
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
        claimed = set(server_name_directive_tokens(text))
        return _server_name_tokens_conflict(claimed, server_name_tokens(server_name))
    except OSError:
        return False


def _nginx_include_text_loads_directory(text: str, directory: Path) -> bool:
    normalized = str(directory)
    for match in re.finditer(r"\binclude\s+([^;]+);", text):
        include_path = match.group(1).strip().strip("\"'")
        if include_path.startswith(normalized + "/") or include_path == normalized:
            return True
    return False


def _nginx_loads_directory(directory: Path) -> bool:
    nginx_conf = Path("/etc/nginx/nginx.conf")
    try:
        text = nginx_conf.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False
    return _nginx_include_text_loads_directory(text, directory)


def _nginx_loads_both_site_directories(sites_available: str, sites_enabled: str) -> bool:
    available = Path(sites_available)
    enabled = Path(sites_enabled)
    if available == enabled:
        return False
    return _nginx_loads_directory(available) and _nginx_loads_directory(enabled)


def ensure_server_names_hash_config() -> None:
    if not settings.allow_live_nginx:
        return
    conf_dir = SERVER_NAMES_HASH_CONFIG.parent
    if not _nginx_loads_directory(conf_dir):
        return
    try:
        current = SERVER_NAMES_HASH_CONFIG.read_text(encoding="utf-8")
    except OSError:
        current = ""
    if current == SERVER_NAMES_HASH_CONFIG_TEXT:
        return
    run_live_step("write nginx server_name hash tuning", lambda: SERVER_NAMES_HASH_CONFIG.write_text(SERVER_NAMES_HASH_CONFIG_TEXT, encoding="utf-8"))


def _config_dump_sections(text: str) -> list[tuple[str, str]]:
    sections: list[tuple[str, list[str]]] = []
    current_file = ""
    current_lines: list[str] = []
    for line in text.splitlines():
        marker = re.match(r"#\s+configuration file\s+(.+?):\s*$", line.strip())
        if marker:
            if current_file:
                sections.append((current_file, current_lines))
            current_file = marker.group(1)
            current_lines = []
            continue
        if current_file:
            current_lines.append(line)
    if current_file:
        sections.append((current_file, current_lines))
    return [(file_path, "\n".join(lines)) for file_path, lines in sections]


def _normalize_conflict_path(path: Path | str) -> str:
    try:
        return str(Path(path).resolve())
    except OSError:
        return str(Path(path).absolute())


def _is_own_conflict_path(path: Path | str, own_paths: set[str]) -> bool:
    if not own_paths:
        return False
    current = Path(path)
    candidates = {str(current), _normalize_conflict_path(current)}
    return bool(candidates & own_paths)


def _config_dump_conflict_files(
    text: str,
    server_name: str,
    own_filename: str = "",
    own_paths: set[str] | None = None,
) -> list[str]:
    requested_tokens = server_name_tokens(server_name)
    own_paths = own_paths or set()
    matches: list[str] = []
    for current_file, file_text in _config_dump_sections(text):
        if _is_own_conflict_path(current_file, own_paths):
            continue
        if own_filename and not own_paths and Path(current_file).name == own_filename:
            continue
        if "server_name" not in file_text:
            continue
        claimed = server_name_directive_tokens(file_text)
        if not claimed:
            continue
        if not _server_name_tokens_conflict(claimed, requested_tokens):
            continue
        if current_file not in matches:
            matches.append(current_file)
    return matches


def nginx_config_dump() -> tuple[str, dict]:
    dump = run_command(["nginx", "-T"], allow_live=True)
    text = "\n".join([dump.get("stdout") or "", dump.get("stderr") or ""])
    return text, dump


def nginx_dump_diagnostic(dump: dict) -> str:
    rc = dump.get("returncode")
    stderr = (dump.get("stderr") or "").strip().replace("\n", " ")[:500]
    stdout = (dump.get("stdout") or "").strip().replace("\n", " ")[:500]
    if stderr:
        return f"nginx -T returncode={rc}, stderr='{stderr}'"
    if stdout:
        return f"nginx -T returncode={rc}, stdout='{stdout}'"
    return f"nginx -T returncode={rc}, no output"


def _is_removable_nginx_conf(path: str) -> bool:
    target = Path(path)
    stem = target.stem.lower()
    if target.suffix != ".conf":
        return False
    try:
        target.resolve().relative_to(Path("/etc/nginx").resolve())
    except ValueError:
        return False
    if stem in STRICTLY_PROTECTED_CONFIG_NAMES:
        return False
    return True


def remove_loaded_conflicting_configs(our_name: str, server_name: str, own_paths: set[str] | None = None) -> list[str]:
    text, _dump = nginx_config_dump()
    removed: list[str] = []
    for file_path in _config_dump_conflict_files(text, server_name, f"{our_name}.conf", own_paths):
        if not _is_removable_nginx_conf(file_path):
            continue
        try:
            Path(file_path).unlink()
            removed.append(file_path)
        except OSError:
            pass
    return removed


def loaded_conflicting_config_files(our_name: str, server_name: str, own_paths: set[str] | None = None) -> list[str]:
    text, _dump = nginx_config_dump()
    return _config_dump_conflict_files(text, server_name, f"{our_name}.conf", own_paths)


def loaded_conflict_diagnostic(our_name: str, server_name: str, own_paths: set[str] | None = None) -> tuple[list[str], str]:
    text, dump = nginx_config_dump()
    return _config_dump_conflict_files(text, server_name, f"{our_name}.conf", own_paths), nginx_dump_diagnostic(dump)


def _config_has_insecure_port443(path: Path) -> bool:
    """True when a file listens on 443 without the ssl flag (plain HTTP on 443 → browser SSL protocol errors)."""
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False
    if not re.search(r"listen\s+(?:\[::\]:)?443\b", text):
        return False
    if re.search(r"listen\s+(?:\[::\]:)?443\s+ssl\b", text):
        return False
    return True


def remove_insecure_port443_configs(
    our_name: str,
    server_name: str,
    *scan_dirs: str,
    own_paths: set[str] | None = None,
) -> list[str]:
    removed: list[str] = []
    our_filename = f"{our_name}.conf"
    own_paths = own_paths or set()
    tokens = server_name_tokens(server_name)
    if not tokens:
        return removed
    for scan_dir in scan_dirs:
        enabled_dir = Path(scan_dir)
        if not enabled_dir.is_dir():
            continue
        for conf_path in enabled_dir.iterdir():
            if _is_own_conflict_path(conf_path, own_paths):
                continue
            if conf_path.name == our_filename and not own_paths:
                continue
            stem = conf_path.stem.lower()
            if stem in STRICTLY_PROTECTED_CONFIG_NAMES:
                continue
            try:
                target = conf_path.resolve() if conf_path.is_symlink() else conf_path
                if not _config_has_insecure_port443(target):
                    continue
                if not any(_config_has_server_name(target, token) for token in tokens):
                    continue
                conf_path.unlink()
                removed.append(conf_path.name)
            except OSError:
                pass
    return removed


def remove_conflicting_configs(
    our_name: str,
    server_name: str,
    *scan_dirs: str,
    own_paths: set[str] | None = None,
) -> list[str]:
    """
    Scan all provided directories and remove any config that claims server_name, except
    our own config. Protects panel system configs by name. No prefix filter — the
    conflicting file may have any name (e.g. certbot-created, manually placed, legacy).
    """
    removed: list[str] = []
    our_filename = f"{our_name}.conf"
    own_paths = own_paths or set()
    for scan_dir in scan_dirs:
        enabled_dir = Path(scan_dir)
        if not enabled_dir.is_dir():
            continue
        for conf_path in enabled_dir.iterdir():
            if _is_own_conflict_path(conf_path, own_paths):
                continue
            if conf_path.name == our_filename and not own_paths:
                continue
            stem = conf_path.stem.lower()
            if stem in STRICTLY_PROTECTED_CONFIG_NAMES:
                continue
            try:
                target = conf_path.resolve() if conf_path.is_symlink() else conf_path
                if _config_has_server_name(target, server_name):
                    conf_path.unlink()
                    removed.append(conf_path.name)
            except OSError:
                pass
    return removed


def _snapshot(path: Path) -> dict:
    if path.is_symlink():
        return {"kind": "symlink", "target": str(path.resolve())}
    if path.exists():
        return {"kind": "file", "content": path.read_text(encoding="utf-8")}
    return {"kind": "missing"}


def _restore(path: Path, snapshot: dict) -> None:
    if path.is_symlink() or path.exists():
        path.unlink()
    kind = snapshot.get("kind")
    if kind == "symlink":
        path.symlink_to(snapshot["target"])
    elif kind == "file":
        path.write_text(snapshot["content"], encoding="utf-8")


def _enable_site(available: Path, enabled: Path) -> None:
    if available == enabled:
        return
    if enabled.is_symlink() or enabled.exists():
        enabled.unlink()
    enabled.symlink_to(available)


def skipped_reload(message: str) -> dict:
    return {
        "dryRun": False,
        "command": ["systemctl", "reload", "nginx"],
        "stdout": "",
        "stderr": message,
        "returncode": 1,
    }


def publish_nginx_config(
    name: str,
    config: str,
    sites_available: str,
    sites_enabled: str,
    *,
    server_name: str | None = None,
    post_reload_check: Callable[[], dict] | None = None,
    rollback_on_post_reload_failure: bool = True,
) -> dict:
    requested_available = safe_nginx_path(sites_available, name)
    requested_enabled = safe_nginx_path(sites_enabled, name)
    single_loaded_site_file = settings.allow_live_nginx and _nginx_loads_both_site_directories(sites_available, sites_enabled)
    if single_loaded_site_file:
        available = requested_enabled
        enabled = requested_enabled
    else:
        available = requested_available
        enabled = requested_enabled
    temp_available = available.with_name(f".{available.name}.{os.getpid()}-{uuid4().hex}.tmp")

    write = {
        "dryRun": not settings.allow_live_nginx,
        "command": ["write-file", str(available)],
        "stdout": "",
        "stderr": "",
        "returncode": 0,
    }
    enable = {
        "dryRun": not settings.allow_live_nginx,
        "command": ["symlink", str(available), str(enabled)],
        "stdout": "",
        "stderr": "",
        "returncode": 0,
    }

    if not settings.allow_live_nginx:
        test = run_command(["nginx", "-t"], allow_live=False)
        reload_result = run_command(["systemctl", "reload", "nginx"], allow_live=False)
        return {
            "write": write,
            "enable": enable,
            "test": test,
            "reload": reload_result,
            "configPath": str(available),
            "enabledPath": str(enabled),
        }

    run_live_step("prepare config directory", lambda: available.parent.mkdir(parents=True, exist_ok=True))
    run_live_step("prepare enabled directory", lambda: enabled.parent.mkdir(parents=True, exist_ok=True))
    ensure_server_names_hash_config()

    if server_name:
        own_paths = {
            _normalize_conflict_path(path)
            for path in {requested_available, requested_enabled, available, enabled, temp_available}
        }
        scan_dirs = [sites_enabled]
        for candidate in ["/etc/nginx/conf.d", "/etc/nginx/sites-enabled", "/etc/nginx/sites-available"]:
            candidate_path = Path(candidate)
            if candidate_path.is_dir() and str(candidate_path) not in scan_dirs:
                scan_dirs.append(str(candidate_path))
        available_dir = Path(sites_available)
        if available_dir.is_dir() and str(available_dir) not in scan_dirs:
            scan_dirs.append(str(available_dir))
        removed = run_live_step(
            "remove conflicting configs",
            lambda: remove_conflicting_configs(name, server_name, *scan_dirs, own_paths=own_paths),
        )
        insecure_removed = run_live_step(
            "remove insecure port 443 configs",
            lambda: remove_insecure_port443_configs(name, server_name, *scan_dirs, own_paths=own_paths),
        )
        loaded_removed = run_live_step(
            "remove loaded conflicting configs",
            lambda: remove_loaded_conflicting_configs(name, server_name, own_paths),
        )
        removed = [*removed, *insecure_removed, *loaded_removed]
    else:
        removed = []
        own_paths = set()

    if single_loaded_site_file and requested_available != available and requested_available.exists():
        try:
            target = requested_available.resolve() if requested_available.is_symlink() else requested_available
            if not server_name or _config_has_server_name(target, server_name):
                run_live_step("remove stale duplicate available config", lambda: requested_available.unlink())
                removed.append(str(requested_available))
        except OSError:
            pass

    old_available = _snapshot(available)
    old_enabled = _snapshot(enabled)

    try:
        if server_name and available != enabled and available.exists():
            try:
                if _config_has_server_name(available.resolve() if available.is_symlink() else available, server_name):
                    run_live_step("hide stale available config", lambda: available.unlink())
            except OSError:
                pass
        run_live_step("write temp config", lambda: temp_available.write_text(config, encoding="utf-8"))
        run_live_step("enable temp config", lambda: _enable_site(temp_available, enabled))
        test = run_command(["nginx", "-t"], allow_live=True)
        if server_name and own_paths:
            late_removed = run_live_step(
                "remove loaded conflicting configs after temp enable",
                lambda: remove_loaded_conflicting_configs(name, server_name, own_paths),
            )
            if late_removed:
                removed = [*removed, *late_removed]
                test = run_command(["nginx", "-t"], allow_live=True)
        test_stderr = test.get("stderr") or ""
        requested_tokens = server_name_tokens(server_name) if server_name else []
        conflict_warning = bool(
            requested_tokens
            and "conflicting server name" in test_stderr
            and any(token in test_stderr for token in requested_tokens)
        )
        # Nginx reports duplicate server_name entries as warnings while still
        # returning success. Do not block publishing on a warning alone; the
        # post-reload ACME probe below verifies whether the active route serves
        # the challenge token.
        if test.get("returncode") != 0:
            run_live_step("rollback failed available config", lambda: _restore(available, old_available))
            run_live_step("rollback failed config", lambda: _restore(enabled, old_enabled))
            run_live_step("remove temp config", lambda: temp_available.unlink(missing_ok=True))
            if conflict_warning:
                # Find which files still claim the server_name so the user knows what to remove
                conflict_files: list[str] = []
                conflict_scan_dirs = [sites_enabled]
                for candidate in ["/etc/nginx/conf.d", "/etc/nginx/sites-enabled", "/etc/nginx/sites-available", sites_available]:
                    if Path(candidate).is_dir() and candidate not in conflict_scan_dirs:
                        conflict_scan_dirs.append(candidate)
                for scan_d in conflict_scan_dirs:
                    for cp in Path(scan_d).iterdir() if Path(scan_d).is_dir() else []:
                        if cp.name == f"{name}.conf":
                            continue
                        try:
                            tgt = cp.resolve() if cp.is_symlink() else cp
                            if any(_config_has_server_name(tgt, token) for token in requested_tokens):
                                conflict_files.append(str(cp))
                        except OSError:
                            pass
                loaded_files, loaded_diagnostic = loaded_conflict_diagnostic(name, server_name, own_paths)
                for file_path in loaded_files:
                    if file_path not in conflict_files:
                        conflict_files.append(file_path)
                if conflict_files:
                    files_hint = ", ".join(conflict_files) + ". Remove it and redeploy."
                else:
                    nginx_test_hint = test_stderr.strip().replace("\n", " ")[:500]
                    files_hint = (
                        "not found in scanned files or nginx -T sections. "
                        f"{loaded_diagnostic}. nginx -t stderr='{nginx_test_hint}'. "
                        "Run nginx -T on the VPS and remove the duplicate server_name."
                    )
                skip_msg = (
                    f'Another nginx config still claims server_name "{server_name}" '
                    f"after cleanup. Conflicting file(s): {files_hint}"
                )
            else:
                skip_msg = "Skipped because nginx -t failed; previous site config was restored"
            return {
                "write": write,
                "enable": enable,
                "test": test,
                "reload": skipped_reload(skip_msg),
                "configPath": str(available),
                "enabledPath": str(enabled),
                "rolledBack": True,
                "removedConflicts": removed,
            }

        def promote_config() -> None:
            if not temp_available.exists():
                temp_available.write_text(config, encoding="utf-8")
            temp_available.replace(available)

        run_live_step("promote config", promote_config)
        run_live_step("enable config", lambda: _enable_site(available, enabled))
        reload_result = run_command(["systemctl", "reload", "nginx"], allow_live=True)
        if reload_result.get("returncode") != 0:
            run_live_step("rollback config", lambda: _restore(available, old_available))
            run_live_step("rollback enabled config", lambda: _restore(enabled, old_enabled))
            return {
                "write": write,
                "enable": enable,
                "test": test,
                "reload": reload_result,
                "configPath": str(available),
                "enabledPath": str(enabled),
                "rolledBack": True,
                "removedConflicts": removed,
            }

        route_check = post_reload_check() if post_reload_check else None
        if route_check and route_check.get("returncode") != 0:
            restart_result = run_command(["systemctl", "restart", "nginx"], allow_live=True)
            restart_route_check = post_reload_check() if restart_result.get("returncode") == 0 and post_reload_check else None
            if restart_route_check and restart_route_check.get("returncode") == 0:
                return {
                    "write": write,
                    "enable": enable,
                    "test": test,
                    "reload": reload_result,
                    "restart": restart_result,
                    "postReloadCheck": restart_route_check,
                    "initialPostReloadCheck": route_check,
                    "configPath": str(available),
                    "enabledPath": str(enabled),
                    "rolledBack": False,
                    "removedConflicts": removed,
                    "postReloadRecoveredByRestart": True,
                }
            if restart_result.get("returncode") == 0:
                route_check = {
                    **route_check,
                    "restart": restart_result,
                    "postRestartCheck": restart_route_check,
                }
            if not rollback_on_post_reload_failure:
                return {
                    "write": write,
                    "enable": enable,
                    "test": test,
                    "reload": reload_result,
                    "restart": restart_result,
                    "postReloadCheck": route_check,
                    "configPath": str(available),
                    "enabledPath": str(enabled),
                    "rolledBack": False,
                    "removedConflicts": removed,
                    "postReloadCheckNonFatal": True,
                }
            run_live_step("rollback config", lambda: _restore(available, old_available))
            run_live_step("rollback enabled config", lambda: _restore(enabled, old_enabled))
            rollback_reload = run_command(["systemctl", "reload", "nginx"], allow_live=True)
            return {
                "write": write,
                "enable": enable,
                "test": test,
                "reload": reload_result,
                "postReloadCheck": route_check,
                "rollbackReload": rollback_reload,
                "configPath": str(available),
                "enabledPath": str(enabled),
                "rolledBack": True,
                "removedConflicts": removed,
            }

        return {
            "write": write,
            "enable": enable,
            "test": test,
            "reload": reload_result,
            "postReloadCheck": route_check,
            "configPath": str(available),
            "enabledPath": str(enabled),
            "rolledBack": False,
            "removedConflicts": removed,
        }
    finally:
        if temp_available.exists() or temp_available.is_symlink():
            run_live_step("cleanup temp config", lambda: temp_available.unlink(missing_ok=True))
