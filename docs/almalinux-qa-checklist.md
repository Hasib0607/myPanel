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
- [ ] Upgrade Composer/Laravel PHP runtime to PHP 8.2 when lockfiles require PHP 8.1/8.2+
- [ ] PHP 8.2 repair removes old PHP 8.0 PECL ABI blockers (`php-pecl-redis*`, `php-pecl-msgpack*`, `php-pecl-igbinary*`) before module switch
- [ ] PHP Redis extension repair removes old `php-pecl-redis*` ABI blockers and rebuilds `ext-redis` with PECL for the active PHP runtime
- [ ] Zip uploads with one nested app folder auto-correct `rootDirectory` before runtime detection, Nginx/start/health checks for Laravel, React/Node, Next.js, Python, and Go projects
- [ ] Laravel zip uploads where the parent has `artisan` but only the nested app has `public/index.php` choose the nested public web root, not backend-only idle mode
- [ ] Parent Laravel folders containing `artisan` do not hide a web root containing `public/index.php` nested up to four folder levels deep; true backend-only Laravel deployments start as idle Supervisor jobs and publish neither a dead upstream nor an empty/index-less `public_html` fallback
- [ ] Deployment Doctor detects Nginx 403 from an index-less/wrong root, recommends redeploy, and reports the corrected nested Laravel public web root
- [ ] Linked domains/subdomains serve the deployment while it is `RUNNING`, then restore the file-manager `public_html`/subdomain root after stop, unlink, or missing deployment target without stale Nginx 502 proxy configs
- [ ] Deployments without a linked domain skip Nginx proxy/SSL configuration, continue on their managed internal port, and never fail with a null domain `name` error
- [ ] Deployment Doctor/Guardian marks public HTTP 502/503/504 as a repairable failure, rewrites the generated Nginx vhost, queues restart, probes again, and does not mark the deployment running if the upstream is still unreachable
- [ ] Deployment Doctor/Guardian identifies Laravel MySQL access-denied crashes, including DB/user case mismatch, host-grant mismatch (`localhost` vs `127.0.0.1`), and password/grant repair needs
- [ ] Wildcard subdomains like `*.example.com` can be added after the parent domain exists, publish a wildcard DNS/vhost, and use the safe file-manager root `example.com/subdomains/_wildcard`
- [ ] Wildcard subdomain SSL does not send `domain-*.example.com` as a sysagent vhost name; it uses DNS-01 TXT automation against the panel-managed zone and stores the cert as `wildcard.example.com`
- [ ] React/Vite build failures like `vite: command not found` are treated as missing project package binaries; Guardian reinstalls Node dependencies with devDependencies and retries the build instead of requesting a global Vite install
- [ ] Laravel apps with Vite/Mix/package frontend markers deploy with compiled CSS/JS assets under `public`, and Doctor/Guardian flags missing built assets before declaring the public site healthy
- [ ] Laravel Mix/Vite `Module not found` / `Can't resolve` errors are reported as missing app source or import-case issues, not server runtime repairs; deploy continues only if built public assets already exist
- [ ] Laravel public route health parses the rendered HTML and checks first-party CSS/JS/image/font URLs through Nginx, marking the deployment degraded when linked static files 404
- [ ] Composer lockfiles that reject PHP 8.3 because dependencies allow only `~8.1.0 || ~8.2.0` trigger PHP 8.2 runtime repair instead of a generic composer-update loop
- [ ] PHP 8.2/8.3 runtime repair does not skip when a newer PHP minor is active; AlmaLinux module packages are distro-synced and the exact requested CLI minor is verified before Composer retries
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
