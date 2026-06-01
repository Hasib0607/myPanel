import tempfile
import unittest
from pathlib import Path

from app.deployment_env import (
    format_dotenv_line,
    is_laravel_artisan_command,
    is_valid_laravel_app_key,
    normalize_database_charset_env,
    normalize_laravel_redis_env,
    normalize_process_env,
    prepare_laravel_env_for_sync,
    resolve_laravel_app_key,
    sync_laravel_env_file,
    write_env_file,
)

COMPLEX_APP_KEY = (
    '"[(##Akash@@{UuM.KgYpks@@WaveBox@Hasib@@018865Akash@@{UuM._sadsdjhasdh@@Akash@@0^0&95)**453'
    "|yi/x-D0t?icuMQ-V2+Uh|WaveBox@Hasib@unKown@0^07199%||@@)**453jashd-_ishd_jahdsh-_ashdj__hKgY^GpOwtwqrf6c40Fspks"
    "@@Wave[{(##Akash@@{UuM.KgYpks@yi/x-D0t?icuMQ-V2+Uh@WaveBox@Hasib@@01886515571@@15571@@unKown@@0^07199%016775"
    r"&^\\$*#^hsgadjhb*%#^*15579@supersecrate@@0^07199%hh\\$%^hh@@\\`~^*\\$#Hasib@@&^%^&%#^\\$%\\$%^\\$\\$&^&72937(*^\\$*#)9)l)ipQMO6.mo-m#CrazyS*^*x&&&SS%%55)}]"
)
VALID_APP_KEY = "base64:" + "A" * 43 + "="


class DeploymentEnvTests(unittest.TestCase):
    def test_is_valid_laravel_app_key(self) -> None:
        self.assertTrue(is_valid_laravel_app_key(VALID_APP_KEY))
        self.assertFalse(is_valid_laravel_app_key(COMPLEX_APP_KEY))
        self.assertFalse(is_valid_laravel_app_key(""))

    def test_normalize_laravel_redis_env_without_extension(self) -> None:
        env = normalize_laravel_redis_env(
            {
                "CACHE_DRIVER": "redis",
                "CACHE_STORE": "redis",
                "SESSION_DRIVER": "redis",
                "QUEUE_CONNECTION": "redis",
            },
            redis_loaded=False,
        )
        self.assertEqual(env["CACHE_DRIVER"], "file")
        self.assertEqual(env["CACHE_STORE"], "file")
        self.assertEqual(env["SESSION_DRIVER"], "file")
        self.assertEqual(env["QUEUE_CONNECTION"], "sync")

    def test_normalize_database_charset_env_for_postgres(self) -> None:
        env = normalize_database_charset_env(
            {"DB_CONNECTION": "pgsql", "DB_CHARSET": "utf8mb4", "DB_COLLATION": "utf8mb4_unicode_ci"}
        )
        self.assertEqual(env["DB_CHARSET"], "utf8")
        self.assertEqual(env["DB_COLLATION"], "")

    def test_prepare_laravel_env_for_sync_rejects_invalid_panel_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            process_env, needs_generate = prepare_laravel_env_for_sync(
                str(root),
                10002,
                {"APP_KEY": COMPLEX_APP_KEY, "APP_ENV": "production"},
            )
            self.assertNotIn("APP_KEY", process_env)
            self.assertTrue(needs_generate)

    def test_prepare_laravel_env_for_sync_preserves_valid_existing_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env_path = root / ".env"
            env_path.write_text(f"APP_KEY={VALID_APP_KEY}\n", encoding="utf-8")
            process_env, needs_generate = prepare_laravel_env_for_sync(str(root), 10002, {"APP_ENV": "production"})
            self.assertEqual(process_env["APP_KEY"], VALID_APP_KEY)
            self.assertFalse(needs_generate)

    def test_resolve_laravel_app_key_prefers_valid_panel_value(self) -> None:
        resolved = resolve_laravel_app_key({"APP_KEY": VALID_APP_KEY}, {"APP_KEY": "base64:" + "B" * 43 + "="})
        self.assertEqual(resolved, VALID_APP_KEY)

    def test_format_dotenv_line_uses_single_quotes_for_complex_secrets(self) -> None:
        line = format_dotenv_line("DB_PASSWORD", COMPLEX_APP_KEY)
        self.assertTrue(line.startswith("DB_PASSWORD='"))
        self.assertTrue(line.endswith("'"))

    def test_format_dotenv_line_keeps_base64_app_key_unquoted(self) -> None:
        self.assertEqual(format_dotenv_line("APP_KEY", VALID_APP_KEY), f"APP_KEY={VALID_APP_KEY}")

    def test_sync_skips_write_when_app_key_must_be_generated(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".env").write_text(f"APP_KEY={VALID_APP_KEY}\n", encoding="utf-8")
            env_path, app_key, needs_generate = sync_laravel_env_file(
                str(root),
                10002,
                {"APP_KEY": COMPLEX_APP_KEY, "APP_ENV": "production"},
            )
            self.assertFalse(needs_generate)
            self.assertEqual(app_key, VALID_APP_KEY)
            self.assertIn(f"APP_KEY={VALID_APP_KEY}", env_path.read_text(encoding="utf-8"))

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env_path, app_key, needs_generate = sync_laravel_env_file(
                str(root),
                10002,
                {"APP_KEY": COMPLEX_APP_KEY},
            )
            self.assertTrue(needs_generate)
            self.assertIsNone(app_key)
            self.assertFalse(env_path.exists())

    def test_sync_writes_runtime_env_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env_path, app_key, needs_generate = sync_laravel_env_file(
                str(root),
                10002,
                {"APP_KEY": VALID_APP_KEY, "APP_ENV": "production"},
            )
            runtime_env = root / ".panel" / "runtime.env"
            self.assertFalse(needs_generate)
            self.assertEqual(env_path.resolve(), (root / ".env").resolve())
            self.assertTrue(runtime_env.is_file())
            self.assertIn(f"APP_KEY={VALID_APP_KEY}", runtime_env.read_text(encoding="utf-8"))

    def test_prepare_supervisor_runtime_writes_wrapper_and_laravel_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            from app.deployment_env import prepare_supervisor_runtime

            wrapper, runtime_env, laravel_env = prepare_supervisor_runtime(
                str(root),
                ["php", "artisan", "serve", "--host=127.0.0.1", "--port", "10002"],
                10002,
                {"APP_KEY": VALID_APP_KEY},
            )
            self.assertTrue(wrapper.is_file())
            self.assertTrue(runtime_env.is_file())
            self.assertEqual(laravel_env.resolve(), (root / ".env").resolve())
            self.assertIn(f"APP_KEY={VALID_APP_KEY}", runtime_env.read_text(encoding="utf-8"))

    def test_is_laravel_artisan_command(self) -> None:
        self.assertTrue(is_laravel_artisan_command(["php", "artisan", "serve"]))
        self.assertFalse(is_laravel_artisan_command(["node", "server.js"]))


if __name__ == "__main__":
    unittest.main()
