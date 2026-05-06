from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.command import run_command
from app.config import settings

router = APIRouter()


class VhostRequest(BaseModel):
    name: str = Field(pattern=r"^[a-zA-Z0-9_.-]+$")
    serverName: str
    upstreamPort: int = Field(ge=1, le=65535)
    sitesAvailable: str = "/etc/nginx/sites-available"
    sitesEnabled: str = "/etc/nginx/sites-enabled"


@router.post("/vhost")
def write_vhost(body: VhostRequest) -> dict:
    available = (Path(body.sitesAvailable).resolve() / f"{body.name}.conf").resolve()
    enabled = (Path(body.sitesEnabled).resolve() / f"{body.name}.conf").resolve()
    config = (
        f"server {{ listen 80; server_name {body.serverName}; "
        f"location / {{ proxy_pass http://127.0.0.1:{body.upstreamPort}; "
        "proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }} }"
    )
    if settings.allow_live_system_commands:
        available.parent.mkdir(parents=True, exist_ok=True)
        available.write_text(config, encoding="utf-8")
        if not enabled.exists():
            enabled.symlink_to(available)
    return {
        "write": {"dryRun": not settings.allow_live_system_commands, "command": ["write-file", str(available)], "returncode": 0},
        "enable": {"dryRun": not settings.allow_live_system_commands, "command": ["symlink", str(available), str(enabled)], "returncode": 0},
        "test": run_command(["nginx", "-t"]),
        "reload": run_command(["systemctl", "reload", "nginx"]),
        "configPath": str(available),
    }
