import unittest
from unittest import mock

from app.command import run_command


class DeploymentLiveCommandTests(unittest.TestCase):
    def test_allow_live_true_runs_even_when_global_live_disabled(self) -> None:
        with mock.patch("app.command.settings") as settings:
            settings.allow_live_system_commands = False
            settings.deployment_command_timeout_seconds = 900
            with mock.patch("app.command.subprocess.Popen") as popen:
                process = mock.Mock()
                process.communicate.return_value = ("ok", "")
                process.returncode = 0
                process.pid = 1234
                popen.return_value = process

                with mock.patch("app.command.os.getpgid", return_value=1234):
                    result = run_command(["echo", "live"], allow_live=True)

        self.assertFalse(result["dryRun"])
        self.assertEqual(result["returncode"], 0)
        popen.assert_called_once()

    def test_allow_live_false_dry_runs_when_global_live_disabled(self) -> None:
        with mock.patch("app.command.settings") as settings:
            settings.allow_live_system_commands = False
            result = run_command(["echo", "dry"], allow_live=False)

        self.assertTrue(result["dryRun"])
        self.assertTrue(result["liveCommandsDisabled"])


if __name__ == "__main__":
    unittest.main()
