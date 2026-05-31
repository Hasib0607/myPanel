#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

require_root
require_repo_url

log "Installing Ubuntu packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg git nginx certbot python3-certbot-nginx postgresql postgresql-contrib redis-server bind9 bind9utils dnsutils ufw python3 python3-venv python3-pip unzip zip openssl build-essential acl lsof psmisc

if ! command -v node >/dev/null 2>&1 || ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1)'; then
  log "Installing Node.js 22"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
fi

ensure_app_user
sync_app_repo
install_node_dependencies
install_sysagent_venv
systemctl enable --now postgresql redis-server bind9 nginx
create_postgresql_database
write_panel_env
prepare_runtime_directories
build_application
write_systemd_services
write_panel_nginx_config
write_update_sudoers

log "Opening firewall ports"
ufw allow "$PANEL_LOGIN_PORT/tcp" || true
ufw allow "$CPANEL_LOGIN_PORT/tcp" || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw allow 53/tcp || true
ufw allow 53/udp || true

start_core_services
run_smoke_tests
log "Running post-install validation"
bash "$SCRIPT_DIR/validate-install.sh" || log "Validation reported failures — review output above"
print_install_summary
