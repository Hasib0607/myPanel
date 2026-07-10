from __future__ import annotations
import re
import secrets
import shlex
import shutil
import string
import tempfile
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.command import run_command, run_install_plan
from app.platform import current_os, install_plan_for, service_spec

router = APIRouter()

ENGINE_PATTERN = "^(POSTGRESQL|MYSQL)$"
IDENTIFIER_PATTERN = r"^[a-zA-Z0-9_]+$"
SYSTEM_POSTGRES_DATABASES = {"postgres"}
SYSTEM_MYSQL_DATABASES = {"information_schema", "mysql", "performance_schema", "sys"}


class DatabaseProvisionRequest(BaseModel):
    engine: str = Field(pattern=ENGINE_PATTERN)
    database: str = Field(pattern=IDENTIFIER_PATTERN)
    username: str = Field(pattern=IDENTIFIER_PATTERN)
    passwordSecretRef: str | None = None
    password: str | None = Field(default=None, min_length=12, max_length=256)


class DatabaseCredentialRequest(BaseModel):
    engine: str = Field(pattern=ENGINE_PATTERN)
    username: str = Field(pattern=IDENTIFIER_PATTERN)
    password: str | None = Field(default=None, min_length=12, max_length=256)


class DatabaseGrantRequest(BaseModel):
    engine: str = Field(pattern=ENGINE_PATTERN)
    database: str = Field(pattern=IDENTIFIER_PATTERN)
    username: str = Field(pattern=IDENTIFIER_PATTERN)


class DatabaseDeleteRequest(BaseModel):
    engine: str = Field(pattern=ENGINE_PATTERN)
    database: str = Field(pattern=IDENTIFIER_PATTERN)


class DatabaseDumpRequest(BaseModel):
    engine: str = Field(pattern=ENGINE_PATTERN)
    database: str = Field(pattern=IDENTIFIER_PATTERN)


class DatabaseImportRequest(BaseModel):
    engine: str = Field(pattern=ENGINE_PATTERN)
    database: str = Field(pattern=IDENTIFIER_PATTERN)
    sql: str = Field(min_length=1, max_length=20_000_000)


class DatabaseImportFileRequest(BaseModel):
    engine: str = Field(pattern=ENGINE_PATTERN)
    database: str = Field(pattern=IDENTIFIER_PATTERN)
    path: str = Field(min_length=1, max_length=4096)


class DatabaseTableRequest(BaseModel):
    engine: str = Field(pattern=ENGINE_PATTERN)
    database: str = Field(pattern=IDENTIFIER_PATTERN)
    table: str = Field(pattern=IDENTIFIER_PATTERN)


class DatabaseRowsRequest(DatabaseTableRequest):
    limit: int = Field(default=50, ge=1, le=500)
    offset: int = Field(default=0, ge=0)
    search: str | None = Field(default=None, max_length=200)
    searchColumns: list[str] | None = None


class DatabaseTableImportRequest(DatabaseTableRequest):
    format: str = Field(default="SQL", pattern="^(SQL|CSV)$")
    content: str = Field(min_length=1, max_length=20_000_000)


class DatabaseRowCreateRequest(DatabaseTableRequest):
    values: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


class DatabaseRowTargetRequest(DatabaseTableRequest):
    keyColumn: str = Field(pattern=IDENTIFIER_PATTERN)
    keyValue: str | int | float | bool


class DatabaseRowUpdateRequest(DatabaseRowTargetRequest):
    values: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


class DatabaseProtectionRequest(BaseModel):
    engine: str = Field(pattern=ENGINE_PATTERN)
    username: str | None = Field(default=None, pattern=IDENTIFIER_PATTERN)
    maxConnections: int | None = Field(default=None, ge=1, le=500)
    slowQueryMs: int = Field(default=1000, ge=100, le=60000)


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def postgres_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def mysql_identifier(value: str) -> str:
    return "`" + value.replace("`", "``") + "`"


def generic_literal(value: str | int | float | bool | None) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    return sql_literal(str(value))


def generated_password() -> str:
    alphabet = string.ascii_letters + string.digits + "-_#@"
    return "".join(secrets.choice(alphabet) for _ in range(24))


def parse_lines(stdout: str | None) -> list[str]:
    return [line.strip() for line in (stdout or "").splitlines() if line.strip()]


def parse_int(value: str | None) -> int:
    try:
        return int(value or "0")
    except ValueError:
        return 0


