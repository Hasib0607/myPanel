#!/usr/bin/env bash
# Shared VPS panel installer functions. Source from OS-specific installers.

detect_vps_ip() {
  local ip=""
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  if [[ -z "$ip" ]]; then
    ip="$(hostname -i 2>/dev/null | awk '{print $1}')" || true
  fi
  echo "${ip:-127.0.0.1}"
}

: "${APP_DIR:=/opt/vps-panel}"
: "${APP_USER:=panel}"
: "${APP_BRANCH:=main}"
: "${REPO_URL:=}"
: "${PANEL_LOGIN_PORT:=8453}"
: "${CPANEL_LOGIN_PORT:=3138}"
: "${PANEL_PORT:=4000}"
: "${FRONTEND_PORT:=3000}"
: "${SYSAGENT_PORT:=5000}"
: "${PANEL_NGINX_SITE:=00-vps-panel}"
: "${DEPLOYMENT_PORT_START:=10000}"
: "${DEPLOYMENT_PORT_END:=19999}"
: "${DEPLOYMENT_RESERVED_PORTS:=22,25,53,80,110,143,443,465,587,993,995,$CPANEL_LOGIN_PORT,$PANEL_LOGIN_PORT,$FRONTEND_PORT,$PANEL_PORT,$SYSAGENT_PORT,5432,6379}"
: "${DB_NAME:=panel_main}"
: "${DB_USER:=panel_user}"
if [[ -z "${DB_PASSWORD+x}" ]]; then
  DB_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  DB_PASSWORD_WAS_GENERATED=true
else
  DB_PASSWORD_WAS_GENERATED=false
fi
export DB_PASSWORD DB_PASSWORD_WAS_GENERATED
: "${DB_HOST:=localhost}"
: "${DB_PORT:=5432}"
: "${DB_CREATE:=true}"
: "${DATABASE_URL:=postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME}"
: "${DIRECT_DATABASE_URL:=$DATABASE_URL}"
: "${SUPERADMIN_USERNAME:=admin}"
if [[ -z "${SUPERADMIN_PASSWORD+x}" ]]; then
  SUPERADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-18)"
  SUPERADMIN_PASSWORD_WAS_GENERATED=true
else
  SUPERADMIN_PASSWORD_WAS_GENERATED=false
fi
SUPERADMIN_PASSWORD_OUTPUT="$SUPERADMIN_PASSWORD"
export SUPERADMIN_PASSWORD SUPERADMIN_PASSWORD_WAS_GENERATED SUPERADMIN_PASSWORD_OUTPUT
: "${VPS_IP:=$(detect_vps_ip)}"
: "${PANEL_DOMAIN:=}"
: "${PANEL_PUBLIC_HOST:=${PANEL_DOMAIN:-$VPS_IP}}"
: "${PANEL_UPDATE_REPO_FULL_NAME:=}"
: "${PANEL_UPDATE_GIT_USERNAME:=}"
: "${PANEL_UPDATE_GIT_TOKEN:=}"
: "${WEB_GROUP:=www-data}"
: "${REDIS_SERVICE:=redis-server}"
: "${BIND_SYSTEMD_SERVICE:=bind9}"
: "${NGINX_SITES_AVAILABLE:=/etc/nginx/sites-available}"
: "${NGINX_SITES_ENABLED:=/etc/nginx/sites-enabled}"
: "${DRY_RUN:=false}"
: "${INSTALL_LOG_FILE:=/var/log/vps-panel/install.log}"
: "${INSTALL_STATE_DIR:=/var/log/vps-panel/install-state}"
: "${RESUME_INSTALL:=true}"
: "${FORCE_STEP:=false}"
: "${AUTO_SSL:=false}"
: "${SSL_EMAIL:=}"
: "${PANEL_PUBLIC_SCHEME:=http}"
: "${MIN_DISK_GB:=8}"
: "${MIN_MEM_MB:=900}"

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*"
}

mask_url_secret() {
  local url="$1"
  echo "$url" | sed -E 's#(://[^:/@]+:)[^@]+@#\1****@#'
}

