#!/usr/bin/env bash
set -Eeuo pipefail

UPLOAD_MAX_FILESIZE="${UPLOAD_MAX_FILESIZE:-500M}"
POST_MAX_SIZE="${POST_MAX_SIZE:-500M}"
PHP_MEMORY_LIMIT="${PHP_MEMORY_LIMIT:-1024M}"
MAX_FILE_UPLOADS="${MAX_FILE_UPLOADS:-100}"

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root." >&2
  exit 1
fi

validate_size() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[0-9]+[kKmMgG]?$ ]]; then
    echo "Invalid $name: $value" >&2
    exit 2
  fi
}

validate_size UPLOAD_MAX_FILESIZE "$UPLOAD_MAX_FILESIZE"
validate_size POST_MAX_SIZE "$POST_MAX_SIZE"
validate_size PHP_MEMORY_LIMIT "$PHP_MEMORY_LIMIT"
if [[ ! "$MAX_FILE_UPLOADS" =~ ^[0-9]+$ ]]; then
  echo "Invalid MAX_FILE_UPLOADS: $MAX_FILE_UPLOADS" >&2
  exit 2
fi

settings_block() {
  cat <<EOF
upload_max_filesize = ${UPLOAD_MAX_FILESIZE}
post_max_size = ${POST_MAX_SIZE}
memory_limit = ${PHP_MEMORY_LIMIT}
max_file_uploads = ${MAX_FILE_UPLOADS}
EOF
}

set_ini_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  if grep -qE "^[[:space:]]*;?[[:space:]]*${key}[[:space:]]*=" "$file"; then
    sed -i -E "s|^[[:space:]]*;?[[:space:]]*${key}[[:space:]]*=.*|${key} = ${value}|" "$file"
  else
    printf '\n%s = %s\n' "$key" "$value" >> "$file"
  fi
}

patch_php_ini() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  cp -a "$file" "${file}.vps-panel-upload.bak.$(date +%s)"
  set_ini_value "$file" upload_max_filesize "$UPLOAD_MAX_FILESIZE"
  set_ini_value "$file" post_max_size "$POST_MAX_SIZE"
  set_ini_value "$file" memory_limit "$PHP_MEMORY_LIMIT"
  set_ini_value "$file" max_file_uploads "$MAX_FILE_UPLOADS"
  echo "Updated $file"
}

write_override_ini() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  local file="$dir/99-vps-panel-upload-limits.ini"
  settings_block > "$file"
  chmod 0644 "$file"
  echo "Wrote $file"
}

shopt -s nullglob

for file in \
  /etc/php.ini \
  /etc/php/*/fpm/php.ini \
  /etc/php/*/apache2/php.ini \
  /etc/php/*/cli/php.ini \
  /etc/opt/remi/php*/php.ini \
  /opt/cpanel/ea-php*/root/etc/php.ini; do
  patch_php_ini "$file"
done

for dir in \
  /etc/php.d \
  /etc/php/*/fpm/conf.d \
  /etc/php/*/apache2/conf.d \
  /etc/opt/remi/php*/php.d \
  /opt/cpanel/ea-php*/root/etc/php.d; do
  write_override_ini "$dir"
done

services=()
while IFS= read -r service; do
  [[ -n "$service" ]] && services+=("$service")
done < <(systemctl list-unit-files --no-legend 'php*-fpm.service' 'php-fpm.service' 'ea-php*-php-fpm.service' 2>/dev/null | awk '{print $1}' | sort -u)

for service in "${services[@]}"; do
  if systemctl is-active --quiet "$service"; then
    systemctl reload "$service" 2>/dev/null || systemctl restart "$service"
    echo "Reloaded $service"
  fi
done

echo "PHP upload limits set: upload_max_filesize=${UPLOAD_MAX_FILESIZE}, post_max_size=${POST_MAX_SIZE}, memory_limit=${PHP_MEMORY_LIMIT}, max_file_uploads=${MAX_FILE_UPLOADS}"
