#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

WEB_GROUP="nginx"
REDIS_SERVICE="redis"
BIND_SYSTEMD_SERVICE="named"
NGINX_SITES_AVAILABLE="/etc/nginx/sites-available"
NGINX_SITES_ENABLED="/etc/nginx/sites-enabled"

require_root
require_repo_url
validate_bootstrap_inputs
maybe_exit_dry_run
setup_install_logging
run_preflight_checks

install_alma_packages() {
  log "Enabling AlmaLinux repositories (CRB + EPEL)"
  dnf -y install dnf-plugins-core
  dnf config-manager --set-enabled crb || true
  dnf install -y epel-release

  log "Installing AlmaLinux packages"
  dnf install -y \
    ca-certificates curl gnupg2 git nginx firewalld \
    postgresql-server postgresql-contrib redis bind bind-utils \
    python3 python3-pip unzip zip openssl \
    gcc gcc-c++ make automake autoconf libtool acl lsof psmisc \
    policycoreutils-python-utils selinux-policy-targeted

  log "Installing Certbot from EPEL"
  dnf install -y certbot python3-certbot-nginx

  log "Installing optional Fail2Ban from EPEL"
  dnf install -y fail2ban || log "fail2ban install skipped (optional)"
  systemctl enable --now fail2ban >/dev/null 2>&1 || true

  if ! command -v node >/dev/null 2>&1 || ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1)'; then
    log "Installing Node.js 22"
    dnf module reset -y nodejs >/dev/null 2>&1 || true
    dnf module disable -y nodejs >/dev/null 2>&1 || true
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs --allowerasing
  fi
}

initialize_alma_postgresql() {
  log "Initializing PostgreSQL"
  if [[ ! -f /var/lib/pgsql/data/PG_VERSION ]]; then
    postgresql-setup --initdb
  fi
  systemctl enable --now postgresql
}

setup_alma_nginx_layout() {
  log "Setting up Nginx sites-available layout (panel_nginx_layout)"
  install -d -m 0755 "$NGINX_SITES_AVAILABLE" "$NGINX_SITES_ENABLED"
  write_file /etc/nginx/conf.d/00-sites-enabled.conf <<'EOF'
# Panel-managed vhosts (Debian-compatible layout on AlmaLinux)
include /etc/nginx/sites-enabled/*;
EOF
  if [[ -f /etc/nginx/conf.d/default.conf ]]; then
    mv /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/default.conf.disabled || true
  fi
}

enable_alma_base_services() {
  systemctl enable --now redis named nginx
}

run_step install_packages install_alma_packages
run_step initialize_postgresql initialize_alma_postgresql
run_step setup_nginx_layout setup_alma_nginx_layout
run_step ensure_app_user ensure_app_user
run_step sync_app_repo sync_app_repo
run_step install_node_dependencies install_node_dependencies
run_step install_sysagent_venv install_sysagent_venv
run_step enable_base_services enable_alma_base_services
run_step create_postgresql_database create_postgresql_database
run_step validate_database_connection validate_database_connection
issue_panel_ssl_certificate
run_step write_panel_env write_panel_env
run_step prepare_runtime_directories prepare_runtime_directories
run_step build_application build_application
run_step write_systemd_services write_systemd_services
run_step write_panel_nginx_config write_panel_nginx_config
run_step write_update_sudoers write_update_sudoers

log "Configuring firewalld"
systemctl enable --now firewalld
firewall-cmd --permanent --add-port="${PANEL_LOGIN_PORT}/tcp"
firewall-cmd --permanent --add-port="${CPANEL_LOGIN_PORT}/tcp"
firewall-cmd --permanent --add-service=http
firewall-cmd --permanent --add-service=https
firewall-cmd --permanent --add-service=dns
firewall-cmd --reload

log "Applying SELinux settings for Nginx reverse proxy"
if command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce)" != "Disabled" ]]; then
  setsebool -P httpd_can_network_connect 1 || true
  if command -v semanage >/dev/null 2>&1; then
    semanage port -a -t http_port_t -p tcp "$PANEL_LOGIN_PORT" 2>/dev/null || semanage port -m -t http_port_t -p tcp "$PANEL_LOGIN_PORT" 2>/dev/null || true
    semanage port -a -t http_port_t -p tcp "$CPANEL_LOGIN_PORT" 2>/dev/null || semanage port -m -t http_port_t -p tcp "$CPANEL_LOGIN_PORT" 2>/dev/null || true
  fi
fi

run_step start_core_services start_core_services
run_step run_smoke_tests run_smoke_tests
log "Running post-install validation"
bash "$SCRIPT_DIR/validate-install.sh" || log "Validation reported failures — review output above"
print_install_summary
