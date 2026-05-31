import tempfile
import unittest
from pathlib import Path

from app.deployment_env import (
    format_dotenv_line,
    is_laravel_artisan_command,
    normalize_process_env,
    prepare_supervisor_runtime,
    sync_laravel_env_file,
    write_env_file,
)

COMPLEX_APP_KEY = (
    '"[(##Akash@@{UuM.KgYpks@@WaveBox@Hasib@@018865Akash@@{UuM._sadsdjhasdh@@Akash@@0^0&95)**453'
    "|yi/x-D0t?icuMQ-V2+Uh|WaveBox@Hasib@unKown@0^07199%||@@)**453jashd-_ishd_jahdsh-_ashdj__hKgY^GpOwtwqrf6c40Fspks"
    "@@Wave[{(##Akash@@{UuM.KgYpks@yi/x-D0t?icuMQ-V2+Uh@WaveBox@Hasib@@01886515571@@15571@@unKown@@0^07199%016775"
    r"&^\\$*#^hsgadjhb*%#^*15579@supersecrate@@0^07199%hh\\$%^hh@@\\`~^*\\$#Hasib@@&^%^&%#^\\$%\\$%^\\$\\$&^&72937(*^\\$*#)9)l)ipQMO6.mo-m#CrazyS*^*x&&&SS%%55)}]"
)


class DeploymentEnvTests(unittest.TestCase):
    def test_format_dotenv_line_uses_single_quotes_for_complex_secrets(self) -> None:
        line = format_dotenv_line("APP_KEY", COMPLEX_APP_KEY)
        self.assertTrue(line.startswith("APP_KEY='"))
        self.assertTrue(line.endswith("'"))
        self.assertNotIn('\\"', line)

    def test_format_dotenv_line_quotes_values_with_hash_or_spaces(self) -> None:
        self.assertEqual(format_dotenv_line("APP_NAME", "My App"), "APP_NAME='My App'")
        self.assertEqual(format_dotenv_line("NOTE", "value#hash"), "NOTE='value#hash'")

    def test_format_dotenv_line_keeps_simple_values_unquoted(self) -> None:
        self.assertEqual(format_dotenv_line("APP_ENV", "production"), "APP_ENV=production")

    def test_format_dotenv_line_double_quotes_when_single_quotes_present(self) -> None:
        line = format_dotenv_line("MSG", "it's fine")
        self.assertEqual(line, 'MSG="it\'s fine"')

    def test_normalize_process_env_includes_port(self) -> None:
        env = normalize_process_env(10002, {"APP_ENV": "production"})
        self.assertEqual(env["PORT"], "10002")
        self.assertEqual(env["APP_ENV"], "production")

    def test_sync_laravel_env_file_writes_phpdotenv_safe_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env_path = sync_laravel_env_file(str(root), 10002, {"APP_KEY": COMPLEX_APP_KEY})
            content = env_path.read_text(encoding="utf-8")
            self.assertIn("APP_KEY='", content)
            self.assertNotIn('\\"', content)

    def test_prepare_supervisor_runtime_writes_wrapper_and_laravel_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            wrapper, runtime_env, laravel_env = prepare_supervisor_runtime(
                str(root),
                ["php", "artisan", "serve", "--host=127.0.0.1", "--port", "10002"],
                10002,
                {"APP_KEY": COMPLEX_APP_KEY},
            )
            self.assertTrue(wrapper.is_file())
            self.assertTrue(runtime_env.is_file())
            self.assertEqual(laravel_env.resolve(), (root / ".env").resolve())
            runtime_content = runtime_env.read_text(encoding="utf-8")
            self.assertIn("APP_KEY='", runtime_content)
            wrapper_text = wrapper.read_text(encoding="utf-8")
            self.assertIn("source", wrapper_text)
            self.assertIn("exec php artisan serve", wrapper_text)

    def test_write_env_file_supports_percent_and_quotes_without_bash_escapes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env_path = Path(tmp) / "runtime.env"
            write_env_file(env_path, {"SECRET": 'abc%"def', "PLAIN": "ok"})
            content = env_path.read_text(encoding="utf-8")
            self.assertIn("SECRET='abc%\"def'", content)
            self.assertIn("PLAIN=ok", content)

    def test_is_laravel_artisan_command(self) -> None:
        self.assertTrue(is_laravel_artisan_command(["php", "artisan", "serve"]))
        self.assertFalse(is_laravel_artisan_command(["node", "server.js"]))


if __name__ == "__main__":
    unittest.main()
