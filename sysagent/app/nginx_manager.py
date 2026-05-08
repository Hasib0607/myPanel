from pathlib import Path
from typing import Callable, TypeVar

from fastapi import HTTPException

from app.command import run_command
from app.config import settings

T = TypeVar("T")

MANAGED_CONFIG_PREFIXES = ("domain-", "deployment-")
PROTECTED_CONFIG_NAMES = {"default", "vps-panel", "panel", "vps_panel"}


def assert_managed_config_name(name: str) -> None:
    normalized = name.lower()
    if normalized in PROTECTED_CONFIG_NAMES or "vps-panel" in normalized:
        raise HTTPException(status_code=400, detail="Refusing to write protected panel Nginx config")
    if not normalized.startswith(MANAGED_CONFIG_PREFIXES):
        raise HTTPException(status_code=400, detail="Nginx config name must be domain-* or deployment-*")


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


def acme_root_for_server_name(server_name: str) -> Path:
    primary = primary_server_name(server_name)
    if not primary:
        raise HTTPException(status_code=400, detail="Server name is required for ACME challenge root")
    return safe_web_root(str(Path(settings.file_manager_root) / primary / "public_html"))


def acme_location(server_name: str) -> str:
    acme_root = acme_root_for_server_name(server_name)
    return (
        "    location ^~ /.well-known/acme-challenge/ {\n"
        f"        root {acme_root};\n"
        "        default_type text/plain;\n"
        "        try_files $uri =404;\n"
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


def publish_nginx_config(name: str, config: str, sites_available: str, sites_enabled: str) -> dict:
    available = safe_nginx_path(sites_available, name)
    enabled = safe_nginx_path(sites_enabled, name)
    temp_available = available.with_name(f".{available.name}.tmp")

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

    old_available = _snapshot(available)
    old_enabled = _snapshot(enabled)

    try:
        run_live_step("write temp config", lambda: temp_available.write_text(config, encoding="utf-8"))
        run_live_step("enable temp config", lambda: _enable_site(temp_available, enabled))
        test = run_command(["nginx", "-t"], allow_live=True)
        if test.get("returncode") != 0:
            run_live_step("rollback failed config", lambda: _restore(enabled, old_enabled))
            run_live_step("remove temp config", lambda: temp_available.unlink(missing_ok=True))
            return {
                "write": write,
                "enable": enable,
                "test": test,
                "reload": skipped_reload("Skipped because nginx -t failed; previous site config was restored"),
                "configPath": str(available),
                "enabledPath": str(enabled),
                "rolledBack": True,
            }

        run_live_step("promote config", lambda: temp_available.replace(available))
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
            }

        return {
            "write": write,
            "enable": enable,
            "test": test,
            "reload": reload_result,
            "configPath": str(available),
            "enabledPath": str(enabled),
            "rolledBack": False,
        }
    finally:
        if temp_available.exists() or temp_available.is_symlink():
            run_live_step("cleanup temp config", lambda: temp_available.unlink(missing_ok=True))
