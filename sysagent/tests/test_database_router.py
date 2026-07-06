import sys
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_fastapi_module = types.ModuleType("fastapi")


class _RouterStub:
    def get(self, *_args, **_kwargs):
        return lambda function: function

    def post(self, *_args, **_kwargs):
        return lambda function: function

    def delete(self, *_args, **_kwargs):
        return lambda function: function

    def patch(self, *_args, **_kwargs):
        return lambda function: function


_fastapi_module.APIRouter = _RouterStub
sys.modules.setdefault("fastapi", _fastapi_module)

# Stub config dependency so command.py can import without pydantic-settings installed.
_config_module = types.ModuleType("app.config")
_settings = types.SimpleNamespace(
    allow_live_system_commands=False,
    deployment_command_timeout_seconds=900,
)
_config_module.settings = _settings
_config_module.DEPLOYMENT_COMMANDS_LIVE = True
sys.modules.setdefault("app.config", _config_module)

from app.routers.database import provision_postgres  # noqa: E402


class PostgresProvisionTests(unittest.TestCase):
    def test_creates_database_without_psql_gexec_meta_command(self) -> None:
        with mock.patch("app.routers.database.run_command") as run_command:
            run_command.side_effect = [
                {"command": [], "stdout": "", "stderr": "", "returncode": 0},
                {"command": [], "stdout": "", "stderr": "", "returncode": 0},
                {"command": [], "stdout": "CREATE DATABASE", "stderr": "", "returncode": 0},
                {"command": [], "stdout": "GRANT", "stderr": "", "returncode": 0},
            ]

            result = provision_postgres("ecommercex_me", "ecommercex_me", "secret-password")

        self.assertEqual(result["database"]["returncode"], 0)
        commands = [" ".join(call.args[0]) for call in run_command.call_args_list]
        self.assertTrue(any('CREATE DATABASE "ecommercex_me" OWNER "ecommercex_me";' in command for command in commands))
        self.assertFalse(any("\\gexec" in command for command in commands))

    def test_skips_create_when_database_already_exists(self) -> None:
        with mock.patch("app.routers.database.run_command") as run_command:
            run_command.side_effect = [
                {"command": [], "stdout": "", "stderr": "", "returncode": 0},
                {"command": [], "stdout": "1\n", "stderr": "", "returncode": 0},
                {"command": [], "stdout": "GRANT", "stderr": "", "returncode": 0},
            ]

            result = provision_postgres("ecommercex_me", "ecommercex_me", "secret-password")

        self.assertEqual(result["database"]["stdout"], "database already exists")
        commands = [" ".join(call.args[0]) for call in run_command.call_args_list]
        self.assertFalse(any("CREATE DATABASE" in command for command in commands))


if __name__ == "__main__":
    unittest.main()
