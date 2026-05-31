import os
import unittest
from unittest import mock

from app.firewall_backend import (
    apply_rule_command,
    auth_log_path,
    backend_name,
    block_ip_command,
    delete_rule_command,
    enable_command,
    list_rules_command,
)


class FirewallBackendTests(unittest.TestCase):
    def test_ubuntu_backend(self) -> None:
        env = {"SYSAGENT_OS_FAMILY": "debian", "SYSAGENT_OS_ID": "ubuntu"}
        with mock.patch.dict(os.environ, env, clear=False):
            self.assertEqual(backend_name(), "ufw")
            self.assertEqual(auth_log_path(), "/var/log/auth.log")
            self.assertEqual(list_rules_command()[0:2], ["ufw", "status"])
            self.assertEqual(
                apply_rule_command(action="allow", port=80, protocol="tcp"),
                ["ufw", "allow", "80/tcp"],
            )
            self.assertEqual(delete_rule_command(3), ["ufw", "--force", "delete", "3"])
            self.assertEqual(enable_command(), ["ufw", "--force", "enable"])

    def test_alma_backend(self) -> None:
        env = {"SYSAGENT_OS_FAMILY": "rhel", "SYSAGENT_OS_ID": "almalinux"}
        with mock.patch.dict(os.environ, env, clear=False):
            self.assertEqual(backend_name(), "firewalld")
            self.assertEqual(auth_log_path(), "/var/log/secure")
            self.assertEqual(list_rules_command()[0], "sh")
            cmd = apply_rule_command(action="allow", port=443, protocol="tcp")
            self.assertEqual(cmd[0], "sh")
            self.assertIn("firewall-cmd", cmd[2])
            self.assertIn("443/tcp", cmd[2])
            self.assertEqual(block_ip_command("203.0.113.10")[0], "sh")
            self.assertEqual(enable_command(), ["systemctl", "enable", "--now", "firewalld"])


if __name__ == "__main__":
    unittest.main()
