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
echo "Updated /etc/sudoers.d/vps-panel-update for $APP_USER"
