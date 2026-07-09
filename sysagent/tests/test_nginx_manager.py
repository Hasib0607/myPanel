import tempfile
import sys
import types
import unittest
from pathlib import Path

fastapi = types.ModuleType("fastapi")


class HTTPException(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


fastapi.HTTPException = HTTPException
sys.modules.setdefault("fastapi", fastapi)

command = types.ModuleType("app.command")
command.run_command = lambda *args, **kwargs: {"returncode": 0, "stdout": "", "stderr": "", "dryRun": False}
sys.modules.setdefault("app.command", command)

config = types.ModuleType("app.config")
config.DEPLOYMENT_COMMANDS_LIVE = True
config.settings = types.SimpleNamespace(allow_live_nginx=False)
sys.modules.setdefault("app.config", config)

from app.nginx_manager import _config_has_server_name, remove_conflicting_configs


class NginxManagerTests(unittest.TestCase):
    def test_detects_wildcard_server_name_directive(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "wildcard.conf"
            config.write_text(
                """
server {
    listen 80;
    server_name *.ebitans.store;
}
""",
                encoding="utf-8",
            )

            self.assertTrue(_config_has_server_name(config, "*.ebitans.store"))
            self.assertFalse(_config_has_server_name(config, "ebitans.store"))

    def test_removes_conflicting_wildcard_server_name_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stale = root / "stale-wildcard.conf"
            own = root / "domain-wildcard.ebitans.store.conf"
            stale.write_text("server { listen 80; server_name *.ebitans.store; }\n", encoding="utf-8")
            own.write_text("server { listen 80; server_name *.ebitans.store; }\n", encoding="utf-8")

            removed = remove_conflicting_configs("domain-wildcard.ebitans.store", "*.ebitans.store", tmp)

            self.assertEqual(removed, ["stale-wildcard.conf"])
            self.assertFalse(stale.exists())
            self.assertTrue(own.exists())

    def test_exact_domain_removes_conflicting_parent_wildcard_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stale = root / "stale-wildcard.conf"
            own = root / "domain-store.ebitans.store.conf"
            stale.write_text("server { listen 80; server_name *.ebitans.store; }\n", encoding="utf-8")
            own.write_text("server { listen 80; server_name store.ebitans.store; }\n", encoding="utf-8")

            removed = remove_conflicting_configs("domain-store.ebitans.store", "store.ebitans.store", tmp)

            self.assertEqual(removed, ["stale-wildcard.conf"])
            self.assertFalse(stale.exists())
            self.assertTrue(own.exists())

    def test_parent_wildcard_does_not_claim_apex_domain(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "wildcard.conf"
            config.write_text("server { listen 80; server_name *.ebitans.store; }\n", encoding="utf-8")

            self.assertFalse(_config_has_server_name(config, "ebitans.store"))


if __name__ == "__main__":
    unittest.main()