def postgres_psql(sql: str) -> dict:
    return run_command(["sudo", "-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql])


def successful_command(command: list[str], stdout: str = "") -> dict:
    return {"command": command, "stdout": stdout, "stderr": "", "returncode": 0}


def ensure_mysql_runtime() -> dict | None:
    if shutil.which("mysql"):
        return None

    install = run_install_plan(install_plan_for("mysql_database", current_os()), timeout=300)
    if install.get("returncode") != 0:
        return install

    if not shutil.which("mysql"):
        return {
            "returncode": 127,
            "stderr": "mysql CLI is still unavailable after MariaDB/MySQL install attempt",
            "stdout": "",
            "command": ["mysql", "-NBe", "SELECT 1"],
        }

    service = service_spec("mysql_database", current_os())
    start = run_command(["systemctl", "enable", "--now", service.unit], timeout=120)
    if start.get("returncode") != 0:
        return start
    return None


def mysql_exec(sql: str) -> dict:
    ensure = ensure_mysql_runtime()
    if ensure is not None:
        return ensure
    return run_command(["mysql", "-NBe", sql])


def mysql_user_exec(username: str, password: str, database: str, host: str) -> dict:
    ensure = ensure_mysql_runtime()
    if ensure is not None:
        return ensure
    return run_command(["mysql", "-u", username, f"-p{password}", "-h", host, database, "-NBe", "SELECT 1;"])


def write_temp_sql(sql: str) -> str:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".sql", prefix="vps-panel-db-", delete=False) as handle:
        handle.write(sql)
        return handle.name


def write_temp_content(content: str, suffix: str) -> str:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=suffix, prefix="vps-panel-db-", delete=False) as handle:
        handle.write(content)
        return handle.name


MYSQL_IMPORT_TIMEOUT_SECONDS = 21_600


def import_sql_path(engine: str, database: str, path: str) -> dict:
    if engine == "POSTGRESQL":
        return run_command(["sudo", "-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-d", database, "-f", path], timeout=3600)
    ensure = ensure_mysql_runtime()
    if ensure is not None:
        return ensure
    mysql_exec("SET GLOBAL max_allowed_packet=1073741824;")
    init_sql = "SET SESSION foreign_key_checks=0; SET SESSION unique_checks=0; SET SESSION sql_log_bin=0;"
    command = (
        "mysql "
        "--binary-mode=1 "
        "--default-character-set=utf8mb4 "
        "--max_allowed_packet=1G "
        f"--init-command={shlex.quote(init_sql)} "
        f"{shlex.quote(database)} < {shlex.quote(path)}"
    )
    return run_command(["sh", "-lc", command], timeout=MYSQL_IMPORT_TIMEOUT_SECONDS)


def postgres_overview() -> dict:
    databases_result = postgres_psql("SELECT datname || '|' || pg_catalog.pg_get_userbyid(datdba) FROM pg_database WHERE datistemplate = false ORDER BY datname;")
    users_result = postgres_psql("SELECT rolname FROM pg_roles WHERE rolcanlogin = true ORDER BY rolname;")
    databases = []
    for line in parse_lines(databases_result.get("stdout")):
        name, _, owner = line.partition("|")
        if name in SYSTEM_POSTGRES_DATABASES:
            continue
        stats_result = run_command([
            "sudo", "-u", "postgres", "psql", "-d", name, "-At", "-c",
            "SELECT "
            "(SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE') || '|' || "
            "COALESCE((SELECT SUM(GREATEST(c.reltuples, 0)::bigint) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'), 0) || '|' || "
            f"pg_database_size({sql_literal(name)});"
        ])
        table_count, _, rest = (stats_result.get("stdout") or "0|0|0").strip().partition("|")
        row_count, _, size_bytes = rest.partition("|")
        databases.append({
            "name": name,
            "owner": owner or None,
            "tableCount": parse_int(table_count),
            "rowCount": parse_int(row_count),
            "sizeBytes": parse_int(size_bytes),
            "statsResult": stats_result,
        })
    return {
        "engine": "POSTGRESQL",
        "installed": databases_result.get("returncode") == 0,
        "databases": databases,
        "users": [{"name": user, "host": None} for user in parse_lines(users_result.get("stdout"))],
        "checks": {"databases": databases_result, "users": users_result},
    }


