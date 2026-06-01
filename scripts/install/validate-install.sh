#!/usr/bin/env bash
# Post-install validation for Ubuntu 22.04 and AlmaLinux 9 panel setups.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/os.sh
source "$SCRIPT_DIR/lib/os.sh"

: "${APP_DIR:=/opt/vps-panel}"
: "${PANEL_PORT:=4000}"
: "${FRONTEND_PORT:=3000}"
: "${PANEL_LOGIN_PORT:=8453}"
: "${CPANEL_LOGIN_PORT:=3138}"
: "${SYSAGENT_PORT:=5000}"
: "${DB_NAME:=panel_main}"
: "${PANEL_PUBLIC_SCHEME:=http}"
: "${NGINX_SITES_AVAILABLE:=$(default_nginx_sites_available)}"
: "${NGINX_SITES_ENABLED:=$(default_nginx_sites_enabled)}"
: "${REDIS_SERVICE:=$(detect_redis_service)}"
: "${BIND_SERVICE:=$(detect_bind_service)}"

PASS=0
FAIL=0
WARN=0

pass() {
  echo "[PASS] $*"
  PASS=$((PASS + 1))
}

fail() {
  echo "[FAIL] $*"
  FAIL=$((FAIL + 1))
}

warn() {
  echo "[WARN] $*"
  WARN=$((WARN + 1))
}

check_cmd() {
  command -v "$1" >/dev/null 2>&1
}

echo "=== VPS Panel install validation ==="
echo "OS: $(detect_os_id)"
echo

if [[ -d "$APP_DIR/.git" ]]; then pass "App directory $APP_DIR exists"; else fail "Missing $APP_DIR"; fi
if [[ -f "$APP_DIR/.env" ]]; then pass "Environment file present"; else fail "Missing $APP_DIR/.env"; fi

for unit in vps-panel-sysagent vps-panel-api vps-panel-workers vps-panel-frontend nginx postgresql "$REDIS_SERVICE" postfix dovecot; do
  if systemctl is-active --quiet "$unit"; then
    pass "Service active: $unit"
  else
    fail "Service not active: $unit"
  fi
done

if systemctl is-active --quiet "$BIND_SERVICE"; then
  pass "Service active: $BIND_SERVICE"
else
  warn "BIND service ($BIND_SERVICE) not active (optional until DNS used)"
fi

if [[ -d "$NGINX_SITES_AVAILABLE" && -d "$NGINX_SITES_ENABLED" ]]; then
  pass "Nginx sites dirs exist ($NGINX_SITES_AVAILABLE)"
else
  fail "Missing Nginx sites directories"
fi

if is_almalinux_or_rhel; then
  if [[ -f /etc/nginx/conf.d/00-sites-enabled.conf ]]; then
    pass "Alma Nginx include drop-in present"
  else
    warn "Missing /etc/nginx/conf.d/00-sites-enabled.conf (panel_nginx_layout)"
  fi
  if systemctl is-active --quiet firewalld; then
    pass "firewalld active"
  else
    warn "firewalld not active"
  fi
else
  if check_cmd ufw; then pass "UFW installed"; else warn "UFW not installed"; fi
fi

if curl --fail --silent --show-error "http://127.0.0.1:$SYSAGENT_PORT/health" >/dev/null; then
  pass "Sysagent health"
else
  fail "Sysagent health check failed"
fi

if curl --fail --silent --show-error "http://127.0.0.1:$PANEL_PORT/health" >/dev/null; then
  pass "API health"
else
  fail "API health check failed"
fi

for url in "http://127.0.0.1:$FRONTEND_PORT/login" "$PANEL_PUBLIC_SCHEME://127.0.0.1:$PANEL_LOGIN_PORT/login" "$PANEL_PUBLIC_SCHEME://127.0.0.1:$CPANEL_LOGIN_PORT/login"; do
  if curl --fail --silent --show-error --insecure "$url" >/dev/null; then
    pass "HTTP reachable: $url"
  else
    fail "HTTP unreachable: $url"
  fi
done

if check_cmd redis-cli && redis-cli ping >/dev/null 2>&1; then
  pass "Redis ping"
else
  fail "Redis ping failed"
fi

if runuser -u postgres -- psql -d "$DB_NAME" -c "select 1" >/dev/null 2>&1; then
  pass "PostgreSQL $DB_NAME query"
else
  fail "PostgreSQL $DB_NAME query failed"
fi

if curl --fail --silent --show-error "http://127.0.0.1:$SYSAGENT_PORT/system/platform" >/dev/null; then
  pass "Sysagent platform endpoint"
else
  warn "Sysagent /system/platform unavailable (upgrade sysagent if missing)"
fi

echo
echo "Summary: pass=$PASS fail=$FAIL warn=$WARN"
if (( FAIL > 0 )); then
  exit 1
fi
