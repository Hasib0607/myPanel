import os
import unittest
from unittest import mock

from app.platform import install_plan_for, platform_summary, runtime_tool_install_plan
from app.service_registry import service_checks


class ServiceChecksTests(unittest.TestCase):
    def test_ubuntu_bind9_packages_and_unit(self) -> None:
        env = {"SYSAGENT_OS_FAMILY": "debian", "SYSAGENT_OS_ID": "ubuntu"}
        with mock.patch.dict(os.environ, env, clear=False):
            checks = service_checks()["bind9"]
        self.assertEqual(checks["unit"], "bind9")
        self.assertIn("bind9utils", checks["packages"])
        self.assertEqual(checks["units"], ["bind9", "named"])

    def test_alma_bind9_packages_and_unit(self) -> None:
        env = {"SYSAGENT_OS_FAMILY": "rhel", "SYSAGENT_OS_ID": "almalinux"}
        with mock.patch.dict(os.environ, env, clear=False):
            checks = service_checks()["bind9"]
        self.assertEqual(checks["unit"], "named")
        self.assertEqual(checks["packages"], ["bind", "bind-utils"])

    def test_alma_dovecot_single_package(self) -> None:
        env = {"SYSAGENT_OS_FAMILY": "rhel", "SYSAGENT_OS_ID": "almalinux"}
        with mock.patch.dict(os.environ, env, clear=False):
            checks = service_checks()["dovecot"]
        self.assertEqual(checks["packages"], ["dovecot"])

    def test_ubuntu_dovecot_split_packages(self) -> None:
        env = {"SYSAGENT_OS_FAMILY": "debian", "SYSAGENT_OS_ID": "ubuntu"}
        with mock.patch.dict(os.environ, env, clear=False):
            checks = service_checks()["dovecot"]
        self.assertEqual(
            checks["packages"],
            ["dovecot-core", "dovecot-imapd", "dovecot-lmtpd"],
        )


class InstallPlanIntegrationTests(unittest.TestCase):
    def test_service_install_plan_uses_dnf_on_alma(self) -> None:
        env = {"SYSAGENT_OS_FAMILY": "rhel", "SYSAGENT_OS_ID": "almalinux"}
        with mock.patch.dict(os.environ, env, clear=False):
            plan = install_plan_for("bind9")
        self.assertEqual(plan.packages, ("bind", "bind-utils"))
        self.assertEqual(plan.steps[-1].command[0], "dnf")

    def test_runtime_php_install_plan_uses_apt_on_ubuntu(self) -> None:
        env = {"SYSAGENT_OS_FAMILY": "debian", "SYSAGENT_OS_ID": "ubuntu"}
        with mock.patch.dict(os.environ, env, clear=False):
            plan = runtime_tool_install_plan("php")
        self.assertEqual(plan.steps[-1].command[0], "apt-get")
        self.assertIn("php-cli", plan.packages)

    def test_runtime_composer_install_plan_includes_epel_on_alma(self) -> None:
        env = {"SYSAGENT_OS_FAMILY": "rhel", "SYSAGENT_OS_ID": "almalinux"}
        with mock.patch.dict(os.environ, env, clear=False):
            plan = runtime_tool_install_plan("composer")
        self.assertEqual(len(plan.steps), 3)
        self.assertEqual(plan.steps[0].command[0], "dnf")
        self.assertTrue(plan.fallback_steps)


    def test_platform_summary_includes_firewall_backend(self) -> None:
        env = {"SYSAGENT_OS_FAMILY": "rhel", "SYSAGENT_OS_ID": "almalinux"}
        with mock.patch.dict(os.environ, env, clear=False):
            summary = platform_summary()
        self.assertEqual(summary["firewallBackend"], "firewalld")
        self.assertEqual(summary["family"], "rhel")


if __name__ == "__main__":
    unittest.main()
