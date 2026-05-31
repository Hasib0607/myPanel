# AlmaLinux 9 — Manual QA Checklist

Run on a **fresh AlmaLinux 9 VPS** after install. Track results in [`almalinux-missing-tracker.md`](almalinux-missing-tracker.md).

## 1. Install

```bash
export REPO_URL="https://github.com/YOUR_OWNER/myPanel.git"
export VPS_IP="$(curl -fsS ifconfig.me)"
bash scripts/install/install.sh
```

- [ ] Install completes without fatal error
- [ ] `bash scripts/install/validate-install.sh` exits 0
- [ ] Admin password and webhook secret printed

## 2. Panel access

- [ ] `http://$VPS_IP:8453/login` loads admin UI
- [ ] `http://$VPS_IP:3138/login` loads account UI
- [ ] Superadmin login works

## 3. Platform / sysagent

```bash
curl -fsS http://127.0.0.1:5000/system/platform | jq .
```

- [ ] `family` = `rhel`
- [ ] `firewallBackend` = `firewalld`
- [ ] `paths.authLog` = `/var/log/secure`
- [ ] `paths.nginxSitesAvailable` = `/etc/nginx/sites-available`

## 4. Services

```bash
systemctl is-active named redis postgresql nginx vps-panel-api vps-panel-sysagent
```

- [ ] All panel units active
- [ ] `named` and `redis` active

## 5. Nginx layout (panel_nginx_layout)

- [ ] `/etc/nginx/sites-available/00-vps-panel` exists
- [ ] Symlink in `sites-enabled`
- [ ] `/etc/nginx/conf.d/00-sites-enabled.conf` exists
- [ ] `conf.d/default.conf` disabled or absent
- [ ] `nginx -t` passes

## 6. Firewall (firewalld)

From panel **Firewall** page:

- [ ] Live status shows firewalld (not UFW error)
- [ ] Add allow rule for test port (e.g. 18080)
- [ ] `firewall-cmd --list-ports` shows the port
- [ ] Delete/remove rule works (best-effort numbered delete)

## 7. Guardian

- [ ] `/guardian` loads without sysagent errors
- [ ] Firewall section shows data (not empty)
- [ ] Redis service shows healthy with unit `redis`

## 8. Deployment runtime tools

From Deployment Doctor or runtime-tools install:

- [ ] Install PHP stack (dnf packages)
- [ ] Install Composer (EPEL or fallback)
- [ ] Install Go if needed

## 9. DNS (BIND)

- [ ] Add test zone from panel
- [ ] `named-checkzone` / zone file created
- [ ] Port 53 listening

## 10. Self-update

- [ ] GitHub webhook configured
- [ ] Push to branch triggers update
- [ ] `update-panel.sh` completes; services restart

## After all pass

- [ ] Mark QA complete in `docs/almalinux-missing-tracker.md`
