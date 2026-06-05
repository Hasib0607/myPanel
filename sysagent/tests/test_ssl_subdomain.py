import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from app.config import settings
from app.routers import ssl as ssl_router
from app.routers.ssl import DnsCertificateRequest, certbot_should_include_www


class CertbotIncludeWwwTests(unittest.TestCase):
    def test_apex_includes_www_when_requested(self) -> None:
        self.assertTrue(certbot_should_include_www("priceinbd.store", True))

    def test_subdomain_never_includes_www(self) -> None:
        self.assertFalse(certbot_should_include_www("admin.priceinbd.store", True))
        self.assertFalse(certbot_should_include_www("admin.priceinbd.store", False))

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
