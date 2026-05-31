#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:?domain required}"
PORT="${2:-3000}"
SITES_AVAILABLE="${NGINX_SITES_AVAILABLE:-/etc/nginx/sites-available}"
SITES_ENABLED="${NGINX_SITES_ENABLED:-/etc/nginx/sites-enabled}"

install -d -m 0755 "$SITES_AVAILABLE" "$SITES_ENABLED"
cat > "$SITES_AVAILABLE/$DOMAIN" <<NGINX
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
ln -sf "$SITES_AVAILABLE/$DOMAIN" "$SITES_ENABLED/$DOMAIN"
nginx -t
systemctl reload nginx
