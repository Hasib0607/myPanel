import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.laravel_nginx import nginx_app_locations


class NginxAppLocationTests(unittest.TestCase):
    def test_python_proxy_does_not_force_websocket_upgrade(self) -> None:
        config = nginx_app_locations(
            deployment_id="python-app",
            framework="PYTHON",
            public_root="/var/www/app/public",
            upstream_port=10011,
            fallback_error_page="",
            fallback_location="",
        )

        self.assertIn("proxy_pass http://127.0.0.1:10011;", config)
        self.assertIn('proxy_set_header Connection "";', config)
        self.assertNotIn('proxy_set_header Connection "upgrade";', config)

    def test_node_proxy_keeps_websocket_upgrade_headers(self) -> None:
        config = nginx_app_locations(
            deployment_id="node-app",
            framework="NODEJS",
            public_root="/var/www/app/public",
            upstream_port=10012,
            fallback_error_page="",
            fallback_location="",
        )

        self.assertIn("proxy_set_header Upgrade $http_upgrade;", config)
        self.assertIn('proxy_set_header Connection "upgrade";', config)


if __name__ == "__main__":
    unittest.main()
