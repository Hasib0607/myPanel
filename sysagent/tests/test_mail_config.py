import unittest

from app.mail_utils import dovecot_password_hash, dovecot_user_line, smtp_settings


class MailConfigTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
