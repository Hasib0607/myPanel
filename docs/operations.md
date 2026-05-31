# Operations Notes

## Backup

Run PostgreSQL backups from the production VPS with:

```bash
DATABASE_URL="$DATABASE_URL" BACKUP_DIR=/var/backups/vps-panel ./scripts/backup/backup-panel-db.sh
```

Keep at least daily backups for 14 days and weekly backups for 8 weeks. Copy backups off the VPS.

## Restore

Restore only during a maintenance window:

```bash
DATABASE_URL="$DATABASE_URL" ./scripts/backup/restore-panel-db.sh /var/backups/vps-panel/panel-main-YYYYMMDDTHHMMSSZ.dump
```

## Live System Actions

Keep `ALLOW_LIVE_SYSTEM_COMMANDS=false` until sudoers rules and sysagent command policies are reviewed on a disposable VPS. Enable live actions module by module: Nginx, DNS, mail, database, deployments.

## Server Files vs Repo Files

Keep real server state on the VPS only:

- `/etc/nginx/sites-available/00-vps-panel`
- `/etc/nginx/sites-available/domain-*.conf`
- `/etc/systemd/system/vps-panel-*.service`
- `/etc/sudoers.d/vps-panel-update`
- `/opt/vps-panel/.env`
- `/opt/vps-panel/api/.env`
- `/opt/vps-panel/frontend/.env.production`

Do not commit real secrets or generated production config. Commit templates instead:

- `infra/nginx/00-vps-panel.conf.example`
- `infra/nginx/domain-proxy.conf.template`
- `infra/systemd/*.service.example`
- `infra/sudoers/vps-panel-update.example`
- `.env.example`

Generated domain configs must never use `default_server`. Only the panel fallback config should claim `default_server`; domain configs should claim explicit `server_name` values and proxy to the deployment port assigned by the panel.

## Ownership Rules

Run Git and builds as the `panel` user so the checkout does not get root-owned files:

```bash
sudo -iu panel
cd /opt/vps-panel
git fetch origin main
git reset --hard origin/main
git clean -fd
npm install
npm run build --workspace api
npm run build --workspace frontend
```

Run service management as root:

```bash
sudo systemctl restart vps-panel-sysagent vps-panel-workers vps-panel-frontend vps-panel-api
sudo systemctl reload nginx
```

If `.next` permissions break after a root build:

```bash
sudo systemctl stop vps-panel-frontend
sudo rm -rf /opt/vps-panel/frontend/.next
sudo chown -R panel:panel /opt/vps-panel
sudo -iu panel bash -lc 'cd /opt/vps-panel/frontend && npm run build'
sudo systemctl restart vps-panel-frontend
```

## Panel Self-Update Webhook

Use this only for the panel repository itself. Project deployments use the per-project GitHub webhook in Deployment Settings.

1. Generate a strong webhook secret on the VPS:

```bash
openssl rand -hex 32
```

2. Add these values to `/opt/vps-panel/.env`:

```bash
PANEL_UPDATE_WEBHOOK_SECRET=replace_with_generated_secret
PANEL_UPDATE_REPO_FULL_NAME=your-github-owner/your-panel-repo
PANEL_UPDATE_BRANCH=main
PANEL_UPDATE_WORKDIR=/opt/vps-panel
PANEL_UPDATE_SCRIPT=/opt/vps-panel/scripts/deploy/update-panel.sh
PANEL_UPDATE_PID_FILE=/tmp/vps-panel-self-update.pid
PANEL_UPDATE_API_SERVICE=vps-panel-api
PANEL_UPDATE_SERVICES=vps-panel-sysagent vps-panel-workers vps-panel-frontend vps-panel-api
PANEL_UPDATE_DIRTY_STRATEGY=fail
PANEL_UPDATE_COMMAND_TIMEOUT=30
PANEL_UPDATE_SYSTEMCTL_NO_BLOCK=true
PANEL_UPDATE_SERVICE_ACTIVE_ATTEMPTS=20
PANEL_UPDATE_STALE_AFTER_SECONDS=1200
```

3. Allow the `panel` user to restart only the panel services:

```bash
sudo visudo -f /etc/sudoers.d/vps-panel-update
```

Add:

