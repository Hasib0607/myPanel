import unittest

from app.routers.ssl import certbot_should_include_www


class CertbotIncludeWwwTests(unittest.TestCase):
    def test_apex_includes_www_when_requested(self) -> None:
        self.assertTrue(certbot_should_include_www("priceinbd.store", True))

    def test_subdomain_never_includes_www(self) -> None:
        self.assertFalse(certbot_should_include_www("admin.priceinbd.store", True))
        self.assertFalse(certbot_should_include_www("admin.priceinbd.store", False))
