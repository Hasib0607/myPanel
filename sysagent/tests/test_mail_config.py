import unittest
from email.message import EmailMessage
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from app.mail_utils import dovecot_password_hash, dovecot_user_line, mail_milter_settings, mail_security_postfix_settings, mail_security_profile, smtp_settings
from app.routers import mail_config
from app.routers.mail_config import IncomingHealthRequest, MailDomain, MailQueueActionRequest, MailboxRequest, SmtpHealthRequest, dry_write, incoming_health_test, mail_diagnostics, mail_queue_action, optional_reload_service, parse_maildir_message, policy_config_from_mailboxes, policy_restriction, policy_script_source, policy_service_restriction, smtp_health_test


class MailConfigTests(unittest.TestCase):
    def test_annotations_are_postponed_for_python39_runtime(self):
        self.assertIsInstance(smtp_settings.__annotations__["certificate_path"], str)
        self.assertIsInstance(MailDomain.__annotations__["hostname"], str)

    def test_bcrypt_hash_is_normalized_for_dovecot(self):
        value = "$2b$12$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuu"
        self.assertEqual(dovecot_password_hash(value), "{BLF-CRYPT}$2y$12$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuu")

    def test_existing_dovecot_scheme_is_preserved(self):
        value = "{BLF-CRYPT}$2y$12$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuu"
        self.assertEqual(dovecot_password_hash(value), value)

    def test_smtp_limits_use_numeric_anvil_window(self):
        config = dict(smtp_settings("mail.example.com", None, None, 60))
        self.assertEqual(config["anvil_rate_time_unit"], "60s")
        self.assertEqual(config["smtpd_client_message_rate_limit"], "60")
        self.assertEqual(config["smtpd_client_recipient_rate_limit"], "600")
        self.assertEqual(config["smtpd_client_connection_rate_limit"], "30")

    def test_dovecot_user_has_maildir_and_per_mailbox_quota(self):
        line = dovecot_user_line("sales@example.com", "$2b$12$hash", "/var/mail/vhosts/example.com/sales", 2048)
        self.assertIn("{BLF-CRYPT}$2y$12$hash", line)
        self.assertIn("userdb_mail=maildir:/var/mail/vhosts/example.com/sales", line)
        self.assertIn("userdb_quota_rule=*:storage=2048M", line)

    def test_security_profile_selects_platform_packages_and_optional_clamav(self):
        debian = mail_security_profile(True, True)
        rhel = mail_security_profile(False, False)
        self.assertIn("clamav-daemon", debian["packages"])
        self.assertEqual(debian["clamSocket"], "/run/clamav/clamd.ctl")
        self.assertNotIn("clamav", rhel["packages"])
        self.assertEqual(rhel["redisService"], "redis")

    def test_security_postfix_settings_block_relay_and_chain_milters(self):
        config = dict(mail_security_postfix_settings())
        self.assertIn("127.0.0.1:8891", config["smtpd_milters"])
        self.assertIn("127.0.0.1:11332", config["smtpd_milters"])
        self.assertIn("defer_unauth_destination", config["smtpd_relay_restrictions"])
        self.assertEqual(config["mynetworks"], "127.0.0.0/8,[::1]/128")

    def test_dkim_milter_chain_preserves_rspamd_when_enabled(self):
        with_rspamd = dict(mail_milter_settings(True))
        without_rspamd = dict(mail_milter_settings(False))
        self.assertEqual(with_rspamd["smtpd_milters"], "inet:127.0.0.1:8891,inet:127.0.0.1:11332")
        self.assertEqual(without_rspamd["smtpd_milters"], "inet:127.0.0.1:8891")

    def test_policy_server_config_enforces_per_mailbox_smtp_limits(self):
        config = policy_config_from_mailboxes([MailboxRequest(email="sales@example.com", dailySendLimit=250, minuteSendLimit=25, smtpSuspended=True)])
        self.assertEqual(config["users"]["sales@example.com"]["dailySendLimit"], 250)
        self.assertTrue(config["users"]["sales@example.com"]["smtpSuspended"])
        self.assertIn("check_policy_service inet:127.0.0.1:10031", policy_restriction())
        self.assertEqual(policy_service_restriction(), "vps_panel_policy,permit_sasl_authenticated,reject")
        self.assertNotIn(" ", policy_service_restriction())
        self.assertIn("Daily SMTP limit reached", policy_script_source())

    def test_missing_opendkim_reload_is_optional_for_smtp_repair(self):
        with patch.object(mail_config, "run_command", return_value={"returncode": 5, "stderr": "Unit opendkim.service not found."}):
            result = optional_reload_service("opendkim")
        self.assertEqual(result["returncode"], 0)
        self.assertTrue(result["skipped"])

    def test_maildir_message_parser_extracts_body_and_stable_headers(self):
        message = EmailMessage()
        message["Message-ID"] = "<incoming-1@example.com>"
        message["From"] = "Sender <sender@example.com>"
        message["To"] = "user@example.com"
        message["Subject"] = "Inbound test"
        message["Date"] = "Sat, 21 Jun 2026 10:00:00 +0000"
        message.set_content("Hello from Maildir")
        with TemporaryDirectory() as directory:
            path = Path(directory) / "message"
            path.write_bytes(message.as_bytes())
            parsed = parse_maildir_message(path)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["messageId"], "incoming-1@example.com")
        self.assertEqual(parsed["subject"], "Inbound test")
        self.assertIn("Hello from Maildir", parsed["bodyText"])

    def test_atomic_write_preserves_existing_mode(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "mail.conf"
            path.write_text("old\n", encoding="utf-8")
            path.chmod(0o640)
            with patch.object(mail_config, "settings", SimpleNamespace(allow_live_system_commands=True)):
                result = dry_write(path, "new\n")
            self.assertFalse(result["dryRun"])
            self.assertEqual(path.read_text(encoding="utf-8"), "new\n")
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)

    def test_dry_run_health_checks_are_not_reported_as_success(self):
        disabled = SimpleNamespace(allow_live_system_commands=False)
        with patch.object(mail_config, "settings", disabled):
            smtp = smtp_health_test(SmtpHealthRequest(hostname="mail.example.com", username="user@example.com", password="password", recipient="user@example.com"))
            incoming = incoming_health_test(IncomingHealthRequest(domain="example.com", email="user@example.com"))
        self.assertFalse(smtp["ok"])
        self.assertTrue(smtp["dryRun"])
        self.assertTrue(all(not check["ok"] for check in smtp["checks"]))
        self.assertFalse(incoming["ok"])
        self.assertTrue(incoming["dryRun"])

    def test_dry_run_diagnostics_and_queue_actions_are_not_successful(self):
        with patch.object(mail_config, "settings", SimpleNamespace(allow_live_system_commands=False)):
            diagnostics = mail_diagnostics(MailDomain(domain="example.com"))
            action = mail_queue_action(MailQueueActionRequest(action="flush"))
        self.assertFalse(diagnostics["ok"])
        self.assertTrue(all(not check["ok"] for check in diagnostics["checks"]))
        self.assertFalse(action["ok"])


if __name__ == "__main__":
    unittest.main()