env_file_value() {
  local key="$1"
  local file="${2:-$APP_DIR/.env}"
  if [[ ! -f "$file" ]]; then
    return 1
  fi
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

database_password_from_url() {
  local url="$1"
  python3 - "$url" <<'PY'
import sys
from urllib.parse import unquote, urlparse

parsed = urlparse(sys.argv[1])
print(unquote(parsed.password or ""))
PY
}

sync_database_credentials_from_existing_env() {
  if [[ "$DB_PASSWORD_WAS_GENERATED" != "true" ]]; then
    return
  fi
  local existing_database_url existing_direct_database_url existing_password
  existing_database_url="$(env_file_value DATABASE_URL || true)"
  if [[ -z "$existing_database_url" ]]; then
    return
  fi
  existing_direct_database_url="$(env_file_value DIRECT_DATABASE_URL || true)"
  existing_password="$(database_password_from_url "$existing_database_url")"
  if [[ -z "$existing_password" ]]; then
    return
  fi
  DATABASE_URL="$existing_database_url"
  DIRECT_DATABASE_URL="${existing_direct_database_url:-$existing_database_url}"
  DB_PASSWORD="$existing_password"
  export DATABASE_URL DIRECT_DATABASE_URL DB_PASSWORD
}

write_file() {
  local path="$1"
  install -d -m 0755 "$(dirname "$path")"
  cat > "$path"
}

require_root() {
  if [[ "$(id -u)" != "0" ]]; then
    echo "Run as root: sudo $0"
    exit 1
  fi
}

require_repo_url() {
  if [[ -z "$REPO_URL" && ! -d "$APP_DIR/.git" ]]; then
    echo "Set REPO_URL, for example:"
    echo "REPO_URL=https://github.com/owner/myPanel.git sudo -E bash $0"
    exit 2
  fi
}

setup_install_logging() {
  if [[ -n "${INSTALL_LOGGING_READY:-}" ]]; then
    return
  fi
  install -d -m 0755 "$(dirname "$INSTALL_LOG_FILE")"
  touch "$INSTALL_LOG_FILE"
  chmod 0600 "$INSTALL_LOG_FILE"
  export INSTALL_LOGGING_READY=true
  exec > >(tee -a "$INSTALL_LOG_FILE") 2>&1
  log "Installer log file: $INSTALL_LOG_FILE"
}

require_db_identifier() {
  local value="$1"
  local label="$2"
  if [[ ! "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "$label must be a PostgreSQL-safe identifier: letters, numbers, and underscores only; first character must not be a number."
    exit 2
  fi
}

validate_bootstrap_inputs() {
  if [[ "$DB_CREATE" == "true" && ( "$DB_HOST" == "localhost" || "$DB_HOST" == "127.0.0.1" ) ]]; then
    require_db_identifier "$DB_NAME" "DB_NAME"
    require_db_identifier "$DB_USER" "DB_USER"
  fi
  for port_var in PANEL_LOGIN_PORT CPANEL_LOGIN_PORT PANEL_PORT FRONTEND_PORT SYSAGENT_PORT DB_PORT; do
    local port="${!port_var}"
    if [[ ! "$port" =~ ^[0-9]+$ || "$port" -lt 1 || "$port" -gt 65535 ]]; then
      echo "$port_var must be a TCP port between 1 and 65535."
      exit 2
    fi
  done
}

is_ip_address() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ || "$1" =~ : ]]
}

check_port_free() {
  local port="$1"
  if command -v ss >/dev/null 2>&1 && ss -ltn "( sport = :$port )" 2>/dev/null | awk 'NR>1 { found=1 } END { exit found ? 0 : 1 }'; then
    echo "Port $port is already in use."
    exit 2
  fi
  if command -v lsof >/dev/null 2>&1 && lsof -PiTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "Port $port is already in use."
    exit 2
  fi
}

run_preflight_checks() {
  log "Running preflight checks"

  local disk_kb disk_gb mem_mb
  disk_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
  disk_gb=$((disk_kb / 1024 / 1024))
  if (( disk_gb < MIN_DISK_GB )); then
    echo "At least ${MIN_DISK_GB}GB free disk is required on /. Found ${disk_gb}GB."
    exit 2
  fi

  mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
  if (( mem_mb > 0 && mem_mb < MIN_MEM_MB )); then
    echo "At least ${MIN_MEM_MB}MB RAM is required. Found ${mem_mb}MB."
    exit 2
  fi

  if [[ "$RESUME_INSTALL" == "true" && -d "$INSTALL_STATE_DIR" ]]; then
    log "Existing installer state found; skipping strict port-free checks for resume mode"
  else
    for port in "$PANEL_LOGIN_PORT" "$CPANEL_LOGIN_PORT" "$PANEL_PORT" "$FRONTEND_PORT" "$SYSAGENT_PORT"; do
      check_port_free "$port"
    done
  fi

  if [[ -n "$PANEL_DOMAIN" ]] && ! is_ip_address "$PANEL_DOMAIN"; then
    local resolved=""
    resolved="$(getent ahostsv4 "$PANEL_DOMAIN" 2>/dev/null | awk '{print $1; exit}')" || true
    if [[ -z "$resolved" ]]; then
      echo "Warning: $PANEL_DOMAIN does not resolve yet. SSL issuance may fail until DNS points to this server."
    elif [[ "$resolved" != "$VPS_IP" ]]; then
      echo "Warning: $PANEL_DOMAIN resolves to $resolved, but this server IP looks like $VPS_IP."
    fi
  fi
}

