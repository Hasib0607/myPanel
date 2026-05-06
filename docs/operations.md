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
