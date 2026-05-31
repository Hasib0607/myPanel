import tempfile
import unittest
from pathlib import Path

from app.deployment_env import (
    format_dotenv_line,
    is_laravel_artisan_command,
    normalize_process_env,
    prepare_supervisor_runtime,
    write_env_file,
)


class DeploymentEnvTests(unittest.TestCase):
    def test_format_dotenv_line_quotes_special_characters(self) -> None:
        line = format_dotenv_line("APP_KEY", 'base64:"secret%value"')
        self.assertEqual(line, 'APP_KEY="base64:\\"secret%value\\""')

    def test_format_dotenv_line_keeps_simple_values_unquoted(self) -> None:
        self.assertEqual(format_dotenv_line("APP_ENV", "production"), "APP_ENV=production")

    def test_normalize_process_env_includes_port(self) -> None:
        env = normalize_process_env(10002, {"APP_ENV": "production"})
        self.assertEqual(env["PORT"], "10002")
        self.assertEqual(env["APP_ENV"], "production")

    def test_prepare_supervisor_runtime_writes_wrapper_and_laravel_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wrapper, runtime_env, laravel_env = prepare_supervisor_runtime(
                str(root),
                ["php", "artisan", "serve", "--host=127.0.0.1", "--port", "10002"],
                10002,
                {"APP_KEY": 'base64:"x%y"', "DB_PASSWORD": "pa\"ss"},
            )
            self.assertTrue(wrapper.is_file())
            self.assertTrue(runtime_env.is_file())
            self.assertEqual(laravel_env.resolve(), (root / ".env").resolve())
            self.assertTrue(laravel_env.is_file())
            wrapper_text = wrapper.read_text(encoding="utf-8")
            self.assertIn("source", wrapper_text)
            self.assertIn("exec php artisan serve", wrapper_text)
            self.assertNotIn("environment=", wrapper_text)

    def test_write_env_file_supports_percent_and_quotes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_path = Path(tmp) / "runtime.env"
            write_env_file(env_path, {"SECRET": 'abc%"def', "PLAIN": "ok"})
            content = env_path.read_text(encoding="utf-8")
            self.assertIn('SECRET="abc%\\"def"', content)
            self.assertIn("PLAIN=ok", content)

    def test_is_laravel_artisan_command(self) -> None:
        self.assertTrue(is_laravel_artisan_command(["php", "artisan", "serve"]))
        self.assertFalse(is_laravel_artisan_command(["node", "server.js"]))


if __name__ == "__main__":
    unittest.main()
