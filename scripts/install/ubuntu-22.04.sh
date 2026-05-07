#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/vps-panel}"
APP_USER="${APP_USER:-panel}"
APP_BRANCH="${APP_BRANCH:-main}"
REPO_URL="${REPO_URL:-}"
PANEL_LOGIN_PORT="${PANEL_LOGIN_PORT:-2083}"
PANEL_PORT="${PANEL_PORT:-4000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
SYSAGENT_PORT="${SYSAGENT_PORT:-5000}"
DB_NAME="${DB_NAME:-panel_main}"
DB_USER="${DB_USER:-panel_user}"
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)}"
SUPERADMIN_USERNAME="${SUPERADMIN_USERNAME:-admin}"
SUPERADMIN_PASSWORD="${SUPERADMIN_PASSWORD:-$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-18)}"
VPS_IP="${VPS_IP:-$(hostname -I | awk '{print $1}')}"
PANEL_UPDATE_REPO_FULL_NAME="${PANEL_UPDATE_REPO_FULL_NAME:-}"

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

if [[ -z "$REPO_URL" && ! -d "$APP_DIR/.git" ]]; then
  echo "Set REPO_URL, for example:"
  echo "REPO_URL=https://github.com/owner/myPanel.git sudo -E bash scripts/install/ubuntu-22.04.sh"
  exit 2
fi

log() {
  echo "[$(date -Is)] $*"
}

write_file() {
  local path="$1"
  install -d -m 0755 "$(dirname "$path")"
  cat > "$path"
}

log "Installing Ubuntu packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg git nginx certbot python3-certbot-nginx postgresql postgresql-contrib redis-server bind9 bind9utils ufw python3 python3-venv python3-pip unzip zip openssl

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt 20 ]]; then
  log "Installing Node.js 22"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
fi

log "Creating app user"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash "$APP_USER"
fi

log "Preparing app directory"
install -d -m 0755 "$APP_DIR"
chown "$APP_USER:$APP_USER" "$APP_DIR"
if [[ -d "$APP_DIR/.git" ]]; then
  runuser -u "$APP_USER" -- git -C "$APP_DIR" fetch origin "$APP_BRANCH"
  runuser -u "$APP_USER" -- git -C "$APP_DIR" checkout "$APP_BRANCH"
  runuser -u "$APP_USER" -- git -C "$APP_DIR" pull --ff-only origin "$APP_BRANCH"
else
  runuser -u "$APP_USER" -- git clone --branch "$APP_BRANCH" "$REPO_URL" "$APP_DIR"
fi

log "Installing Node dependencies"
runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR' && npm install"
runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR/api' && npm install"
runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR/frontend' && npm install"
npm install -g pm2

log "Installing sysagent Python dependencies"
runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR/sysagent' && python3 -m venv .venv && . .venv/bin/activate && pip install --upgrade pip && pip install -r requirements.txt"

log "Creating PostgreSQL database"
systemctl enable --now postgresql redis-server bind9 nginx
runuser -u postgres -- psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASSWORD';
  ELSE
    ALTER ROLE $DB_USER WITH PASSWORD '$DB_PASSWORD';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE $DB_NAME OWNER $DB_USER'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')\gexec
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
SQL

log "Generating secrets"
JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
TOTP_ENCRYPTION_KEY="$(openssl rand -base64 32 | tr -d '\n')"
WEBHOOK_SECRET="$(openssl rand -hex 32)"
SUPERADMIN_PASSWORD_HASH="$(runuser -u "$APP_USER" -- env PANEL_ADMIN_PASSWORD="$SUPERADMIN_PASSWORD" bash -lc "cd '$APP_DIR/api' && node -e \"const bcrypt=require('bcrypt'); bcrypt.hash(process.env.PANEL_ADMIN_PASSWORD, 12).then((hash)=>console.log(hash))\"")"

