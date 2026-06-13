#!/usr/bin/env bash
set -Eeuo pipefail

NGINX_SITES_AVAILABLE="${NGINX_SITES_AVAILABLE:-/etc/nginx/sites-available}"
PANEL_NGINX_SITE="${PANEL_NGINX_SITE:-00-vps-panel}"
NGINX_CONF="${NGINX_SITES_AVAILABLE}/${PANEL_NGINX_SITE}"
PANEL_API_UPLOAD_SIZE="${PANEL_API_UPLOAD_SIZE:-500M}"

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root." >&2
  exit 1
fi

if [[ ! -f "$NGINX_CONF" ]]; then
  echo "Panel nginx config not found at $NGINX_CONF; skipping API upload size patch"
  exit 0
fi

if grep -qE "[[:space:]]client_max_body_size[[:space:]]+(${PANEL_API_UPLOAD_SIZE}|0)[[:space:]]*;" "$NGINX_CONF"; then
  echo "Panel nginx already allows uploads up to ${PANEL_API_UPLOAD_SIZE} or more"
  exit 0
fi

if awk '
  /location[[:space:]]+\/api\/v1\// { in_block = 1 }
  in_block && /client_max_body_size[[:space:]]+(500M|0)[[:space:]]*;/ { found = 1 }
  in_block && /^[[:space:]]*}[[:space:]]*$/ { in_block = 0 }
  END { exit found ? 0 : 1 }
' "$NGINX_CONF"; then
  echo "Panel nginx API location already allows uploads up to ${PANEL_API_UPLOAD_SIZE} or more"
  exit 0
fi

if ! grep -qE '[[:space:]]location[[:space:]]+/api/v1/' "$NGINX_CONF"; then
  echo "No /api/v1/ location block found in $NGINX_CONF; skipping API upload size patch"
  exit 0
fi

echo "Patching $NGINX_CONF: setting upload size ${PANEL_API_UPLOAD_SIZE} for /api/v1/"
backup="${NGINX_CONF}.vps-panel.bak.$(date +%s)"
cp -a "$NGINX_CONF" "$backup"

sed -i -E "/^[[:space:]]*location[[:space:]]+\/api\/v1\//a\\        client_max_body_size ${PANEL_API_UPLOAD_SIZE};" "$NGINX_CONF"

if nginx -t; then
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
  echo "nginx reloaded with API upload size override"
  exit 0
fi

echo "nginx config test failed after API upload patch; restoring backup" >&2
cp -a "$backup" "$NGINX_CONF"
nginx -t
exit 1