validate_database_connection() {
  log "Checking database connectivity"
  sync_database_credentials_from_existing_env
  if [[ "$DB_CREATE" == "true" && ( "$DB_HOST" == "localhost" || "$DB_HOST" == "127.0.0.1" ) ]]; then
    runuser -u postgres -- psql -d "$DB_NAME" -c "select 1" >/dev/null
  else
    psql "$DATABASE_URL" -c "select 1" >/dev/null
  fi
}

run_step() {
  local name="$1"
  shift
  local marker="$INSTALL_STATE_DIR/$name.done"
  install -d -m 0755 "$INSTALL_STATE_DIR"
  if [[ "$RESUME_INSTALL" == "true" && "$FORCE_STEP" != "true" && -f "$marker" ]]; then
    log "Skipping completed step: $name"
    return
  fi
  log "Starting step: $name"
  "$@"
  touch "$marker"
  log "Completed step: $name"
}

print_bootstrap_plan() {
  cat <<EOF
VPS Panel bootstrap plan

OS installer:      auto-detected by scripts/install/install.sh
Repository:        ${REPO_URL:-existing checkout at $APP_DIR}
Branch:            $APP_BRANCH
App directory:     $APP_DIR
App user:          $APP_USER
Public host:       $PANEL_PUBLIC_HOST
WHM/Admin port:    $PANEL_LOGIN_PORT
cPanel port:       $CPANEL_LOGIN_PORT
API port:          $PANEL_PORT
Frontend port:     $FRONTEND_PORT
Sysagent port:     $SYSAGENT_PORT
Database URL:      $(mask_url_secret "$DATABASE_URL")
Create database:   $DB_CREATE
Admin username:    $SUPERADMIN_USERNAME

The database will start empty apart from Prisma migration metadata.
EOF
}

maybe_exit_dry_run() {
  if [[ "$DRY_RUN" == "true" ]]; then
    print_bootstrap_plan
    exit 0
  fi
}

ensure_app_user() {
  log "Creating app user"
  if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd --system --create-home --shell /bin/bash "$APP_USER"
  fi
}

configure_app_git_credentials() {
  log "Configuring persistent Git credentials for $APP_USER"
  git config --global credential.helper store || true
  git config --global --add safe.directory "$APP_DIR" || true
  runuser -u "$APP_USER" -- git config --global credential.helper store || true
  runuser -u "$APP_USER" -- git config --global --add safe.directory "$APP_DIR" || true

  if [[ -f /root/.git-credentials && ! -f "/home/$APP_USER/.git-credentials" ]]; then
    install -o "$APP_USER" -g "$APP_USER" -m 0600 /root/.git-credentials "/home/$APP_USER/.git-credentials" || true
  fi
}

repair_app_workspace_permissions() {
  if [[ -d "$APP_DIR" ]]; then
    log "Repairing app workspace permissions"
    chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  fi
}

sync_app_repo() {
  log "Preparing app directory"
  configure_app_git_credentials
  install -d -m 0755 "$APP_DIR"
  chown "$APP_USER:$APP_USER" "$APP_DIR"
  repair_app_workspace_permissions
  if [[ -d "$APP_DIR/.git" ]]; then
    runuser -u "$APP_USER" -- git -C "$APP_DIR" fetch origin "$APP_BRANCH"
    runuser -u "$APP_USER" -- git -C "$APP_DIR" checkout "$APP_BRANCH"
    runuser -u "$APP_USER" -- git -C "$APP_DIR" pull --ff-only origin "$APP_BRANCH"
  else
    runuser -u "$APP_USER" -- git clone --branch "$APP_BRANCH" "$REPO_URL" "$APP_DIR"
  fi
}

install_node_dependencies() {
  log "Installing Node dependencies"
  runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR' && npm install"
  npm install -g pm2
  pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
  pm2 save --force >/dev/null 2>&1 || true
}

