#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${PANEL_UPDATE_WORKDIR:-/opt/vps-panel}"
PANEL_NGINX_SITE="${PANEL_NGINX_SITE:-00-vps-panel}"
NGINX_SITES_AVAILABLE="${NGINX_SITES_AVAILABLE:-/etc/nginx/sites-available}"
NGINX_CONF="${NGINX_SITES_AVAILABLE}/${PANEL_NGINX_SITE}"
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
FRONTEND_HEALTH_URL="${PANEL_UPDATE_FRONTEND_HEALTH_URL:-http://127.0.0.1:3000/health}"
DIRTY_STRATEGY="${PANEL_UPDATE_DIRTY_STRATEGY:-fail}"
COMMAND_TIMEOUT="${PANEL_UPDATE_COMMAND_TIMEOUT:-30}"
SYSTEMCTL_NO_BLOCK="${PANEL_UPDATE_SYSTEMCTL_NO_BLOCK:-true}"
STALE_AFTER_SECONDS="${PANEL_UPDATE_STALE_AFTER_SECONDS:-1200}"
APP_USER="${APP_USER:-panel}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${BASH_SOURCE[0]}")"
SCRIPT_REEXECUTED="${PANEL_UPDATE_SCRIPT_REEXECUTED:-false}"
FINAL_COMMIT=""
FINAL_COMMIT_SUBJECT=""
GIT_ASKPASS_FILE=""

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

on_term() {
  write_status "failed" "panel self-update interrupted by TERM" "$(current_commit)" "$(current_commit_subject)"
  log "panel self-update interrupted by TERM"
  rm -f "$PID_FILE"
  exit 143
}

trap on_error ERR
trap on_term TERM
cleanup() {
  rm -f "$PID_FILE"
  if [[ -n "$GIT_ASKPASS_FILE" ]]; then
    rm -f "$GIT_ASKPASS_FILE"
  fi
}

trap cleanup EXIT

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

configure_git_auth() {
  export GIT_TERMINAL_PROMPT=0
  git config --global credential.helper store >/dev/null 2>&1 || true
  git config --global --add safe.directory "$APP_DIR" >/dev/null 2>&1 || true

  if [[ -z "${PANEL_UPDATE_GIT_TOKEN:-}" ]]; then
    log "No PANEL_UPDATE_GIT_TOKEN configured; using existing git credential helper/SSH auth"
    return 0
  fi

  GIT_ASKPASS_FILE="$(mktemp)"
  cat > "$GIT_ASKPASS_FILE" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' "${PANEL_UPDATE_GIT_USERNAME:-x-access-token}" ;;
  *Password*) printf '%s\n' "$PANEL_UPDATE_GIT_TOKEN" ;;
  *) printf '%s\n' "$PANEL_UPDATE_GIT_TOKEN" ;;
esac
EOF
  chmod 0700 "$GIT_ASKPASS_FILE"
  export GIT_ASKPASS="$GIT_ASKPASS_FILE"
  log "Configured non-interactive GitHub credentials from PANEL_UPDATE_GIT_TOKEN"
}

current_systemd_unit() {
  if [[ ! -r /proc/self/cgroup ]]; then
    return 0
  fi
  grep -oE '[^/]+\.service' /proc/self/cgroup 2>/dev/null | tail -n 1 || true
}

handoff_to_isolated_service() {
  local current_unit=""
  current_unit="$(current_systemd_unit)"

  if [[ "${PANEL_UPDATE_ISOLATED:-false}" == "true" ]]; then
    return 0
  fi

  if [[ "$current_unit" == "vps-panel-self-update.service" ]]; then
    log "panel self-update is already running inside vps-panel-self-update.service"
    return 0
  fi

  case "$current_unit" in
    vps-panel-api.service|vps-panel-workers.service|vps-panel-guardian.service|vps-panel-frontend.service)
      ;;
    *)
      log "panel self-update is not running inside a panel service context; continuing in current process"
      return 0
      ;;
  esac

  log "panel self-update is running inside $current_unit; handing off to vps-panel-self-update.service"
  if [[ "$(id -u)" == "0" ]]; then
    "$SYSTEMCTL_BIN" start vps-panel-self-update 2>&1 | tee -a "$LOG_FILE"
  else
    "$SUDO_BIN" -n "$SYSTEMCTL_BIN" start vps-panel-self-update 2>&1 | tee -a "$LOG_FILE"
  fi
  write_status "running" "panel self-update handed off to vps-panel-self-update.service" "$(current_commit)" "$(current_commit_subject)"
  rm -f "$PID_FILE"
  exit 0
}

repair_panel_permissions() {
  local repair_script="$APP_DIR/scripts/maintenance/repair-panel-permissions.sh"
  if [[ ! -x "$repair_script" ]]; then
    return 0
  fi

  if [[ "$(id -u)" == "0" ]]; then
    run "$repair_script"
    return 0
  fi

  if [[ ! -w "$APP_DIR/.git/objects" || ! -w "$APP_DIR/frontend" || ! -w "$APP_DIR/api" ]]; then
    log "panel checkout is not writable by $(id -un); attempting permission repair"
    if "$SUDO_BIN" -n "$repair_script" 2>&1 | tee -a "$LOG_FILE"; then
      log "panel checkout permission repair completed"
    else
      log "panel checkout permission repair failed; git fetch may still fail"
    fi
  fi
}

