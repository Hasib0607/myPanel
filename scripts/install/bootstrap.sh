#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage:
  sudo bash scripts/install/bootstrap.sh --repo https://github.com/OWNER/myPanel.git [options]

One-command VPS Panel deploy for Ubuntu 22.04 and AlmaLinux 9.

Required on a fresh server:
  --repo URL                 Git repository URL to clone into /opt/vps-panel.

Common options:
  --branch NAME              Git branch. Default: main.
  --domain HOST              Public hostname used in generated URLs and Nginx server_name.
  --app-dir PATH             Install directory. Default: /opt/vps-panel.
  --repo-full-name OWNER/REPO GitHub full name used by self-update webhooks.
  --admin-user USER          Superadmin username. Default: admin.
  --admin-pass PASSWORD      Superadmin password. Random if omitted.
  --db-name NAME             PostgreSQL database name. Default: panel_main.
  --db-user USER             PostgreSQL role name. Default: panel_user.
  --db-pass PASSWORD         PostgreSQL role password. Random if omitted.
  --db-host HOST             PostgreSQL host. Default: localhost.
  --db-port PORT             PostgreSQL port. Default: 5432.
  --database-url URL         Full DATABASE_URL. Overrides DB pieces in .env.
  --skip-db-create           Do not create local PostgreSQL database/user.
  --raw-base URL             Raw install script base URL for non-GitHub repositories.
  --whm-port PORT            WHM/Admin public port. Default: 8453.
  --cpanel-port PORT         cPanel/Account public port. Default: 3138.
  --dry-run                  Print the resolved deployment plan and exit.
  --help                     Show this help.

Example:
  curl -fsSL https://raw.githubusercontent.com/Hasib0607/myPanel/main/scripts/install/bootstrap.sh | sudo bash -s -- \
    --repo https://github.com/Hasib0607/myPanel.git \
    --domain panel.example.com \
    --db-name panel_main \
    --db-user panel_user \
    --db-pass 'StrongDatabasePassword' \
    --admin-user admin \
    --admin-pass 'StrongAdminPassword'
EOF
}

require_value() {
  local key="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    echo "$key requires a value"
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      require_value "$1" "${2:-}"
      export REPO_URL="$2"
      shift 2
      ;;
    --branch)
      require_value "$1" "${2:-}"
      export APP_BRANCH="$2"
      shift 2
      ;;
    --domain)
      require_value "$1" "${2:-}"
      export PANEL_DOMAIN="$2"
      shift 2
      ;;
    --app-dir)
      require_value "$1" "${2:-}"
      export APP_DIR="$2"
      shift 2
      ;;
    --repo-full-name)
      require_value "$1" "${2:-}"
      export PANEL_UPDATE_REPO_FULL_NAME="$2"
      shift 2
      ;;
    --admin-user)
      require_value "$1" "${2:-}"
      export SUPERADMIN_USERNAME="$2"
      shift 2
      ;;
    --admin-pass)
      require_value "$1" "${2:-}"
      export SUPERADMIN_PASSWORD="$2"
      shift 2
      ;;
    --db-name)
      require_value "$1" "${2:-}"
      export DB_NAME="$2"
      shift 2
      ;;
    --db-user)
      require_value "$1" "${2:-}"
      export DB_USER="$2"
      shift 2
      ;;
    --db-pass)
      require_value "$1" "${2:-}"
      export DB_PASSWORD="$2"
      shift 2
      ;;
    --db-host)
      require_value "$1" "${2:-}"
      export DB_HOST="$2"
      shift 2
      ;;
    --db-port)
      require_value "$1" "${2:-}"
      export DB_PORT="$2"
      shift 2
      ;;
    --database-url)
      require_value "$1" "${2:-}"
      export DATABASE_URL="$2"
      export DIRECT_DATABASE_URL="$2"
      export DB_CREATE=false
      shift 2
      ;;
    --skip-db-create)
      export DB_CREATE=false
      shift
      ;;
    --raw-base)
      require_value "$1" "${2:-}"
      export BOOTSTRAP_RAW_BASE="${2%/}"
      shift 2
      ;;
    --whm-port)
      require_value "$1" "${2:-}"
      export PANEL_LOGIN_PORT="$2"
      shift 2
      ;;
    --cpanel-port)
      require_value "$1" "${2:-}"
      export CPANEL_LOGIN_PORT="$2"
      shift 2
      ;;
    --dry-run)
      export DRY_RUN=true
      shift
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

derive_raw_base() {
  if [[ -n "${BOOTSTRAP_RAW_BASE:-}" ]]; then
    echo "$BOOTSTRAP_RAW_BASE"
    return
  fi

  local branch="${APP_BRANCH:-main}"
  local repo="${REPO_URL:-}"
  repo="${repo%.git}"

  case "$repo" in
    https://github.com/*/*)
      repo="${repo#https://github.com/}"
      echo "https://raw.githubusercontent.com/$repo/$branch/scripts/install"
      ;;
    git@github.com:*/*)
      repo="${repo#git@github.com:}"
      echo "https://raw.githubusercontent.com/$repo/$branch/scripts/install"
      ;;
    *)
      echo ""
      ;;
  esac
}

prepare_install_scripts() {
  if [[ -f "$SCRIPT_DIR/install.sh" && -f "$SCRIPT_DIR/common.sh" ]]; then
    return
  fi

  local raw_base
  raw_base="$(derive_raw_base)"
  if [[ -z "$raw_base" ]]; then
    echo "Cannot find local installer files. Pass --repo with a GitHub URL or pass --raw-base."
    exit 2
  fi

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  install -d -m 0755 "$tmp_dir/lib"

  for file in install.sh common.sh ubuntu-22.04.sh alma-linux-9.sh validate-install.sh lib/os.sh; do
    curl -fsSL "$raw_base/$file" -o "$tmp_dir/$file"
  done

  SCRIPT_DIR="$tmp_dir"
}

prepare_install_scripts

if [[ -z "${PANEL_UPDATE_REPO_FULL_NAME:-}" && -n "${REPO_URL:-}" ]]; then
  repo_for_full_name="${REPO_URL%.git}"
  case "$repo_for_full_name" in
    https://github.com/*/*)
      export PANEL_UPDATE_REPO_FULL_NAME="${repo_for_full_name#https://github.com/}"
      ;;
    git@github.com:*/*)
      export PANEL_UPDATE_REPO_FULL_NAME="${repo_for_full_name#git@github.com:}"
      ;;
  esac
fi

if [[ "${DRY_RUN:-false}" == "true" ]]; then
  # shellcheck source=common.sh
  source "$SCRIPT_DIR/common.sh"
  validate_bootstrap_inputs
  print_bootstrap_plan
  exit 0
fi

exec bash "$SCRIPT_DIR/install.sh"
