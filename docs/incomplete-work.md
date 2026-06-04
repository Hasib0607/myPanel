# Incomplete Work Tracker

Last updated: 2026-05-09

This file keeps every known incomplete, deferred, or partially complete task in one place so the next planning pass does not need to hunt through all phase notes.

## Deferred Feature: Server Guardian Bot

Status: Phase 1 started

Goal: Add a server autopilot/guardian agent that continuously monitors the VPS, diagnoses incidents, performs safe auto-healing, and suggests or applies security responses.

Planned phases:

- Phase 1: Read-only monitoring for systemd services, PM2 processes, ports, disk, RAM, CPU, load, Redis, PostgreSQL, Nginx, SSL expiry, deployment health, auth logs, and Fail2Ban/UFW status.
- Phase 2: Safe auto-healing for known services: restart dead panel services, restart crashed PM2 apps, run `nginx -t` before reload, clear stale deployment logs/cache, and record incident logs.
- Phase 3: Security response: detect SSH brute force, suspicious request floods, repeated 4xx/5xx patterns, abnormal login attempts, and dynamically block abusive IPs through UFW/Fail2Ban with allowlist support.
- Phase 4: Deployment doctor: detect port conflicts, crash loops, env issues, wrong Nginx upstreams, bad SSL redirects, and show exact remediation.
- Phase 5: Approval workflow: classify actions as safe-auto or approval-required, show suggested commands, and keep audit logs for every action.
- Phase 6: AI-assisted diagnosis: summarize structured logs and recent incidents, generate explanation/fix suggestions, and only auto-run allowlisted safe commands.

Safety rules:

- Auto-run only low-risk actions such as restarting known services, reloading Nginx after a successful config test, cleaning old logs, and blocking clearly abusive IPs.
- Require explicit admin approval for deleting files, resetting Git, dropping databases, opening public ports, rewriting Nginx configs, killing unknown processes, or changing SSH/firewall lockout-sensitive rules.
- Keep an allowlist for trusted IP ranges and never block panel admin IPs or configured CDN ranges without confirmation.

Suggested UI:

- Add `/guardian` with live health, incidents, auto-fixed actions, blocked IPs, allowlist, rule settings, manual diagnosis, and approval queue.

Suggested service:

- Add `vps-panel-guardian.service` plus BullMQ repeat jobs for periodic checks.

Implemented Phase 1 foundation:

