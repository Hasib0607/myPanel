#!/usr/bin/env bash
set -euo pipefail

NAME="${1:?project name required}"
PASSWORD="${2:?password required}"
DB_NAME="proj_${NAME}_db"
DB_USER="proj_${NAME}_user"
psql -v ON_ERROR_STOP=1 <<SQL
CREATE USER $DB_USER WITH PASSWORD '$PASSWORD';
CREATE DATABASE $DB_NAME OWNER $DB_USER;
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
SQL
