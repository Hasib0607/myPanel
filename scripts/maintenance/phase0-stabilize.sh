#!/usr/bin/env bash
set -Eeuo pipefail

PANEL_LOGIN_PORT="${PANEL_LOGIN_PORT:-2083}"
PANEL_API_PORT="${PANEL_API_PORT:-4000}"
PANEL_FRONTEND_PORT="${PANEL_FRONTEND_PORT:-3000}"
VPS_IP="${VPS_IP:-$(hostname -I | awk '{print $1}')}"
PANEL_SITE="${PANEL_SITE:-00-vps-panel}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/vps-panel/nginx-phase0-$(date +%Y%m%d%H%M%S)}"

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

log() {
  echo "[$(date -Is)] $*"
}

log "Backing up Nginx site configs to $BACKUP_DIR"
install -d -m 0755 "$BACKUP_DIR"
cp -a /etc/nginx/sites-available "$BACKUP_DIR/" 2>/dev/null || true
cp -a /etc/nginx/sites-enabled "$BACKUP_DIR/" 2>/dev/null || true

log "Writing protected panel listener $PANEL_SITE"
cat > "/etc/nginx/sites-available/$PANEL_SITE" <<EOF
# Protected panel listener. Domain/project publishing must never overwrite this file.
server {
    listen $PANEL_LOGIN_PORT;
    server_name $VPS_IP _;

    client_max_body_size 100M;

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
rm -f /etc/nginx/sites-enabled/vps-panel /etc/nginx/sites-enabled/vps-panel-2083
ln -sfn "/etc/nginx/sites-available/$PANEL_SITE" "/etc/nginx/sites-enabled/$PANEL_SITE"

log "Restarting core panel dependencies"
systemctl enable --now redis-server postgresql nginx >/dev/null 2>&1 || true
systemctl restart redis-server vps-panel-api vps-panel-workers vps-panel-frontend >/dev/null 2>&1 || true

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
