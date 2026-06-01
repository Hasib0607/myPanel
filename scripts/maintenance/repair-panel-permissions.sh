#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_USER="${APP_USER:-panel}"
APP_GROUP="${APP_GROUP:-$APP_USER}"

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "App user $APP_USER does not exist"
  exit 2
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "$APP_DIR is not a git checkout"
  exit 3
fi

chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
find "$APP_DIR/.git" -type d -exec chmod u+rwx {} +
find "$APP_DIR/.git" -type f -exec chmod u+rw {} +

if [[ -d "$APP_DIR/node_modules" ]]; then
  chown -R "$APP_USER:$APP_GROUP" "$APP_DIR/node_modules"
fi

if [[ -d "$APP_DIR/frontend/.next" ]]; then
  chown -R "$APP_USER:$APP_GROUP" "$APP_DIR/frontend/.next"
fi

echo "Repaired panel permissions for $APP_DIR"
