"""OS-aware firewall command builders (UFW on Debian, firewalld on RHEL)."""

from __future__ import annotations

from app.platform import OsReleaseInfo, current_os, firewall_backend, is_rhel, platform_paths


def auth_log_path(info: OsReleaseInfo | None = None) -> str:
    return platform_paths(info).auth_log


def ssh_service_name(info: OsReleaseInfo | None = None) -> str:
    return "sshd" if is_rhel(info) else "ssh"


def backend_name(info: OsReleaseInfo | None = None) -> str:
    return firewall_backend(info)


def list_rules_command(info: OsReleaseInfo | None = None) -> list[str]:
    if is_rhel(info):
        return [
            "sh",
            "-lc",
            (
                "echo '=== firewalld (public zone) ==='; "
                "firewall-cmd --zone=public --list-all 2>/dev/null || firewall-cmd --list-all; "
                "echo; echo '=== numbered ports ==='; "
                "firewall-cmd --permanent --zone=public --list-ports 2>/dev/null | tr ' ' '\\n' | nl -ba; "
                "echo; echo '=== numbered rich rules ==='; "
                "firewall-cmd --permanent --zone=public --list-rich-rules 2>/dev/null | nl -ba -v 100"
            ),
        ]
    return ["ufw", "status", "numbered"]


def status_commands(info: OsReleaseInfo | None = None) -> dict[str, list[str]]:
    if is_rhel(info):
        return {
            "firewall": ["firewall-cmd", "--state"],
            "firewallDetails": ["firewall-cmd", "--zone=public", "--list-all"],
        }
    return {
        "firewall": ["ufw", "status", "verbose"],
    }


def apply_rule_command(
    *,
    action: str,
    port: int,
    protocol: str,
    source_ip: str | None = None,
    info: OsReleaseInfo | None = None,
) -> list[str]:
    action = action.lower()
    if is_rhel(info):
        proto = protocol.lower()
        if source_ip:
            if action in {"deny", "reject"}:
                rule = f'rule family="ipv4" source address="{source_ip}" port port="{port}" protocol="{proto}" reject'
            elif action == "limit":
                rule = f'rule family="ipv4" source address="{source_ip}" port port="{port}" protocol="{proto}" limit value="6/m"'
            else:
                rule = f'rule family="ipv4" source address="{source_ip}" port port="{port}" protocol="{proto}" accept'
            return [
                "sh",
                "-lc",
                f"firewall-cmd --permanent --zone=public --add-rich-rule='{rule}' && firewall-cmd --reload",
            ]
        if action in {"deny", "reject"}:
            rule = f'rule family="ipv4" port port="{port}" protocol="{proto}" reject'
            return [
                "sh",
                "-lc",
                f"firewall-cmd --permanent --zone=public --add-rich-rule='{rule}' && firewall-cmd --reload",
            ]
        if action == "limit":
            rule = f'rule family="ipv4" port port="{port}" protocol="{proto}" limit value="6/m"'
            return [
                "sh",
                "-lc",
                f"firewall-cmd --permanent --zone=public --add-rich-rule='{rule}' && firewall-cmd --reload",
            ]
        return [
            "sh",
            "-lc",
            f"firewall-cmd --permanent --zone=public --add-port={port}/{proto} && firewall-cmd --reload",
        ]

    if action == "limit":
        return ["ufw", "limit", f"{port}/{protocol}"]
    if source_ip:
        return ["ufw", action, "from", source_ip, "to", "any", "port", str(port), "proto", protocol]
    return ["ufw", action, f"{port}/{protocol}"]


def delete_rule_command(rule_number: int, info: OsReleaseInfo | None = None) -> list[str]:
    if is_rhel(info):
        return [
            "sh",
            "-lc",
            (
                f"N={rule_number}; "
                "PORTS=($(firewall-cmd --permanent --zone=public --list-ports 2>/dev/null)); "
                "RULES=($(firewall-cmd --permanent --zone=public --list-rich-rules 2>/dev/null)); "
                'if (( N >= 100 )); then '
                "  IDX=$((N-100)); "
                '  if (( IDX < 0 || IDX >= ${#RULES[@]} )); then exit 2; fi; '
                '  firewall-cmd --permanent --zone=public --remove-rich-rule="${RULES[$IDX]}" && firewall-cmd --reload; '
                "else "
                '  if (( N < 1 || N > ${#PORTS[@]} )); then exit 2; fi; '
                '  firewall-cmd --permanent --zone=public --remove-port="${PORTS[$((N-1))]}" && firewall-cmd --reload; '
                "fi"
            ),
        ]
    return ["ufw", "--force", "delete", str(rule_number)]


def enable_command(info: OsReleaseInfo | None = None) -> list[str]:
    if is_rhel(info):
        return ["systemctl", "enable", "--now", "firewalld"]
    return ["ufw", "--force", "enable"]


def disable_command(info: OsReleaseInfo | None = None) -> list[str]:
    if is_rhel(info):
        return ["systemctl", "stop", "firewalld"]
    return ["ufw", "disable"]


def block_ip_command(ip: str, info: OsReleaseInfo | None = None) -> list[str]:
    if is_rhel(info):
        return [
            "sh",
            "-lc",
            f"firewall-cmd --permanent --zone=public --add-rich-rule='rule family=\"ipv4\" source address=\"{ip}\" reject' && firewall-cmd --reload",
        ]
    return ["ufw", "deny", "from", ip]


def unblock_ip_command(ip: str, info: OsReleaseInfo | None = None) -> list[str]:
    if is_rhel(info):
        return [
            "sh",
            "-lc",
            f"firewall-cmd --permanent --zone=public --remove-rich-rule='rule family=\"ipv4\" source address=\"{ip}\" reject' && firewall-cmd --reload",
        ]
    return ["ufw", "--force", "delete", "deny", "from", ip]


def failed_ssh_attempts_command(info: OsReleaseInfo | None = None) -> list[str]:
    path = auth_log_path(info)
    return ["sh", "-lc", f"grep -E 'Failed password|Invalid user|Authentication failure' {path} 2>/dev/null | tail -20"]


def firewall_status_command(info: OsReleaseInfo | None = None) -> list[str]:
    commands = status_commands(info)
    return commands["firewallDetails"] if is_rhel(info) else commands["firewall"]


def current_backend_label(info: OsReleaseInfo | None = None) -> str:
    return "firewalld" if is_rhel(info) else "ufw"
