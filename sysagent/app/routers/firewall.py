from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.command import run_command
from app.config import settings
from app.firewall_backend import (
    apply_rule_command,
    auth_log_path,
    delete_rule_command,
    disable_command,
    enable_command,
    failed_ssh_attempts_command,
    firewall_status_command,
    list_rules_command,
    ssh_service_name,
    status_commands,
)

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
    return run_command(list_rules_command())


@router.get("/status")
def status() -> dict:
    commands = status_commands()
    payload = {
        "firewall": run_command(commands["firewall"]),
        "fail2ban": run_command(["fail2ban-client", "status"]),
        "liveCommandsEnabled": settings.allow_live_system_commands,
    }
    if "firewallDetails" in commands:
        payload["firewallDetails"] = run_command(commands["firewallDetails"])
    # Legacy API field name used by the frontend.
    payload["ufw"] = payload["firewall"]
    return payload


@router.post("/rules")
def apply_rule(rule: FirewallRule) -> dict:
    return run_command(
        apply_rule_command(
            action=rule.action,
            port=rule.port,
            protocol=rule.protocol,
            source_ip=rule.sourceIp,
        )
    )


@router.delete("/rules/{rule_number}")
def delete_rule(rule_number: int) -> dict:
    return run_command(delete_rule_command(rule_number))


@router.post("/enable")
def enable() -> dict:
    return run_command(enable_command())


@router.post("/disable")
def disable() -> dict:
    return run_command(disable_command())


@router.get("/security")
def security() -> dict:
    return {
        "activeSshSessions": run_command(["who"]),
        "failedSshAttempts": run_command(failed_ssh_attempts_command()),
        "rootLogin": run_command(["sshd", "-T"]),
        "passwordAuthentication": run_command(["sshd", "-T"]),
        "fail2banSshd": run_command(["fail2ban-client", "status", "sshd"]),
        "liveCommandsEnabled": settings.allow_live_system_commands,
    }


@router.post("/ssh-hardening")
def ssh_hardening(settings_body: SshHardening) -> dict:
    service = ssh_service_name()
    commands = [
        ["sed", "-i", f"s/^#\\?Port .*/Port {settings_body.port}/", "/etc/ssh/sshd_config"],
        ["sed", "-i", f"s/^#\\?PermitRootLogin .*/PermitRootLogin {'yes' if settings_body.permitRootLogin else 'no'}/", "/etc/ssh/sshd_config"],
        ["sed", "-i", f"s/^#\\?PasswordAuthentication .*/PasswordAuthentication {'yes' if settings_body.passwordAuthentication else 'no'}/", "/etc/ssh/sshd_config"],
        ["systemctl", "reload", service],
    ]
    return {"results": [run_command(command) for command in commands]}
