#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/vps-panel}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
NPM_BIN="${NPM_BIN:-npm}"
HOST="${FRONTEND_HOST:-127.0.0.1}"
LOG_FILE="${FRONTEND_START_LOG_FILE:-/var/log/vps-panel/frontend-start.log}"
FRONTEND_DIR="$APP_DIR/frontend"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  echo "[$(date -Is)] $*" | tee -a "$LOG_FILE"
}

build_frontend() {
  local status=0
  log "building frontend before start"
  set +e
  "$NPM_BIN" run build 2>&1 | tee -a "$LOG_FILE"
  status=${PIPESTATUS[0]}
  set -e
  if [[ "$status" == "0" ]]; then
    return 0
  fi

  log "frontend build failed with exit code $status; cleaning stale artifacts and retrying once"
  rm -rf .next .next.tmp node_modules/.cache || true
  "$NPM_BIN" cache clean --force 2>&1 | tee -a "$LOG_FILE" || true
  "$NPM_BIN" run build 2>&1 | tee -a "$LOG_FILE"
}

cd "$FRONTEND_DIR"

if [[ ! -x node_modules/.bin/next ]]; then
  log "frontend dependencies missing; running npm install"
  "$NPM_BIN" install 2>&1 | tee -a "$LOG_FILE"
fi

if [[ ! -s .next/BUILD_ID || ! -s .next/routes-manifest.json || ! -d .next/server ]]; then
  log "frontend production build is missing or incomplete"
  build_frontend
fi

if command -v ss >/dev/null 2>&1 && ss -ltn | awk '{print $4}' | grep -Eq "(:|\\])${FRONTEND_PORT}$"; then
  log "port $FRONTEND_PORT is already listening before frontend start"
fi

NEXT_BIN="$FRONTEND_DIR/node_modules/.bin/next"
if [[ ! -x "$NEXT_BIN" ]]; then
  log "next binary is still missing after install; cannot start frontend"
  exit 1
fi

log "starting frontend on $HOST:$FRONTEND_PORT"
exec "$NEXT_BIN" start -H "$HOST" -p "$FRONTEND_PORT"