normalize_known_self_update_dirty_files() {
  local dirty_paths=""
  dirty_paths="$(git status --porcelain | awk '{print $2}')"
  if [[ -z "$dirty_paths" ]]; then
    return 0
  fi

  local path=""
  while IFS= read -r path; do
    case "$path" in
      scripts/maintenance/repair-panel-permissions.sh)
        ;;
      *)
        return 0
        ;;
    esac
  done <<< "$dirty_paths"

  log "normalizing known self-update permission changes before dirty worktree check"
  run git checkout "origin/$BRANCH" -- scripts/maintenance/repair-panel-permissions.sh
}

file_checksum() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
  else
    stat -c '%s:%Y' "$path" 2>/dev/null || stat -f '%z:%m' "$path"
  fi
}

reexec_if_script_changed() {
  local before="$1"
  local after=""
  after="$(file_checksum "$SCRIPT_PATH")"
  if [[ "$before" != "$after" && "$SCRIPT_REEXECUTED" != "true" ]]; then
    log "panel update script changed during pull; reloading updated script"
    write_status "running" "panel update script changed; reloading updated script" "$(current_commit)" "$(current_commit_subject)"
    export PANEL_UPDATE_SCRIPT_REEXECUTED=true
    exec bash "$SCRIPT_PATH"
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
  local status=0
  local retry_status=0
  local conflict_paths=""
  log "cleaning stale npm rename temp folders before install"
  find "$APP_DIR/node_modules" -maxdepth 1 -type d -name ".*-*" -print -exec rm -rf {} + 2>&1 | tee -a "$LOG_FILE" || true

  log "+ $NPM_BIN install"
  output_file="$(mktemp)"
  set +e
  "$NPM_BIN" install 2>&1 | tee "$output_file" | tee -a "$LOG_FILE"
  status=${PIPESTATUS[0]}
  set -e
  output="$(cat "$output_file")"
  rm -f "$output_file"
  if [[ "$status" == "0" ]]; then
    return 0
  fi

  log "npm install failed with exit code $status"

  if printf '%s' "$output" | grep -qiE "ENOTEMPTY|EEXIST|directory not empty|rename .*node_modules"; then
    log "npm install hit a stale node_modules rename conflict; cleaning npm temp folders and retrying"
    conflict_paths="$(printf '%s\n' "$output" | awk '/^npm error (path|dest) / {print $4}' | sort -u)"
    if [[ -n "$conflict_paths" ]]; then
      while IFS= read -r conflict_path; do
        if [[ "$conflict_path" == "$APP_DIR/node_modules/"* ]]; then
          log "removing conflicted npm path $conflict_path"
          rm -rf "$conflict_path"
        fi
      done <<< "$conflict_paths"
    fi
    find "$APP_DIR/node_modules" -maxdepth 1 -type d -name ".*-*" -print -exec rm -rf {} + 2>&1 | tee -a "$LOG_FILE" || true
    "$NPM_BIN" cache clean --force 2>&1 | tee -a "$LOG_FILE" || true

    output_file="$(mktemp)"
    log "+ $NPM_BIN install"
    set +e
    "$NPM_BIN" install 2>&1 | tee "$output_file" | tee -a "$LOG_FILE"
    retry_status=${PIPESTATUS[0]}
    set -e
    rm -f "$output_file"
    if [[ "$retry_status" == "0" ]]; then
      return 0
    fi

    log "npm install retry failed; rebuilding root node_modules once"
    rm -rf "$APP_DIR/node_modules"
    run "$NPM_BIN" install
    return 0
  fi

  return "$status"
}

frontend_build_with_recovery() {
  local output_file=""
  local status=0

  log "+ $NPM_BIN --workspace frontend run build"
  output_file="$(mktemp)"
  set +e
  "$NPM_BIN" --workspace frontend run build 2>&1 | tee "$output_file" | tee -a "$LOG_FILE"
  status=${PIPESTATUS[0]}
  set -e
  if [[ "$status" == "0" ]]; then
    rm -f "$output_file"
    return 0
  fi

  log "frontend build failed with exit code $status; cleaning .next and retrying once"
  rm -rf "$APP_DIR/frontend/.next" "$APP_DIR/frontend/.next.tmp" "$APP_DIR/frontend/node_modules/.cache" 2>&1 | tee -a "$LOG_FILE" || true
  find "$APP_DIR/frontend" -maxdepth 2 -type d -name ".*-*" -print -exec rm -rf {} + 2>&1 | tee -a "$LOG_FILE" || true
  "$NPM_BIN" cache clean --force 2>&1 | tee -a "$LOG_FILE" || true

  log "+ $NPM_BIN --workspace frontend run build"
  set +e
  "$NPM_BIN" --workspace frontend run build 2>&1 | tee -a "$LOG_FILE"
  status=${PIPESTATUS[0]}
  set -e
  rm -f "$output_file"
  if [[ "$status" != "0" ]]; then
    write_status "failed" "frontend build failed with exit code $status after retry" "$(current_commit)" "$(current_commit_subject)"
    return "$status"
  fi
}

