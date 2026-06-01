#!/usr/bin/env bash
set -Eeuo pipefail

# Opinionated shortcut for this repository. It keeps the full bootstrap script
# generic, while giving new servers a copy-paste install command.

: "${REPO_URL:=https://github.com/Hasib0607/myPanel.git}"
: "${APP_BRANCH:=${BRANCH:-main}}"
: "${APP_DIR:=/opt/myPanel}"
: "${DB_NAME:=panel_db}"
: "${DB_USER:=panel_user}"
: "${PANEL_LOGIN_PORT:=8453}"
: "${CPANEL_LOGIN_PORT:=3138}"

if [[ -n "${ADMIN_USER:-}" && -z "${SUPERADMIN_USERNAME:-}" ]]; then
  export SUPERADMIN_USERNAME="$ADMIN_USER"
fi
if [[ -n "${ADMIN_PASS:-}" && -z "${SUPERADMIN_PASSWORD:-}" ]]; then
  export SUPERADMIN_PASSWORD="$ADMIN_PASS"
fi
if [[ -n "${DB_PASS:-}" && -z "${DB_PASSWORD:-}" ]]; then
  export DB_PASSWORD="$DB_PASS"
fi
if [[ -n "${GITHUB_USER:-}" && -z "${PANEL_UPDATE_GIT_USERNAME:-}" ]]; then
  export PANEL_UPDATE_GIT_USERNAME="$GITHUB_USER"
fi
if [[ -n "${GITHUB_TOKEN:-}" && -z "${PANEL_UPDATE_GIT_TOKEN:-}" ]]; then
  export PANEL_UPDATE_GIT_TOKEN="$GITHUB_TOKEN"
fi

export REPO_URL APP_BRANCH APP_DIR DB_NAME DB_USER PANEL_LOGIN_PORT CPANEL_LOGIN_PORT
export SUPERADMIN_USERNAME="${SUPERADMIN_USERNAME:-admin}"

RAW_BASE="${RAW_BASE:-https://raw.githubusercontent.com/Hasib0607/myPanel/${APP_BRANCH}/scripts/install}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

curl -fsSL "$RAW_BASE/bootstrap.sh" -o "$tmp_dir/bootstrap.sh"
chmod +x "$tmp_dir/bootstrap.sh"

args=(
  --repo "$REPO_URL"
  --branch "$APP_BRANCH"
  --app-dir "$APP_DIR"
  --db-name "$DB_NAME"
  --db-user "$DB_USER"
  --admin-user "$SUPERADMIN_USERNAME"
  --whm-port "$PANEL_LOGIN_PORT"
  --cpanel-port "$CPANEL_LOGIN_PORT"
)

[[ -n "${PANEL_DOMAIN:-}" ]] && args+=(--domain "$PANEL_DOMAIN")
[[ -n "${SUPERADMIN_PASSWORD:-}" ]] && args+=(--admin-pass "$SUPERADMIN_PASSWORD")
[[ -n "${DB_PASSWORD:-}" ]] && args+=(--db-pass "$DB_PASSWORD")
[[ -n "${DATABASE_URL:-}" ]] && args+=(--database-url "$DATABASE_URL")
[[ -n "${PANEL_UPDATE_REPO_FULL_NAME:-}" ]] && args+=(--repo-full-name "$PANEL_UPDATE_REPO_FULL_NAME")
[[ -n "${PANEL_UPDATE_GIT_USERNAME:-}" ]] && args+=(--git-user "$PANEL_UPDATE_GIT_USERNAME")
[[ -n "${PANEL_UPDATE_GIT_TOKEN:-}" ]] && args+=(--git-token "$PANEL_UPDATE_GIT_TOKEN")
[[ "${ENABLE_SSL:-false}" == "true" || "${AUTO_SSL:-false}" == "true" ]] && args+=(--enable-ssl)
[[ -n "${SSL_EMAIL:-}" ]] && args+=(--ssl-email "$SSL_EMAIL")
[[ "${PROMPT_SECRETS:-false}" == "true" ]] && args+=(--prompt-secrets)
[[ "${NO_RESUME:-false}" == "true" ]] && args+=(--no-resume)
[[ "${FORCE_STEP:-false}" == "true" ]] && args+=(--force-step)
[[ "${DRY_RUN:-false}" == "true" ]] && args+=(--dry-run)

exec bash "$tmp_dir/bootstrap.sh" "${args[@]}"
