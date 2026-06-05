#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${1:-$(pwd)}"
DB_NAME="${2:-}"
DB_USER="${3:-}"
DB_PASS="${4:-}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-3306}"

if [[ ! -f "$APP_DIR/artisan" || ! -f "$APP_DIR/.env" ]]; then
  echo "Usage: $0 /path/to/laravel-app [db_name] [db_user] [db_pass]" >&2
  echo "The target path must contain artisan and .env" >&2
  exit 2
fi

set_env() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "$APP_DIR/.env"; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$APP_DIR/.env"
  else
    printf '%s=%s\n' "$key" "$value" >> "$APP_DIR/.env"
  fi
}

set_env DB_CONNECTION mysql
set_env DB_HOST "$DB_HOST"
set_env DB_PORT "$DB_PORT"
if [[ -n "$DB_NAME" ]]; then set_env DB_DATABASE "$DB_NAME"; fi
if [[ -n "$DB_USER" ]]; then set_env DB_USERNAME "$DB_USER"; fi
if [[ -n "$DB_PASS" ]]; then set_env DB_PASSWORD "$DB_PASS"; fi
set_env DB_CHARSET utf8mb4
set_env DB_COLLATION utf8mb4_unicode_ci

(
  cd "$APP_DIR"
  php artisan optimize:clear
  php artisan config:clear
)

echo "Laravel MySQL env repaired at $APP_DIR"
grep -E '^(DB_CONNECTION|DB_HOST|DB_PORT|DB_DATABASE|DB_USERNAME|DB_CHARSET|DB_COLLATION)=' "$APP_DIR/.env"
