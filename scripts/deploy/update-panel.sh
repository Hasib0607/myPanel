#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${PANEL_UPDATE_WORKDIR:-/opt/vps-panel}"
PANEL_NGINX_SITE="${PANEL_NGINX_SITE:-00-vps-panel}"
NGINX_CONF="/etc/nginx/sites-available/$PANEL_NGINX_SITE"
BRANCH="${PANEL_UPDATE_BRANCH:-main}"
LOG_FILE="${PANEL_UPDATE_LOG_FILE:-/var/log/vps-panel/self-update.log}"
STATUS_FILE="${PANEL_UPDATE_STATUS_FILE:-/var/log/vps-panel/self-update-status.json}"
LOCK_FILE="${PANEL_UPDATE_LOCK_FILE:-/tmp/vps-panel-self-update.lock}"
PID_FILE="${PANEL_UPDATE_PID_FILE:-/tmp/vps-panel-self-update.pid}"
NPM_BIN="${NPM_BIN:-npm}"
NODE_BIN="${NODE_BIN:-node}"
REQUIRED_NODE_VERSION="${PANEL_UPDATE_REQUIRED_NODE_VERSION:-20.9.0}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-}"
SUDO_BIN="${SUDO_BIN:-sudo}"
SERVICES="${PANEL_UPDATE_SERVICES:-vps-panel-sysagent vps-panel-workers vps-panel-frontend vps-panel-api}"
API_SERVICE="${PANEL_UPDATE_API_SERVICE:-vps-panel-api}"
HEALTH_URL="${PANEL_UPDATE_HEALTH_URL:-http://127.0.0.1:4000/health}"
DIRTY_STRATEGY="${PANEL_UPDATE_DIRTY_STRATEGY:-fail}"
COMMAND_TIMEOUT="${PANEL_UPDATE_COMMAND_TIMEOUT:-30}"
SYSTEMCTL_NO_BLOCK="${PANEL_UPDATE_SYSTEMCTL_NO_BLOCK:-true}"
STALE_AFTER_SECONDS="${PANEL_UPDATE_STALE_AFTER_SECONDS:-1200}"

mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$(dirname "$STATUS_FILE")"

if [[ -z "$SYSTEMCTL_BIN" ]]; then
  SYSTEMCTL_BIN="$(command -v systemctl || true)"
fi

if [[ -z "$SYSTEMCTL_BIN" ]]; then
  echo "[$(date -Is)] systemctl was not found in PATH" | tee -a "$LOG_FILE"
  exit 70
fi