def mysql_overview() -> dict:
    databases_result = mysql_exec("SHOW DATABASES;")
    users_result = mysql_exec("SELECT user, host FROM mysql.user ORDER BY user, host;")
    stats_result = mysql_exec(
        "SELECT TABLE_SCHEMA, COUNT(*), COALESCE(SUM(TABLE_ROWS),0), COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH),0) "
        "FROM information_schema.TABLES "
        "WHERE TABLE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys') "
        "GROUP BY TABLE_SCHEMA;"
    )
    stats_by_database = {}
    for line in parse_lines(stats_result.get("stdout")):
        parts = re.split(r"\s+", line)
        if len(parts) >= 4:
            stats_by_database[parts[0]] = {
                "tableCount": parse_int(parts[1]),
                "rowCount": parse_int(parts[2]),
                "sizeBytes": parse_int(parts[3]),
            }
    databases = []
    for name in parse_lines(databases_result.get("stdout")):
        if name in SYSTEM_MYSQL_DATABASES:
            continue
        stats = stats_by_database.get(name, {"tableCount": 0, "rowCount": 0, "sizeBytes": 0})
        databases.append({"name": name, "owner": None, **stats})
    users = []
    for line in parse_lines(users_result.get("stdout")):
        parts = re.split(r"\s+", line, maxsplit=1)
        if parts and parts[0]:
            users.append({"name": parts[0], "host": parts[1] if len(parts) > 1 else None})
    return {
        "engine": "MYSQL",
        "installed": databases_result.get("returncode") == 0,
        "databases": databases,
        "users": users,
        "checks": {"databases": databases_result, "users": users_result, "stats": stats_result},
    }


def provision_postgres(database: str, username: str, password: str) -> dict:
    user_sql = (
        "DO $$ BEGIN "
        f"IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = {sql_literal(username)}) THEN "
        f"CREATE ROLE {postgres_identifier(username)} LOGIN PASSWORD {sql_literal(password)}; "
        "ELSE "
        f"ALTER ROLE {postgres_identifier(username)} WITH LOGIN PASSWORD {sql_literal(password)}; "
        "END IF; END $$;"
    )
    create_user = postgres_psql(user_sql)
    check_database = postgres_psql(f"SELECT 1 FROM pg_database WHERE datname = {sql_literal(database)};")
    if check_database.get("returncode") == 0 and parse_lines(check_database.get("stdout")):
        create_database = successful_command(["postgres-database-exists", database], "database already exists")
    elif check_database.get("returncode") == 0:
        create_database = postgres_psql(f"CREATE DATABASE {postgres_identifier(database)} OWNER {postgres_identifier(username)};")
    else:
        create_database = check_database
    grant = (
        postgres_psql(f"GRANT ALL PRIVILEGES ON DATABASE {postgres_identifier(database)} TO {postgres_identifier(username)};")
        if create_database.get("returncode") == 0
        else successful_command(["postgres-grant-skipped", database, username], "skipped because database create failed")
    )
    return {"user": create_user, "database": create_database, "grant": grant}


def provision_mysql(database: str, username: str, password: str) -> dict:
    host_steps = []
    for host in ("localhost", "127.0.0.1", "%"):
        host_steps.extend([
            f"CREATE USER IF NOT EXISTS {sql_literal(username)}@{sql_literal(host)} IDENTIFIED BY {sql_literal(password)};",
            f"ALTER USER {sql_literal(username)}@{sql_literal(host)} IDENTIFIED BY {sql_literal(password)};",
            f"GRANT ALL PRIVILEGES ON {mysql_identifier(database)}.* TO {sql_literal(username)}@{sql_literal(host)};",
        ])
    sql = " ".join([
        f"CREATE DATABASE IF NOT EXISTS {mysql_identifier(database)};",
        *host_steps,
        "FLUSH PRIVILEGES;",
    ])
    apply = mysql_exec(sql)
    verify_local = mysql_user_exec(username, password, database, "localhost") if apply.get("returncode") == 0 else {
        "returncode": 1,
        "stderr": "Skipped because MySQL grant/password repair failed",
        "stdout": "",
    }
    verify_tcp = mysql_user_exec(username, password, database, "127.0.0.1") if apply.get("returncode") == 0 else {
        "returncode": 1,
        "stderr": "Skipped because MySQL grant/password repair failed",
        "stdout": "",
    }
    return {"apply": apply, "verifyLocal": verify_local, "verifyTcp": verify_tcp}


