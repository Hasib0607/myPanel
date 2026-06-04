import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app.platform import (
    COMPOSER_MANUAL_INSTALL_COMMAND,
    CRB_ENABLE_COMMAND,
    DEBIAN_DOVECOT_PACKAGES,
    EPEL_INSTALL_COMMAND,
    INCOMPLETE_ON_ALMA,
    RHEL_CERTBOT_PACKAGES,
    RHEL_COMPOSER_PACKAGES,
    RHEL_DOVECOT_PACKAGES,
    RHEL_PHP82_CONFLICT_CLEANUP_COMMAND,
    RHEL_PHP_REDIS_BUILD_PACKAGES,
    PHP_REDIS_EXTENSION_LOADED_COMMAND,
    PHP_REDIS_PECL_INSTALL_COMMAND,
    OsFamily,
    certbot_install_plan,
    classify_os_release,
    composer_install_plan,
    current_os,
    detect_os,
    dovecot_install_plan,
    epel_prerequisite_steps,
    firewall_backend,
    install_plan_for,
    is_almalinux,
    is_debian,
    is_rhel,
    package_install_command,
    package_install_env,
    package_installed_command,
    package_manager,
    package_requires_epel,
    packages_for,
    parse_os_release,
    platform_paths,
    platform_summary,
    runtime_tool_install_command,
    runtime_tool_install_plan,
    service_spec,
    service_unit,
    service_units,
)


UBUNTU_RELEASE = """
NAME="Ubuntu"
VERSION="22.04.5 LTS (Jammy Jellyfish)"
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 22.04.5 LTS"
VERSION_ID="22.04"
""".strip()

ALMA_RELEASE = """
NAME="AlmaLinux"
VERSION="9.4 (Seafoam Ocelot)"
ID="almalinux"
ID_LIKE="rhel fedora centos"
VERSION_ID="9.4"
PRETTY_NAME="AlmaLinux 9.4 (Seafoam Ocelot)"
""".strip()


