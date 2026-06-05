#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${1:-$(pwd)}"
REDIS_CLI="${REDIS_CLI:-redis-cli}"

if [[ "$(id -u)" != "0" ]]; then
  echo "Run as root" >&2
  exit 1
fi

if [[ ! -d "$APP_DIR/api" || ! -d "$APP_DIR/sysagent" ]]; then
  echo "Usage: $0 /path/to/myPanel" >&2
  exit 2
fi

echo "Stopping workers so no new SSL job starts..."
systemctl stop vps-panel-workers 2>/dev/null || true

echo "Stopping orphan Certbot DNS jobs..."
pkill -TERM -f 'certbot certonly --manual' 2>/dev/null || true
pkill -TERM -f 'vps-panel-certbot-dns' 2>/dev/null || true
sleep 3
pkill -KILL -f 'certbot certonly --manual' 2>/dev/null || true
pkill -KILL -f 'vps-panel-certbot-dns' 2>/dev/null || true

if ! pgrep -f 'certbot certonly --manual|vps-panel-certbot-dns' >/dev/null 2>&1; then
  echo "Removing stale Certbot lock files..."
  rm -f /var/lib/letsencrypt/.certbot.lock \
    /var/log/letsencrypt/.certbot.lock \
    /etc/letsencrypt/.certbot.lock
else
  echo "Certbot is still running; not removing lock files." >&2
fi

echo "Clearing only the BullMQ SSL queue..."
if command -v "$REDIS_CLI" >/dev/null 2>&1; then
  mapfile -t ssl_keys < <("$REDIS_CLI" --scan --pattern 'bull:ssl:*')
  if [[ "${#ssl_keys[@]}" -gt 0 ]]; then
    printf '%s\n' "${ssl_keys[@]}" | xargs -r "$REDIS_CLI" del >/dev/null
    echo "Deleted ${#ssl_keys[@]} SSL queue key(s)."
  else
    echo "No SSL queue keys found."
  fi
else
  echo "redis-cli not found; skipped SSL queue cleanup." >&2
fi

echo "Restarting panel services..."
systemctl restart vps-panel-sysagent 2>/dev/null || true
systemctl restart vps-panel-api 2>/dev/null || true
systemctl restart vps-panel-workers 2>/dev/null || true

echo "Current process check:"
pgrep -af 'certbot certonly --manual|vps-panel-certbot-dns' || true

echo "SSL job reset complete."
