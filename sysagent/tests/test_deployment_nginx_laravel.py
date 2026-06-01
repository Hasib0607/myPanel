import unittest

from app.laravel_nginx import nginx_app_locations, nginx_laravel_app_locations, nginx_upstream_proxy_locations


class DeploymentNginxLaravelTests(unittest.TestCase):
    def test_root_location_does_not_use_directory_try_files(self) -> None:
        block = nginx_laravel_app_locations(
            public_root="/var/www/deployments/example/public",
            upstream_port=10002,
            fallback_error_page="",
            fallback_location="",
        )
        self.assertIn("    location / {\n        try_files $uri @deployment_upstream;", block)
        self.assertNotIn("try_files $uri $uri/", block)

    def test_nodejs_uses_upstream_proxy_only(self) -> None:
        block = nginx_app_locations(
            framework="NODEJS",
            public_root="/var/www/deployments/example/public",
            upstream_port=10005,
            fallback_error_page="",
            fallback_location="",
        )
        self.assertIn("proxy_pass http://127.0.0.1:10005;", block)
        self.assertNotIn("try_files $uri @deployment_upstream", block)

    def test_upstream_proxy_location(self) -> None:
        block = nginx_upstream_proxy_locations(10005)
        self.assertIn("location / {", block)
        self.assertIn("proxy_pass http://127.0.0.1:10005;", block)


if __name__ == "__main__":
    unittest.main()
