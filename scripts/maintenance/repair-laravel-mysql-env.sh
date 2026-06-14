#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${1:-$(pwd)}"
DB_NAME="${2:-}"
DB_USER="${3:-}"
DB_PASS="${4:-}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-3306}"

is_placeholder() {
  case "${1:-}" in
    ""|YOUR_MYSQL_DATABASE|YOUR_MYSQL_USER|YOUR_MYSQL_PASSWORD|your_mysql_database|your_mysql_user|your_mysql_password)
      return 0
      ;;
  esac
  return 1
}

normalize_optional_arg() {
  if is_placeholder "${1:-}"; then
    printf ''
  else
    printf '%s' "$1"
  fi
}

DB_NAME="$(normalize_optional_arg "$DB_NAME")"
DB_USER="$(normalize_optional_arg "$DB_USER")"
DB_PASS="$(normalize_optional_arg "$DB_PASS")"

find_laravel_roots() {
  local root artisan dir
  for root in "$PWD" /home /var/www /srv /opt /root; do
    [[ -d "$root" ]] || continue
    find "$root" -maxdepth 7 -type f -name artisan -print 2>/dev/null | while IFS= read -r artisan; do
      dir="$(dirname "$artisan")"
      [[ -f "$dir/.env" ]] && printf '%s\n' "$dir"
    done
  done | awk '!seen[$0]++'
}

if [[ ! -f "$APP_DIR/artisan" || ! -f "$APP_DIR/.env" ]]; then
  mapfile -t candidates < <(find_laravel_roots)
  if [[ "${#candidates[@]}" -eq 1 ]]; then
    APP_DIR="${candidates[0]}"
    echo "Target path did not contain artisan + .env; using detected Laravel app: $APP_DIR" >&2
  else
    echo "Usage: $0 /path/to/laravel-app [db_name] [db_user] [db_pass]" >&2
    echo "The target path must contain artisan and .env." >&2
    echo "Current directory: $PWD" >&2
    if [[ "${#candidates[@]}" -gt 1 ]]; then
      echo "Multiple Laravel apps found; rerun with the correct path:" >&2
      printf '  %s\n' "${candidates[@]}" >&2
    else
      echo "No Laravel app with both artisan and .env was found under common roots." >&2
      echo "Find it manually with: find /home /var/www /srv /opt -maxdepth 7 -type f -name artisan -print 2>/dev/null" >&2
    fi
    exit 2
  fi
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

env_value() {
  local key="$1"
  grep -E "^${key}=" "$APP_DIR/.env" | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

clear_if_postgres_url() {
  local key="$1"
  local value
  value="$(env_value "$key" | tr '[:upper:]' '[:lower:]')"
  if [[ "$value" == postgres://* || "$value" == postgresql://* ]]; then
    set_env "$key" ""
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
clear_if_postgres_url DATABASE_URL
clear_if_postgres_url DB_URL

(
  cd "$APP_DIR"
  php artisan optimize:clear
  php artisan config:clear
)

echo "Laravel MySQL env repaired at $APP_DIR"
grep -E '^(DB_CONNECTION|DB_HOST|DB_PORT|DB_DATABASE|DB_USERNAME|DB_CHARSET|DB_COLLATION|DATABASE_URL|DB_URL)=' "$APP_DIR/.env"