install_sysagent_venv() {
  log "Installing sysagent Python dependencies"
  runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR/sysagent' && python3 -m venv .venv && . .venv/bin/activate && pip install --upgrade pip && pip install -r requirements.txt"
}

write_panel_env() {
  log "Generating secrets"
  sync_database_credentials_from_existing_env
  local existing_jwt existing_totp existing_webhook existing_admin_hash existing_database_url existing_direct_database_url
  existing_jwt="$(env_file_value JWT_SECRET || true)"
  existing_totp="$(env_file_value TOTP_ENCRYPTION_KEY || true)"
  existing_webhook="$(env_file_value PANEL_UPDATE_WEBHOOK_SECRET || true)"
  existing_admin_hash="$(env_file_value SUPERADMIN_PASSWORD_HASH || true)"
  existing_database_url="$(env_file_value DATABASE_URL || true)"
  existing_direct_database_url="$(env_file_value DIRECT_DATABASE_URL || true)"

  JWT_SECRET="${existing_jwt:-$(openssl rand -base64 48 | tr -d '\n')}"
  TOTP_ENCRYPTION_KEY="${existing_totp:-$(openssl rand -base64 32 | tr -d '\n')}"
  WEBHOOK_SECRET="${existing_webhook:-$(openssl rand -hex 32)}"
  if [[ "$DB_PASSWORD_WAS_GENERATED" == "true" && -n "$existing_database_url" ]]; then
    DATABASE_URL="$existing_database_url"
    DIRECT_DATABASE_URL="${existing_direct_database_url:-$existing_database_url}"
  fi
  if [[ "$SUPERADMIN_PASSWORD_WAS_GENERATED" == "true" && -n "$existing_admin_hash" ]]; then
    SUPERADMIN_PASSWORD_HASH="$existing_admin_hash"
    SUPERADMIN_PASSWORD_OUTPUT="(unchanged; existing admin password kept)"
  else
    SUPERADMIN_PASSWORD_HASH="$(runuser -u "$APP_USER" -- env PANEL_ADMIN_PASSWORD="$SUPERADMIN_PASSWORD" bash -lc "cd '$APP_DIR/api' && node -e \"const bcrypt=require('bcrypt'); bcrypt.hash(process.env.PANEL_ADMIN_PASSWORD, 12).then((hash)=>console.log(hash))\"")"
    SUPERADMIN_PASSWORD_OUTPUT="$SUPERADMIN_PASSWORD"
  fi

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
CPANEL_LOGIN_PORT=$CPANEL_LOGIN_PORT
DEPLOYMENT_PORT_START=$DEPLOYMENT_PORT_START
DEPLOYMENT_PORT_END=$DEPLOYMENT_PORT_END
DEPLOYMENT_RESERVED_PORTS=$DEPLOYMENT_RESERVED_PORTS
DEPLOYMENT_LOG_ROOT=/var/log/vps-panel/deployments
DEPLOY_WORKER_CONCURRENCY=2
PANEL_UPDATE_WEBHOOK_SECRET=$WEBHOOK_SECRET
PANEL_UPDATE_REPO_FULL_NAME=$PANEL_UPDATE_REPO_FULL_NAME
PANEL_UPDATE_GIT_USERNAME=$PANEL_UPDATE_GIT_USERNAME
PANEL_UPDATE_GIT_TOKEN=$PANEL_UPDATE_GIT_TOKEN
PANEL_UPDATE_BRANCH=$APP_BRANCH
PANEL_UPDATE_WORKDIR=$APP_DIR
PANEL_UPDATE_SCRIPT=$APP_DIR/scripts/deploy/update-panel.sh
PANEL_UPDATE_STATUS_FILE=/var/log/vps-panel/self-update-status.json
PANEL_UPDATE_LOG_FILE=/var/log/vps-panel/self-update.log
PANEL_UPDATE_PID_FILE=/tmp/vps-panel-self-update.pid
PANEL_UPDATE_API_SERVICE=vps-panel-api
PANEL_UPDATE_SERVICES=vps-panel-sysagent vps-panel-workers vps-panel-guardian vps-panel-frontend vps-panel-api
PANEL_UPDATE_DIRTY_STRATEGY=fail
PANEL_UPDATE_COMMAND_TIMEOUT=30
PANEL_UPDATE_SYSTEMCTL_NO_BLOCK=true
PANEL_UPDATE_SERVICE_ACTIVE_ATTEMPTS=20
PANEL_UPDATE_STALE_AFTER_SECONDS=1200
PANEL_UPDATE_POLL_ENABLED=true
PANEL_UPDATE_POLL_REMOTE=origin
PANEL_UPDATE_POLL_INTERVAL_MS=60000
FRONTEND_URL=$PANEL_PUBLIC_SCHEME://$PANEL_PUBLIC_HOST:$PANEL_LOGIN_PORT
NEXT_PUBLIC_API_URL=$PANEL_PUBLIC_SCHEME://$PANEL_PUBLIC_HOST:$PANEL_LOGIN_PORT/api/v1
NEXT_PUBLIC_PANEL_LOGIN_PORT=$PANEL_LOGIN_PORT
NEXT_PUBLIC_CPANEL_LOGIN_PORT=$CPANEL_LOGIN_PORT
DATABASE_URL=$DATABASE_URL
DIRECT_DATABASE_URL=$DIRECT_DATABASE_URL
REDIS_URL=redis://localhost:6379
SYSAGENT_URL=http://127.0.0.1:$SYSAGENT_PORT
VPS_IP=$VPS_IP
DEPLOYMENT_COMMAND_TIMEOUT_SECONDS=900
REQUIRE_DOMAIN_NAMESERVER_MATCH=true
ALLOW_PENDING_DOMAIN_NAMESERVER_MISMATCH=true
ALLOW_VANITY_NAMESERVER_GLUE_FALLBACK=true
ALLOW_PENDING_VANITY_NAMESERVER_DOMAINS=true
DOMAIN_NAMESERVER_RESOLVERS=1.1.1.1,8.8.8.8,9.9.9.9
DOMAIN_NAMESERVER_DOH_URLS=https://cloudflare-dns.com/dns-query,https://dns.google/resolve,https://dns.quad9.net/dns-query
FILE_MANAGER_ROOT=/var/www
NGINX_SITES_AVAILABLE=$NGINX_SITES_AVAILABLE
NGINX_SITES_ENABLED=$NGINX_SITES_ENABLED
ALLOW_LIVE_SYSTEM_COMMANDS=true
ALLOW_LIVE_FILE_MANAGER=true
ALLOW_LIVE_DNS=true
ALLOW_LIVE_NGINX=true
ALLOW_LIVE_SSL=true
GUARDIAN_AUTO_HEAL=true
GUARDIAN_AUTO_DEPLOY_REPAIR=true
GUARDIAN_DEPLOYMENT_DOCTOR_INTERVAL_MS=300000
GUARDIAN_SSL_RENEW_ENABLED=true
GUARDIAN_SSL_RENEW_INTERVAL_MS=43200000
DEPLOY_GUARDIAN_RECOVERY_ATTEMPTS=3
EOF
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 0640 "$APP_DIR/.env"
  ln -sfn ../.env "$APP_DIR/api/.env"
  ln -sfn ../.env "$APP_DIR/frontend/.env.production"
  ln -sfn ../.env "$APP_DIR/sysagent/.env"
  chown -h "$APP_USER:$APP_USER" "$APP_DIR/api/.env" "$APP_DIR/frontend/.env.production" "$APP_DIR/sysagent/.env"
}