@router.get("/overview")
def overview() -> dict:
    return {
        "engines": [
            postgres_overview(),
            mysql_overview(),
        ]
    }


@router.post("/protection")
def database_protection(body: DatabaseProtectionRequest) -> dict:
    if body.engine == "POSTGRESQL":
        slow = postgres_psql(f"ALTER SYSTEM SET log_min_duration_statement = {sql_literal(str(body.slowQueryMs))}; SELECT pg_reload_conf();")
        connection_limit = None
        if body.username and body.maxConnections:
            connection_limit = postgres_psql(f"ALTER ROLE {postgres_identifier(body.username)} CONNECTION LIMIT {body.maxConnections};")
        pressure = postgres_psql(
            "SELECT datname || '|' || usename || '|' || count(*) "
            "FROM pg_stat_activity WHERE datname IS NOT NULL GROUP BY datname, usename ORDER BY count(*) DESC LIMIT 25;"
        )
        return {"engine": body.engine, "slowQuery": slow, "connectionLimit": connection_limit, "pressure": pressure}

    slow = mysql_exec(
        "SET GLOBAL slow_query_log = 'ON'; "
        f"SET GLOBAL long_query_time = {max(0.1, body.slowQueryMs / 1000):.3f}; "
        "SET GLOBAL log_output = 'FILE';"
    )
    connection_limit = None
    if body.username and body.maxConnections:
        connection_limit = mysql_exec(
            f"ALTER USER {sql_literal(body.username)}@'localhost' WITH MAX_USER_CONNECTIONS {body.maxConnections}; "
            f"ALTER USER {sql_literal(body.username)}@'127.0.0.1' WITH MAX_USER_CONNECTIONS {body.maxConnections}; "
            "FLUSH PRIVILEGES;"
        )
    pressure = mysql_exec(
        "SELECT IFNULL(DB,'') AS db, IFNULL(USER,'') AS user, COUNT(*) "
        "FROM information_schema.PROCESSLIST GROUP BY DB, USER ORDER BY COUNT(*) DESC LIMIT 25;"
    )
    return {"engine": body.engine, "slowQuery": slow, "connectionLimit": connection_limit, "pressure": pressure}


@router.post("/provision")
def provision_database(body: DatabaseProvisionRequest) -> dict:
    password = body.password or generated_password()
    if body.engine == "POSTGRESQL":
        result = provision_postgres(body.database, body.username, password)
    else:
        result = provision_mysql(body.database, body.username, password)
    return {"engine": body.engine, "database": body.database, "username": body.username, "password": password, "result": result}


@router.post("/password")
def change_password(body: DatabaseCredentialRequest) -> dict:
    password = body.password or generated_password()
    if body.engine == "POSTGRESQL":
        result = postgres_psql(f"ALTER ROLE {postgres_identifier(body.username)} WITH LOGIN PASSWORD {sql_literal(password)};")
    else:
        result = mysql_exec(f"ALTER USER {sql_literal(body.username)}@'localhost' IDENTIFIED BY {sql_literal(password)}; FLUSH PRIVILEGES;")
    return {"engine": body.engine, "username": body.username, "password": password, "result": result}


@router.post("/grant")
def grant_access(body: DatabaseGrantRequest) -> dict:
    if body.engine == "POSTGRESQL":
        result = postgres_psql(f"GRANT ALL PRIVILEGES ON DATABASE {postgres_identifier(body.database)} TO {postgres_identifier(body.username)};")
    else:
        result = mysql_exec(f"GRANT ALL PRIVILEGES ON {mysql_identifier(body.database)}.* TO {sql_literal(body.username)}@'localhost'; FLUSH PRIVILEGES;")
    return {"engine": body.engine, "database": body.database, "username": body.username, "result": result}


@router.delete("/database")
def delete_database(body: DatabaseDeleteRequest) -> dict:
    if body.engine == "POSTGRESQL":
        result = postgres_psql(f"DROP DATABASE IF EXISTS {postgres_identifier(body.database)};")
    else:
        result = mysql_exec(f"DROP DATABASE IF EXISTS {mysql_identifier(body.database)};")
    return {"engine": body.engine, "database": body.database, "result": result}