class PlatformDetectionTests(unittest.TestCase):
    def test_parse_os_release_strips_quotes(self) -> None:
        values = parse_os_release('ID="almalinux"\nVERSION_ID="9.4"\n')
        self.assertEqual(values["ID"], "almalinux")
        self.assertEqual(values["VERSION_ID"], "9.4")

    def test_detect_ubuntu(self) -> None:
        with tempfile.NamedTemporaryFile("w", delete=False) as handle:
            handle.write(UBUNTU_RELEASE)
            path = Path(handle.name)
        self.addCleanup(lambda: path.unlink(missing_ok=True))

        info = detect_os(path)
        self.assertEqual(info.id, "ubuntu")
        self.assertEqual(info.family, OsFamily.DEBIAN)
        self.assertTrue(info.is_debian)
        self.assertFalse(info.is_rhel)

    def test_detect_almalinux(self) -> None:
        with tempfile.NamedTemporaryFile("w", delete=False) as handle:
            handle.write(ALMA_RELEASE)
            path = Path(handle.name)
        self.addCleanup(lambda: path.unlink(missing_ok=True))

        info = detect_os(path)
        self.assertEqual(info.id, "almalinux")
        self.assertEqual(info.version_id, "9.4")
        self.assertEqual(info.family, OsFamily.RHEL)
        self.assertTrue(info.is_rhel)
        self.assertFalse(info.is_debian)

    def test_detect_missing_file_returns_unknown(self) -> None:
        info = detect_os(Path("/tmp/definitely-not-os-release-vps-panel"))
        self.assertEqual(info.family, OsFamily.UNKNOWN)

    def test_classify_by_id_like(self) -> None:
        self.assertEqual(classify_os_release({"ID": "linuxmint", "ID_LIKE": "ubuntu debian"}), OsFamily.DEBIAN)
        self.assertEqual(classify_os_release({"ID": "rocky", "ID_LIKE": "rhel centos fedora"}), OsFamily.RHEL)

    def test_current_os_env_override(self) -> None:
        env = {
            "SYSAGENT_OS_FAMILY": "rhel",
            "SYSAGENT_OS_ID": "almalinux",
            "SYSAGENT_OS_VERSION_ID": "9.4",
            "SYSAGENT_OS_PRETTY_NAME": "Test Alma",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            info = current_os()
        self.assertEqual(info.id, "almalinux")
        self.assertEqual(info.family, OsFamily.RHEL)
        self.assertTrue(is_almalinux(info))
        self.assertTrue(is_rhel(info))
        self.assertFalse(is_debian(info))


class PlatformMappingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.ubuntu = detect_os(self._write_release(UBUNTU_RELEASE))
        self.alma = detect_os(self._write_release(ALMA_RELEASE))

    def _write_release(self, content: str) -> Path:
        handle = tempfile.NamedTemporaryFile("w", delete=False)
        handle.write(content)
        handle.close()
        path = Path(handle.name)
        self.addCleanup(lambda: path.unlink(missing_ok=True))
        return path

    def test_package_manager(self) -> None:
        self.assertEqual(package_manager(self.ubuntu), "apt")
        self.assertEqual(package_manager(self.alma), "dnf")

    def test_firewall_backend(self) -> None:
        self.assertEqual(firewall_backend(self.ubuntu), "ufw")
        self.assertEqual(firewall_backend(self.alma), "firewalld")

    def test_packages_for_bind_and_redis(self) -> None:
        self.assertEqual(packages_for("bind9", self.ubuntu), ["bind9", "bind9utils", "bind9-doc"])
        self.assertEqual(packages_for("bind9", self.alma), ["bind", "bind-utils"])
        self.assertEqual(packages_for("redis", self.ubuntu), ["redis-server"])
        self.assertEqual(packages_for("redis", self.alma), ["redis"])

    def test_rhel_base_excludes_certbot_until_epel(self) -> None:
        base = packages_for("base", self.alma)
        self.assertNotIn("certbot", base)
        self.assertNotIn("python3-certbot-nginx", base)

    def test_service_units(self) -> None:
        self.assertEqual(service_unit("bind9", self.ubuntu), "bind9")
        self.assertEqual(service_unit("bind9", self.alma), "named")
        self.assertEqual(service_units("redis", self.ubuntu), ["redis-server", "redis"])
        self.assertEqual(service_units("redis", self.alma), ["redis", "redis-server"])

    def test_service_spec_matches_system_router_keys(self) -> None:
        for key in ("nginx", "bind9", "postfix", "dovecot"):
            ubuntu_spec = service_spec(key, self.ubuntu)
            alma_spec = service_spec(key, self.alma)
            self.assertTrue(ubuntu_spec.unit)
            self.assertTrue(alma_spec.unit)
            self.assertGreaterEqual(len(ubuntu_spec.packages), 1)
            self.assertGreaterEqual(len(alma_spec.packages), 1)

    def test_dovecot_package_split(self) -> None:
        self.assertEqual(list(DEBIAN_DOVECOT_PACKAGES), packages_for("dovecot", self.ubuntu))
        self.assertEqual(list(RHEL_DOVECOT_PACKAGES), packages_for("dovecot", self.alma))
        self.assertEqual(packages_for("dovecot", self.alma), ["dovecot"])
        self.assertEqual(service_spec("dovecot", self.alma).packages, ("dovecot",))

    def test_platform_paths(self) -> None:
        ubuntu_paths = platform_paths(self.ubuntu)
        alma_paths = platform_paths(self.alma)
        self.assertEqual(ubuntu_paths.auth_log, "/var/log/auth.log")
        self.assertEqual(alma_paths.auth_log, "/var/log/secure")
        self.assertEqual(ubuntu_paths.nginx_user, "www-data")
        self.assertEqual(alma_paths.nginx_user, "nginx")
        self.assertEqual(ubuntu_paths.nginx_sites_available, "/etc/nginx/sites-available")
        self.assertEqual(alma_paths.nginx_sites_available, "/etc/nginx/conf.d")

    def test_package_install_command_and_env(self) -> None:
        self.assertEqual(
            package_install_command(["nginx"], self.ubuntu),
            ["apt-get", "install", "-y", "nginx"],
        )
        self.assertEqual(package_install_env(self.ubuntu), {"DEBIAN_FRONTEND": "noninteractive"})
        self.assertEqual(
            package_install_command(["nginx"], self.alma),
            ["dnf", "install", "-y", "nginx"],
        )
        self.assertEqual(package_install_env(self.alma), {})
        self.assertEqual(package_installed_command(("nginx",), self.ubuntu)[0:2], ("sh", "-lc"))
        self.assertIn("dpkg-query", package_installed_command(("nginx",), self.ubuntu)[2])
        self.assertIn("rpm -q", package_installed_command(("nginx",), self.alma)[2])

    def test_runtime_tool_install_command(self) -> None:
        self.assertEqual(runtime_tool_install_command("pnpm", self.ubuntu), ["npm", "install", "-g", "pnpm"])
        self.assertEqual(
            runtime_tool_install_command("php", self.alma)[0:3],
            ["dnf", "install", "-y"],
        )
        self.assertIn("php", runtime_tool_install_command("php", self.alma))

    def test_python_modern_runtime_mapping(self) -> None:
        ubuntu_plan = runtime_tool_install_plan("python311", self.ubuntu)
        self.assertEqual(ubuntu_plan.packages, ("python3", "python3-venv", "python3-pip"))
        self.assertEqual(ubuntu_plan.steps[0].command, ("apt-get", "install", "-y", "python3", "python3-venv", "python3-pip"))
        self.assertIsNotNone(ubuntu_plan.steps[0].skip_if)

        alma_plan = runtime_tool_install_plan("python311", self.alma)
        self.assertEqual(alma_plan.packages, ("python3.11", "python3.11-pip"))
        self.assertEqual(alma_plan.steps[0].command, ("dnf", "install", "-y", "python3.11", "python3.11-pip"))
        self.assertIsNotNone(alma_plan.steps[0].skip_if)

    def test_php_extension_runtime_tool_mapping(self) -> None:
        self.assertEqual(runtime_tool_install_plan("php-gd", self.ubuntu).packages, ("php-gd",))
        self.assertEqual(runtime_tool_install_plan("php-pgsql", self.ubuntu).packages, ("php-pgsql",))
        self.assertEqual(runtime_tool_install_plan("php-mysql", self.alma).packages, ("php-mysqlnd",))
        self.assertEqual(runtime_tool_install_command("php-curl", self.ubuntu), ["apt-get", "install", "-y", "php-curl"])
        self.assertIsNotNone(runtime_tool_install_plan("php-gd", self.ubuntu).steps[0].skip_if)
        sodium_plan = runtime_tool_install_plan("php-sodium", self.alma)
        self.assertEqual(sodium_plan.steps[-1].description, "Verify PHP Sodium extension is loaded")

    def test_rhel_php_redis_install_plan_builds_against_active_php(self) -> None:
        plan = runtime_tool_install_plan("php-redis", self.alma)
        self.assertEqual(plan.key, "php_redis")
        self.assertEqual(plan.packages, RHEL_PHP_REDIS_BUILD_PACKAGES)
        self.assertIn("php-pecl-redis*", plan.steps[0].command[-1])
        self.assertEqual(plan.steps[1].command, ("dnf", "install", "-y", *RHEL_PHP_REDIS_BUILD_PACKAGES))
        self.assertEqual(plan.steps[2].command, PHP_REDIS_PECL_INSTALL_COMMAND)
        self.assertEqual(plan.steps[0].skip_if, PHP_REDIS_EXTENSION_LOADED_COMMAND)
        self.assertEqual(plan.steps[1].skip_if, PHP_REDIS_EXTENSION_LOADED_COMMAND)
        self.assertEqual(plan.steps[2].skip_if, PHP_REDIS_EXTENSION_LOADED_COMMAND)

    def test_platform_summary_has_no_known_alma_code_gaps(self) -> None:
        summary = platform_summary(self.alma)
        self.assertEqual(summary["family"], "rhel")
        self.assertEqual(summary["firewallBackend"], "firewalld")
        incomplete = summary["incompleteOnAlma"]
        self.assertIsInstance(incomplete, list)
        self.assertTrue(set(incomplete).issubset(INCOMPLETE_ON_ALMA))
        self.assertNotIn("panel_nginx_layout", incomplete)
        self.assertNotIn("certbot", incomplete)
        self.assertNotIn("composer", incomplete)
        self.assertNotIn("dovecot", incomplete)

    def test_platform_summary_empty_incomplete_on_ubuntu(self) -> None:
        summary = platform_summary(self.ubuntu)
        self.assertEqual(summary["incompleteOnAlma"], [])


class AlmaPackagePlanTests(unittest.TestCase):
    def setUp(self) -> None:
        self.alma = detect_os(self._write_release(ALMA_RELEASE))
        self.ubuntu = detect_os(self._write_release(UBUNTU_RELEASE))

    def _write_release(self, content: str) -> Path:
        handle = tempfile.NamedTemporaryFile("w", delete=False)
        handle.write(content)
        handle.close()
        path = Path(handle.name)
        self.addCleanup(lambda: path.unlink(missing_ok=True))
        return path

    def test_epel_prerequisite_steps(self) -> None:
        steps = epel_prerequisite_steps(self.alma)
        self.assertEqual(len(steps), 2)
        self.assertEqual(steps[0].command, CRB_ENABLE_COMMAND)
        self.assertEqual(steps[0].on_failure, "continue")
        self.assertIsNotNone(steps[0].skip_if)
        self.assertEqual(steps[1].command, EPEL_INSTALL_COMMAND)
        self.assertIsNotNone(steps[1].skip_if)
        self.assertEqual(epel_prerequisite_steps(self.ubuntu), ())

    def test_package_requires_epel(self) -> None:
        self.assertTrue(package_requires_epel("certbot", self.alma))
        self.assertTrue(package_requires_epel("composer", self.alma))
        self.assertFalse(package_requires_epel("dovecot", self.alma))
        self.assertFalse(package_requires_epel("certbot", self.ubuntu))

    def test_certbot_install_plan(self) -> None:
        plan = certbot_install_plan(self.alma)
        self.assertEqual(plan.packages, RHEL_CERTBOT_PACKAGES)
        self.assertEqual(len(plan.steps), 3)
        self.assertEqual(plan.steps[0].command, CRB_ENABLE_COMMAND)
        self.assertEqual(plan.steps[1].command, EPEL_INSTALL_COMMAND)
        self.assertEqual(plan.steps[-1].command, ("dnf", "install", "-y", *RHEL_CERTBOT_PACKAGES))
        self.assertTrue(all(step.skip_if for step in plan.steps))
        ubuntu_plan = certbot_install_plan(self.ubuntu)
        self.assertEqual(len(ubuntu_plan.steps), 1)
        self.assertEqual(ubuntu_plan.steps[0].command[0], "apt-get")
        self.assertIsNotNone(ubuntu_plan.steps[0].skip_if)

    def test_composer_install_plan(self) -> None:
        plan = composer_install_plan(self.alma)
        self.assertEqual(plan.packages, RHEL_COMPOSER_PACKAGES)
        self.assertEqual(len(plan.steps), 3)
        self.assertEqual(plan.steps[0].command, CRB_ENABLE_COMMAND)
        self.assertEqual(plan.steps[1].command, EPEL_INSTALL_COMMAND)
        self.assertEqual(plan.steps[-1].command, ("dnf", "install", "-y", *RHEL_COMPOSER_PACKAGES))
        self.assertTrue(all(step.skip_if for step in plan.steps))
        self.assertEqual(len(plan.fallback_steps), 1)
        self.assertEqual(plan.fallback_steps[0].command, COMPOSER_MANUAL_INSTALL_COMMAND)
        self.assertIsNotNone(plan.fallback_steps[0].skip_if)

        runtime_plan = runtime_tool_install_plan("composer", self.alma)
        self.assertEqual(runtime_plan.fallback_steps, plan.fallback_steps)
        self.assertEqual(
            runtime_tool_install_command("composer", self.alma),
            ["dnf", "install", "-y", *RHEL_COMPOSER_PACKAGES],
        )

    def test_rhel_php82_install_plan_enables_php82_module(self) -> None:
        plan = runtime_tool_install_plan("php82", self.alma)
        self.assertEqual(plan.key, "php82_runtime")
        self.assertEqual(plan.steps[0].command, ("dnf", "module", "reset", "-y", "php"))
        self.assertEqual(plan.steps[1].command, RHEL_PHP82_CONFLICT_CLEANUP_COMMAND)
        self.assertEqual(plan.steps[2].command, ("dnf", "module", "enable", "-y", "php:8.2"))
        self.assertEqual(plan.steps[3].command, ("dnf", "distro-sync", "-y", "--allowerasing", "php*"))
        self.assertEqual(plan.steps[4].command[0:3], ("dnf", "install", "-y"))
        self.assertIn("php-fpm", plan.steps[4].command)
        self.assertTrue(all(step.skip_if for step in plan.steps[:5]))
        self.assertIn("PHP_MINOR_VERSION === 2", plan.steps[0].skip_if[-1])
        self.assertNotIn("PHP_MINOR_VERSION >= 2", plan.steps[0].skip_if[-1])
        self.assertIn("PHP_MINOR_VERSION === 2", plan.steps[-1].command[-1])

    def test_rhel_php82_install_plan_removes_old_pecl_abi_conflicts(self) -> None:
        plan = runtime_tool_install_plan("php82", self.alma)
        cleanup = plan.steps[1]
        self.assertIn("PECL", cleanup.description)
        self.assertIn("php-pecl-redis*", cleanup.command[-1])
        self.assertIn("php-pecl-msgpack*", cleanup.command[-1])
        self.assertIn("php-pecl-igbinary*", cleanup.command[-1])
        self.assertIn("dnf remove -y", cleanup.command[-1])

    def test_rhel_php83_install_plan_switches_exact_runtime(self) -> None:
        plan = runtime_tool_install_plan("php83", self.alma)
        self.assertEqual(plan.steps[3].command, ("dnf", "module", "enable", "-y", "php:remi-8.3"))
        self.assertEqual(plan.steps[4].command, ("dnf", "distro-sync", "-y", "--allowerasing", "php*"))
        self.assertIn("PHP_MINOR_VERSION === 3", plan.steps[1].skip_if[-1])
        self.assertNotIn("PHP_MINOR_VERSION >= 3", plan.steps[1].skip_if[-1])
        self.assertIn("PHP_MINOR_VERSION === 3", plan.steps[-1].command[-1])

    def test_dovecot_install_plan(self) -> None:
        plan = dovecot_install_plan(self.alma)
        self.assertEqual(plan.packages, ("dovecot",))
        self.assertEqual(len(plan.steps), 1)
        self.assertEqual(plan.steps[0].command, ("dnf", "install", "-y", "dovecot"))
        self.assertIn("single dovecot package", plan.notes)

        ubuntu_plan = dovecot_install_plan(self.ubuntu)
        self.assertEqual(len(ubuntu_plan.packages), 3)

    def test_install_plan_for_dispatches(self) -> None:
        self.assertEqual(install_plan_for("certbot", self.alma).key, "certbot")
        self.assertEqual(install_plan_for("composer", self.alma).key, "composer")
        self.assertEqual(install_plan_for("nginx", self.alma).key, "nginx")


if __name__ == "__main__":
    unittest.main()