set_env_value() {
  local key="$1"
  local value="$2"
  local file="$APP_DIR/.env"
  if [[ ! -f "$file" ]]; then
    log "panel env file not found at $file; cannot set $key"
    return 1
  fi

  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

ensure_live_sysagent_config() {
  local file="$APP_DIR/.env"
  local changed="false"
  local current=""
  if [[ ! -f "$file" ]]; then
    log "panel env file not found at $file; skipping sysagent live command normalization"
    return 0
  fi

  ln -sfn ../.env "$APP_DIR/sysagent/.env"

  current="$(grep -E '^ALLOW_LIVE_SYSTEM_COMMANDS=' "$file" | tail -n 1 | cut -d= -f2- || true)"
  if [[ "$current" != "true" ]]; then
    log "enabling ALLOW_LIVE_SYSTEM_COMMANDS=true for deploy/start/repair commands"
    set_env_value "ALLOW_LIVE_SYSTEM_COMMANDS" "true"
    changed="true"
  fi

  for key in ALLOW_LIVE_FILE_MANAGER ALLOW_LIVE_NGINX ALLOW_LIVE_SSL; do
    current="$(grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- || true)"
    if [[ "$current" != "true" ]]; then
      log "enabling ${key}=true for panel live operations"
      set_env_value "$key" "true"
      changed="true"
    fi
  done

  if [[ "$changed" == "true" ]]; then
    write_status "running" "enabled sysagent live command mode" "$(current_commit)" "$(current_commit_subject)"
  fi
}

repair_frontend_service_unit() {
  local unit="/etc/systemd/system/vps-panel-frontend.service"
  local start_script="$APP_DIR/scripts/deploy/start-frontend.sh"
  if [[ ! -f "$start_script" ]]; then
    log "frontend start repair script missing at $start_script; skipping service unit repair"
    return 0
  fi

  chmod +x "$start_script" 2>/dev/null || true

  if [[ "$(id -u)" != "0" ]]; then
    log "not root; skipping frontend systemd unit repair"
    return 0
  fi

  if [[ -f "$unit" ]] && grep -q "$start_script" "$unit"; then
    log "frontend systemd unit already uses resilient start script"
    return 0
  fi

  log "repairing frontend systemd unit to rebuild missing artifacts before start"
  cat > "$unit" <<EOF
[Unit]
Description=VPS Panel Frontend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/frontend
EnvironmentFile=$APP_DIR/.env
Environment=APP_DIR=$APP_DIR
Environment=PORT=$FRONTEND_PORT
ExecStart=/usr/bin/bash $start_script
Restart=always
RestartSec=5
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
EOF
  "$SYSTEMCTL_BIN" daemon-reload 2>&1 | tee -a "$LOG_FILE"
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

wait_http_ready() {
  local label="$1"
  local url="$2"
  local attempts="${3:-30}"

  if ! command -v curl >/dev/null 2>&1; then
    log "curl not installed; skipping $label readiness check"
    return 0
  fi

  log "Waiting for $label at $url"
  for i in $(seq 1 "$attempts"); do
    if curl --fail --silent --show-error "$url" 2>&1 | tee -a "$LOG_FILE" >/dev/null; then
      log "$label readiness check passed"
      return 0
    fi
    log "$label not ready yet, retry $i/$attempts..."
    sleep 2
  done

  log "$label readiness check failed after retries"
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
SCRIPT_CHECKSUM_BEFORE_PULL="$(file_checksum "$SCRIPT_PATH")"
configure_git_auth
handoff_to_isolated_service
repair_panel_permissions

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
normalize_known_self_update_dirty_files

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
reexec_if_script_changed "$SCRIPT_CHECKSUM_BEFORE_PULL"
NEW_COMMIT="$(current_commit)"
NEW_COMMIT_SUBJECT="$(current_commit_subject)"
write_status "running" "source updated; building panel" "$NEW_COMMIT" "$NEW_COMMIT_SUBJECT"
ensure_systemctl_permission
ensure_node_runtime
ensure_live_sysagent_config
repair_frontend_service_unit

npm_install_with_recovery
run "$NPM_BIN" --workspace api run prisma:generate

(
  cd api
  run npx prisma migrate deploy
  run "$NPM_BIN" run build
)

frontend_build_with_recovery

patch_nginx_websocket

for service in $SERVICES; do
  write_status "running" "restarting $service" "$NEW_COMMIT" "$NEW_COMMIT_SUBJECT"
  run_systemctl restart "$service"
  wait_service_active "$service"
done

wait_http_ready "API health" "$HEALTH_URL" 30
wait_http_ready "frontend" "$FRONTEND_HEALTH_URL" 30

write_status "succeeded" "panel self-update completed" "$NEW_COMMIT" "$NEW_COMMIT_SUBJECT"
log "panel self-update completed"
rm -f "$PID_FILE"