log() {
  echo "[$(date -Is)] $*" | tee -a "$LOG_FILE"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_status() {
  local state="$1"
  local message="$2"
  local commit="${3:-}"
  local commit_subject="${4:-}"
  local dirty_files="${5:-}"
  printf '{"state":"%s","message":"%s","branch":"%s","commit":"%s","commitSubject":"%s","dirtyFiles":"%s","updatedAt":"%s","logFile":"%s"}\n' \
    "$(json_escape "$state")" \
    "$(json_escape "$message")" \
    "$(json_escape "$BRANCH")" \
    "$(json_escape "$commit")" \
    "$(json_escape "$commit_subject")" \
    "$(json_escape "$dirty_files")" \
    "$(date -Is)" \
    "$(json_escape "$LOG_FILE")" > "$STATUS_FILE"
}

current_commit() {
  git rev-parse --short HEAD 2>/dev/null || true
}

current_commit_subject() {
  git log -1 --pretty=%s 2>/dev/null || true
}

on_error() {
  local exit_code=$?
  write_status "failed" "panel self-update failed with exit code $exit_code" "$(current_commit)" "$(current_commit_subject)"
  log "panel self-update failed with exit code $exit_code"
  rm -f "$PID_FILE"
  exit "$exit_code"
}

trap on_error ERR
trap 'rm -f "$PID_FILE"' EXIT

run() {
  log "+ $*"
  "$@" 2>&1 | tee -a "$LOG_FILE"
}

run_timeout() {
  log "+ $*"
  if command -v timeout >/dev/null 2>&1; then
    timeout "$COMMAND_TIMEOUT" "$@" 2>&1 | tee -a "$LOG_FILE"
  else
    "$@" 2>&1 | tee -a "$LOG_FILE"
  fi
}

version_at_least() {
  local current="$1"
  local required="$2"
  local current_major current_minor current_patch required_major required_minor required_patch
  IFS=. read -r current_major current_minor current_patch <<< "$current"
  IFS=. read -r required_major required_minor required_patch <<< "$required"
  current_minor="${current_minor:-0}"
  current_patch="${current_patch:-0}"
  required_minor="${required_minor:-0}"
  required_patch="${required_patch:-0}"

  if (( current_major > required_major )); then return 0; fi
  if (( current_major < required_major )); then return 1; fi
  if (( current_minor > required_minor )); then return 0; fi
  if (( current_minor < required_minor )); then return 1; fi
  (( current_patch >= required_patch ))
}

ensure_node_runtime() {
  local node_path npm_path node_version npm_version
  node_path="$(command -v "$NODE_BIN" || true)"
  npm_path="$(command -v "$NPM_BIN" || true)"

  if [[ -z "$node_path" || -z "$npm_path" ]]; then
    log "Node.js or npm was not found. node=$node_path npm=$npm_path"
    write_status "failed" "Node.js and npm are required for panel self-update" "$(current_commit)" "$(current_commit_subject)"
    exit 71
  fi

  node_version="$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null || true)"
  npm_version="$("$NPM_BIN" --version 2>/dev/null || true)"
  log "Using node $node_version at $node_path"
  log "Using npm $npm_version at $npm_path"

  if [[ -z "$node_version" ]] || ! version_at_least "$node_version" "$REQUIRED_NODE_VERSION"; then
    log "Node.js $REQUIRED_NODE_VERSION or newer is required by the panel frontend build"
    log "Install Node.js 22 on the VPS, then retry the panel update"
    write_status "failed" "Node.js $REQUIRED_NODE_VERSION or newer required; found ${node_version:-unknown}" "$(current_commit)" "$(current_commit_subject)"
    exit 71
  fi
}

npm_install_with_recovery() {
  local output=""
  local output_file=""
  log "+ $NPM_BIN install"
  output_file="$(mktemp)"
  set +e
  "$NPM_BIN" install 2>&1 | tee "$output_file" | tee -a "$LOG_FILE"
  local status=${PIPESTATUS[0]}
  set -e
  output="$(cat "$output_file")"
  rm -f "$output_file"
  if [[ "$status" == "0" ]]; then
    return 0
  fi

  log "npm install failed with exit code $status"

  if printf '%s' "$output" | grep -qiE "ENOTEMPTY|EEXIST|directory not empty|rename .*node_modules"; then
    log "npm install hit a stale node_modules rename conflict; cleaning npm temp folders and retrying"
    find "$APP_DIR/node_modules" -maxdepth 1 -type d -name ".*-*" -print -exec rm -rf {} + 2>&1 | tee -a "$LOG_FILE" || true
    "$NPM_BIN" cache verify 2>&1 | tee -a "$LOG_FILE" || true
    run "$NPM_BIN" install && return 0

    log "npm install retry failed; rebuilding root node_modules once"
    rm -rf "$APP_DIR/node_modules"
    run "$NPM_BIN" install
    return 0
  fi

  return "$status"
}

sudo_systemctl_output() {
  "$SUDO_BIN" -n "$SYSTEMCTL_BIN" "$@" 2>&1
}

ensure_systemctl_permission() {
  if [[ "$(id -u)" == "0" ]]; then
    SUDO_BIN=""
    return 0
  fi

  local service=""
  local output=""
  local sudoers_rule="panel ALL=(root) NOPASSWD:"
  for service in $SERVICES; do
    sudoers_rule="$sudoers_rule $SYSTEMCTL_BIN --no-block restart $service, $SYSTEMCTL_BIN is-active $service, $SYSTEMCTL_BIN status $service,"
    output="$(sudo_systemctl_output is-active "$service" || true)"
    if printf '%s' "$output" | grep -qiE "password is required|a password is required|not in the sudoers|may not run sudo"; then
      log "panel user cannot run sudo systemctl without a password"
      log "Detected systemctl path: $SYSTEMCTL_BIN"
      log "Add this sudoers rule with: sudo visudo -f /etc/sudoers.d/vps-panel-update"
      log "${sudoers_rule%,}"
      write_status "failed" "sudoers missing for panel service restarts; systemctl path is $SYSTEMCTL_BIN" "$(current_commit)" "$(current_commit_subject)"
      exit 69
    fi
  done
}

run_systemctl() {
  local action="$1"
  local service="$2"
  local cmd=()
  if [[ -n "$SUDO_BIN" ]]; then
    cmd=("$SUDO_BIN" -n)
  fi
  if [[ "$action" == "restart" && "$SYSTEMCTL_NO_BLOCK" == "true" ]]; then
    run_timeout "${cmd[@]}" "$SYSTEMCTL_BIN" --no-block "$action" "$service"
  else
    run_timeout "${cmd[@]}" "$SYSTEMCTL_BIN" "$action" "$service"
  fi
}

wait_service_active() {
  local service="$1"
  local attempts="${PANEL_UPDATE_SERVICE_ACTIVE_ATTEMPTS:-20}"
  local cmd=()
  if [[ -n "$SUDO_BIN" ]]; then
    cmd=("$SUDO_BIN" -n)
  fi
  for i in $(seq 1 "$attempts"); do
    if "${cmd[@]}" "$SYSTEMCTL_BIN" is-active "$service" >/dev/null 2>&1; then
      log "$service active"
      return 0
    fi
    log "$service not active yet, retry $i/$attempts..."
    sleep 1
  done

  log "$service did not become active"
  run_systemctl status "$service" || true
  return 1
}

pid_is_running() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" >/dev/null 2>&1
}

