import unittest

from app.laravel_nginx import nginx_laravel_app_locations


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


if __name__ == "__main__":
    unittest.main()
