#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${1:-$(pwd)}"
ENV_FILE="$APP_DIR/.env"

if [[ ! -f "$APP_DIR/artisan" ]]; then
  echo "Laravel artisan file not found in $APP_DIR" >&2
  exit 2
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo ".env file not found in $APP_DIR" >&2
  exit 2
fi

env_value() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

set_env() {
  local key="$1"
  local value="$2"
  if grep -Eq "^${key}=" "$ENV_FILE"; then
    sed -i.bak -E "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

db_connection="$(env_value DB_CONNECTION | tr '[:upper:]' '[:lower:]')"
database_url="$(env_value DATABASE_URL | tr '[:upper:]' '[:lower:]')"

if [[ "$db_connection" != "pgsql" && "$db_connection" != "postgres" && "$db_connection" != "postgresql" && "$database_url" != postgres://* && "$database_url" != postgresql://* ]]; then
  echo "This Laravel app does not look like it uses PostgreSQL. DB_CONNECTION=$db_connection" >&2
  exit 1
fi

set_env DB_CONNECTION pgsql
set_env DB_CHARSET utf8
set_env DB_COLLATION ""

php "$APP_DIR/artisan" config:clear || true
php "$APP_DIR/artisan" cache:clear || true

echo "PostgreSQL Laravel env repaired:"
grep -E '^(DB_CONNECTION|DB_HOST|DB_PORT|DB_DATABASE|DB_USERNAME|DB_CHARSET|DB_COLLATION)=' "$ENV_FILE" || true
echo
echo "Now rerun your migration."
