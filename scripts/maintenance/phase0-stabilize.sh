#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../install/lib/os.sh
source "$SCRIPT_DIR/../install/lib/os.sh"

PANEL_LOGIN_PORT="${PANEL_LOGIN_PORT:-8453}"
CPANEL_LOGIN_PORT="${CPANEL_LOGIN_PORT:-3138}"
PANEL_API_PORT="${PANEL_API_PORT:-4000}"
PANEL_FRONTEND_PORT="${PANEL_FRONTEND_PORT:-3000}"
VPS_IP="${VPS_IP:-$(hostname -I | awk '{print $1}')}"
PANEL_SITE="${PANEL_SITE:-00-vps-panel}"
PANEL_DOMAIN="${PANEL_DOMAIN:-}"
PANEL_PUBLIC_SCHEME="${PANEL_PUBLIC_SCHEME:-http}"
PANEL_PUBLIC_HOST="${PANEL_PUBLIC_HOST:-${PANEL_DOMAIN:-$VPS_IP}}"
NGINX_SITES_AVAILABLE="${NGINX_SITES_AVAILABLE:-$(default_nginx_sites_available)}"
NGINX_SITES_ENABLED="${NGINX_SITES_ENABLED:-$(default_nginx_sites_enabled)}"
REDIS_SERVICE="${REDIS_SERVICE:-$(detect_redis_service)}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/vps-panel/nginx-phase0-$(date +%Y%m%d%H%M%S)}"

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

log() {
  echo "[$(date -Is)] $*"
}

install -d -m 0755 "$NGINX_SITES_AVAILABLE" "$NGINX_SITES_ENABLED"

log "Backing up Nginx site configs to $BACKUP_DIR"
install -d -m 0755 "$BACKUP_DIR"
cp -a "$NGINX_SITES_AVAILABLE" "$BACKUP_DIR/" 2>/dev/null || true
cp -a "$NGINX_SITES_ENABLED" "$BACKUP_DIR/" 2>/dev/null || true

log "Writing protected panel listener $PANEL_SITE"
ssl_listen=""
ssl_block=""
if [[ "$PANEL_PUBLIC_SCHEME" == "https" && -n "$PANEL_DOMAIN" ]]; then
  ssl_listen=" ssl http2"
  ssl_block=$(cat <<SSL
    ssl_certificate /etc/letsencrypt/live/$PANEL_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$PANEL_DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    error_page 497 https://\$host:\$server_port\$request_uri;
SSL
)
fi
cat > "$NGINX_SITES_AVAILABLE/$PANEL_SITE" <<EOF
# Protected panel listener. Domain/project publishing must never overwrite this file.
server {
    listen $PANEL_LOGIN_PORT$ssl_listen;
    server_name $PANEL_PUBLIC_HOST $VPS_IP _;

    client_max_body_size 0;
$ssl_block

    location = /health {
        proxy_pass http://127.0.0.1:$PANEL_API_PORT/health;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Port $PANEL_LOGIN_PORT;
        proxy_set_header X-Panel-Login-Port $PANEL_LOGIN_PORT;
    }

    location /api/v1/ {
        proxy_pass http://127.0.0.1:$PANEL_API_PORT/api/v1/;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Port $PANEL_LOGIN_PORT;
        proxy_set_header X-Panel-Login-Port $PANEL_LOGIN_PORT;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_send_timeout 3600s;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:$PANEL_FRONTEND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Port $PANEL_LOGIN_PORT;
        proxy_set_header X-Panel-Login-Port $PANEL_LOGIN_PORT;
    }
}
EOF

log "Replacing old panel Nginx aliases with protected site"
rm -f "$NGINX_SITES_ENABLED/vps-panel" "$NGINX_SITES_ENABLED/vps-panel-2083"
rm -f "$NGINX_SITES_AVAILABLE/vps-panel" "$NGINX_SITES_AVAILABLE/vps-panel-2083"
ln -sfn "$NGINX_SITES_AVAILABLE/$PANEL_SITE" "$NGINX_SITES_ENABLED/$PANEL_SITE"

log "Restarting core panel dependencies (redis=$REDIS_SERVICE)"
systemctl enable --now "$REDIS_SERVICE" postgresql nginx >/dev/null 2>&1 || true
systemctl restart "$REDIS_SERVICE" vps-panel-api vps-panel-workers vps-panel-frontend >/dev/null 2>&1 || true

log "Testing Nginx"
nginx -t
systemctl reload nginx

log "Smoke checks"
curl -fsS "http://127.0.0.1:$PANEL_API_PORT/health" >/dev/null
curl -fsSI "http://127.0.0.1:$PANEL_FRONTEND_PORT/login" >/dev/null
curl -fsSI "http://127.0.0.1:$PANEL_LOGIN_PORT/login" >/dev/null

log "Phase 0 stabilization complete"
echo "Panel URL: http://$VPS_IP:$PANEL_LOGIN_PORT/login"
echo "Nginx backup: $BACKUP_DIR"
