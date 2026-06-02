import sys
import types
import unittest
from unittest import mock

# Stub config dependency so command.py can import without pydantic installed.
_config_module = types.ModuleType("app.config")
_settings = types.SimpleNamespace(
    allow_live_system_commands=False,
    deployment_command_timeout_seconds=900,
)
_config_module.settings = _settings
_config_module.DEPLOYMENT_COMMANDS_LIVE = True
sys.modules.setdefault("app.config", _config_module)

from app.command import run_install_plan  # noqa: E402
from app.platform import InstallStep, PackageInstallPlan  # noqa: E402


class RunInstallPlanTests(unittest.TestCase):
    def test_runs_all_steps_in_dry_run_mode(self) -> None:
        plan = PackageInstallPlan(
            key="nginx",
            packages=("nginx",),
            steps=(
                InstallStep("Enable repo", ("dnf", "config-manager", "--set-enabled", "crb"), on_failure="continue"),
                InstallStep("Install nginx", ("dnf", "install", "-y", "nginx")),
            ),
        )
        _settings.allow_live_system_commands = False
        result = run_install_plan(plan)

        self.assertEqual(result["returncode"], 0)
        self.assertEqual(result["planKey"], "nginx")
        self.assertTrue(result["dryRun"])
        self.assertEqual(len(result["steps"]), 2)
        self.assertEqual(result["steps"][0]["description"], "Enable repo")

    def test_stops_on_failed_step_without_continue(self) -> None:
        plan = PackageInstallPlan(
            key="demo",
            packages=("pkg",),
            steps=(
                InstallStep("Fail", ("false",)),
                InstallStep("Skipped", ("echo", "never")),
            ),
        )

        with mock.patch("app.command.run_command") as run_command:
            run_command.return_value = {
                "dryRun": False,
                "command": ["false"],
                "stdout": "",
                "stderr": "failed",
                "returncode": 1,
            }
            result = run_install_plan(plan)

        self.assertEqual(result["returncode"], 1)
        self.assertEqual(len(result["steps"]), 1)
        self.assertEqual(run_command.call_count, 1)

    def test_runs_fallback_steps_after_primary_failure(self) -> None:
        plan = PackageInstallPlan(
            key="composer",
            packages=("composer",),
            steps=(InstallStep("Primary", ("dnf", "install", "-y", "composer")),),
            fallback_steps=(InstallStep("Fallback", ("sh", "-lc", "install composer manually")),),
        )

        with mock.patch("app.command.run_command") as run_command:
            run_command.side_effect = [
                {
                    "dryRun": False,
                    "command": ["dnf", "install", "-y", "composer"],
                    "stdout": "",
                    "stderr": "No package composer available",
                    "returncode": 1,
                },
                {
                    "dryRun": False,
                    "command": ["sh", "-lc", "install composer manually"],
                    "stdout": "installed",
                    "stderr": "",
                    "returncode": 0,
                },
            ]
            result = run_install_plan(plan)

        self.assertEqual(result["returncode"], 0)
        self.assertEqual(len(result["steps"]), 2)
        self.assertTrue(result["steps"][1]["fallback"])

    def test_skips_installed_step_when_check_passes(self) -> None:
        plan = PackageInstallPlan(
            key="demo",
            packages=("pkg",),
            steps=(InstallStep("Install pkg", ("apt-get", "install", "-y", "pkg"), skip_if=("dpkg-query", "-W", "pkg")),),
        )

        with mock.patch("app.command.run_command") as run_command:
            run_command.return_value = {
                "dryRun": False,
                "command": ["dpkg-query", "-W", "pkg"],
                "stdout": "pkg installed",
                "stderr": "",
                "returncode": 0,
            }
            result = run_install_plan(plan)

        self.assertEqual(result["returncode"], 0)
        self.assertTrue(result["steps"][0]["skipped"])
        self.assertEqual(run_command.call_count, 1)


if __name__ == "__main__":
    unittest.main()
