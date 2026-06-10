import unittest
from unittest import mock

from app.laravel_fpm import render_laravel_fpm_pool


class LaravelFpmTests(unittest.TestCase):
    @mock.patch("app.laravel_fpm.nginx_runtime_user", return_value="nginx")
    def test_pool_is_isolated_and_bounded(self, _runtime_user: mock.Mock) -> None:
        config = render_laravel_fpm_pool(
            "deployment-123",
            "/var/www/accounts/example/deployments/app",
            memory_limit_mb=512,
            max_children=20,
        )

        self.assertIn("[vps-panel-deployment-123]", config)
        self.assertIn("listen = /run/php-fpm/vps-panel-deployment-123.sock", config)
        self.assertIn("user = panel", config)
        self.assertIn("pm.max_children = 20", config)
        self.assertIn("pm.max_requests = 500", config)
        self.assertIn("php_admin_value[memory_limit] = 512M", config)
        self.assertIn("request_slowlog_timeout = 5s", config)


if __name__ == "__main__":
    unittest.main()
