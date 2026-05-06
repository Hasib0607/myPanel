#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/vps-panel}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/panel-main-${STAMP}.dump"

mkdir -p "${BACKUP_DIR}"
pg_dump --format=custom --no-owner --no-acl "${DATABASE_URL}" > "${OUT}"
sha256sum "${OUT}" > "${OUT}.sha256"

echo "${OUT}"
