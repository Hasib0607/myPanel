import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from app.config import settings
from app.routers import ssl as ssl_router
from app.routers.ssl import CertificateRequest, DnsCertificateRequest, certificate_names_cover, certbot_should_include_www, dns_hook_script


class CertbotIncludeWwwTests(unittest.TestCase):
    def test_apex_includes_www_when_requested(self) -> None:
        self.assertTrue(certbot_should_include_www("priceinbd.store", True))

    def test_subdomain_never_includes_www(self) -> None:
        self.assertFalse(certbot_should_include_www("admin.priceinbd.store", True))
        self.assertFalse(certbot_should_include_www("admin.priceinbd.store", False))

    def test_http_issue_expands_existing_certificate_for_www(self) -> None:
        captured = {}

        def fake_run_command(command, **kwargs):
            captured["command"] = command
            return {"dryRun": False, "command": command, "stdout": "", "stderr": "", "returncode": 0}

        with TemporaryDirectory() as tmp, \
             patch.object(ssl_router, "ensure_acme_webroot"), \
             patch.object(ssl_router, "safe_web_root", return_value=Path(tmp)), \
             patch.object(ssl_router, "run_command", side_effect=fake_run_command):
            ssl_router.issue_certificate(CertificateRequest(
                domain="ebitans.com",
                email="admin@ebitans.com",
                webRoot=tmp,
                includeWww=True,
                certName="ebitans.com",
            ))

        self.assertIn("www.ebitans.com", captured["command"])
        self.assertIn("--expand", captured["command"])

    def test_dns_issue_uses_ssl_certbot_timeout(self) -> None:
        captured = {}

        def fake_run_command(command, **kwargs):
            captured["command"] = command
            captured["kwargs"] = kwargs
            return {"dryRun": False, "command": command, "stdout": "", "stderr": "", "returncode": 0}

        with TemporaryDirectory() as tmp:
            zone_path = Path(tmp) / "db.alfena.shop"
            zone_path.write_text("$TTL 60\n@ IN SOA ns1.alfena.shop. admin.alfena.shop. (2026060501 3600 900 604800 60)\n", encoding="utf-8")
            with patch.object(ssl_router, "effective_dns_paths", return_value=(Path(tmp), Path(tmp) / "named.conf.local", Path(tmp) / "named.conf.options")), \
                 patch.object(ssl_router, "run_command", side_effect=fake_run_command):
                ssl_router.issue_dns_certificate(DnsCertificateRequest(
                    domain="alfena.shop",
                    parentDomain="alfena.shop",
                    email="admin@alfena.shop",
                    certName="alfena.shop",
                    zoneDir=tmp,
                ))

        self.assertEqual(captured["kwargs"]["timeout"], settings.ssl_certbot_timeout_seconds)
        self.assertIn("--preferred-challenges", captured["command"])

    def test_dns_hook_script_compiles(self) -> None:
        script = dns_hook_script(
            Path("/var/named/db.alfena.shop"),
            Path("/var/named"),
            Path("/etc/named.vps-panel.zones"),
            "alfena.shop",
            "auth",
            300,
        )

        compile(script, "certbot-dns-hook.py", "exec")

    def test_reusable_certificate_accepts_one_level_wildcard(self) -> None:
        self.assertTrue(certificate_names_cover("fahpet.ebitan.store", ["*.ebitan.store"]))
        self.assertTrue(certificate_names_cover("fahpet.ebitan.store", ["fahpet.ebitan.store"]))
        self.assertFalse(certificate_names_cover("deep.fahpet.ebitan.store", ["*.ebitan.store"]))
        self.assertFalse(certificate_names_cover("ebitan.store", ["*.ebitan.store"]))

    def test_reusable_certificate_rejects_matching_folder_with_wrong_san(self) -> None:
        with TemporaryDirectory() as tmp, \
             patch.object(ssl_router, "LETSENCRYPT_LIVE_DIR", Path(tmp)), \
             patch.object(ssl_router, "letsencrypt_certificate_exists", return_value=True), \
             patch.object(ssl_router, "certificate_expiry", return_value="2026-12-31T00:00:00+00:00"), \
             patch.object(ssl_router, "certificate_names", return_value=["other-site.test"]):
            cert_dir = Path(tmp) / "need4you.xyz"
            cert_dir.mkdir()

            result = ssl_router.certificate_reusable("need4you.xyz")

        self.assertFalse(result["exists"])
        self.assertEqual(result["candidates"], [])

    def test_reusable_certificate_accepts_duplicate_folder_when_san_matches(self) -> None:
        with TemporaryDirectory() as tmp, \
             patch.object(ssl_router, "LETSENCRYPT_LIVE_DIR", Path(tmp)), \
             patch.object(ssl_router, "letsencrypt_certificate_exists", return_value=True), \
             patch.object(ssl_router, "certificate_expiry", return_value="2026-12-31T00:00:00+00:00"), \
             patch.object(ssl_router, "certificate_names", return_value=["need4you.xyz"]):
            cert_dir = Path(tmp) / "need4you.xyz-0001"
            cert_dir.mkdir()

            result = ssl_router.certificate_reusable("need4you.xyz")

        self.assertTrue(result["exists"])
        self.assertEqual(result["domain"], "need4you.xyz-0001")
