import tempfile
import sys
import types
import unittest
import stat
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
config.settings = types.SimpleNamespace(allow_live_nginx=False, file_manager_root="/tmp")
sys.modules.setdefault("app.config", config)

from app.nginx_manager import (
    _config_dump_conflict_files,
    _config_has_server_name,
    _enable_site,
    make_web_root_readable,
    remove_conflicting_configs,
)


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

    def test_make_web_root_readable_allows_nginx_parent_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            file_root = Path(tmp)
            config.settings.file_manager_root = str(file_root)
            web_root = file_root / "accounts" / "shop" / "public_html"
            web_root.mkdir(parents=True)
            for path in [file_root, file_root / "accounts", file_root / "accounts" / "shop", web_root]:
                path.chmod(0o700)

            result = make_web_root_readable(web_root)

            self.assertEqual(result["webRoot"], str(web_root.resolve()))
            self.assertTrue(web_root.stat().st_mode & stat.S_IROTH)
            for path in [file_root, file_root / "accounts", file_root / "accounts" / "shop", web_root]:
                self.assertTrue(path.stat().st_mode & stat.S_IXOTH)

    def test_enable_site_noops_when_available_and_enabled_are_same_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "domain-example.conf"
            content = "server { listen 80; server_name example.com; }\n"
            config_path.write_text(content, encoding="utf-8")

            _enable_site(config_path, config_path)

            self.assertTrue(config_path.is_file())
            self.assertFalse(config_path.is_symlink())
            self.assertEqual(config_path.read_text(encoding="utf-8"), content)

    def test_config_dump_conflict_files_tracks_nginx_t_sources(self) -> None:
        dump = """
# configuration file /etc/nginx/nginx.conf:
http {
    include /etc/nginx/conf.d/*.conf;
}
# configuration file /etc/nginx/conf.d/default.conf:
server { listen 80; server_name rettrovibes.shop; }
# configuration file /etc/nginx/conf.d/domain-rettrovibes.shop.conf:
server { listen 80; server_name rettrovibes.shop www.rettrovibes.shop; }
"""

        files = _config_dump_conflict_files(dump, "rettrovibes.shop www.rettrovibes.shop", "domain-rettrovibes.shop.conf")

        self.assertEqual(files, ["/etc/nginx/conf.d/default.conf"])

    def test_config_dump_conflict_files_handles_multiline_server_name(self) -> None:
        dump = """
# configuration file /etc/nginx/conf.d/legacy.conf:
server {
    listen 80;
    server_name
        rettrovibes.shop
        www.rettrovibes.shop;
}
# configuration file /etc/nginx/conf.d/domain-rettrovibes.shop.conf:
server { listen 80; server_name rettrovibes.shop www.rettrovibes.shop; }
"""

        files = _config_dump_conflict_files(dump, "rettrovibes.shop www.rettrovibes.shop", "domain-rettrovibes.shop.conf")

        self.assertEqual(files, ["/etc/nginx/conf.d/legacy.conf"])


if __name__ == "__main__":
    unittest.main()
