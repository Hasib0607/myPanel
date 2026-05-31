# One-Command VPS Install

Supported: **Ubuntu 22.04** and **AlmaLinux 9**.

## Auto-detect OS (recommended)

```bash
export REPO_URL="https://github.com/YOUR_OWNER/YOUR_REPO.git"
export APP_BRANCH="main"
export VPS_IP="YOUR_SERVER_IP"
export PANEL_UPDATE_REPO_FULL_NAME="YOUR_OWNER/YOUR_REPO"
bash scripts/install/install.sh
```

Or from GitHub:

```bash
export REPO_URL="https://github.com/YOUR_OWNER/YOUR_REPO.git"
export APP_BRANCH="main"
export VPS_IP="YOUR_SERVER_IP"
export PANEL_UPDATE_REPO_FULL_NAME="YOUR_OWNER/YOUR_REPO"
curl -fsSL "https://raw.githubusercontent.com/YOUR_OWNER/YOUR_REPO/main/scripts/install/install.sh" | sudo -E bash
```

## Ubuntu 22.04 only

```bash
bash scripts/install/ubuntu-22.04.sh
```

Uses `apt`, UFW, `redis-server`, `bind9`, and native `sites-available` Nginx layout.

## AlmaLinux 9 only

```bash
bash scripts/install/alma-linux-9.sh
```

Uses `dnf`, CRB + EPEL, firewalld, `redis` + `named` services, and creates a Debian-compatible Nginx `sites-available` / `sites-enabled` layout on Alma.

## What the installer sets up

- Node.js 22, PostgreSQL, Redis, Nginx, BIND, Python sysagent
- Certbot (Ubuntu repos / Alma EPEL)
- `/opt/vps-panel`
- managed deployment ports `10000-19999`, keeping panel ports reserved
- systemd services: `vps-panel-api`, `vps-panel-workers`, `vps-panel-frontend`, `vps-panel-sysagent`
- WHM-style admin listener on `:8453`
- cPanel-style account listener on `:3138`
- PM2 startup for deployed Node/Next.js projects
- `/var/www` and `/var/www/deployments` permissions for managed hosting
- file manager, DNS, and Nginx live sysagent permissions
- self-update sudoers for git-push deploys
- database migrations and production builds
- smoke tests for sysagent, API, frontend, panel Nginx proxy, Redis, PostgreSQL, and systemd services

Output includes the generated admin password and webhook secret. Save them immediately.

Validate after install:

```bash
bash scripts/install/validate-install.sh
curl -fsS http://127.0.0.1:5000/system/platform
```

Manual QA checklist: `docs/almalinux-qa-checklist.md`

## Useful options

```bash
export PANEL_LOGIN_PORT=8453
export CPANEL_LOGIN_PORT=3138
export FRONTEND_PORT=3000
export DEPLOYMENT_PORT_START=10000
export DEPLOYMENT_PORT_END=19999
export SUPERADMIN_USERNAME=admin
export SUPERADMIN_PASSWORD="your-strong-password"
```

## AlmaLinux notes

- Installer enables **firewalld** and opens panel/HTTP/HTTPS/DNS ports
- **SELinux**: sets `httpd_can_network_connect` and attempts custom port labels for panel listeners
- **Nginx**: writes `conf.d/00-sites-enabled.conf` and disables default `conf.d/default.conf` if present
- Remaining live QA checklist: `docs/almalinux-missing-tracker.md`
