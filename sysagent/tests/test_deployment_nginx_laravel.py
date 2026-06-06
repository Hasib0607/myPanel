import unittest

from app.laravel_nginx import nginx_app_locations, nginx_laravel_app_locations, nginx_upstream_proxy_locations


class DeploymentNginxLaravelTests(unittest.TestCase):
    def test_root_location_proxies_to_laravel_without_directory_try_files(self) -> None:
        block = nginx_laravel_app_locations(
            public_root="/var/www/deployments/example/public",
            upstream_port=10002,
            fallback_error_page="",
            fallback_location="",
        )
        self.assertIn("    location / {\n        proxy_http_version 1.1;", block)
        self.assertIn("proxy_pass http://127.0.0.1:10002;", block)
        self.assertNotIn("    location / {\n        try_files $uri @deployment_upstream;", block)
        self.assertNotIn("try_files $uri $uri/", block)

    def test_legacy_public_prefixed_assets_map_to_laravel_public_root(self) -> None:
        block = nginx_laravel_app_locations(
            public_root="/var/www/deployments/example/public",
            upstream_port=10002,
            fallback_error_page="",
            fallback_location="",
        )
        self.assertIn("location ~* ^/public/", block)
        self.assertIn("alias /var/www/deployments/example/public/$1;", block)

    def test_static_asset_miss_falls_back_to_laravel_upstream(self) -> None:
        block = nginx_laravel_app_locations(
            public_root="/var/www/deployments/example/public",
            upstream_port=10002,
            fallback_error_page="",
            fallback_location="",
        )
        self.assertIn(
            "location ~* \\.(?:css|js|mjs|map|ico|gif|jpe?g|png|svg|webp|woff2?|ttf|eot|otf)$ {\n"
            "        try_files $uri @deployment_upstream;",
            block,
        )

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

    def test_nodejs_vite_preview_uses_loopback_host_header(self) -> None:
        block = nginx_app_locations(
            framework="NODEJS",
            public_root="/var/www/deployments/example/public",
            upstream_port=10005,
            fallback_error_page="",
            fallback_location="",
            loopback_proxy_host=True,
        )
        self.assertIn("proxy_set_header Host 127.0.0.1:10005;", block)

    def test_upstream_proxy_location(self) -> None:
        block = nginx_upstream_proxy_locations(10005)
        self.assertIn("location / {", block)
        self.assertIn("proxy_pass http://127.0.0.1:10005;", block)


if __name__ == "__main__":
    unittest.main()