prepare_runtime_directories() {
  log "Preparing runtime directories"
  install -d -m 0775 -o "$APP_USER" -g "$APP_USER" /var/log/vps-panel
  install -d -m 0775 -o root -g "$APP_USER" /var/log/vps-panel/deployments
  install -d -m 2775 -o "$APP_USER" -g "$WEB_GROUP" /var/www /var/www/deployments
  setfacl -m "u:$APP_USER:rwx,u:$WEB_GROUP:rwx" /var/www /var/www/deployments || true
  setfacl -d -m "u:$APP_USER:rwx,u:$WEB_GROUP:rwx" /var/www /var/www/deployments || true
  chmod +x "$APP_DIR/scripts/deploy/update-panel.sh"
  chmod +x "$APP_DIR/scripts/maintenance/repair-panel-permissions.sh" 2>/dev/null || true
  git config --global --add safe.directory "$APP_DIR" || true
}

build_application() {
  log "Building application"
  repair_app_workspace_permissions
  if [[ "$DB_CREATE" == "true" && ( "$DB_HOST" == "localhost" || "$DB_HOST" == "127.0.0.1" ) ]]; then
    create_postgresql_database
  fi
  runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR/api' && npm run prisma:generate && npx prisma migrate deploy && npm run build"
  if ! runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR/frontend' && npm run build"; then
    log "Frontend build failed; cleaning stale build artifacts and retrying once"
    rm -rf "$APP_DIR/frontend/.next" "$APP_DIR/frontend/.next.tmp" "$APP_DIR/frontend/node_modules/.cache" || true
    chown -R "$APP_USER:$APP_USER" "$APP_DIR/frontend"
    runuser -u "$APP_USER" -- bash -lc "cd '$APP_DIR/frontend' && npm cache clean --force || true && npm run build"
  fi
}

