#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${PANEL_UPDATE_WORKDIR:-/opt/vps-panel}"
BRANCH="${PANEL_UPDATE_BRANCH:-main}"
LOG_FILE="${PANEL_UPDATE_LOG_FILE:-/var/log/vps-panel/self-update.log}"
STATUS_FILE="${PANEL_UPDATE_STATUS_FILE:-/var/log/vps-panel/self-update-status.json}"
LOCK_FILE="${PANEL_UPDATE_LOCK_FILE:-/tmp/vps-panel-self-update.lock}"
PID_FILE="${PANEL_UPDATE_PID_FILE:-/tmp/vps-panel-self-update.pid}"
NPM_BIN="${NPM_BIN:-npm}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
SUDO_BIN="${SUDO_BIN:-sudo}"
SERVICES="${PANEL_UPDATE_SERVICES:-vps-panel-workers vps-panel-frontend vps-panel-api}"
HEALTH_URL="${PANEL_UPDATE_HEALTH_URL:-http://127.0.0.1:4000/health}"
DIRTY_STRATEGY="${PANEL_UPDATE_DIRTY_STRATEGY:-fail}"
COMMAND_TIMEOUT="${PANEL_UPDATE_COMMAND_TIMEOUT:-30}"
SYSTEMCTL_NO_BLOCK="${PANEL_UPDATE_SYSTEMCTL_NO_BLOCK:-true}"
STALE_AFTER_SECONDS="${PANEL_UPDATE_STALE_AFTER_SECONDS:-1200}"

mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$(dirname "$STATUS_FILE")"

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

run_systemctl() {
  local action="$1"
  local service="$2"
  if [[ "$action" == "restart" && "$SYSTEMCTL_NO_BLOCK" == "true" ]]; then
    run_timeout "$SUDO_BIN" -n "$SYSTEMCTL_BIN" --no-block "$action" "$service"
  else
    run_timeout "$SUDO_BIN" -n "$SYSTEMCTL_BIN" "$action" "$service"
  fi
}

wait_service_active() {
  local service="$1"
  local attempts="${PANEL_UPDATE_SERVICE_ACTIVE_ATTEMPTS:-20}"
  for i in $(seq 1 "$attempts"); do
    if "$SUDO_BIN" -n "$SYSTEMCTL_BIN" is-active "$service" >/dev/null 2>&1; then
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

run "$NPM_BIN" install
run "$NPM_BIN" --workspace api run prisma:generate

(
  cd api
  run npx prisma migrate deploy
  run "$NPM_BIN" run build
)

run "$NPM_BIN" --workspace frontend run build

for service in $SERVICES; do
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

write_status "succeeded" "panel self-update completed" "$NEW_COMMIT" "$NEW_COMMIT_SUBJECT"
log "panel self-update completed"
rm -f "$PID_FILE"
