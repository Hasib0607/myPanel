#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${1:?app directory required}"
PROCESS_NAME="${2:?pm2 process name required}"
cd "$APP_DIR"
npm ci
npm run build
pm2 start npm --name "$PROCESS_NAME" -- start
pm2 save
