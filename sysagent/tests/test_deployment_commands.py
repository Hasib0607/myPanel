import unittest

from app.deployment_commands import (
    deployment_path_allowed,
    is_allowed_deploy_executable,
    normalize_laravel_start_command,
    parse_deployment_command,
)


class DeploymentCommandTests(unittest.TestCase):
    def test_allows_php_artisan_serve(self) -> None:
        parsed = parse_deployment_command("php artisan serve --host=127.0.0.1 --port 12001")
        self.assertEqual(parsed[:3], ["php", "artisan", "serve"])

    def test_allows_versioned_php_fpm_executable(self) -> None:
        self.assertTrue(is_allowed_deploy_executable("php8.2-fpm"))

    def test_normalizes_legacy_php_fpm_start_command(self) -> None:
        normalized = normalize_laravel_start_command("php-fpm", 12001)
        self.assertEqual(normalized, "php artisan serve --host=127.0.0.1 --port 12001")

    def test_normalizes_versioned_php_fpm_start_command(self) -> None:
        normalized = normalize_laravel_start_command("php8.2-fpm", 12001)
        self.assertEqual(normalized, "php artisan serve --host=127.0.0.1 --port 12001")

    def test_keeps_custom_laravel_start_command(self) -> None:
        normalized = normalize_laravel_start_command("php artisan serve --host=127.0.0.1 --port {PORT}", 12001)
        self.assertEqual(normalized, "php artisan serve --host=127.0.0.1 --port 12001")

    def test_deployment_path_allowed_under_file_manager_root(self) -> None:
        self.assertTrue(deployment_path_allowed("/var/www/deployments/example-app", "/var/www"))


if __name__ == "__main__":
    unittest.main()
