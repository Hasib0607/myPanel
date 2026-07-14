#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/vps-panel}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
PANEL_NGINX_SITE="${PANEL_NGINX_SITE:-00-vps-panel}"
NGINX_SITES_AVAILABLE="${NGINX_SITES_AVAILABLE:-/etc/nginx/sites-available}"
NGINX_SITES_ENABLED="${NGINX_SITES_ENABLED:-/etc/nginx/sites-enabled}"
PANEL_LOGIN_PORT="${PANEL_LOGIN_PORT:-8453}"
CPANEL_LOGIN_PORT="${CPANEL_LOGIN_PORT:-3138}"
PANEL_PORT="${PANEL_PORT:-4000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
PANEL_DOMAIN="${PANEL_DOMAIN:-}"
PANEL_PUBLIC_SCHEME="${PANEL_PUBLIC_SCHEME:-http}"
SSL_EMAIL="${SSL_EMAIL:-}"
ENABLE_SSL="${ENABLE_SSL:-false}"
VPS_IP_WAS_PROVIDED="${VPS_IP+x}"

detect_vps_ip() {
  local ip=""
  if command -v curl >/dev/null 2>&1; then
    ip="$(curl -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
  fi
  if [[ -z "$ip" ]] && command -v curl >/dev/null 2>&1; then
    ip="$(curl -fsS --max-time 3 https://ifconfig.me/ip 2>/dev/null || true)"
  fi
  if [[ -z "$ip" ]]; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  fi
  if [[ -z "$ip" ]]; then
    ip="$(hostname -i 2>/dev/null | awk '{print $1}')" || true
  fi
  echo "${ip:-127.0.0.1}"
}

VPS_IP="${VPS_IP:-$(detect_vps_ip)}"
VPS_IP="${VPS_IP:-127.0.0.1}"

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/maintenance/repair-panel-listener.sh [options]

Repairs legacy 2083 panel installs by enforcing WHM/Admin on 8453 and
cPanel/Account on 3138, rewriting .env URLs, replacing old Nginx aliases,
and optionally issuing Let's Encrypt for a real domain.

Options:
  --domain HOST       Public panel domain.
  --enable-ssl        Issue/attach Let's Encrypt certificate for --domain.
  --ssl-email EMAIL   Email for Let's Encrypt registration.
  --whm-port PORT     Admin port. Default: 8453.
  --cpanel-port PORT  Account port. Default: 3138.
  --help              Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      PANEL_DOMAIN="${2:?--domain requires a value}"
      shift 2
      ;;
    --enable-ssl)
      ENABLE_SSL=true
      shift
      ;;
    --ssl-email)
      SSL_EMAIL="${2:?--ssl-email requires a value}"
      shift 2
      ;;
    --whm-port)
      PANEL_LOGIN_PORT="${2:?--whm-port requires a value}"
      shift 2
      ;;
    --cpanel-port)
      CPANEL_LOGIN_PORT="${2:?--cpanel-port requires a value}"
      shift 2
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

env_value() {
  local key="$1"
  local value=""
  if [[ -f "$ENV_FILE" ]]; then
    value="$(awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE")"
  fi
  printf '%s' "$value"
}

file_panel_login_port="$(env_value PANEL_LOGIN_PORT)"
file_cpanel_login_port="$(env_value CPANEL_LOGIN_PORT)"
file_panel_port="$(env_value PANEL_PORT)"
file_frontend_port="$(env_value FRONTEND_PORT)"
file_panel_domain="$(env_value PANEL_DOMAIN)"
file_vps_ip="$(env_value VPS_IP)"
file_public_scheme="$(env_value PANEL_PUBLIC_SCHEME)"

PANEL_LOGIN_PORT="${file_panel_login_port:-$PANEL_LOGIN_PORT}"
CPANEL_LOGIN_PORT="${file_cpanel_login_port:-$CPANEL_LOGIN_PORT}"
PANEL_PORT="${file_panel_port:-$PANEL_PORT}"
FRONTEND_PORT="${file_frontend_port:-$FRONTEND_PORT}"
PANEL_DOMAIN="${PANEL_DOMAIN:-$file_panel_domain}"
if [[ -z "$VPS_IP_WAS_PROVIDED" && "$VPS_IP" == "127.0.0.1" && -n "$file_vps_ip" ]]; then
  VPS_IP="$file_vps_ip"
elif [[ -z "$VPS_IP_WAS_PROVIDED" && -n "$file_vps_ip" && "$file_vps_ip" != "$VPS_IP" ]]; then
  echo "Detected current server IP $VPS_IP; replacing stale .env VPS_IP $file_vps_ip."
fi
PANEL_PUBLIC_SCHEME="${file_public_scheme:-$PANEL_PUBLIC_SCHEME}"

if [[ "$PANEL_LOGIN_PORT" == "2083" ]]; then
  PANEL_LOGIN_PORT=8453
fi
if [[ -z "$PANEL_DOMAIN" && -n "${1:-}" ]]; then
  PANEL_DOMAIN="$1"
fi
PANEL_PUBLIC_HOST="${PANEL_DOMAIN:-$VPS_IP}"

is_ip_address() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || "$1" =~ : ]]
}