- Added sysagent read-only `/guardian/diagnosis` for watched services, ports, resources, PM2 availability, Nginx/auth log signals, UFW, Fail2Ban, and active incident detection.
- Added authenticated API `/api/v1/guardian/overview` with deployment and SSL expiry enrichment.
- Added frontend `/guardian` page with live incidents, watched services, resource meters, security signals, watched ports, deployment watch, and SSL watch.
- Added `vps-panel-guardian.service.example` and API `guardian` runner script for periodic read-only diagnosis logging.
- Added parsed PM2 app health, Postgres/PgBouncer port awareness, live TLS certificate probing, and detailed Nginx access-log summaries for Phase 1 hardening.
- Phase 2 implemented with safe auto-heal actions for allowlisted service restarts, PM2 restarts, Nginx config-test reloads, stale deployment log cleanup, DB-backed incident/action history, cooldown and retry limits, action result UI, health rechecks, and BullMQ worker execution. Actions respect `ALLOW_LIVE_SYSTEM_COMMANDS`; the guardian scheduler can enable periodic healing with `GUARDIAN_AUTO_HEAL=true`.
- Phase 3 started with security response foundation: suspicious IP scoring from SSH/Nginx signals, IP allowlist/block history, manual block/unblock controls, temporary auto-block expiry support, failed-login audit signals, and suspicious file watch findings for unusual files under configured roots.
- Phase 3 slice 2 added trusted CIDR protection, failed-login anomaly grouping, Nginx rate-limit template planning/application, and expanded Guardian UI controls for allowlist, blocked IPs, suspicious IPs, file watch, and login anomalies.
- Phase 3 completion pass added IPv6 CIDR matching, Cloudflare CIDR sync, RDAP IP context lookup, evidence lookup, file trust/quarantine workflow, notification records, auto-block mode/duration settings, and active Nginx `conf.d` rate-limit deployment.
- Guardian critical actions now include manual safe restart controls for PostgreSQL, PgBouncer, Nginx, and panel services, direct Nginx config-test reload, action history records, notifications, audit logs, and post-action diagnosis rechecks.
- Phase 4 started with a Deployment Doctor that auto-detects runtime drift, source/root issues, port conflicts, PM2/start command health, recent build/runtime error patterns, and public Nginx route problems, then offers safe repairs such as sync runtime commands, health recheck, restart, or redeploy.
- Phase 4 slice 2 added Doctor evidence snippets, env fix suggestions, safe NODE_OPTIONS memory-cap repair, and public URL env sync for apps that redirect/generate localhost URLs.
- Phase 4 slice 3/4 added richer build-error parsing, missing runtime tool detection, database checks, Nginx upstream inspection, Supervisor health validation, rollback suggestions, approval-required risky fix previews, and scheduled deployment health watch jobs.
- Deployment Doctor approval workflow added persistent approval records, approve/reject controls, and allowlisted execution for runtime package installs, permission repair, Supervisor repair, generated Nginx rewrite, and DB provision fixes.
- Deployment Doctor/Guardian runtime repair now recognizes Composer lockfiles requiring PHP 8.1/8.2+ on a PHP 8.0 VPS, prioritizes PHP runtime repair over generic lockfile warnings, and handles AlmaLinux/RHEL PHP 8.2 module switches blocked by old `php-pecl-redis*`, `php-pecl-msgpack*`, or `php-pecl-igbinary*` ABI RPMs.
- Deployment Doctor/Guardian now handles PHP Redis extension installs on AlmaLinux/RHEL after PHP 8.2 upgrades by removing old `php-pecl-redis*` ABI RPMs and rebuilding `ext-redis` with PECL for the active PHP runtime.
- Deployment Doctor/Guardian now recognizes Laravel/Supervisor starts that fail because `php artisan serve` needs a missing `public` directory, corrects accidental `/public` roots, detects nested app roots created by zip uploads for Laravel, React/Node, Next.js, Python, and Go projects, prefers nested Laravel roots that actually contain `public/index.php` over parent folders that only contain `artisan`, uses the corrected app root for runtime detection, Nginx/start/health repair paths, uses a long-running idle Supervisor process for backend-only Laravel projects without `public/index.php`, treats that backend-only idle process as healthy instead of degraded, skips `storage:link` for those backend-only projects, and skips public route probes only when no nested public Laravel web root exists.
- Deployment domain routing now gives active `RUNNING` deployment proxies priority for linked domains/subdomains, restores the file-manager `public_html`/subdomain root when a deployment is stopped, unlinked, missing, or not running, and scrubs stale Nginx vhosts that share the same `server_name` so old deployment proxy configs cannot keep causing 502s.
- Deployment Doctor/Guardian now treats public-route `degraded` probes and HTTP 502/503/504 Bad Gateway responses as real failures, rewrites the generated deployment Nginx vhost with stale `server_name` cleanup, and queues a process restart when Nginx still cannot reach the upstream after the rewrite.
- Deployment Doctor/Guardian now recognizes Laravel MySQL/MariaDB `SQLSTATE[HY000] [1045/1698] Access denied for user` crashes, calls out exact database/user case, localhost vs `127.0.0.1` host grants, password mismatch, and offers the panel-managed database grant/password repair path when metadata is available.
- Domain management now supports wildcard subdomains such as `*.example.com` once the parent domain exists, creating wildcard DNS/Nginx entries while mapping the file-manager root to `example.com/subdomains/_wildcard` instead of a literal unsafe `*` folder.
- Deployment Doctor/Guardian now recognizes React/Vite build failures such as `vite: command not found` as missing project package binaries, not missing server runtimes, and redeploys by reinstalling Node dependencies with devDependencies before retrying the build.
- Wildcard subdomain SSL now uses safe Nginx/Certbot names such as `domain-wildcard.example.com` / `wildcard.example.com` and issues wildcard certificates through DNS-01 against the panel-managed authoritative zone instead of the HTTP webroot flow.
- Deployment Doctor/Guardian now recognizes Laravel apps with frontend build markers but missing built public CSS/JS assets, and redeploys by installing Node frontend dependencies and running the Laravel Vite/Mix build before Nginx/public health checks.
- Laravel frontend deploys now distinguish missing app source files or Linux case-sensitive import mismatches from server dependency issues; if Mix/Vite reports `Module not found` / `Can't resolve`, Doctor points to the missing source/import fix, while the deploy worker may continue only when usable built public assets already exist.
- Deployment Doctor/Guardian now parses the rendered Laravel public page and probes first-party CSS/JS/image/font URLs through Nginx, so a page that returns HTTP 200 but has missing `/admin/assets/...`, logo, favicon, or built frontend files is marked degraded with the exact missing URLs instead of healthy.
- Account split added cPanel-style account records, WHM account create/detail/manage UI, reusable package templates, package limits, assignment/unassignment, activity history, account-owned domain/mail/file/deployment/database/DNS/SSL APIs, account dashboard, separate `panel_session` / `account_session` cookies, account role guards, suspend/delete resource handling, live disk usage, account file-root isolation, sysagent home scaffolding, and split listener defaults: WHM/admin on `8453`, account/cPanel on `3138`.

