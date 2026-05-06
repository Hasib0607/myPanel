#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:?app directory required}"
PROCESS_NAME="${2:?pm2 process name required}"
ENTRY="${3:-server.js}"
cd "$APP_DIR"
npm ci --omit=dev
pm2 start "$ENTRY" --name "$PROCESS_NAME"
pm2 save
