import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

_config_module = types.ModuleType("app.config")
_config_module.settings = types.SimpleNamespace(
    allow_live_system_commands=False,
    deployment_command_timeout_seconds=900,
)
_config_module.DEPLOYMENT_COMMANDS_LIVE = True
sys.modules.setdefault("app.config", _config_module)

from app.supervisor_utils import (  # noqa: E402
    _include_dir_from_config,
    supervisor_program_extension,
    supervisor_program_path,
    supervisorctl_command,
)


class SupervisorUtilsTests(unittest.TestCase):
    def test_include_dir_from_alma_supervisord_conf(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "supervisord.conf"
            include_dir = Path(tmp) / "supervisord.d"
            include_dir.mkdir()
            config.write_text(
                "[include]\nfiles = supervisord.d/*.ini\n",
                encoding="utf-8",
            )
            parsed = _include_dir_from_config(config)
            self.assertEqual(parsed, include_dir)

    def test_program_extension_uses_ini_on_alma(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "supervisord.conf"
            config.write_text("[include]\nfiles = supervisord.d/*.ini\n", encoding="utf-8")
            with mock.patch("app.supervisor_utils.supervisor_config_dir", return_value=Path(tmp) / "supervisord.d"):
                with mock.patch("app.supervisor_utils.supervisor_config_file", return_value=config):
                    self.assertEqual(supervisor_program_extension(), "ini")

    def test_program_extension_uses_conf_on_ubuntu(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "supervisor.conf"
            config.write_text("[include]\nfiles = /etc/supervisor/conf.d/*.conf\n", encoding="utf-8")
            with mock.patch("app.supervisor_utils.supervisor_config_dir", return_value=Path("/etc/supervisor/conf.d")):
                with mock.patch("app.supervisor_utils.supervisor_config_file", return_value=config):
                    self.assertEqual(supervisor_program_extension(), "conf")

    def test_supervisorctl_command_uses_config_file(self) -> None:
        config = Path("/etc/supervisord.conf")
        with mock.patch("app.supervisor_utils.supervisor_config_file", return_value=config):
            with mock.patch.object(Path, "is_file", return_value=True):
                self.assertEqual(
                    supervisorctl_command("reread"),
                    ["supervisorctl", "-c", "/etc/supervisord.conf", "reread"],
                )

    def test_program_path_uses_detected_extension(self) -> None:
        with mock.patch("app.supervisor_utils.supervisor_config_dir", return_value=Path("/etc/supervisord.d")):
            with mock.patch("app.supervisor_utils.supervisor_program_extension", return_value="ini"):
                self.assertEqual(
                    supervisor_program_path("my-app"),
                    Path("/etc/supervisord.d/my-app.ini"),
                )


if __name__ == "__main__":
    unittest.main()
