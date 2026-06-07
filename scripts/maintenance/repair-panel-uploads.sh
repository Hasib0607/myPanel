#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/vps-panel}"
if [[ -d "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" ]]; then
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$APP_DIR/scripts/install/common.sh"

write_update_sudoers
bash "$APP_DIR/scripts/maintenance/repair-self-update-service.sh"
bash "$APP_DIR/scripts/maintenance/patch-panel-nginx-api-upload.sh"
bash "$APP_DIR/scripts/maintenance/fix-nginx-upload-size.sh"
systemctl restart vps-panel-api

echo "Panel upload path repaired (sudoers, nginx limits, self-update service, API restart)"
