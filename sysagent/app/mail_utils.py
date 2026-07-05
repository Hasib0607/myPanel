from __future__ import annotations


def dovecot_password_hash(password_hash: str) -> str:
    if password_hash.startswith("{"):
        return password_hash
    normalized = f"$2y${password_hash[4:]}" if password_hash.startswith("$2b$") else password_hash
    return f"{{BLF-CRYPT}}{normalized}"


def dovecot_user_line(email: str, password_hash: str, maildir: str, quota_mb: int) -> str:
    return (
        f"{email}:{dovecot_password_hash(password_hash)}:5000:5000::/var/mail/vhosts::"
        f"userdb_mail=maildir:{maildir} userdb_quota_rule=*:storage={quota_mb}M"
    )


def smtp_settings(hostname: str, certificate_path: str | None, key_path: str | None, message_rate_limit: int) -> list[tuple[str, str]]:
    settings_map = [
        ("smtpd_sasl_type", "dovecot"),
        ("smtpd_sasl_path", "private/auth"),
        ("smtpd_sasl_auth_enable", "yes"),
        ("smtpd_tls_security_level", "may"),
        ("smtpd_tls_auth_only", "yes"),
        ("smtpd_recipient_restrictions", "permit_sasl_authenticated,reject_unauth_destination"),
        ("inet_interfaces", "all"),
        ("inet_protocols", "ipv4"),
        ("virtual_mailbox_domains", "hash:/etc/postfix/vmaildomains"),
        ("virtual_mailbox_maps", "hash:/etc/postfix/vmailbox"),
        ("virtual_transport", "lmtp:unix:private/dovecot-lmtp"),
        ("message_size_limit", "52428800"),
        ("mailbox_size_limit", "0"),
        ("anvil_rate_time_unit", "60s"),
        ("smtpd_client_message_rate_limit", str(message_rate_limit)),
        ("smtpd_client_recipient_rate_limit", str(message_rate_limit * 10)),
        ("smtpd_client_connection_rate_limit", str(max(10, message_rate_limit // 2))),
        ("myhostname", hostname),
    ]
    if certificate_path and key_path:
        settings_map.extend([
            ("smtpd_tls_cert_file", certificate_path),
            ("smtpd_tls_key_file", key_path),
        ])
    return settings_map


def mail_security_profile(is_debian: bool, enable_clamav: bool) -> dict:
    if is_debian:
        return {
            "packages": ["fail2ban", "rspamd", "redis-server", *(["clamav", "clamav-daemon"] if enable_clamav else [])],
            "redisService": "redis-server",
            "clamService": "clamav-daemon",
            "clamSocket": "/run/clamav/clamd.ctl",
        }
    return {
        "packages": ["fail2ban", "rspamd", "redis", *(["clamav", "clamav-update", "clamd"] if enable_clamav else [])],
        "redisService": "redis",
        "clamService": "clamd@scan",
        "clamSocket": "/run/clamd.scan/clamd.sock",
    }


def mail_milter_settings(include_rspamd: bool) -> list[tuple[str, str]]:
    milters = ["inet:127.0.0.1:8891"]
    if include_rspamd:
        milters.append("inet:127.0.0.1:11332")
    value = ",".join(milters)
    return [
        ("smtpd_milters", value),
        ("non_smtpd_milters", value),
        ("milter_default_action", "accept"),
        ("milter_protocol", "6"),
    ]


def mail_security_postfix_settings() -> list[tuple[str, str]]:
    return [
        *mail_milter_settings(include_rspamd=True),
        ("smtpd_sender_restrictions", "reject_non_fqdn_sender,reject_unknown_sender_domain"),
        ("smtpd_helo_restrictions", "reject_invalid_helo_hostname,reject_non_fqdn_helo_hostname"),
        ("smtpd_relay_restrictions", "permit_mynetworks,permit_sasl_authenticated,defer_unauth_destination"),
        ("mynetworks", "127.0.0.0/8,[::1]/128"),
        ("disable_vrfy_command", "yes"),
    ]