pid_age_seconds() {
  local pid="$1"
  ps -p "$pid" -o etimes= 2>/dev/null | tr -d ' ' || true
}

terminate_update_pid() {
  local pid="$1"
  log "terminating stale panel update process $pid"
  kill -TERM "-$pid" >/dev/null 2>&1 || kill -TERM "$pid" >/dev/null 2>&1 || true
  sleep 3
  if pid_is_running "$pid"; then
    log "stale panel update process $pid ignored TERM; sending KILL"
    kill -KILL "-$pid" >/dev/null 2>&1 || kill -KILL "$pid" >/dev/null 2>&1 || true
  fi
}

acquire_update_lock() {
  exec 9>"$LOCK_FILE"
  if flock -n 9; then
    return 0
  fi

  log "another panel update is already running"

  local existing_pid=""
  local existing_age=""
  if [[ -f "$PID_FILE" ]]; then
    existing_pid="$(tr -dc '0-9' < "$PID_FILE" || true)"
  fi

  if [[ -n "$existing_pid" ]] && pid_is_running "$existing_pid"; then
    existing_age="$(pid_age_seconds "$existing_pid")"
    log "existing panel update pid $existing_pid has been running for ${existing_age:-unknown}s"
    if [[ "$existing_age" =~ ^[0-9]+$ ]] && (( existing_age >= STALE_AFTER_SECONDS )); then
      write_status "running" "recovering stale panel update process $existing_pid" "$(current_commit)" "$(current_commit_subject)"
      terminate_update_pid "$existing_pid"
      rm -f "$PID_FILE"
      sleep 1
      if flock -n 9; then
        log "recovered stale panel update lock"
        return 0
      fi
    fi
  elif [[ -n "$existing_pid" ]]; then
    log "removing dead panel update pid file for $existing_pid"
    rm -f "$PID_FILE"
    if flock -n 9; then
      return 0
    fi
  fi

  write_status "running" "another panel update is already running" "$(current_commit)" "$(current_commit_subject)"
  exit 75
}

cd "$APP_DIR"
acquire_update_lock
printf '%s\n' "$$" > "$PID_FILE"