```sudoers
panel ALL=(root) NOPASSWD: /bin/systemctl --no-block restart vps-panel-sysagent, /bin/systemctl is-active vps-panel-sysagent, /bin/systemctl status vps-panel-sysagent, /bin/systemctl --no-block restart vps-panel-workers, /bin/systemctl is-active vps-panel-workers, /bin/systemctl status vps-panel-workers, /bin/systemctl --no-block restart vps-panel-frontend, /bin/systemctl is-active vps-panel-frontend, /bin/systemctl status vps-panel-frontend, /bin/systemctl --no-block restart vps-panel-api, /bin/systemctl is-active vps-panel-api, /bin/systemctl status vps-panel-api
```

If `systemctl` is located somewhere else, use `which systemctl` and update the path. On many Ubuntu installs it is `/usr/bin/systemctl`, so the rule would be:

```sudoers
panel ALL=(root) NOPASSWD: /usr/bin/systemctl --no-block restart vps-panel-sysagent, /usr/bin/systemctl is-active vps-panel-sysagent, /usr/bin/systemctl status vps-panel-sysagent, /usr/bin/systemctl --no-block restart vps-panel-workers, /usr/bin/systemctl is-active vps-panel-workers, /usr/bin/systemctl status vps-panel-workers, /usr/bin/systemctl --no-block restart vps-panel-frontend, /usr/bin/systemctl is-active vps-panel-frontend, /usr/bin/systemctl status vps-panel-frontend, /usr/bin/systemctl --no-block restart vps-panel-api, /usr/bin/systemctl is-active vps-panel-api, /usr/bin/systemctl status vps-panel-api
```

The update script resolves `systemctl` to an absolute path and fails before building if the `panel` user cannot run these commands without a password.

4. Restart the API once after changing `.env`:

```bash
sudo systemctl restart vps-panel-api
```

5. Add a GitHub webhook to the panel repository:

- Payload URL: `http://129.121.99.82:8453/api/v1/webhooks/panel-update`
- Content type: `application/json`
- Secret: the value from `PANEL_UPDATE_WEBHOOK_SECRET`
- Event: `push`

When the configured branch receives a push, the VPS runs `scripts/deploy/update-panel.sh`. The script refuses to update if the server worktree has local changes and uses `git pull --ff-only` to avoid rewriting history.

Update logs:

```bash
tail -f /var/log/vps-panel/self-update.log
```

Update status from an authenticated panel browser/API session:

```text
GET /api/v1/webhooks/panel-update/status
```

The update script writes `/var/log/vps-panel/self-update-status.json` with one of:

- `running`
- `succeeded`
- `failed`

The script restarts services with `systemctl --no-block restart`, verifies each service with `systemctl is-active`, and checks `http://127.0.0.1:4000/health` when `curl` is installed. The API service restarts last so the status endpoint stays reachable for as long as possible.

## AlmaLinux 9 operations notes

- **Install:** `bash scripts/install/install.sh` or `bash scripts/install/alma-linux-9.sh`
- **Firewall:** firewalld (not UFW). Panel sysagent uses `firewall-cmd` for live rules.
- **Services:** Redis unit is `redis`, BIND is `named`, web user is `nginx`
- **Auth logs:** `/var/log/secure` (not `/var/log/auth.log`)
- **Nginx:** installer creates `/etc/nginx/sites-available` and `sites-enabled`; env vars `NGINX_SITES_AVAILABLE` / `NGINX_SITES_ENABLED` are written to `.env`
- **SELinux:** installer runs `setsebool -P httpd_can_network_connect 1`; if panel ports fail to bind, check `semanage port -l | grep http_port_t`
- **Optional:** install fail2ban from EPEL if you want parity with Ubuntu guardian fail2ban signals

Live QA checklist: `docs/almalinux-missing-tracker.md`

The updater writes a PID file and treats a running update as stale after `PANEL_UPDATE_STALE_AFTER_SECONDS` seconds. Future webhook runs and direct script runs can recover a stale update process instead of leaving the dashboard permanently stuck on `running`.

The API service is special because the webhook starts the updater from inside the API service. The script writes `succeeded` before requesting the final API restart, so systemd cannot leave the dashboard stuck on `restarting vps-panel-api` if it kills child processes during the API restart.

If you want the VPS to discard local tracked edits and always follow GitHub, set:

```bash
PANEL_UPDATE_DIRTY_STRATEGY=reset
```

Use this only when `/opt/vps-panel` is treated as a deployment checkout and all real changes are pushed from GitHub. Ignored files such as `.env` are kept, but local tracked code edits are discarded.
