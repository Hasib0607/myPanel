#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-$(pwd)}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
PANEL_DOMAIN="${PANEL_DOMAIN:-}"
PANEL_PORT="${PANEL_PORT:-4000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
SSL_EMAIL="${SSL_EMAIL:-}"
NGINX_SITES_AVAILABLE="${NGINX_SITES_AVAILABLE:-/etc/nginx/sites-available}"
NGINX_SITES_ENABLED="${NGINX_SITES_ENABLED:-/etc/nginx/sites-enabled}"
PANEL_SITE_NAME="${PANEL_SITE_NAME:-00-vps-panel-ssl}"

usage() {
  cat >&2 <<EOF
Usage: sudo $0 --domain admin.example.com [--ssl-email admin@example.com]

Repairs the standard HTTPS panel vhost:
  https://admin.example.com -> frontend/api on localhost

It issues/renews the Let's Encrypt certificate for the panel domain, disables
conflicting nginx server_name entries for that hostname, writes a clean 80/443
vhost, reloads nginx, and restarts panel services.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      PANEL_DOMAIN="${2:?--domain requires a value}"
      shift 2
      ;;
    --ssl-email)
      SSL_EMAIL="${2:?--ssl-email requires a value}"
      shift 2
      ;;
    --app-dir)
      APP_DIR="${2:?--app-dir requires a value}"
      ENV_FILE="$APP_DIR/.env"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root." >&2
  exit 1
fi

nginx_was_stopped=false
cleanup() {
  if [[ "$nginx_was_stopped" == "true" ]]; then
    systemctl start nginx >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

env_value() {
  local key="$1"
  if [[ -f "$ENV_FILE" ]]; then
    awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
  fi
}

detect_vps_ip() {
  curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}'
}

set_env_value() {
  local key="$1"
  local value="$2"
  local escaped
  install -d -m 0755 "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"
  escaped="$(printf '%s' "$value" | sed 's/[#&]/\\&/g')"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i.bak "s#^${key}=.*#${key}=${escaped}#" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

PANEL_DOMAIN="${PANEL_DOMAIN:-$(env_value PANEL_DOMAIN)}"
PANEL_PORT="${PANEL_PORT:-$(env_value PANEL_PORT)}"
FRONTEND_PORT="${FRONTEND_PORT:-$(env_value FRONTEND_PORT)}"
PANEL_PORT="${PANEL_PORT:-4000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
VPS_IP="${VPS_IP:-$(detect_vps_ip)}"

if [[ -z "$PANEL_DOMAIN" || "$PANEL_DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "A real PANEL_DOMAIN is required. Pass --domain admin.example.com" >&2
  exit 2
fi

resolved_ip="$(dig +short A "$PANEL_DOMAIN" 2>/dev/null | tail -n 1 || true)"
if [[ -n "$resolved_ip" && "$resolved_ip" != "$VPS_IP" ]]; then
  echo "Warning: $PANEL_DOMAIN currently resolves to $resolved_ip, this VPS is $VPS_IP." >&2
  echo "Let's Encrypt may fail until DNS points to this server." >&2
fi

email_args=(--register-unsafely-without-email)
if [[ -n "$SSL_EMAIL" ]]; then
  email_args=(-m "$SSL_EMAIL")
fi

install -d -m 0755 "$NGINX_SITES_AVAILABLE" "$NGINX_SITES_ENABLED"

echo "Stopping nginx briefly so certbot standalone can bind port 80..."
systemctl stop nginx >/dev/null 2>&1 || true
nginx_was_stopped=true
certbot certonly --standalone --non-interactive --agree-tos --keep-until-expiring "${email_args[@]}" -d "$PANEL_DOMAIN"

echo "Disabling nginx configs that also claim $PANEL_DOMAIN..."
for enabled in "$NGINX_SITES_ENABLED"/*; do
  [[ -e "$enabled" ]] || continue
  target="$(readlink -f "$enabled" 2>/dev/null || printf '%s' "$enabled")"
  [[ "$(basename "$enabled")" != "$PANEL_SITE_NAME" ]] || continue
  if [[ -f "$target" ]] && grep -Eq "server_name[[:space:]][^;]*\\b${PANEL_DOMAIN//./\\.}\\b" "$target"; then
    mv "$enabled" "$enabled.disabled-$(date +%Y%m%d%H%M%S)" 2>/dev/null || rm -f "$enabled"
  fi
done

cat > "$NGINX_SITES_AVAILABLE/$PANEL_SITE_NAME" <<EOF
# Managed by repair-admin-panel-ssl.sh. Do not use this hostname for customer domains.
server {
    listen 80;
    server_name $PANEL_DOMAIN;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type "text/plain";
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    http2 on;
    server_name $PANEL_DOMAIN;

    client_max_body_size 0;
    ssl_certificate /etc/letsencrypt/live/$PANEL_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$PANEL_DOMAIN/privkey.pem;

    location = /health {
        proxy_pass http://127.0.0.1:$PANEL_PORT/health;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Port 443;
    }

    location /api/v1/ {
        proxy_pass http://127.0.0.1:$PANEL_PORT/api/v1/;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Port 443;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_send_timeout 3600s;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:$FRONTEND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Port 443;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

ln -sfn "$NGINX_SITES_AVAILABLE/$PANEL_SITE_NAME" "$NGINX_SITES_ENABLED/$PANEL_SITE_NAME"

set_env_value PANEL_DOMAIN "$PANEL_DOMAIN"
set_env_value PANEL_PUBLIC_SCHEME https
set_env_value FRONTEND_URL "https://$PANEL_DOMAIN"
set_env_value NEXT_PUBLIC_API_URL "/api/v1"
set_env_value VPS_IP "$VPS_IP"

nginx -t
systemctl start nginx
nginx_was_stopped=false
systemctl reload nginx
systemctl restart vps-panel-api vps-panel-workers vps-panel-frontend >/dev/null 2>&1 || true

echo "Panel repaired: https://$PANEL_DOMAIN"
openssl x509 -noout -subject -issuer -dates -in "/etc/letsencrypt/live/$PANEL_DOMAIN/fullchain.pem" || true
