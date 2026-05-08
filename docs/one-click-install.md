# One-Command Ubuntu Install

Run this on a fresh Ubuntu 22.04 VPS as root after cloning the repo.

```bash
export REPO_URL="https://github.com/YOUR_OWNER/YOUR_REPO.git"
export APP_BRANCH="main"
export VPS_IP="YOUR_SERVER_IP"
export PANEL_UPDATE_REPO_FULL_NAME="YOUR_OWNER/YOUR_REPO"
bash scripts/install/ubuntu-22.04.sh
```

Or run the raw installer directly from GitHub:

```bash
export REPO_URL="https://github.com/YOUR_OWNER/YOUR_REPO.git"
export APP_BRANCH="main"
export VPS_IP="YOUR_SERVER_IP"
export PANEL_UPDATE_REPO_FULL_NAME="YOUR_OWNER/YOUR_REPO"
curl -fsSL "https://raw.githubusercontent.com/YOUR_OWNER/YOUR_REPO/main/scripts/install/ubuntu-22.04.sh" | sudo -E bash
```

The installer sets up:

- Node.js, PostgreSQL, Redis, Nginx, BIND9, Python sysagent
- `/opt/vps-panel`
- managed deployment ports `10000-19999`, keeping panel ports reserved
- systemd services: `vps-panel-api`, `vps-panel-workers`, `vps-panel-frontend`, `vps-panel-sysagent`
- panel listener on `:2083`
- PM2 startup for deployed Node/Next.js projects
- `/var/www` and `/var/www/deployments` permissions for managed hosting
- file manager, DNS, and Nginx live sysagent permissions
- self-update sudoers for git-push deploys
- database migrations and production builds
- smoke tests for sysagent, API, frontend, panel Nginx proxy, Redis, PostgreSQL, and systemd services

Output includes the generated admin password and webhook secret. Save them immediately.

Useful options:

```bash
export PANEL_LOGIN_PORT=2083
export FRONTEND_PORT=3000
export DEPLOYMENT_PORT_START=10000
export DEPLOYMENT_PORT_END=19999
export SUPERADMIN_USERNAME=admin
export SUPERADMIN_PASSWORD="your-strong-password"
```
