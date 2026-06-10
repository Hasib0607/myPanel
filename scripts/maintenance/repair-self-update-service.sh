#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/vps-panel}"
APP_USER="${APP_USER:-panel}"
if [[ -d "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" ]]; then
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root." >&2
  exit 1
fi

SYSTEMCTL_BIN="$(command -v systemctl)"
unit="/etc/systemd/system/vps-panel-self-update.service"
nginx_patch="$APP_DIR/scripts/maintenance/patch-panel-nginx-api-upload.sh"
nginx_global="$APP_DIR/scripts/maintenance/fix-nginx-upload-size.sh"
update_script="$APP_DIR/scripts/deploy/update-panel.sh"

cat > "$unit" <<EOF
[Unit]
Description=VPS Panel Self Update
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=PANEL_UPDATE_ISOLATED=true
ExecStartPre=+/usr/bin/bash $nginx_patch
ExecStartPre=+/usr/bin/bash $nginx_global
ExecStart=/usr/bin/env PANEL_UPDATE_ISOLATED=true /usr/bin/bash $update_script
Nice=15
CPUAccounting=true
CPUWeight=10
CPUQuota=200%
MemoryAccounting=true
MemoryHigh=3G
MemoryMax=4G
MemorySwapMax=0
IOAccounting=true
IOWeight=10
IOSchedulingClass=idle
OOMScoreAdjust=500
KillMode=process
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

chmod 0644 "$unit"
"$SYSTEMCTL_BIN" daemon-reload
if "$SYSTEMCTL_BIN" is-active --quiet vps-panel-self-update.service; then
  "$SYSTEMCTL_BIN" set-property --runtime vps-panel-self-update.service \
    CPUWeight=10 \
    CPUQuota=200% \
    MemoryHigh=3G \
    MemoryMax=4G \
    MemorySwapMax=0 \
    IOWeight=10 || true
fi
echo "Repaired $unit with root nginx upload prep and isolated self-update resources"