@router.post("/export")
def export_database(body: DatabaseDumpRequest) -> dict:
    if body.engine == "POSTGRESQL":
        result = run_command(["sudo", "-u", "postgres", "pg_dump", "--clean", "--if-exists", "--no-owner", "--no-privileges", body.database], timeout=300)
    else:
        result = run_command(["mysqldump", "--single-transaction", "--routines", "--triggers", body.database], timeout=300)
    return {"engine": body.engine, "database": body.database, "dump": result.get("stdout") or "", "result": result}


@router.post("/import")
def import_database(body: DatabaseImportRequest) -> dict:
    path = write_temp_sql(body.sql)
    try:
        result = import_sql_path(body.engine, body.database, path)
        return {"engine": body.engine, "database": body.database, "result": result}
    finally:
        Path(path).unlink(missing_ok=True)


@router.post("/import-file")
def import_database_file(body: DatabaseImportFileRequest) -> dict:
    path = Path(body.path)
    if not path.exists() or not path.is_file():
        return {
            "engine": body.engine,
            "database": body.database,
            "path": body.path,
            "result": {
                "command": [body.engine == "POSTGRESQL" and "psql" or "mysql", body.database],
                "stdout": "",
                "stderr": f"SQL import file does not exist: {body.path}",
                "returncode": 2,
            },
        }
    result = import_sql_path(body.engine, body.database, str(path))
    return {"engine": body.engine, "database": body.database, "path": body.path, "result": result}


@router.post("/tables")
def list_tables(body: DatabaseDumpRequest) -> dict:
    if body.engine == "POSTGRESQL":
        sql = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;"
        result = run_command(["sudo", "-u", "postgres", "psql", "-d", body.database, "-At", "-c", sql])
    else:
        result = run_command(["mysql", "-NBe", "SHOW FULL TABLES WHERE Table_type = 'BASE TABLE';", body.database])
    tables = [line.split()[0] for line in parse_lines(result.get("stdout"))]
    return {"engine": body.engine, "database": body.database, "tables": tables, "result": result}


@router.post("/columns")
def list_columns(body: DatabaseTableRequest) -> dict:
    if body.engine == "POSTGRESQL":
        sql = (
            "SELECT c.column_name || '|' || c.data_type || '|' || c.is_nullable || '|' || "
            "CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN 'YES' ELSE 'NO' END "
            "FROM information_schema.columns c "
            "LEFT JOIN information_schema.key_column_usage kcu "
            "ON kcu.table_schema = c.table_schema AND kcu.table_name = c.table_name AND kcu.column_name = c.column_name "
            "LEFT JOIN information_schema.table_constraints tc "
            "ON tc.constraint_schema = kcu.constraint_schema AND tc.constraint_name = kcu.constraint_name AND tc.table_name = kcu.table_name "
            f"WHERE c.table_schema = 'public' AND c.table_name = {sql_literal(body.table)} "
            "ORDER BY c.ordinal_position;"
        )
        result = run_command(["sudo", "-u", "postgres", "psql", "-d", body.database, "-At", "-c", sql])
    else:
        sql = (
            "SELECT CONCAT(COLUMN_NAME, '|', COLUMN_TYPE, '|', IS_NULLABLE, '|', IF(COLUMN_KEY='PRI','YES','NO')) "
            "FROM information_schema.COLUMNS "
            f"WHERE TABLE_SCHEMA = {sql_literal(body.database)} AND TABLE_NAME = {sql_literal(body.table)} "
            "ORDER BY ORDINAL_POSITION;"
        )
        result = mysql_exec(sql)
    columns = []
    for line in parse_lines(result.get("stdout")):
        name, _, rest = line.partition("|")
        data_type, _, nullable = rest.partition("|")
        nullable, _, primary = nullable.partition("|")
        columns.append({"name": name, "type": data_type, "nullable": nullable, "primary": primary == "YES"})
    return {"engine": body.engine, "database": body.database, "table": body.table, "columns": columns, "result": result}


