from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.command import run_command
from app.config import settings

router = APIRouter()


class FirewallRule(BaseModel):
    port: int = Field(ge=1, le=65535)
    protocol: str = "tcp"
    direction: str = "IN"
    action: str
    sourceIp: str | None = None
    note: str | None = None


class SshHardening(BaseModel):
    port: int = Field(ge=1, le=65535)
    permitRootLogin: bool = False
    passwordAuthentication: bool = False


@router.get("/rules")
def list_rules() -> dict:
    return run_command(["ufw", "status", "numbered"])


@router.get("/status")
def status() -> dict:
    return {
        "ufw": run_command(["ufw", "status", "verbose"]),
        "fail2ban": run_command(["fail2ban-client", "status"]),
        "liveCommandsEnabled": settings.allow_live_system_commands,
    }


@router.post("/rules")
def apply_rule(rule: FirewallRule) -> dict:
    action = rule.action.lower()
    if action == "limit":
        command = ["ufw", "limit", f"{rule.port}/{rule.protocol}"]
    elif rule.sourceIp:
        command = ["ufw", action, "from", rule.sourceIp, "to", "any", "port", str(rule.port), "proto", rule.protocol]
    else:
        command = ["ufw", action, f"{rule.port}/{rule.protocol}"]

    return run_command(command)


@router.delete("/rules/{rule_number}")
def delete_rule(rule_number: int) -> dict:
    return run_command(["ufw", "--force", "delete", str(rule_number)])


@router.post("/enable")
def enable() -> dict:
    return run_command(["ufw", "--force", "enable"])


@router.post("/disable")
def disable() -> dict:
    return run_command(["ufw", "disable"])


@router.get("/security")
def security() -> dict:
    return {
        "activeSshSessions": run_command(["who"]),
        "failedSshAttempts": run_command(["sh", "-lc", "grep 'Failed password' /var/log/auth.log | tail -20"]),
        "rootLogin": run_command(["sshd", "-T"]),
        "passwordAuthentication": run_command(["sshd", "-T"]),
        "fail2banSshd": run_command(["fail2ban-client", "status", "sshd"]),
        "liveCommandsEnabled": settings.allow_live_system_commands,
    }


@router.post("/ssh-hardening")
def ssh_hardening(settings_body: SshHardening) -> dict:
    commands = [
        ["sed", "-i", f"s/^#\\?Port .*/Port {settings_body.port}/", "/etc/ssh/sshd_config"],
        ["sed", "-i", f"s/^#\\?PermitRootLogin .*/PermitRootLogin {'yes' if settings_body.permitRootLogin else 'no'}/", "/etc/ssh/sshd_config"],
        ["sed", "-i", f"s/^#\\?PasswordAuthentication .*/PasswordAuthentication {'yes' if settings_body.passwordAuthentication else 'no'}/", "/etc/ssh/sshd_config"],
        ["systemctl", "reload", "ssh"],
    ]
    return {"results": [run_command(command) for command in commands]}
