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
        ("virtual_mailbox_domains", "hash:/etc/postfix/vmaildomains"),
        ("virtual_mailbox_maps", "hash:/etc/postfix/vmailbox"),
        ("virtual_transport", "lmtp:unix:private/dovecot-lmtp"),
        ("message_size_limit", "52428800"),
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
