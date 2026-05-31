import re
import secrets
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


class DatabaseTableRequest(BaseModel):
    engine: str = Field(pattern=ENGINE_PATTERN)
    database: str = Field(pattern=IDENTIFIER_PATTERN)
    table: str = Field(pattern=IDENTIFIER_PATTERN)


class DatabaseRowsRequest(DatabaseTableRequest):
    limit: int = Field(default=50, ge=1, le=500)
    offset: int = Field(default=0, ge=0)


class DatabaseTableImportRequest(DatabaseTableRequest):
    format: str = Field(default="SQL", pattern="^(SQL|CSV)$")
    content: str = Field(min_length=1, max_length=20_000_000)


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def postgres_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def mysql_identifier(value: str) -> str:
    return "`" + value.replace("`", "``") + "`"


def generated_password() -> str:
    alphabet = string.ascii_letters + string.digits + "-_#@"
    return "".join(secrets.choice(alphabet) for _ in range(24))


def parse_lines(stdout: str | None) -> list[str]:
    return [line.strip() for line in (stdout or "").splitlines() if line.strip()]


def postgres_psql(sql: str) -> dict:
    return run_command(["sudo", "-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql])


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


def write_temp_sql(sql: str) -> str:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".sql", prefix="vps-panel-db-", delete=False) as handle:
        handle.write(sql)
        return handle.name


def write_temp_content(content: str, suffix: str) -> str:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=suffix, prefix="vps-panel-db-", delete=False) as handle:
        handle.write(content)
        return handle.name


def postgres_overview() -> dict:
    databases_result = postgres_psql("SELECT datname || '|' || pg_catalog.pg_get_userbyid(datdba) FROM pg_database WHERE datistemplate = false ORDER BY datname;")
    users_result = postgres_psql("SELECT rolname FROM pg_roles WHERE rolcanlogin = true ORDER BY rolname;")
    databases = []
    for line in parse_lines(databases_result.get("stdout")):
        name, _, owner = line.partition("|")
        if name in SYSTEM_POSTGRES_DATABASES:
            continue
        databases.append({"name": name, "owner": owner or None})
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
    databases = [{"name": name, "owner": None} for name in parse_lines(databases_result.get("stdout")) if name not in SYSTEM_MYSQL_DATABASES]
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
        "checks": {"databases": databases_result, "users": users_result},
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
    create_database = postgres_psql(
        f"SELECT 'CREATE DATABASE {postgres_identifier(database)} OWNER {postgres_identifier(username)}' "
        f"WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = {sql_literal(database)})\\gexec"
    )
    grant = postgres_psql(f"GRANT ALL PRIVILEGES ON DATABASE {postgres_identifier(database)} TO {postgres_identifier(username)};")
    return {"user": create_user, "database": create_database, "grant": grant}


def provision_mysql(database: str, username: str, password: str) -> dict:
    sql = " ".join([
        f"CREATE DATABASE IF NOT EXISTS {mysql_identifier(database)};",
        f"CREATE USER IF NOT EXISTS {sql_literal(username)}@'localhost' IDENTIFIED BY {sql_literal(password)};",
        f"ALTER USER {sql_literal(username)}@'localhost' IDENTIFIED BY {sql_literal(password)};",
        f"GRANT ALL PRIVILEGES ON {mysql_identifier(database)}.* TO {sql_literal(username)}@'localhost';",
        "FLUSH PRIVILEGES;",
    ])
    return {"apply": mysql_exec(sql)}


@router.get("/overview")
def overview() -> dict:
    return {
        "engines": [
            postgres_overview(),
            mysql_overview(),
        ]
    }


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
        if body.engine == "POSTGRESQL":
            result = run_command(["sudo", "-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-d", body.database, "-f", path], timeout=300)
        else:
            result = run_command(["mysql", body.database, "-e", f"source {path}"], timeout=300)
        return {"engine": body.engine, "database": body.database, "result": result}
    finally:
        Path(path).unlink(missing_ok=True)


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
            "SELECT column_name || '|' || data_type || '|' || is_nullable "
            "FROM information_schema.columns "
            f"WHERE table_schema = 'public' AND table_name = {sql_literal(body.table)} "
            "ORDER BY ordinal_position;"
        )
        result = run_command(["sudo", "-u", "postgres", "psql", "-d", body.database, "-At", "-c", sql])
    else:
        sql = (
            "SELECT CONCAT(COLUMN_NAME, '|', COLUMN_TYPE, '|', IS_NULLABLE) "
            "FROM information_schema.COLUMNS "
            f"WHERE TABLE_SCHEMA = {sql_literal(body.database)} AND TABLE_NAME = {sql_literal(body.table)} "
            "ORDER BY ORDINAL_POSITION;"
        )
        result = mysql_exec(sql)
    columns = []
    for line in parse_lines(result.get("stdout")):
        name, _, rest = line.partition("|")
        data_type, _, nullable = rest.partition("|")
        columns.append({"name": name, "type": data_type, "nullable": nullable})
    return {"engine": body.engine, "database": body.database, "table": body.table, "columns": columns, "result": result}


@router.post("/rows")
def preview_rows(body: DatabaseRowsRequest) -> dict:
    if body.engine == "POSTGRESQL":
        result = run_command([
            "sudo", "-u", "postgres", "psql", "-d", body.database, "--csv",
            "-c", f"SELECT * FROM {postgres_identifier(body.table)} LIMIT {body.limit} OFFSET {body.offset};"
        ])
    else:
        result = run_command([
            "mysql", "--batch", "--raw", "-e",
            f"SELECT * FROM {mysql_identifier(body.table)} LIMIT {body.limit} OFFSET {body.offset};",
            body.database,
        ])
    return {"engine": body.engine, "database": body.database, "table": body.table, "format": "CSV" if body.engine == "POSTGRESQL" else "TSV", "rows": result.get("stdout") or "", "result": result}


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
            result = run_command(["mysql", body.database, "-e", f"source {path}"], timeout=300)
        return {"engine": body.engine, "database": body.database, "table": body.table, "format": body.format, "result": result}
    finally:
        Path(path).unlink(missing_ok=True)
