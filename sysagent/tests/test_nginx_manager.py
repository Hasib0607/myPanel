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
fastapi.APIRouter = lambda *args, **kwargs: types.SimpleNamespace(
    get=lambda *route_args, **route_kwargs: (lambda fn: fn),
    post=lambda *route_args, **route_kwargs: (lambda fn: fn),
    patch=lambda *route_args, **route_kwargs: (lambda fn: fn),
    delete=lambda *route_args, **route_kwargs: (lambda fn: fn),
)
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
    _normalize_conflict_path,
    _nginx_include_text_loads_directory,
    acme_location,
    certificate_name_for_server_name,
    certificate_names_cover_server_name,
    make_web_root_readable,
    nginx_listen_directives,
    probe_host_for_server_name,
    remove_conflicting_configs,
    route_ownership_config_seen,
    route_ownership_header,
    route_ownership_header_seen,
    server_name_has_wildcard,
)
import app.nginx_manager as nginx_manager


class NginxManagerTests(unittest.TestCase):
    def test_route_ownership_header_uses_managed_config_name(self) -> None:
        self.assertEqual(
            route_ownership_header("domain-a8.ecommercex.store"),
            '    add_header X-VPS-Panel-Route "domain-a8.ecommercex.store" always;\n',
        )

    def test_route_ownership_header_rejects_protected_panel_config(self) -> None:
        with self.assertRaises(HTTPException):
            route_ownership_header("panel")

    def test_route_ownership_header_seen_accepts_http2_lowercase_headers(self) -> None:
        output = "HTTP/2 200\r\nx-vps-panel-route: domain-nextsoftpremium.com\r\n"

        self.assertTrue(route_ownership_header_seen(output, "domain-nextsoftpremium.com"))

    def test_listen_directives_keep_dry_run_config_deterministic(self) -> None:
        self.assertEqual(nginx_listen_directives(443, ssl=True, http2=True), "    listen 443 ssl http2;\n")

    def test_listen_directives_do_not_mix_wildcard_and_ip_listeners_in_live_mode(self) -> None:
        previous_allow_live = nginx_manager.settings.allow_live_nginx
        previous_vps_ip = getattr(nginx_manager.settings, "vps_ip", "")
        previous_run_command = nginx_manager.run_command
        try:
            nginx_manager.settings.allow_live_nginx = True
            nginx_manager.settings.vps_ip = ""
            nginx_manager.run_command = lambda *args, **kwargs: {
                "returncode": 0,
                "stdout": "127.0.0.1 72.60.235.117\n",
                "stderr": "",
            }

            self.assertEqual(
                nginx_listen_directives(443, ssl=True, http2=True),
                "    listen 443 ssl http2;\n",
            )
        finally:
            nginx_manager.settings.allow_live_nginx = previous_allow_live
            nginx_manager.settings.vps_ip = previous_vps_ip
            nginx_manager.run_command = previous_run_command

    def test_listen_directives_ignore_configured_public_ip_to_keep_sni_table_shared(self) -> None:
        previous_allow_live = nginx_manager.settings.allow_live_nginx
        previous_vps_ip = getattr(nginx_manager.settings, "vps_ip", "")
        previous_run_command = nginx_manager.run_command
        try:
            nginx_manager.settings.allow_live_nginx = True
            nginx_manager.settings.vps_ip = "72.60.235.117"
            nginx_manager.run_command = lambda *args, **kwargs: {
                "returncode": 0,
                "stdout": "10.0.0.5 127.0.0.1\n",
                "stderr": "",
            }

            self.assertEqual(
                nginx_listen_directives(443, ssl=True, http2=True),
                "    listen 443 ssl http2;\n",
            )
        finally:
            nginx_manager.settings.allow_live_nginx = previous_allow_live
            nginx_manager.settings.vps_ip = previous_vps_ip
            nginx_manager.run_command = previous_run_command

    def test_route_ownership_config_seen_accepts_mixed_case_nginx_dump(self) -> None:
        output = 'add_header X-VPS-Panel-Route "deployment-wildcard.ebitan.store" always;'

        self.assertTrue(route_ownership_config_seen(output, "deployment-wildcard.ebitan.store"))

    def test_probe_host_for_wildcard_server_name_uses_real_child_host(self) -> None:
        self.assertEqual(
            probe_host_for_server_name("*.ebitans.store"),
            "vps-panel-wildcard-probe.ebitans.store",
        )
        self.assertEqual(probe_host_for_server_name("shop.ebitans.store"), "shop.ebitans.store")

    def test_certificate_name_for_wildcard_server_name_uses_certbot_name(self) -> None:
        self.assertEqual(certificate_name_for_server_name("*.ebitan.store"), "wildcard.ebitan.store")
        self.assertEqual(certificate_name_for_server_name("shop.ebitan.store"), "shop.ebitan.store")

    def test_certificate_names_cover_all_server_name_tokens(self) -> None:
        self.assertTrue(
            certificate_names_cover_server_name(
                "example.com www.example.com",
                ["example.com", "www.example.com"],
            )
        )
        self.assertFalse(
            certificate_names_cover_server_name(
                "example.com www.example.com",
                ["example.com"],
            )
        )
        self.assertTrue(
            certificate_names_cover_server_name(
                "shop.example.com",
                ["*.example.com"],
            )
        )
        self.assertFalse(
            certificate_names_cover_server_name(
                "deep.shop.example.com",
                ["*.example.com"],
            )
        )

    def test_server_name_has_wildcard_detects_any_token(self) -> None:
        self.assertTrue(server_name_has_wildcard("*.ebitans.store"))
        self.assertTrue(server_name_has_wildcard("shop.ebitans.store *.ebitans.store"))
        self.assertFalse(server_name_has_wildcard("shop.ebitans.store www.shop.ebitans.store"))

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

    def test_exact_domain_keeps_parent_wildcard_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stale = root / "stale-wildcard.conf"
            own = root / "domain-store.ebitans.store.conf"
            stale.write_text("server { listen 80; server_name *.ebitans.store; }\n", encoding="utf-8")
            own.write_text("server { listen 80; server_name store.ebitans.store; }\n", encoding="utf-8")

            removed = remove_conflicting_configs("domain-store.ebitans.store", "store.ebitans.store", tmp)

            self.assertEqual(removed, [])
            self.assertTrue(stale.exists())
            self.assertTrue(own.exists())

    def test_wildcard_domain_removes_exact_child_shadow_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stale = root / "domain-fahpet.ebitan.store.conf"
            own = root / "deployment-wildcard.ebitan.store.conf"
            stale.write_text("server { listen 443 ssl; server_name fahpet.ebitan.store; }\n", encoding="utf-8")
            own.write_text("server { listen 443 ssl; server_name *.ebitan.store; }\n", encoding="utf-8")

            removed = remove_conflicting_configs("deployment-wildcard.ebitan.store", "*.ebitan.store", tmp)

            self.assertEqual(removed, ["domain-fahpet.ebitan.store.conf"])
            self.assertFalse(stale.exists())
            self.assertTrue(own.exists())

    def test_wildcard_domain_keeps_apex_and_deep_child_configs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            apex = root / "domain-ebitan.store.conf"
            deep_child = root / "domain-deep.fahpet.ebitan.store.conf"
            own = root / "deployment-wildcard.ebitan.store.conf"
            apex.write_text("server { listen 443 ssl; server_name ebitan.store; }\n", encoding="utf-8")
            deep_child.write_text(
                "server { listen 443 ssl; server_name deep.fahpet.ebitan.store; }\n",
                encoding="utf-8",
            )
            own.write_text("server { listen 443 ssl; server_name *.ebitan.store; }\n", encoding="utf-8")

            removed = remove_conflicting_configs("deployment-wildcard.ebitan.store", "*.ebitan.store", tmp)

            self.assertEqual(removed, [])
            self.assertTrue(apex.exists())
            self.assertTrue(deep_child.exists())
            self.assertTrue(own.exists())

    def test_removes_default_config_when_it_claims_requested_domain(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stale = root / "default.conf"
            own = root / "domain-rettrovibes.shop.conf"
            stale.write_text("server { listen 80; server_name rettrovibes.shop www.rettrovibes.shop; }\n", encoding="utf-8")
            own.write_text("server { listen 80; server_name rettrovibes.shop www.rettrovibes.shop; }\n", encoding="utf-8")

            removed = remove_conflicting_configs("domain-rettrovibes.shop", "rettrovibes.shop www.rettrovibes.shop", tmp)

            self.assertEqual(removed, ["default.conf"])
            self.assertFalse(stale.exists())
            self.assertTrue(own.exists())

    def test_removes_same_filename_conflict_outside_own_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            conf_d = root / "conf.d"
            sites_enabled = root / "sites-enabled"
            conf_d.mkdir()
            sites_enabled.mkdir()
            stale = conf_d / "domain-empirepointbd.shop.conf"
            own = sites_enabled / "domain-empirepointbd.shop.conf"
            stale.write_text("server { listen 80; server_name empirepointbd.shop www.empirepointbd.shop; root /old; }\n", encoding="utf-8")
            own.write_text("server { listen 80; server_name empirepointbd.shop www.empirepointbd.shop; root /new; }\n", encoding="utf-8")

            removed = remove_conflicting_configs(
                "domain-empirepointbd.shop",
                "empirepointbd.shop www.empirepointbd.shop",
                str(conf_d),
                str(sites_enabled),
                own_paths={_normalize_conflict_path(own)},
            )

            self.assertEqual(removed, ["domain-empirepointbd.shop.conf"])
            self.assertFalse(stale.exists())
            self.assertTrue(own.exists())

    def test_removes_stale_vps_panel_named_domain_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stale = root / "vps-panel-acme-rettrovibes.shop.conf"
            protected = root / "vps-panel.conf"
            own = root / "domain-rettrovibes.shop.conf"
            stale.write_text("server { listen 80; server_name rettrovibes.shop www.rettrovibes.shop; }\n", encoding="utf-8")
            protected.write_text("server { listen 80; server_name rettrovibes.shop; }\n", encoding="utf-8")
            own.write_text("server { listen 80; server_name rettrovibes.shop www.rettrovibes.shop; }\n", encoding="utf-8")

            removed = remove_conflicting_configs("domain-rettrovibes.shop", "rettrovibes.shop www.rettrovibes.shop", tmp)

            self.assertEqual(removed, ["vps-panel-acme-rettrovibes.shop.conf"])
            self.assertFalse(stale.exists())
            self.assertTrue(protected.exists())
            self.assertTrue(own.exists())

    def test_parent_wildcard_does_not_claim_apex_domain(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "wildcard.conf"
            config.write_text("server { listen 80; server_name *.ebitans.store; }\n", encoding="utf-8")

            self.assertFalse(_config_has_server_name(config, "ebitans.store"))

    def test_acme_location_uses_webroot_mapping(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            file_root = Path(tmp)
            config.settings.file_manager_root = str(file_root)
            web_root = file_root / "accounts" / "shop" / "public_html"
            web_root.mkdir(parents=True)

            location = acme_location("shop.test", web_root)

            self.assertIn(f"root {web_root.resolve()};", location)
            self.assertIn("try_files $uri =404;", location)
            self.assertNotIn("alias", location)

    def test_similar_wildcard_domains_do_not_conflict(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sibling = root / "domain-wildcard.ebitans.store.conf"
            own = root / "domain-wildcard.ebitan.store.conf"
            sibling.write_text("server { listen 443 ssl; server_name *.ebitans.store; }\n", encoding="utf-8")
            own.write_text("server { listen 443 ssl; server_name *.ebitan.store; }\n", encoding="utf-8")

            removed = remove_conflicting_configs("domain-wildcard.ebitan.store", "*.ebitan.store", tmp)

            self.assertEqual(removed, [])
            self.assertTrue(sibling.exists())
            self.assertTrue(own.exists())
            self.assertFalse(_config_has_server_name(sibling, "*.ebitan.store"))
            self.assertFalse(_config_has_server_name(own, "*.ebitans.store"))

    def test_parent_wildcard_does_not_conflict_with_child_labels(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "wildcard.conf"
            config.write_text("server { listen 80; server_name *.ebitans.store; }\n", encoding="utf-8")

            self.assertFalse(_config_has_server_name(config, "shop.ebitans.store"))
            self.assertFalse(_config_has_server_name(config, "deep.shop.ebitans.store"))

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

    def test_nginx_include_text_detects_loaded_site_directories(self) -> None:
        text = """
http {
    include /etc/nginx/sites-available/*.conf;
    include /etc/nginx/sites-enabled/*.conf;
}
"""

        self.assertTrue(_nginx_include_text_loads_directory(text, Path("/etc/nginx/sites-available")))
        self.assertTrue(_nginx_include_text_loads_directory(text, Path("/etc/nginx/sites-enabled")))
        self.assertFalse(_nginx_include_text_loads_directory(text, Path("/etc/nginx/conf.d")))


if __name__ == "__main__":
    unittest.main()
