import tempfile
import unittest
from pathlib import Path

from app.deployment_commands import (
    deployment_path_allowed,
    is_allowed_deploy_executable,
    laravel_has_public_web_root,
    laravel_public_permission_commands,
    normalize_laravel_start_command,
    parse_deployment_command,
    resolve_laravel_public_root,
)


class DeploymentCommandTests(unittest.TestCase):
    def test_allows_php_artisan_serve(self) -> None:
        parsed = parse_deployment_command("php artisan serve --host=127.0.0.1 --port 12001")
        self.assertEqual(parsed[:3], ["php", "artisan", "serve"])

    def test_allows_versioned_php_fpm_executable(self) -> None:
        self.assertTrue(is_allowed_deploy_executable("php8.2-fpm"))

    def test_allows_backend_only_idle_command(self) -> None:
        self.assertEqual(parse_deployment_command("sleep infinity"), ["sleep", "infinity"])

    def test_normalizes_legacy_php_fpm_start_command(self) -> None:
        normalized = normalize_laravel_start_command("php-fpm", 12001)
        self.assertEqual(normalized, "php artisan serve --host=127.0.0.1 --port 12001")

    def test_normalizes_versioned_php_fpm_start_command(self) -> None:
        normalized = normalize_laravel_start_command("php8.2-fpm", 12001)
        self.assertEqual(normalized, "php artisan serve --host=127.0.0.1 --port 12001")

    def test_keeps_custom_laravel_start_command(self) -> None:
        normalized = normalize_laravel_start_command("php artisan serve --host=127.0.0.1 --port {PORT}", 12001)
        self.assertEqual(normalized, "php artisan serve --host=127.0.0.1 --port 12001")

    def test_backend_only_laravel_without_public_uses_idle_process(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "artisan").write_text("#!/usr/bin/env php\n", encoding="utf-8")
            self.assertFalse(laravel_has_public_web_root(str(root)))
            normalized = normalize_laravel_start_command("php artisan serve --host=127.0.0.1 --port {PORT}", 12001, str(root))
            self.assertEqual(normalized, "sleep infinity")

    def test_laravel_with_public_index_keeps_artisan_serve(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            public = root / "public"
            public.mkdir()
            (public / "index.php").write_text("<?php\n", encoding="utf-8")
            self.assertTrue(laravel_has_public_web_root(str(root)))
            normalized = normalize_laravel_start_command("php artisan serve --host=127.0.0.1 --port {PORT}", 12001, str(root))
            self.assertEqual(normalized, "php artisan serve --host=127.0.0.1 --port 12001")

    def test_deployment_path_allowed_under_file_manager_root(self) -> None:
        self.assertTrue(deployment_path_allowed("/var/www/deployments/example-app", "/var/www"))

    def test_resolve_laravel_public_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            public = root / "public"
            public.mkdir()
            (public / "css").mkdir()
            self.assertEqual(Path(resolve_laravel_public_root(str(root), "public")).resolve(), public.resolve())

    def test_laravel_public_permissions_allow_nginx_read_and_root_traversal(self) -> None:
        root = str(Path("/srv/deployments/example").resolve())
        public_command, root_command = laravel_public_permission_commands(root)
        self.assertEqual(public_command, ["chmod", "-R", "a+rX", f"{root}/public"])
        self.assertEqual(root_command, ["chmod", "o+x", root])


if __name__ == "__main__":
    unittest.main()