set_env_value() {
  local key="$1"
  local value="$2"
  local escaped=""
  install -d -m 0755 "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"
  escaped="$(printf '%s' "$value" | sed 's/[#&]/\\&/g')"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i.bak "s#^${key}=.*#${key}=${escaped}#" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

if [[ "$ENABLE_SSL" == "true" ]]; then
  if [[ -z "$PANEL_DOMAIN" ]] || is_ip_address "$PANEL_DOMAIN"; then
    echo "SSL needs a real domain. IP addresses cannot get a trusted Let's Encrypt certificate."
    exit 2
  fi
  email_args=(--register-unsafely-without-email)
  if [[ -n "$SSL_EMAIL" ]]; then
    email_args=(-m "$SSL_EMAIL")
  fi
  systemctl stop nginx >/dev/null 2>&1 || true
  certbot certonly --standalone --non-interactive --agree-tos "${email_args[@]}" -d "$PANEL_DOMAIN"
  PANEL_PUBLIC_SCHEME=https
fi

echo "Updating $ENV_FILE"
set_env_value PANEL_LOGIN_PORT "$PANEL_LOGIN_PORT"
set_env_value CPANEL_LOGIN_PORT "$CPANEL_LOGIN_PORT"
set_env_value NEXT_PUBLIC_PANEL_LOGIN_PORT "$PANEL_LOGIN_PORT"
set_env_value NEXT_PUBLIC_CPANEL_LOGIN_PORT "$CPANEL_LOGIN_PORT"
set_env_value FRONTEND_URL "$PANEL_PUBLIC_SCHEME://$PANEL_PUBLIC_HOST:$PANEL_LOGIN_PORT"
set_env_value NEXT_PUBLIC_API_URL "/api/v1"
set_env_value VPS_IP "$VPS_IP"
if [[ -n "$PANEL_DOMAIN" ]]; then
  set_env_value PANEL_DOMAIN "$PANEL_DOMAIN"
fi
set_env_value PANEL_PUBLIC_SCHEME "$PANEL_PUBLIC_SCHEME"

install -d -m 0755 "$NGINX_SITES_AVAILABLE" "$NGINX_SITES_ENABLED"
rm -f "$NGINX_SITES_ENABLED/vps-panel" "$NGINX_SITES_ENABLED/vps-panel-2083"
rm -f "$NGINX_SITES_AVAILABLE/vps-panel" "$NGINX_SITES_AVAILABLE/vps-panel-2083"

ssl_listen=""
ssl_block=""
if [[ "$PANEL_PUBLIC_SCHEME" == "https" && -n "$PANEL_DOMAIN" ]]; then
  ssl_listen=" ssl"
  ssl_block=$(cat <<SSL
    ssl_certificate /etc/letsencrypt/live/$PANEL_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$PANEL_DOMAIN/privkey.pem;
SSL
)
fi

echo "Writing $NGINX_SITES_AVAILABLE/$PANEL_NGINX_SITE"
cat > "$NGINX_SITES_AVAILABLE/$PANEL_NGINX_SITE" <<EOF
# Protected panel listener. Domain/project publishing must never overwrite this file.
server {
    listen 80;
    server_name $VPS_IP;

    return 302 http://$VPS_IP:$PANEL_LOGIN_PORT/login;
}

server {
    listen $PANEL_LOGIN_PORT$ssl_listen;
    server_name $PANEL_PUBLIC_HOST $VPS_IP;

    client_max_body_size 0;
$ssl_block

    location = /health {
        proxy_pass http://127.0.0.1:$PANEL_PORT/health;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Port $PANEL_LOGIN_PORT;
        proxy_set_header X-Panel-Login-Port $PANEL_LOGIN_PORT;
    }

    location /api/v1/ {
        proxy_pass http://127.0.0.1:$PANEL_PORT/api/v1/;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Port $PANEL_LOGIN_PORT;
        proxy_set_header X-Panel-Login-Port $PANEL_LOGIN_PORT;
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
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Port $PANEL_LOGIN_PORT;
        proxy_set_header X-Panel-Login-Port $PANEL_LOGIN_PORT;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

server {
    listen $CPANEL_LOGIN_PORT$ssl_listen;
    server_name $PANEL_PUBLIC_HOST $VPS_IP;

    client_max_body_size 0;
$ssl_block

    location /api/v1/ {
        proxy_pass http://127.0.0.1:$PANEL_PORT/api/v1/;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Port $CPANEL_LOGIN_PORT;
        proxy_set_header X-Panel-Mode account;
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
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Port $CPANEL_LOGIN_PORT;
        proxy_set_header X-Panel-Mode account;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

ln -sfn "$NGINX_SITES_AVAILABLE/$PANEL_NGINX_SITE" "$NGINX_SITES_ENABLED/$PANEL_NGINX_SITE"

if command -v ufw >/dev/null 2>&1; then
  ufw allow "$PANEL_LOGIN_PORT/tcp" || true
  ufw allow "$CPANEL_LOGIN_PORT/tcp" || true
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
fi
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port="${PANEL_LOGIN_PORT}/tcp" || true
  firewall-cmd --permanent --add-port="${CPANEL_LOGIN_PORT}/tcp" || true
  firewall-cmd --permanent --add-service=http || true
  firewall-cmd --permanent --add-service=https || true
  firewall-cmd --reload || true
fi
if command -v semanage >/dev/null 2>&1; then
  semanage port -a -t http_port_t -p tcp "$PANEL_LOGIN_PORT" 2>/dev/null || semanage port -m -t http_port_t -p tcp "$PANEL_LOGIN_PORT" 2>/dev/null || true
  semanage port -a -t http_port_t -p tcp "$CPANEL_LOGIN_PORT" 2>/dev/null || semanage port -m -t http_port_t -p tcp "$CPANEL_LOGIN_PORT" 2>/dev/null || true
fi

nginx -t
systemctl reload nginx
systemctl restart vps-panel-api vps-panel-workers vps-panel-frontend >/dev/null 2>&1 || true

echo "Panel:   $PANEL_PUBLIC_SCHEME://$PANEL_PUBLIC_HOST:$PANEL_LOGIN_PORT/login"
echo "Account: $PANEL_PUBLIC_SCHEME://$PANEL_PUBLIC_HOST:$CPANEL_LOGIN_PORT/login"