log "Writing environment"
write_file "$APP_DIR/.env" <<EOF
SUPERADMIN_USERNAME=$SUPERADMIN_USERNAME
SUPERADMIN_PASSWORD_HASH=$SUPERADMIN_PASSWORD_HASH
JWT_SECRET=$JWT_SECRET
JWT_EXPIRY=86400
TOTP_ISSUER=VPS Panel
TOTP_ENCRYPTION_KEY=$TOTP_ENCRYPTION_KEY
PANEL_PORT=$PANEL_PORT
PANEL_LOGIN_PORT=$PANEL_LOGIN_PORT
PANEL_UPDATE_WEBHOOK_SECRET=$WEBHOOK_SECRET
PANEL_UPDATE_REPO_FULL_NAME=$PANEL_UPDATE_REPO_FULL_NAME
PANEL_UPDATE_BRANCH=$APP_BRANCH
PANEL_UPDATE_WORKDIR=$APP_DIR
PANEL_UPDATE_SCRIPT=$APP_DIR/scripts/deploy/update-panel.sh
PANEL_UPDATE_STATUS_FILE=/var/log/vps-panel/self-update-status.json
PANEL_UPDATE_LOG_FILE=/var/log/vps-panel/self-update.log
PANEL_UPDATE_PID_FILE=/tmp/vps-panel-self-update.pid
PANEL_UPDATE_API_SERVICE=vps-panel-api
PANEL_UPDATE_SERVICES=vps-panel-sysagent vps-panel-workers vps-panel-frontend vps-panel-api
PANEL_UPDATE_DIRTY_STRATEGY=fail
PANEL_UPDATE_COMMAND_TIMEOUT=30
PANEL_UPDATE_SYSTEMCTL_NO_BLOCK=true
PANEL_UPDATE_SERVICE_ACTIVE_ATTEMPTS=20
PANEL_UPDATE_STALE_AFTER_SECONDS=1200
FRONTEND_URL=http://$VPS_IP:$PANEL_LOGIN_PORT
NEXT_PUBLIC_API_URL=http://$VPS_IP:$PANEL_LOGIN_PORT/api/v1
NEXT_PUBLIC_PANEL_LOGIN_PORT=$PANEL_LOGIN_PORT
DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME
DIRECT_DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME
REDIS_URL=redis://localhost:6379
SYSAGENT_URL=http://127.0.0.1:$SYSAGENT_PORT
VPS_IP=$VPS_IP
REQUIRE_DOMAIN_NAMESERVER_MATCH=true
ALLOW_VANITY_NAMESERVER_GLUE_FALLBACK=true
ALLOW_PENDING_VANITY_NAMESERVER_DOMAINS=true
DOMAIN_NAMESERVER_RESOLVERS=1.1.1.1,8.8.8.8,9.9.9.9
DOMAIN_NAMESERVER_DOH_URLS=https://cloudflare-dns.com/dns-query,https://dns.google/resolve,https://dns.quad9.net/dns-query
FILE_MANAGER_ROOT=/var/www
ALLOW_LIVE_SYSTEM_COMMANDS=true
ALLOW_LIVE_FILE_MANAGER=true
ALLOW_LIVE_DNS=true
ALLOW_LIVE_NGINX=true
ALLOW_LIVE_SSL=true
EOF
chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
chmod 0640 "$APP_DIR/.env"

log "Preparing runtime directories"
install -d -m 0775 -o "$APP_USER" -g "$APP_USER" /var/log/vps-panel
install -d -m 0755 /var/www
chmod +x "$APP_DIR/scripts/deploy/update-panel.sh"
git config --global --add safe.directory "$APP_DIR" || true

log "Building application"
runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR/api' && npm run prisma:generate && npx prisma migrate deploy && npm run build"
runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR/frontend' && npm run build"

log "Writing systemd services"
write_file /etc/systemd/system/vps-panel-api.service <<EOF
[Unit]
Description=VPS Panel API
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/api
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

write_file /etc/systemd/system/vps-panel-workers.service <<EOF
[Unit]
Description=VPS Panel Workers
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/api
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/npm run start:workers
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

write_file /etc/systemd/system/vps-panel-frontend.service <<EOF
[Unit]
Description=VPS Panel Frontend
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/frontend
EnvironmentFile=$APP_DIR/.env
Environment=PORT=$FRONTEND_PORT
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

write_file /etc/systemd/system/vps-panel-sysagent.service <<EOF
[Unit]
Description=VPS Panel System Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/sysagent
EnvironmentFile=$APP_DIR/.env
ExecStart=$APP_DIR/sysagent/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port $SYSAGENT_PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

log "Writing Nginx panel listener"
rm -f /etc/nginx/sites-enabled/default
write_file /etc/nginx/sites-available/vps-panel-2083 <<EOF
server {
    listen $PANEL_LOGIN_PORT;
    server_name $VPS_IP _;

    client_max_body_size 100M;

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
    }
}
EOF
ln -sf /etc/nginx/sites-available/vps-panel-2083 /etc/nginx/sites-enabled/vps-panel-2083

log "Writing sudoers for panel self-update"
SYSTEMCTL_BIN="$(command -v systemctl)"
write_file /etc/sudoers.d/vps-panel-update <<EOF
$APP_USER ALL=(root) NOPASSWD: $SYSTEMCTL_BIN --no-block restart vps-panel-sysagent, $SYSTEMCTL_BIN is-active vps-panel-sysagent, $SYSTEMCTL_BIN status vps-panel-sysagent, $SYSTEMCTL_BIN --no-block restart vps-panel-api, $SYSTEMCTL_BIN is-active vps-panel-api, $SYSTEMCTL_BIN status vps-panel-api, $SYSTEMCTL_BIN --no-block restart vps-panel-workers, $SYSTEMCTL_BIN is-active vps-panel-workers, $SYSTEMCTL_BIN status vps-panel-workers, $SYSTEMCTL_BIN --no-block restart vps-panel-frontend, $SYSTEMCTL_BIN is-active vps-panel-frontend, $SYSTEMCTL_BIN status vps-panel-frontend
EOF
chmod 0440 /etc/sudoers.d/vps-panel-update
visudo -c -f /etc/sudoers.d/vps-panel-update

log "Opening firewall ports"
ufw allow "$PANEL_LOGIN_PORT/tcp" || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw allow 53/tcp || true
ufw allow 53/udp || true

log "Starting services"
systemctl daemon-reload
systemctl enable --now vps-panel-sysagent vps-panel-api vps-panel-workers vps-panel-frontend nginx bind9 redis-server postgresql
nginx -t
systemctl reload nginx

log "Install complete"
cat <<EOF

Panel URL: http://$VPS_IP:$PANEL_LOGIN_PORT/login
Username:  $SUPERADMIN_USERNAME
Password:  $SUPERADMIN_PASSWORD

Webhook URL: http://$VPS_IP:$PANEL_LOGIN_PORT/api/v1/webhooks/panel-update
Webhook secret: $WEBHOOK_SECRET

Save these credentials now. The password is not stored in plaintext.
EOF