log "starting panel self-update in $APP_DIR on branch $BRANCH"
write_status "running" "panel self-update started" "$(current_commit)" "$(current_commit_subject)"

patch_nginx_websocket() {
  if [[ ! -f "$NGINX_CONF" ]]; then
    log "Panel nginx config not found at $NGINX_CONF; skipping websocket patch"
    return 0
  fi
  if grep -q 'proxy_set_header Upgrade' "$NGINX_CONF"; then
    log "Panel nginx config already has WebSocket headers"
    return 0
  fi
  log "Patching $NGINX_CONF: adding WebSocket proxy headers"
  # Insert Upgrade + Connection headers after every proxy_set_header X-Forwarded-Port line
  if command -v sed >/dev/null 2>&1; then
    sed -i '/proxy_set_header X-Forwarded-Port/a\        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";' "$NGINX_CONF"
  fi
  if nginx -t 2>&1 | tee -a "$LOG_FILE"; then
    systemctl reload nginx 2>&1 | tee -a "$LOG_FILE" || true
    log "nginx reloaded with WebSocket headers"
  else
    log "nginx config test failed after patch; skipping reload"
  fi
}

run git fetch origin "$BRANCH"

DIRTY_FILES="$(git status --porcelain)"
if [[ -n "$DIRTY_FILES" ]]; then
  log "worktree is dirty"
  git status --short 2>&1 | tee -a "$LOG_FILE"
  if [[ "$DIRTY_STRATEGY" == "reset" ]]; then
    write_status "running" "worktree dirty; resetting to origin/$BRANCH" "$(current_commit)" "$(current_commit_subject)" "$DIRTY_FILES"
    run git reset --hard "origin/$BRANCH"
    run git clean -fd
  else
    write_status "failed" "worktree is dirty; refusing to auto-update" "$(current_commit)" "$(current_commit_subject)" "$DIRTY_FILES"
    exit 2
  fi
fi

run git checkout "$BRANCH"
run git pull --ff-only origin "$BRANCH"
NEW_COMMIT="$(current_commit)"
NEW_COMMIT_SUBJECT="$(current_commit_subject)"
write_status "running" "source updated; building panel" "$NEW_COMMIT" "$NEW_COMMIT_SUBJECT"
ensure_systemctl_permission
ensure_node_runtime

npm_install_with_recovery
run "$NPM_BIN" --workspace api run prisma:generate

(
  cd api
  run npx prisma migrate deploy
  run "$NPM_BIN" run build
)

run "$NPM_BIN" --workspace frontend run build

patch_nginx_websocket

API_RESTART_NEEDED="false"
for service in $SERVICES; do
  if [[ "$service" == "$API_SERVICE" ]]; then
    API_RESTART_NEEDED="true"
    continue
  fi
  write_status "running" "restarting $service" "$NEW_COMMIT" "$NEW_COMMIT_SUBJECT"
  run_systemctl restart "$service"
  wait_service_active "$service"
done

if command -v curl >/dev/null 2>&1; then
  log "Waiting for API health at $HEALTH_URL"

  for i in {1..20}; do
    if curl --fail --silent --show-error "$HEALTH_URL" 2>&1 | tee -a "$LOG_FILE"; then
      log "API health check passed"
      break
    fi

    log "API not ready yet, retry $i/20..."
    sleep 2

    if [ "$i" -eq 20 ]; then
      log "API health check failed after retries"
      exit 7
    fi
  done
else
  log "curl not installed; skipping API health check"
fi

if [[ "$API_RESTART_NEEDED" == "true" ]]; then
  write_status "succeeded" "panel self-update completed; restarting $API_SERVICE" "$NEW_COMMIT" "$NEW_COMMIT_SUBJECT"
  log "panel self-update completed; restarting $API_SERVICE"
  run_systemctl restart "$API_SERVICE"
else
  write_status "succeeded" "panel self-update completed" "$NEW_COMMIT" "$NEW_COMMIT_SUBJECT"
  log "panel self-update completed"
fi
rm -f "$PID_FILE"