write_systemd_services() {
  log "Writing systemd services"
  write_file /etc/systemd/system/vps-panel-api.service <<EOF
[Unit]
Description=VPS Panel API
After=network.target postgresql.service ${REDIS_SERVICE}.service

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
After=network.target postgresql.service ${REDIS_SERVICE}.service

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

  write_file /etc/systemd/system/vps-panel-guardian.service <<EOF
[Unit]
Description=VPS Panel Guardian Scheduler
After=network.target postgresql.service ${REDIS_SERVICE}.service vps-panel-workers.service vps-panel-sysagent.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/api
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/npm run guardian
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
ExecStart=/usr/bin/npm run start -- -p $FRONTEND_PORT
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
EnvironmentFile=-$APP_DIR/.env
Environment=ALLOW_LIVE_SYSTEM_COMMANDS=true
Environment=ALLOW_LIVE_FILE_MANAGER=true
Environment=ALLOW_LIVE_NGINX=true
Environment=ALLOW_LIVE_SSL=true
Environment=ALLOW_LIVE_DNS=true
ExecStart=$APP_DIR/sysagent/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port $SYSAGENT_PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

  write_file /etc/systemd/system/vps-panel-self-update.service <<EOF
[Unit]
Description=VPS Panel Self Update
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=PANEL_UPDATE_ISOLATED=true
ExecStart=/usr/bin/env PANEL_UPDATE_ISOLATED=true /usr/bin/bash $APP_DIR/scripts/deploy/update-panel.sh
KillMode=process
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
}

