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
PANEL_UPDATE_DIRTY_STRATEGY=fail
PANEL_UPDATE_COMMAND_TIMEOUT=30
PANEL_UPDATE_SYSTEMCTL_NO_BLOCK=true
PANEL_UPDATE_SERVICE_ACTIVE_ATTEMPTS=20
```

3. Allow the `panel` user to restart only the panel services:

```bash
sudo visudo -f /etc/sudoers.d/vps-panel-update
```

Add:

```sudoers
panel ALL=(root) NOPASSWD: /bin/systemctl restart --no-block vps-panel-api, /bin/systemctl restart --no-block vps-panel-workers, /bin/systemctl restart --no-block vps-panel-frontend, /bin/systemctl is-active vps-panel-api, /bin/systemctl is-active vps-panel-workers, /bin/systemctl is-active vps-panel-frontend
```

If `systemctl` is located somewhere else, use `which systemctl` and update the path.

4. Restart the API once after changing `.env`:

```bash
sudo systemctl restart vps-panel-api
```

5. Add a GitHub webhook to the panel repository:

- Payload URL: `http://129.121.99.82:2083/api/v1/webhooks/panel-update`
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

The script restarts services with `systemctl restart --no-block`, verifies each service with `systemctl is-active`, and checks `http://127.0.0.1:4000/health` when `curl` is installed. The API service restarts last so the status endpoint stays reachable for as long as possible.

If you want the VPS to discard local tracked edits and always follow GitHub, set:

```bash
PANEL_UPDATE_DIRTY_STRATEGY=reset
```

Use this only when `/opt/vps-panel` is treated as a deployment checkout and all real changes are pushed from GitHub. Ignored files such as `.env` are kept, but local tracked code edits are discarded.
