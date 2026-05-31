# One-Command VPS Install

Supported: **Ubuntu 22.04** and **AlmaLinux 9**.

## Bootstrap from one command (recommended)

This path auto-detects Ubuntu 22.04 or AlmaLinux 9, provisions an empty PostgreSQL database, writes the project `.env`, builds the API/frontend, installs systemd services, opens WHM/cPanel ports, and runs smoke tests.

```bash
curl -fsSL "https://raw.githubusercontent.com/YOUR_OWNER/YOUR_REPO/main/scripts/install/bootstrap.sh" | sudo bash -s -- \
  --repo "https://github.com/YOUR_OWNER/YOUR_REPO.git" \
  --branch main \
  --domain panel.example.com \
  --db-name panel_main \
  --db-user panel_user \
  --db-pass "change-this-database-password" \
  --admin-user admin \
  --admin-pass "change-this-admin-password"
```

Preview without changing the server:

```bash
curl -fsSL "https://raw.githubusercontent.com/YOUR_OWNER/YOUR_REPO/main/scripts/install/bootstrap.sh" | sudo bash -s -- \
  --repo "https://github.com/YOUR_OWNER/YOUR_REPO.git" \
  --domain panel.example.com \
  --dry-run
```

Use prompt mode to keep passwords out of shell history:

```bash
curl -fsSL "https://raw.githubusercontent.com/YOUR_OWNER/YOUR_REPO/main/scripts/install/bootstrap.sh" | sudo bash -s -- \
  --repo "https://github.com/YOUR_OWNER/YOUR_REPO.git" \
  --domain panel.example.com \
  --prompt-secrets
```

Enable Let's Encrypt for the panel domain:

```bash
curl -fsSL "https://raw.githubusercontent.com/YOUR_OWNER/YOUR_REPO/main/scripts/install/bootstrap.sh" | sudo bash -s -- \
  --repo "https://github.com/YOUR_OWNER/YOUR_REPO.git" \
  --domain panel.example.com \
  --enable-ssl \
  --ssl-email admin@example.com \
  --prompt-secrets
```

SSL mode uses HTTP-01 validation on port `80`, then serves WHM/cPanel panel listeners over HTTPS on `8453` and `3138`.

For an external or already-created empty database, pass the full URL and skip local DB creation:

```bash
sudo bash scripts/install/bootstrap.sh \
  --repo "https://github.com/YOUR_OWNER/YOUR_REPO.git" \
  --database-url "postgresql://panel_user:password@db.example.com:5432/panel_main"
```

## Auto-detect OS with environment variables

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

The database starts empty apart from Prisma migration metadata. Output includes the generated admin password and webhook secret when you do not pass them explicitly. Save them immediately.

Installer output is saved to `/var/log/vps-panel/install.log`. Completed step markers are saved under `/var/log/vps-panel/install-state`, so a failed install can usually be rerun safely. Use `--no-resume` or `--force-step` when you intentionally want to rerun completed steps.

Validate after install:

```bash
bash scripts/install/validate-install.sh
curl -fsS http://127.0.0.1:5000/system/platform
```

Manual QA checklist: `docs/almalinux-qa-checklist.md`

Rollback a failed fresh install:

```bash
sudo bash scripts/install/uninstall.sh --yes
```

Add `--purge-db`, `--purge-app`, or `--purge-logs` only when you explicitly want to delete those resources.

Repair an older `:2083` panel listener after updating:

```bash
sudo bash /opt/vps-panel/scripts/maintenance/repair-panel-listener.sh
```

For trusted SSL, point a real domain to the VPS first, then run:

```bash
sudo bash /opt/vps-panel/scripts/maintenance/repair-panel-listener.sh \
  --domain panel.example.com \
  --enable-ssl \
  --ssl-email admin@example.com
```

Trusted Let's Encrypt certificates cannot be issued for a bare IP address.

## Useful options

```bash
export PANEL_LOGIN_PORT=8453
export CPANEL_LOGIN_PORT=3138
export FRONTEND_PORT=3000
export DEPLOYMENT_PORT_START=10000
export DEPLOYMENT_PORT_END=19999
export SUPERADMIN_USERNAME=admin
export SUPERADMIN_PASSWORD="your-strong-password"
export DB_NAME=panel_main
export DB_USER=panel_user
export DB_PASSWORD="your-strong-db-password"
export PANEL_DOMAIN=panel.example.com
```

## AlmaLinux notes

- Installer enables **firewalld** and opens panel/HTTP/HTTPS/DNS ports
- **SELinux**: sets `httpd_can_network_connect` and attempts custom port labels for panel listeners
- **Nginx**: writes `conf.d/00-sites-enabled.conf` and disables default `conf.d/default.conf` if present
- Remaining live QA checklist: `docs/almalinux-missing-tracker.md`
