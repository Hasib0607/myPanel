from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.command import run_command

router = APIRouter()


class DatabaseProvisionRequest(BaseModel):
    engine: str = Field(pattern="^(POSTGRESQL|MYSQL)$")
    database: str = Field(pattern=r"^[a-zA-Z0-9_]+$")
    username: str = Field(pattern=r"^[a-zA-Z0-9_]+$")
    passwordSecretRef: str | None = None


@router.post("/provision")
def provision_database(body: DatabaseProvisionRequest) -> dict:
    if body.engine == "POSTGRESQL":
        return {
            "user": run_command(["createuser", "--no-superuser", "--no-createdb", "--no-createrole", body.username]),
            "database": run_command(["createdb", "--owner", body.username, body.database]),
        }
    return {
        "database": run_command(["mysql", "-e", f"CREATE DATABASE IF NOT EXISTS `{body.database}`"]),
        "user": run_command(["mysql", "-e", f"CREATE USER IF NOT EXISTS '{body.username}'@'localhost' IDENTIFIED BY '<secret>'"]),
        "grant": run_command(["mysql", "-e", f"GRANT ALL PRIVILEGES ON `{body.database}`.* TO '{body.username}'@'localhost'"]),
    }
