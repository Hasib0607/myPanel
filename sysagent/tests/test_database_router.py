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

from app.routers.database import DatabaseRowsRequest, mysql_row_select_list, preview_rows, provision_postgres, row_search_where, row_sort_order, selected_row_search_columns  # noqa: E402


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


class RowSearchColumnTests(unittest.TestCase):
    def test_uses_all_columns_when_column_filter_is_omitted(self) -> None:
        self.assertEqual(selected_row_search_columns(["id", "name", "description"], None), ["id", "name", "description"])

    def test_empty_column_filter_selects_no_columns(self) -> None:
        self.assertEqual(selected_row_search_columns(["id", "name", "description"], []), [])

    def test_keeps_only_existing_safe_column_filters(self) -> None:
        selected = selected_row_search_columns(["id", "name", "description"], ["name", "missing", "bad-name", "description"])

        self.assertEqual(selected, ["name", "description"])

    def test_postgres_row_preview_searches_selected_columns_only(self) -> None:
        with (
            mock.patch("app.routers.database.table_column_metadata", return_value=[
                {"name": "id", "type": "integer"},
                {"name": "name", "type": "text"},
                {"name": "description", "type": "text"},
            ]),
            mock.patch("app.routers.database.run_command") as run_command,
        ):
            run_command.return_value = {"command": [], "stdout": "id,name,description\n1,Pangabi,Lorem\n", "stderr": "", "returncode": 0}

            result = preview_rows(DatabaseRowsRequest(
                engine="POSTGRESQL",
                database="shop",
                table="products",
                search="pang",
                searchColumns=["name", "description"],
            ))

        command = run_command.call_args.args[0]
        sql = command[-1]
        self.assertEqual(result["searchColumns"], ["name", "description"])
        self.assertIn('"name"::text', sql)
        self.assertIn('"description"::text', sql)
        self.assertNotIn('"id"::text', sql)

    def test_selected_numeric_column_search_uses_like_on_that_column_only(self) -> None:
        where = row_search_where("MYSQL", [{"name": "store_id", "type": "bigint(20)"}], "14393")

        self.assertEqual(where, " WHERE CAST(`store_id` AS CHAR) LIKE '%14393%'")
        self.assertNotIn("customer_id", where)
        self.assertNotIn("uid", where)

    def test_row_sort_order_uses_only_existing_columns(self) -> None:
        self.assertEqual(row_sort_order("MYSQL", ["id", "name"], "name", "desc"), " ORDER BY `name` DESC")
        self.assertEqual(row_sort_order("POSTGRESQL", ["id", "name"], "id", "asc"), ' ORDER BY "id" ASC')
        self.assertEqual(row_sort_order("MYSQL", ["id", "name"], "missing", "desc"), "")

    def test_mysql_row_select_list_escapes_multiline_cells(self) -> None:
        select_list = mysql_row_select_list([
            {"name": "id", "type": "bigint(20)"},
            {"name": "description", "type": "longtext"},
        ])

        self.assertIn("REPLACE(REPLACE(REPLACE(CAST(`description` AS CHAR)", select_list)
        self.assertIn("CHAR(10), '\\\\n'", select_list)
        self.assertIn("AS `description`", select_list)

    def test_mysql_row_preview_does_not_use_select_star(self) -> None:
        with (
            mock.patch("app.routers.database.table_column_metadata", return_value=[
                {"name": "id", "type": "bigint(20)"},
                {"name": "description", "type": "longtext"},
            ]),
            mock.patch("app.routers.database.run_command") as run_command,
        ):
            run_command.return_value = {"command": [], "stdout": "id\tdescription\n1\tline\\nnext\n", "stderr": "", "returncode": 0}

            preview_rows(DatabaseRowsRequest(
                engine="MYSQL",
                database="shop",
                table="products",
            ))

        sql = run_command.call_args.args[0][3]
        self.assertNotIn("SELECT *", sql)
        self.assertIn("CHAR(10), '\\\\n'", sql)

    def test_postgres_row_preview_returns_no_matches_when_no_columns_are_selected(self) -> None:
        with (
            mock.patch("app.routers.database.table_column_metadata", return_value=[
                {"name": "id", "type": "integer"},
                {"name": "name", "type": "text"},
                {"name": "description", "type": "text"},
            ]),
            mock.patch("app.routers.database.run_command") as run_command,
        ):
            run_command.return_value = {"command": [], "stdout": "id,name,description\n", "stderr": "", "returncode": 0}

            result = preview_rows(DatabaseRowsRequest(
                engine="POSTGRESQL",
                database="shop",
                table="products",
                search="pang",
                searchColumns=[],
            ))

        sql = run_command.call_args.args[0][-1]
        self.assertEqual(result["searchColumns"], [])
        self.assertIn("WHERE 1 = 0", sql)


if __name__ == "__main__":
    unittest.main()