def table_column_metadata(engine: str, database: str, table: str) -> list[dict[str, str]]:
    if engine == "POSTGRESQL":
        sql = (
            "SELECT column_name || '|' || data_type FROM information_schema.columns "
            f"WHERE table_schema = 'public' AND table_name = {sql_literal(table)} "
            "ORDER BY ordinal_position;"
        )
        result = run_command(["sudo", "-u", "postgres", "psql", "-d", database, "-At", "-c", sql])
    else:
        sql = (
            "SELECT CONCAT(COLUMN_NAME, '|', COLUMN_TYPE) FROM information_schema.COLUMNS "
            f"WHERE TABLE_SCHEMA = {sql_literal(database)} AND TABLE_NAME = {sql_literal(table)} "
            "ORDER BY ORDINAL_POSITION;"
        )
        result = mysql_exec(sql)
    columns = []
    for line in parse_lines(result.get("stdout")):
        name, _, data_type = line.partition("|")
        columns.append({"name": name, "type": data_type})
    return columns


def table_column_names(engine: str, database: str, table: str) -> list[str]:
    return [column["name"] for column in table_column_metadata(engine, database, table)]


def selected_row_search_columns(all_columns: list[str], requested_columns: list[str] | None) -> list[str]:
    if requested_columns is None:
        return all_columns
    requested = [column for column in requested_columns if re.match(IDENTIFIER_PATTERN, column)]
    allowed = set(all_columns)
    return [column for column in requested if column in allowed]


def row_search_where(engine: str, columns: list[dict[str, str]], search: str) -> str:
    if not search:
        return ""
    if not columns:
        return " WHERE 1 = 0"

    conditions = []
    for column in columns:
        name = column["name"]
        if engine == "POSTGRESQL":
            conditions.append(f"{postgres_identifier(name)}::text ILIKE {sql_literal('%' + search + '%')}")
        else:
            conditions.append(f"CAST({mysql_identifier(name)} AS CHAR) LIKE {sql_literal('%' + search + '%')}")
    return " WHERE " + " OR ".join(conditions)


@router.post("/rows")
def preview_rows(body: DatabaseRowsRequest) -> dict:
    search = (body.search or "").strip()
    all_column_metadata = table_column_metadata(body.engine, body.database, body.table) if search else []
    all_column_names = [column["name"] for column in all_column_metadata]
    selected_columns = selected_row_search_columns(all_column_names, body.searchColumns) if search else []
    selected_column_set = set(selected_columns)
    columns = [column for column in all_column_metadata if column["name"] in selected_column_set]
    if body.engine == "POSTGRESQL":
        where = row_search_where(body.engine, columns, search)
        result = run_command([
            "sudo", "-u", "postgres", "psql", "-d", body.database, "--csv",
            "-c", f"SELECT * FROM {postgres_identifier(body.table)}{where} LIMIT {body.limit} OFFSET {body.offset};"
        ])
    else:
        where = row_search_where(body.engine, columns, search)
        result = run_command([
            "mysql", "--batch", "--raw", "-e",
            f"SELECT * FROM {mysql_identifier(body.table)}{where} LIMIT {body.limit} OFFSET {body.offset};",
            body.database,
        ])
    return {
        "engine": body.engine,
        "database": body.database,
        "table": body.table,
        "format": "CSV" if body.engine == "POSTGRESQL" else "TSV",
        "rows": result.get("stdout") or "",
        "search": search,
        "searchColumns": selected_columns,
        "result": result,
    }


@router.post("/table/export")
def export_table(body: DatabaseTableRequest) -> dict:
    if body.engine == "POSTGRESQL":
        result = run_command(["sudo", "-u", "postgres", "pg_dump", "--clean", "--if-exists", "--no-owner", "--no-privileges", "-t", body.table, body.database], timeout=300)
    else:
        result = run_command(["mysqldump", "--single-transaction", "--routines", "--triggers", body.database, body.table], timeout=300)
    return {"engine": body.engine, "database": body.database, "table": body.table, "dump": result.get("stdout") or "", "result": result}


@router.post("/table/export-csv")
def export_table_csv(body: DatabaseTableRequest) -> dict:
    if body.engine == "POSTGRESQL":
        result = run_command([
            "sudo", "-u", "postgres", "psql", "-d", body.database, "--csv",
            "-c", f"SELECT * FROM {postgres_identifier(body.table)};"
        ], timeout=300)
        content = result.get("stdout") or ""
    else:
        result = run_command([
            "mysql", "--batch", "--raw", "-e", f"SELECT * FROM {mysql_identifier(body.table)};", body.database
        ], timeout=300)
        content = result.get("stdout") or ""
    return {"engine": body.engine, "database": body.database, "table": body.table, "format": "CSV" if body.engine == "POSTGRESQL" else "TSV", "content": content, "result": result}


