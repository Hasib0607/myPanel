import re
import secrets
import string
import tempfile
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.command import run_command

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


def mysql_exec(sql: str) -> dict:
    return run_command(["mysql", "-NBe", sql])


def write_temp_sql(sql: str) -> str:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".sql", prefix="vps-panel-db-", delete=False) as handle:
        handle.write(sql)
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