write_panel_nginx_config() {
  log "Writing Nginx panel listener"
  install -d -m 0755 "$NGINX_SITES_AVAILABLE" "$NGINX_SITES_ENABLED"
  rm -f "$NGINX_SITES_ENABLED/default"
  rm -f "$NGINX_SITES_ENABLED/vps-panel" "$NGINX_SITES_ENABLED/vps-panel-2083"
  rm -f "$NGINX_SITES_AVAILABLE/vps-panel" "$NGINX_SITES_AVAILABLE/vps-panel-2083"
  write_file "$NGINX_SITES_AVAILABLE/$PANEL_NGINX_SITE" <<EOF
# Protected panel listener. Domain/project publishing must never overwrite this file.
server {
    listen $PANEL_LOGIN_PORT$(if [[ "$PANEL_PUBLIC_SCHEME" == "https" && -n "$PANEL_DOMAIN" ]]; then printf " ssl"; fi);
    server_name $PANEL_PUBLIC_HOST $VPS_IP _;

    client_max_body_size 100M;
$(if [[ "$PANEL_PUBLIC_SCHEME" == "https" && -n "$PANEL_DOMAIN" ]]; then cat <<SSL
    ssl_certificate /etc/letsencrypt/live/$PANEL_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$PANEL_DOMAIN/privkey.pem;
SSL
fi)

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
    listen $CPANEL_LOGIN_PORT$(if [[ "$PANEL_PUBLIC_SCHEME" == "https" && -n "$PANEL_DOMAIN" ]]; then printf " ssl"; fi);
    server_name $PANEL_PUBLIC_HOST $VPS_IP _;

    client_max_body_size 100M;
$(if [[ "$PANEL_PUBLIC_SCHEME" == "https" && -n "$PANEL_DOMAIN" ]]; then cat <<SSL
    ssl_certificate /etc/letsencrypt/live/$PANEL_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$PANEL_DOMAIN/privkey.pem;
SSL
fi)

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
  ln -sf "$NGINX_SITES_AVAILABLE/$PANEL_NGINX_SITE" "$NGINX_SITES_ENABLED/$PANEL_NGINX_SITE"
}

issue_panel_ssl_certificate() {
  if [[ "$AUTO_SSL" != "true" ]]; then
    return
  fi
  if [[ -z "$PANEL_DOMAIN" ]] || is_ip_address "$PANEL_DOMAIN"; then
    log "Skipping SSL: --domain must be a DNS name, not an IP address"
    return
  fi
  log "Issuing Let's Encrypt certificate for $PANEL_DOMAIN"
  local email_args=(--register-unsafely-without-email)
  if [[ -n "$SSL_EMAIL" ]]; then
    email_args=(-m "$SSL_EMAIL")
  fi
  systemctl stop nginx >/dev/null 2>&1 || true
  certbot certonly --standalone --non-interactive --agree-tos "${email_args[@]}" -d "$PANEL_DOMAIN"
  PANEL_PUBLIC_SCHEME=https
  export PANEL_PUBLIC_SCHEME
}

configure_certbot_auto_renewal() {
  log "Configuring Certbot auto-renewal"
  install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
  write_file /etc/letsencrypt/renewal-hooks/deploy/vps-panel-reload-nginx.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if command -v systemctl >/dev/null 2>&1; then
  systemctl reload nginx >/dev/null 2>&1 || systemctl restart nginx >/dev/null 2>&1 || true
fi
EOF
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/vps-panel-reload-nginx.sh

  local enabled_timer=false
  for timer in certbot.timer certbot-renew.timer snap.certbot.renew.timer; do
    if systemctl list-unit-files "$timer" >/dev/null 2>&1; then
      systemctl enable --now "$timer" >/dev/null 2>&1 && enabled_timer=true && log "Enabled $timer" && break
    fi
  done

  if [[ "$enabled_timer" != "true" ]]; then
    log "Certbot systemd timer not found; installing daily cron fallback"
    write_file /etc/cron.d/vps-panel-certbot-renew <<EOF
SHELL=/bin/bash
PATH=/sbin:/bin:/usr/sbin:/usr/bin
17 3,15 * * * root certbot renew --quiet --deploy-hook "systemctl reload nginx >/dev/null 2>&1 || systemctl restart nginx >/dev/null 2>&1 || true"
EOF
    chmod 0644 /etc/cron.d/vps-panel-certbot-renew
  fi
}

write_update_sudoers() {
  log "Writing sudoers for panel self-update"
  SYSTEMCTL_BIN="$(command -v systemctl)"
  write_file /etc/sudoers.d/vps-panel-update <<EOF
$APP_USER ALL=(root) NOPASSWD: $SYSTEMCTL_BIN --no-block restart vps-panel-sysagent, $SYSTEMCTL_BIN is-active vps-panel-sysagent, $SYSTEMCTL_BIN status vps-panel-sysagent, $SYSTEMCTL_BIN --no-block restart vps-panel-api, $SYSTEMCTL_BIN is-active vps-panel-api, $SYSTEMCTL_BIN status vps-panel-api, $SYSTEMCTL_BIN --no-block restart vps-panel-workers, $SYSTEMCTL_BIN is-active vps-panel-workers, $SYSTEMCTL_BIN status vps-panel-workers, $SYSTEMCTL_BIN --no-block restart vps-panel-guardian, $SYSTEMCTL_BIN is-active vps-panel-guardian, $SYSTEMCTL_BIN status vps-panel-guardian, $SYSTEMCTL_BIN --no-block restart vps-panel-frontend, $SYSTEMCTL_BIN is-active vps-panel-frontend, $SYSTEMCTL_BIN status vps-panel-frontend
$APP_USER ALL=(root) NOPASSWD: $SYSTEMCTL_BIN start vps-panel-self-update, $SYSTEMCTL_BIN is-active vps-panel-self-update, $SYSTEMCTL_BIN status vps-panel-self-update
$APP_USER ALL=(root) NOPASSWD: $APP_DIR/scripts/maintenance/repair-panel-permissions.sh
EOF
  chmod 0440 /etc/sudoers.d/vps-panel-update
  visudo -c -f /etc/sudoers.d/vps-panel-update
}

create_postgresql_database() {
  if [[ "$DB_CREATE" != "true" ]]; then
    log "Skipping PostgreSQL database creation because DB_CREATE=$DB_CREATE"
    return
  fi
  if [[ "$DB_HOST" != "localhost" && "$DB_HOST" != "127.0.0.1" ]]; then
    log "Skipping PostgreSQL database creation for remote DB_HOST=$DB_HOST"
    return
  fi
  sync_database_credentials_from_existing_env
  require_db_identifier "$DB_NAME" "DB_NAME"
  require_db_identifier "$DB_USER" "DB_USER"
  local db_password_sql="${DB_PASSWORD//\'/\'\'}"
  log "Creating PostgreSQL database"
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE $DB_USER LOGIN PASSWORD '$db_password_sql';
  ELSE
    ALTER ROLE $DB_USER WITH PASSWORD '$db_password_sql';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE $DB_NAME OWNER $DB_USER'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')\gexec
ALTER DATABASE $DB_NAME OWNER TO $DB_USER;
GRANT CONNECT, TEMPORARY ON DATABASE $DB_NAME TO $DB_USER;
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
SQL
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 -d "$DB_NAME" <<SQL
ALTER SCHEMA public OWNER TO $DB_USER;
GRANT USAGE, CREATE ON SCHEMA public TO $DB_USER;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO $DB_USER;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO $DB_USER;
SQL
}

