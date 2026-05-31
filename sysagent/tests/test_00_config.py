import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app.env_loader import env_flag, panel_env_path, reload_panel_env


class EnvLoaderTests(unittest.TestCase):
    def test_env_flag_parses_common_truthy_values(self) -> None:
        with mock.patch.dict(os.environ, {"ALLOW_LIVE_SYSTEM_COMMANDS": "true"}, clear=False):
            self.assertTrue(env_flag("ALLOW_LIVE_SYSTEM_COMMANDS", False))
        with mock.patch.dict(os.environ, {"ALLOW_LIVE_SYSTEM_COMMANDS": "1"}, clear=False):
            self.assertTrue(env_flag("ALLOW_LIVE_SYSTEM_COMMANDS", False))
        with mock.patch.dict(os.environ, {"ALLOW_LIVE_SYSTEM_COMMANDS": "false"}, clear=False):
            self.assertFalse(env_flag("ALLOW_LIVE_SYSTEM_COMMANDS", True))

    def test_reload_panel_env_updates_os_environ(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / ".env"
            env_file.write_text("ALLOW_LIVE_SYSTEM_COMMANDS=false\n", encoding="utf-8")
            with mock.patch("app.env_loader.panel_env_path", return_value=env_file):
                with mock.patch.dict(os.environ, {}, clear=True):
                    path = reload_panel_env()
                    self.assertEqual(path, env_file)
                    self.assertEqual(os.environ.get("ALLOW_LIVE_SYSTEM_COMMANDS"), "false")

                    env_file.write_text("ALLOW_LIVE_SYSTEM_COMMANDS=true\n", encoding="utf-8")
                    reload_panel_env()
                    self.assertEqual(os.environ.get("ALLOW_LIVE_SYSTEM_COMMANDS"), "true")

    def test_panel_env_path_prefers_existing_file(self) -> None:
        resolved = panel_env_path()
        if resolved is None:
            self.skipTest("no panel .env in this checkout")
        self.assertTrue(resolved.is_file())


if __name__ == "__main__":
    unittest.main()
