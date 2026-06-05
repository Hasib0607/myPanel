#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/myPanel}"
API_DIR="$APP_DIR/api"
ENV_FILE="$APP_DIR/.env"
PASSWORD="${1:-${NEW_PASS:-${SUPERADMIN_PASSWORD:-}}}"
USERNAME="${SUPERADMIN_USERNAME:-admin}"

strip_wrapping_quotes() {
  printf '%s' "$1" | sed "s/^[[:space:]\"'“”‘’]*//;s/[[:space:]\"'“”‘’]*$//"
}

USERNAME="$(strip_wrapping_quotes "$USERNAME")"

if [[ -z "$PASSWORD" ]]; then
  echo "Usage: sudo NEW_PASS='new-password' bash scripts/maintenance/reset-admin-password.sh"
  echo "   or: sudo bash scripts/maintenance/reset-admin-password.sh 'new-password'"
  exit 2
fi

if [[ ! -d "$API_DIR" || ! -f "$ENV_FILE" ]]; then
  echo "Panel API or .env not found under $APP_DIR"
  exit 2
fi

HASH="$(cd "$API_DIR" && NEW_PASS="$PASSWORD" node -e 'const bcrypt=require("bcrypt"); bcrypt.hash(process.env.NEW_PASS,12).then((hash)=>process.stdout.write(hash))')"

if [[ -z "$HASH" ]]; then
  echo "Could not generate bcrypt hash"
  exit 1
fi

if grep -q '^SUPERADMIN_USERNAME=' "$ENV_FILE"; then
  sed -i "s#^SUPERADMIN_USERNAME=.*#SUPERADMIN_USERNAME=$USERNAME#" "$ENV_FILE"
else
  printf '\nSUPERADMIN_USERNAME=%s\n' "$USERNAME" >> "$ENV_FILE"
fi

if grep -q '^SUPERADMIN_PASSWORD_HASH=' "$ENV_FILE"; then
  sed -i "s#^SUPERADMIN_PASSWORD_HASH=.*#SUPERADMIN_PASSWORD_HASH=$HASH#" "$ENV_FILE"
else
  printf 'SUPERADMIN_PASSWORD_HASH=%s\n' "$HASH" >> "$ENV_FILE"
fi

systemctl restart vps-panel-api
echo "Superadmin password reset for username: $USERNAME"