## Current VPS Deployment Blockers

### VPS Step 10: Domain And SSL Setup

Status: Incomplete

- Point a real panel domain to `129.121.99.82`.
- Update production `.env`:
  - `FRONTEND_URL=https://panel.yourdomain.com`
  - `VPS_IP=129.121.99.82`
- Update Nginx `server_name` from IP-only access to the real panel domain.
- Run Certbot for the panel domain.
- Restart API, worker, frontend, and sysagent services after env/domain change.
- Confirm HTTPS login works through the final panel domain.

### VPS Step 11: Production Verification

Status: Incomplete

- Verify API health through localhost and public Nginx.
- Verify sysagent health only through localhost.
- Verify frontend loads through the panel domain.
- Verify login/logout with production cookies.
- Verify CSRF-protected actions from the frontend.
- Verify dashboard service health.
- Verify nameserver CRUD on dashboard.
- Verify GitHub repository list/import using the rotated production token.
- Verify deploy queue, worker, logs, and dry-run/live status.
- Verify database migration state on the VPS.
- Verify panel self-update webhook pulls/builds/restarts after a GitHub push.

## Cross-Cutting Production Blockers

- Rotate the GitHub token that was pasted into chat history and configure a fresh production token.
- Apply all pending Prisma migrations on the VPS database.
- Keep `ALLOW_LIVE_SYSTEM_COMMANDS=false` until sudoers, command policies, and module-by-module live testing are complete.
- Finalize exact sudoers allowlist for sysagent commands.
- Validate all sysagent live command paths on Ubuntu 22.04.
- Configure log rotation for API, workers, frontend, sysagent, Nginx, mail services, and system logs.
- Confirm backup and restore scripts work against the production PostgreSQL database.
- Decide whether local PgBouncer is required for development or only production.

## Phase 0: Decisions And Ground Rules

Status: Incomplete

- PgBouncer local policy is unresolved.
- Dry-run/live operation behavior needs final production policy per module.
- Production sudoers policy needs exact command review.

## Phase 1: Local Foundation

Status: Incomplete

- Start and verify local PgBouncer, or formally defer PgBouncer to VPS/staging only.

## Phase 3: Core Dashboard

Status: Partially Complete

- Add WebSocket live stats.
- Replace pending service statuses with real Nginx, BIND9, Postfix, and Dovecot checks after services are installed on VPS.

## Phase 4: Domain Management

Status: Partially Complete

- Add fully live Nginx virtual host generation through sysagent after production command policy is approved.
- Add domain-level UI/status for generated vhost path, Nginx test result, and reload result.

## Phase 5: DNS Zone Control

Status: Partially Complete

- Run real BIND9 zone writes and `rndc freeze/reload/thaw` on VPS.
- Validate BIND9 service install, zone path ownership, and named-checkzone output.
- Add UI status for last DNS apply result.
- Confirm dashboard nameserver sync with real domains.
- Add registrar/glue-record guidance UI for custom nameservers.

## Phase 6: SSL Automation

Status: Partially Complete

- Add subdomain SSL support.
- Wire force-HTTPS Nginx rules into live vhost generation.
- Verify Certbot issue/renew on production with a real domain.
- Add renewal cron/systemd timer verification.

## Phase 7: Mail Account Management

Status: Production Mail Deferrals

- Enable live Dovecot mailbox creation.
- Enable live Postfix virtual map updates.
- Enable live OpenDKIM key generation and service reloads.
- Verify SPF, DKIM, DMARC, MX, PTR/rDNS with a real domain.
- Add production mail service permission and ownership checks.

## Phase 8: Webmail

Status: Production Mail Deferrals

- Add IMAP sync worker using BullMQ.
- Store full message body content safely.
- Send mail through Postfix submission.
- Add Reply, Reply All, Forward, attachments, filters, vacation auto-reply, and bulk actions.
- Add live Nodemailer/Postfix submission integration.
- Add message ingestion error handling and retry visibility.