@router.post("/table/import")
def import_table(body: DatabaseTableImportRequest) -> dict:
    suffix = ".csv" if body.format == "CSV" else ".sql"
    path = write_temp_content(body.content, suffix)
    try:
        if body.format == "CSV":
            if body.engine == "POSTGRESQL":
                sql = f"\\copy {postgres_identifier(body.table)} FROM {sql_literal(path)} WITH (FORMAT csv, HEADER true);"
                result = run_command(["sudo", "-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-d", body.database, "-c", sql], timeout=300)
            else:
                sql = (
                    f"LOAD DATA LOCAL INFILE {sql_literal(path)} INTO TABLE {mysql_identifier(body.table)} "
                    "FIELDS TERMINATED BY ',' ENCLOSED BY '\"' LINES TERMINATED BY '\\n' IGNORE 1 LINES;"
                )
                result = run_command(["mysql", "--local-infile=1", body.database, "-e", sql], timeout=300)
        elif body.engine == "POSTGRESQL":
            result = run_command(["sudo", "-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-d", body.database, "-f", path], timeout=300)
        else:
            result = import_sql_path(body.engine, body.database, path)
        return {"engine": body.engine, "database": body.database, "table": body.table, "format": body.format, "result": result}
    finally:
        Path(path).unlink(missing_ok=True)


@router.post("/row")
def create_row(body: DatabaseRowCreateRequest) -> dict:
    values = {key: value for key, value in body.values.items() if re.match(IDENTIFIER_PATTERN, key)}
    if not values:
        return {"engine": body.engine, "database": body.database, "table": body.table, "result": {"returncode": 2, "stdout": "", "stderr": "No row values supplied"}}
    if body.engine == "POSTGRESQL":
        columns = ", ".join(postgres_identifier(key) for key in values)
        literals = ", ".join(generic_literal(value) for value in values.values())
        sql = f"INSERT INTO {postgres_identifier(body.table)} ({columns}) VALUES ({literals});"
        result = run_command(["sudo", "-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-d", body.database, "-c", sql])
    else:
        columns = ", ".join(mysql_identifier(key) for key in values)
        literals = ", ".join(generic_literal(value) for value in values.values())
        result = run_command(["mysql", body.database, "-e", f"INSERT INTO {mysql_identifier(body.table)} ({columns}) VALUES ({literals});"])
    return {"engine": body.engine, "database": body.database, "table": body.table, "result": result}


@router.patch("/row")
def update_row(body: DatabaseRowUpdateRequest) -> dict:
    values = {key: value for key, value in body.values.items() if re.match(IDENTIFIER_PATTERN, key) and key != body.keyColumn}
    if not values:
        return {"engine": body.engine, "database": body.database, "table": body.table, "result": {"returncode": 2, "stdout": "", "stderr": "No editable row values supplied"}}
    if body.engine == "POSTGRESQL":
        assignments = ", ".join(f"{postgres_identifier(key)} = {generic_literal(value)}" for key, value in values.items())
        sql = f"UPDATE {postgres_identifier(body.table)} SET {assignments} WHERE {postgres_identifier(body.keyColumn)} = {generic_literal(body.keyValue)};"
        result = run_command(["sudo", "-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-d", body.database, "-c", sql])
    else:
        assignments = ", ".join(f"{mysql_identifier(key)} = {generic_literal(value)}" for key, value in values.items())
        sql = f"UPDATE {mysql_identifier(body.table)} SET {assignments} WHERE {mysql_identifier(body.keyColumn)} = {generic_literal(body.keyValue)};"
        result = run_command(["mysql", body.database, "-e", sql])
    return {"engine": body.engine, "database": body.database, "table": body.table, "result": result}


@router.delete("/row")
def delete_row(body: DatabaseRowTargetRequest) -> dict:
    if body.engine == "POSTGRESQL":
        sql = f"DELETE FROM {postgres_identifier(body.table)} WHERE {postgres_identifier(body.keyColumn)} = {generic_literal(body.keyValue)};"
        result = run_command(["sudo", "-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-d", body.database, "-c", sql])
    else:
        sql = f"DELETE FROM {mysql_identifier(body.table)} WHERE {mysql_identifier(body.keyColumn)} = {generic_literal(body.keyValue)};"
        result = run_command(["mysql", body.database, "-e", sql])
    return {"engine": body.engine, "database": body.database, "table": body.table, "result": result}
