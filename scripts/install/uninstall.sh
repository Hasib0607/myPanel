#!/usr/bin/env bash
set -Eeuo pipefail

: "${APP_DIR:=/opt/vps-panel}"
: "${APP_USER:=panel}"
: "${DB_NAME:=panel_main}"
: "${DB_USER:=panel_user}"
: "${PANEL_NGINX_SITE:=00-vps-panel}"
: "${NGINX_SITES_AVAILABLE:=/etc/nginx/sites-available}"
: "${NGINX_SITES_ENABLED:=/etc/nginx/sites-enabled}"
: "${INSTALL_STATE_DIR:=/var/log/vps-panel/install-state}"
: "${PURGE_DB:=false}"
: "${PURGE_APP:=false}"
: "${PURGE_LOGS:=false}"

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/install/uninstall.sh [options]

Stops and removes VPS Panel systemd services, Nginx panel config, sudoers policy,
and installer resume state. It does not delete the app directory, logs, or database
unless explicitly requested.

Options:
  --purge-db       Drop DB_NAME and DB_USER from local PostgreSQL.
  --purge-app      Delete APP_DIR.
  --purge-logs     Delete /var/log/vps-panel.
  --yes            Do not ask for confirmation.
  --help           Show this help.
EOF
}

YES=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge-db)
      PURGE_DB=true
      shift
      ;;
    --purge-app)
      PURGE_APP=true
      shift
      ;;
    --purge-logs)
      PURGE_LOGS=true
      shift
      ;;
    --yes)
      YES=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 2
      ;;
  esac
done

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

if [[ "$YES" != "true" ]]; then
  read -r -p "Remove VPS Panel services/config from this server? Type 'remove panel' to continue: " answer
  if [[ "$answer" != "remove panel" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo "Stopping panel services"
systemctl disable --now vps-panel-sysagent vps-panel-api vps-panel-workers vps-panel-frontend >/dev/null 2>&1 || true
rm -f /etc/systemd/system/vps-panel-sysagent.service \
  /etc/systemd/system/vps-panel-api.service \
  /etc/systemd/system/vps-panel-workers.service \
  /etc/systemd/system/vps-panel-frontend.service
systemctl daemon-reload

echo "Removing Nginx panel config"
rm -f "$NGINX_SITES_ENABLED/$PANEL_NGINX_SITE" "$NGINX_SITES_AVAILABLE/$PANEL_NGINX_SITE"
nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true

echo "Removing sudoers and install state"
rm -f /etc/sudoers.d/vps-panel-update
rm -rf "$INSTALL_STATE_DIR"

if [[ "$PURGE_DB" == "true" ]]; then
  echo "Dropping local PostgreSQL database/user"
  if id postgres >/dev/null 2>&1; then
    runuser -u postgres -- psql -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME';
DROP DATABASE IF EXISTS $DB_NAME;
DROP ROLE IF EXISTS $DB_USER;
SQL
  fi
fi

if [[ "$PURGE_APP" == "true" ]]; then
  echo "Deleting $APP_DIR"
  rm -rf "$APP_DIR"
fi

if [[ "$PURGE_LOGS" == "true" ]]; then
  echo "Deleting /var/log/vps-panel"
  rm -rf /var/log/vps-panel
fi

if id "$APP_USER" >/dev/null 2>&1 && [[ "$PURGE_APP" == "true" ]]; then
  userdel "$APP_USER" >/dev/null 2>&1 || true
fi

echo "Uninstall complete."