start_core_services() {
  log "Starting services"
  systemctl daemon-reload
  systemctl enable --now vps-panel-sysagent vps-panel-api vps-panel-workers vps-panel-guardian vps-panel-frontend nginx "$BIND_SYSTEMD_SERVICE" "$REDIS_SERVICE" postgresql
  systemctl restart vps-panel-sysagent vps-panel-api vps-panel-workers vps-panel-guardian vps-panel-frontend
  nginx -t
  systemctl reload nginx
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local attempts="${3:-45}"
  local delay="${4:-1}"
  local attempt=1
  while (( attempt <= attempts )); do
    if curl --fail --silent --show-error "$url" >/dev/null; then
      return 0
    fi
    if (( attempt == 1 || attempt % 5 == 0 )); then
      log "Waiting for $label at $url ($attempt/$attempts)"
    fi
    sleep "$delay"
    attempt=$((attempt + 1))
  done
  log "$label did not become healthy at $url"
  return 1
}

wait_for_head() {
  local url="$1"
  local label="$2"
  local attempts="${3:-45}"
  local delay="${4:-1}"
  local attempt=1
  while (( attempt <= attempts )); do
    if curl --fail --silent --show-error --insecure --head "$url" >/dev/null; then
      return 0
    fi
    if (( attempt == 1 || attempt % 5 == 0 )); then
      log "Waiting for $label at $url ($attempt/$attempts)"
    fi
    sleep "$delay"
    attempt=$((attempt + 1))
  done
  log "$label did not become healthy at $url"
  return 1
}

diagnose_service_failure() {
  local service="$1"
  log "---- systemctl status $service ----"
  systemctl status "$service" --no-pager -l || true
  log "---- journalctl -u $service ----"
  journalctl -u "$service" -n 80 --no-pager || true
}

run_smoke_tests() {
  log "Running smoke tests"
  wait_for_http "http://127.0.0.1:$SYSAGENT_PORT/health" "sysagent" || { diagnose_service_failure vps-panel-sysagent; return 1; }
  wait_for_http "http://127.0.0.1:$PANEL_PORT/health" "api" || { diagnose_service_failure vps-panel-api; return 1; }
  wait_for_http "http://127.0.0.1:$FRONTEND_PORT/health" "frontend" || { diagnose_service_failure vps-panel-frontend; return 1; }
  wait_for_http "$PANEL_PUBLIC_SCHEME://127.0.0.1:$PANEL_LOGIN_PORT/login" "admin panel listener" || { diagnose_service_failure nginx; return 1; }
  wait_for_http "$PANEL_PUBLIC_SCHEME://127.0.0.1:$CPANEL_LOGIN_PORT/login" "account panel listener" || { diagnose_service_failure nginx; return 1; }
  redis-cli ping >/dev/null
  if [[ "$DB_CREATE" == "true" && ( "$DB_HOST" == "localhost" || "$DB_HOST" == "127.0.0.1" ) ]]; then
    runuser -u postgres -- psql -d "$DB_NAME" -c "select 1" >/dev/null
  else
    psql "$DATABASE_URL" -c "select 1" >/dev/null
  fi
  systemctl is-active --quiet vps-panel-sysagent vps-panel-api vps-panel-workers vps-panel-guardian vps-panel-frontend nginx "$REDIS_SERVICE" postgresql
}

print_install_summary() {
  log "Install complete"
  cat <<EOF

Panel URL: $PANEL_PUBLIC_SCHEME://$PANEL_PUBLIC_HOST:$PANEL_LOGIN_PORT/login
Account URL: $PANEL_PUBLIC_SCHEME://$PANEL_PUBLIC_HOST:$CPANEL_LOGIN_PORT/login
Username:  $SUPERADMIN_USERNAME
Password:  $SUPERADMIN_PASSWORD_OUTPUT

Webhook URL: $PANEL_PUBLIC_SCHEME://$PANEL_PUBLIC_HOST:$PANEL_LOGIN_PORT/api/v1/webhooks/panel-update
Webhook secret: $WEBHOOK_SECRET

Save these credentials now. The password is not stored in plaintext.
EOF
}
