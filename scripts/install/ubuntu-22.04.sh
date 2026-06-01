#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

require_root
require_repo_url
validate_bootstrap_inputs
maybe_exit_dry_run
setup_install_logging
run_preflight_checks

install_ubuntu_packages() {
  log "Installing Ubuntu packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl gnupg git nginx certbot python3-certbot-nginx postgresql postgresql-contrib redis-server bind9 bind9utils dnsutils ufw python3 python3-venv python3-pip unzip zip openssl build-essential acl lsof psmisc php php-cli php-fpm php-mysql php-pgsql php-xml php-mbstring php-curl php-zip php-gd php-soap

  if ! command -v node >/dev/null 2>&1 || ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1)'; then
    log "Installing Node.js 22"
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update
    apt-get install -y nodejs
  fi
}

enable_ubuntu_base_services() {
  systemctl enable --now postgresql redis-server bind9 nginx
  systemctl enable --now php*-fpm >/dev/null 2>&1 || true
}

run_step install_packages install_ubuntu_packages
run_step ensure_app_user ensure_app_user
run_step sync_app_repo sync_app_repo
run_step install_node_dependencies install_node_dependencies
run_step install_sysagent_venv install_sysagent_venv
run_step enable_base_services enable_ubuntu_base_services
run_step create_postgresql_database create_postgresql_database
run_step validate_database_connection validate_database_connection
issue_panel_ssl_certificate
run_step write_panel_env write_panel_env
run_step prepare_runtime_directories prepare_runtime_directories
run_step build_application build_application
run_step write_systemd_services write_systemd_services
run_step write_panel_nginx_config write_panel_nginx_config
run_step write_update_sudoers write_update_sudoers

log "Opening firewall ports"
ufw allow "$PANEL_LOGIN_PORT/tcp" || true
ufw allow "$CPANEL_LOGIN_PORT/tcp" || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw allow 53/tcp || true
ufw allow 53/udp || true

run_step start_core_services start_core_services
run_step run_smoke_tests run_smoke_tests
log "Running post-install validation"
bash "$SCRIPT_DIR/validate-install.sh" || log "Validation reported failures — review output above"
print_install_summary