## Phase 9: Firewall And Security

Status: Live-System Deferrals

- Enable live UFW operations only after VPS service account/sudoers validation.
- Verify SSH hardening controls on the VPS.
- Add real auth-log parser output on Ubuntu.
- Verify Fail2Ban install/status/actions.
- Add production-safe rollback instructions for SSH/firewall changes.

## Phase 10: File Manager

Status: Incomplete Polish

- Add selection and bulk action bar.
- Add multi-file tabs in the editor.
- Add explicit discard/reload controls for dirty files.
- Add line-ending selector.
- Add rendered Markdown preview.
- Add inline PDF preview.
- Add image dimension detection.
- Add upload progress UI.
- Add permission preset UI and chmod confirmation.
- Add overwrite confirmation.
- Add extract confirmation.
- Add open containing folder action.
- Promote path-safety verification script into committed tests.
- Verify live archive create/extract on Ubuntu with `zip` and `unzip` installed.

## Phase 11: Deployment Engine

Status: Incomplete Live Provider And Production Work

- Add GitHub connection/settings UI for storing or rotating the production token.
- Verify live GitHub repo listing and branch listing on VPS with the rotated token.
- Keep GitHub token encrypted at rest and never echo it in logs/UI.
- Add DB migration panel for deployment database operations.
- Complete live DB provisioning/rotation/backup UI.
- Validate live database provisioning through sysagent for PostgreSQL and MySQL.
- Finalize live process/Nginx execution with sudoers and Ubuntu validation.
- Add one-click repair actions for common preflight failures.
- Verify push-to-deploy webhook endpoint with a real GitHub push on VPS.
- Verify panel self-update webhook with the real panel repository on VPS.
- Add deploy-from-commit-SHA flow.
- Add release retention cleanup for old releases.
- Verify live deploy for at least one real GitHub project.

## Phase 12: Production VPS Setup

Status: Pending

- Install required packages on Ubuntu 22.04 LTS.
- Create service users.
- Configure PostgreSQL, PgBouncer, Redis, Nginx, BIND9, Postfix, Dovecot, SpamAssassin, ClamAV, OpenDKIM, UFW, Fail2Ban, Supervisor, and PM2.
- Configure sysagent as localhost-only systemd service.
- Configure API and frontend systemd services.
- Configure workers as a systemd service.
- Configure sudoers rules for exact sysagent commands.
- Configure firewall to expose only required ports.
- Enable HTTPS for the configured panel domain.
- Confirm system services survive reboot.

## Phase 13: Hardening

Status: Partially Complete, Still Pending Production Validation

- Enforce secure cookies in production after HTTPS is enabled.
- Validate CSRF protection behind final domain and HTTPS.
- Expand audit logs coverage and add audit log UI.
- Finish destructive confirmation flows across all risky modules.
- Verify backup and restore with production data.
- Verify encrypted secret storage for generated DB and mail credentials.
- Add structured log rotation.
- Add permission checks around file manager operations.
- Finalize sysagent command allowlist.
- Add security headers in Nginx.
- Add production rate limits for sensitive endpoints.

## Phase 14: Testing

Status: Pending

- Add unit tests for auth, validation, DNS records, path safety, and deployment config.
- Add integration tests for API, PostgreSQL, and Redis.
- Add sysagent dry-run tests.
- Add frontend smoke tests.
- Add end-to-end tests for login, add domain, edit DNS, create mailbox, and deploy project.
- Run VPS staging tests with one real domain, one real mailbox, and one real deployment.
- Load test 2,000 domains, large DNS record lists, and mailbox metadata search.
- Add migration regression tests for new nameserver/audit/secret tables.

## Phase 15: Release And Operations

Status: Pending

- Create final deployment checklist.
- Create finalized backup plan.
- Create disaster recovery notes.
- Add monitoring for disk usage, mail queue, SSL expiry, failed jobs, Redis health, and PostgreSQL health.
- Add admin documentation.
- Tag first release as `v0.1.0`.
- Start using the panel in dry-run mode.
- Enable live system actions module by module.

## Recent Local Verification Gaps

- The nameserver migration file exists, but local migration apply failed because the local Prisma/Postgres schema engine errored. Apply on VPS with `npx prisma migrate deploy` once PostgreSQL is running.
- Frontend production build passes with existing SWC fallback warnings.
- API lint/test and frontend TypeScript passed after the dashboard nameserver work.
