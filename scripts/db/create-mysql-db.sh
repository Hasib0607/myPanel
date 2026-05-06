#!/usr/bin/env bash
set -euo pipefail

NAME="${1:?project name required}"
PASSWORD="${2:?password required}"
DB_NAME="mysql_${NAME}_db"
DB_USER="mysql_${NAME}_user"
mysql <<SQL
CREATE USER '$DB_USER'@'localhost' IDENTIFIED BY '$PASSWORD';
CREATE DATABASE $DB_NAME;
GRANT ALL ON $DB_NAME.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL
