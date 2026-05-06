#!/usr/bin/env bash
set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_FILE="${1:?Usage: restore-panel-db.sh /path/to/panel-main.dump}"

if [[ ! -f "${BACKUP_FILE}" ]]; then
  echo "Backup file not found: ${BACKUP_FILE}" >&2
  exit 1
fi

pg_restore --clean --if-exists --no-owner --no-acl --dbname="${DATABASE_URL}" "${BACKUP_FILE}"
