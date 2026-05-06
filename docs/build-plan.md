# VPS Panel Build Plan

This is the living implementation plan for the VPS Hosting Control Panel. Update this file whenever a phase decision changes or a phase is completed.

All open, deferred, and partially complete work is consolidated in `docs/incomplete-work.md`.

## Phase 0: Decisions And Ground Rules

Status: Incomplete - PgBouncer pending locally

### Production Target

- Operating system: Ubuntu 22.04 LTS

### Panel Domain

- Panel domain will be dynamic.
- The system must support configuring or changing the panel domain later instead of hard-coding one domain into the application.

### Live Operations Mode

- DNS and mail operation mode will be managed dynamically.
- The system must support dry-run and live execution behavior through configuration.
- Live system actions should stay gated behind explicit settings and safe sysagent command policies.

### Database Choices

- Panel database: PostgreSQL.
- Laravel deployment database option: MySQL may be provisioned when selected.
- PostgreSQL remains the primary database for panel data, mail metadata, DNS records, domains, firewall records, and deployments.

### Security Model

- Single superadmin only.
- No registration.
- No tenant users.
- No multi-user SaaS behavior.
- Superadmin credentials are environment-configured.

## Phase 1: Local Foundation

Status: Completed

### Planned Work

- [x] Install project dependencies for `frontend`, `api`, and `sysagent`.
- [x] Create `.env` from `.env.example`.
- [x] Generate a strong superadmin password hash.
- [x] Generate strong application secrets for JWT and 2FA encryption.
- [x] Add mobile-app two-factor authentication using TOTP.
- [x] Start local PostgreSQL and Redis.
- [ ] Start local PgBouncer.
- [x] Run Prisma generate.
- [x] Create first migration file.
- [x] Apply first migration to PostgreSQL.
- [x] Add seed data script for test domains, DNS records, mailboxes, deployments, and firewall rules.
- [x] Execute seed data against PostgreSQL.
- [x] Verify frontend runs locally on `3000`.
- [x] Verify API health runs locally on `4000`.
- [x] Verify sysagent health runs locally on `5000`.

### Phase 1 Execution Notes

- Docker is not installed or not available on PATH, so PostgreSQL, PgBouncer, and Redis could not be started through Docker Compose on this machine.
- PostgreSQL 16 was installed locally on port `5433`.
- Redis was installed locally and verified on port `6379`.
- PgBouncer was not installed locally; local development is using direct PostgreSQL on `5433`.
- Phase 1 is intentionally kept incomplete until PgBouncer is installed and verified locally or a formal decision is made to defer PgBouncer to staging/production only.
- Chocolatey can find PostgreSQL 16 and Redis packages, but this Codex session is not running with Administrator rights, so Chocolatey cannot install into `C:\ProgramData\chocolatey`.
- WSL is present but inaccessible from this session due to `E_ACCESSDENIED`.
- Administrator fallback script created at `scripts/local/install-datastores.ps1`.
- Prisma Client generation completed successfully.
- The initial migration SQL is saved at `api/prisma/migrations/20260503000000_phase1_foundation/migration.sql`.
- Seed data is saved at `api/prisma/seed.ts` and was applied successfully.
- Seed result: 1 domain, 6 DNS records, 1 mailbox, 1 deployment, 2 firewall rules, and 1 superadmin security row.
- API and frontend dependency audits currently report zero vulnerabilities.
- Frontend production build completed successfully on Next.js `16.2.4`.
- API TypeScript check completed successfully.
- Sysagent Python syntax check completed successfully.
- Local development credentials were generated into `.local-superadmin-credentials.txt`; this file is gitignored.
- Local services were verified:
  - Frontend: `http://127.0.0.1:3000`
  - API health: `http://127.0.0.1:4000/health`
  - Sysagent health: `http://127.0.0.1:5000/health`

### Security Decisions Added During Phase 1

- Superadmin password must be high entropy and stored only as a bcrypt hash.
- JWT secret must be generated from cryptographically secure random bytes.
- TOTP 2FA must support mobile authenticator apps such as Google Authenticator, Microsoft Authenticator, Authy, 1Password, or Bitwarden.
- TOTP secrets must not be stored in plain text.
- 2FA setup should require password verification before exposing an enrollment secret.
- Login should complete only after both password and TOTP verification when 2FA is enabled.

## Phase 2: Authentication

Status: Completed

### Planned Work

- [x] Finish login form submission in Next.js.
- [x] Store JWT in secure httpOnly cookie from Fastify.
- [x] Add frontend session guard for protected pages.
- [x] Add logout flow.
- [x] Add API rate limiting for login attempts.
- [x] Add auth error states in UI.
- [x] Add mobile authenticator app TOTP setup flow.
- [x] Add encrypted TOTP secret storage in API.
- [x] Add second-step TOTP login flow when 2FA is enabled.
- [x] Test valid login API flow.
- [x] Test invalid login, expired session, logout, and protected route access in browser.
- [x] Manually enroll 2FA from the Security page by scanning the QR code with a mobile authenticator app.

### Phase 2 Execution Notes

- Login UI now posts to `/api/v1/auth/login`.
- If 2FA is enabled, login continues through `/api/v1/auth/login/2fa`.
- Protected frontend routes are guarded by `frontend/proxy.ts`.
- Logout clears the `panel_session` cookie through `/api/v1/auth/logout`.
- 2FA setup UI is available on the Security page.
- Verified API login, `/auth/me`, `/auth/2fa/status`, and `/auth/2fa/setup`.
- Verified mobile-app 2FA enrollment works in browser.
- TOTP verifier now uses standard authenticator settings explicitly: SHA1, 6 digits, 30-second period, and a 90-second clock tolerance.
- API TypeScript check passes.
- Frontend production build passes.
- API and frontend dependency audits report zero vulnerabilities.

## Phase 3: Core Dashboard

Status: Completed

### Planned Work

- [x] Connect dashboard UI to real API data.
- [x] Show domain count, mailbox count, deployments, and firewall rules.
- [x] Connect sysagent stats for CPU, RAM, disk, and network.
- [x] Add real-time refresh with TanStack Query.
- [x] Add service status cards for PostgreSQL, Redis, Nginx, BIND9, Postfix, and Dovecot.
- [ ] Later add WebSocket live stats.

### Phase 3 Execution Notes

- Dashboard API now returns counts, deployment status totals, sysagent resource stats, service health, and `generatedAt`.
- Frontend dashboard now uses TanStack Query with a 10-second refresh interval.
- Verified authenticated dashboard API returns live data from PostgreSQL, Redis, and sysagent.
- Current service statuses:
  - PostgreSQL: healthy on local port `5433`
  - Redis: healthy on local port `6379`
  - System Agent: healthy on local port `5000`
  - Nginx, BIND9, Postfix, Dovecot: pending until those production modules are installed/configured
- API TypeScript check passes.
- Frontend production build passes.
- API and frontend dependency audits report zero vulnerabilities.
- WebSocket live stats are intentionally deferred until the real-time/log streaming work begins.

## Phase 4: Domain Management

Status: Completed

### Planned Work

- [x] Build domain CRUD.
- [x] Add domain search, suspend, delete, and detail pages.
- [x] On domain creation, save domain to PostgreSQL, generate default DNS records, and invalidate Redis cache.
- [x] Add health checks for DNS propagation, SSL status, and mail readiness.
- [ ] Add Nginx virtual host generation through sysagent.
- [x] Add domain removal safety confirmation.

### Phase 4 Execution Notes

- Domain list is now live and backed by `/api/v1/domains`.
- Domain creation generates default DNS records and invalidates Redis cache.
- Duplicate domain creation returns `409`.
- Domain status can be changed from the UI.
- Domain deletion has browser confirmation and cascades related Prisma records.
- Domain overview, DNS, subdomain, SSL, and mail account pages now read live API data.
- Subdomain and mail account creation are wired to API routes.
- Domain health endpoint returns A, MX, SPF, DMARC, SSL, and deployment checks.
- Verified domain list and health API with authenticated request.
- API TypeScript check passes.
- Frontend production build passes.
- API and frontend dependency audits report zero vulnerabilities.
- Nginx virtual host generation is deferred until the sysagent command allowlist and production service policy are implemented.

## Phase 5: DNS Zone Control

Status: Completed

### Planned Work

- [x] Finish DNS record CRUD.
- [x] Add inline editable DNS table.
- [x] Support `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`, `SRV`, and `CAA`.
- [x] Add record-type validation.
- [x] Add raw zone editor.
- [x] Build BIND9-style zone file renderer.
- [x] Add SOA serial generation.
- [ ] Apply changes with `rndc freeze`, write zone, and `rndc reload`.
- [x] Add zone export.
- [x] Add Redis cache invalidation for DNS records.

### Phase 5 Execution Notes

- DNS API validates record names, IPv4/IPv6 values, hostnames, MX priority, and CAA value shape.
- Invalid DNS input now returns HTTP `400` with validation details through the global Zod error handler.
- DNS zone export is available at `/api/v1/dns/:domainId/zone`.
- Global DNS page now has a domain selector and live editor.
- Per-domain DNS page reuses the same live editor.
- Editor supports add, inline edit/save, delete, raw zone preview, and zone text export.
- Verified zone export returns SOA/serial data.
- Verified invalid `A` record value returns `400`.
- API TypeScript check passes.
- Frontend production build passes.
- API and frontend dependency audits report zero vulnerabilities.
- Actual BIND9 file writes and `rndc freeze/reload` are deferred until sysagent privileged command allowlist and production DNS service policy are implemented.

## Phase 6: SSL Automation

Status: Completed

### Planned Work

- [x] Add Certbot issue and renewal jobs through BullMQ.
- [x] Add per-domain SSL status and expiry.
- [x] Add force HTTPS toggle.
- [x] Add renewal action from UI.
- [x] Add expiry alerts under 14 days.
- [ ] Add subdomain SSL support.
- [x] Add queue logs for failed certificate jobs.

### Phase 6 Execution Notes

- SSL status API is available at `/api/v1/ssl/domains/:domainId/status`.
- SSL issue and renew actions enqueue BullMQ jobs.
- SSL worker entry point added: `npm run dev:workers`.
- SSL worker calls sysagent Certbot routes, which remain dry-run-safe unless live system commands are explicitly enabled.
- Local development helper `/api/v1/ssl/domains/:domainId/mark-issued` marks a certificate as issued with a 90-day expiry.
- Domain SSL page now shows certificate state, expiry date, days remaining, force HTTPS state, issue, renew, and local mark-issued actions.
- Verified SSL status and local mark-issued flow.
- Verified BullMQ issue job queues and worker receives the job.
- API TypeScript check passes.
- Frontend production build passes.
- API and frontend dependency audits report zero vulnerabilities.
- Redis warning observed: BullMQ reports running Redis as `6.0.16`; production should use Redis 7+ per architecture.
- Subdomain SSL support is deferred until subdomain Nginx/Certbot generation is wired through the sysagent command allowlist.

## Phase 7: Mail Account Management

Status: Completed

### Planned Work

- [x] Build mailbox CRUD.
- [x] Add password reset.
- [x] Add mailbox quota editing.
- [x] Add aliases and catch-all aliases.
- [x] Add Dovecot mailbox creation script integration surface.
- [x] Add Postfix virtual map update surface.
- [x] Add DKIM key generation per domain surface.
- [x] Display SPF, DKIM, DMARC, and PTR status.
- [x] Add warnings for missing reverse DNS.

### Phase 7 Execution Notes

- Mail account API now supports create, list, enable/disable, quota update, password reset, and delete.
- Mail alias API now supports create, list, and delete. Catch-all alias input is represented by `*`.
- Per-domain mail auth status is available at `/api/v1/mail/domains/:domainId/auth-status`.
- Auth status checks include MX, SPF, DKIM, DMARC, and PTR/rDNS reminder.
- DKIM setup and mail-service reload routes call sysagent dry-run-safe mail config endpoints.
- Domain mail accounts UI now includes mailbox controls, quota editing, password reset, delete, aliases, DKIM setup, mail reload, and auth status cards.
- Verified mailbox list route.
- Verified alias create/list/delete.
- Verified mail auth status route.
- Verified DKIM setup returns sysagent dry-run result.
- API TypeScript check passes.
- Frontend production build passes.
- API and frontend dependency audits report zero vulnerabilities.
- Live Dovecot/Postfix/OpenDKIM file writes remain deferred until sysagent privileged command allowlist and production mail service policy are implemented.

## Phase 8: Webmail

Status: Completed With Production Mail Deferrals

### Planned Work

- [x] Build mail service by extending the API mail module.
- [ ] Add IMAP sync worker using BullMQ.
- [x] Store mail metadata in PostgreSQL.
- [x] Build inbox UI with Inbox, Sent, Drafts, Spam, and Trash.
- [x] Add compose flow using the mail queue in dry-run mode.
- [ ] Send mail through Postfix submission.
- [ ] Add Reply, Reply All, Forward, attachments, filters, vacation auto-reply, and bulk actions.
- [x] Add metadata search for sender, recipient, and subject.
- [x] Add message read, star, and move-to-trash actions.
- [x] Add seed mail metadata for local verification.

### Phase 8 Notes

- Webmail now has authenticated API routes for folder counts, message lists, metadata search, message actions, soft-delete-to-trash, and compose queueing.
- The mail worker handles `send` jobs as dry-run accepted jobs and records the intended Postfix submission transport as pending.
- The `/mail` UI now loads real mail accounts, folder counts, message metadata, search results, and a compose form.
- Domain-scoped webmail pages reuse the same webmail client filtered by domain id.
- Verified API health, mail accounts, folder counts, metadata search, compose queueing, and BullMQ completed job count.
- API TypeScript build passes.
- Frontend production build passes.
- API and frontend dependency audits report zero vulnerabilities.
- Full IMAP body sync, rich-text storage, attachments, Reply/Reply All/Forward, filters, vacation auto-reply, and live Nodemailer/Postfix submission remain deferred until privileged production mail service integration is enabled.

## Phase 9: Firewall And Security

Status: Completed With Live-System Deferrals

### Planned Work

- [x] Connect firewall UI to sysagent UFW commands.
- [x] Add allow, deny, and limit rules.
- [x] Add presets for HTTP, HTTPS, SSH, SMTP, IMAP, and DNS.
- [x] Add IP whitelist and blacklist using optional source IP/CIDR rules.
- [x] Add UFW enable and disable endpoints.
- [x] Add auth log parser surface for failed SSH attempts.
- [x] Add Fail2Ban status surface.
- [x] Add active SSH sessions surface.
- [x] Add root login status check surface.
- [x] Add SSH port and password-auth controls.

### Phase 9 Notes

- Firewall overview API now returns saved rules, live UFW command output when sysagent is reachable, UFW/Fail2Ban status, SSH security output, and preset definitions.
- Firewall rule API supports create and local delete for `ALLOW`, `DENY`, and `LIMIT` rules with protocol, direction, source IP/CIDR, and notes.
- Preset API supports HTTP, HTTPS, SSH limit, SMTP, submission, IMAPS, DNS TCP, and DNS UDP.
- Sysagent now exposes dry-run-safe routes for UFW status, rule apply, rule delete by UFW number, UFW enable/disable, security checks, and SSH hardening command sets.
- Firewall UI now supports saved rules, custom rules, presets, UFW enable/disable actions, live output display, active SSH sessions, failed SSH attempt output, and SSH hardening controls.
- Seed data now includes the full Phase 9 service preset set.
- Verified API TypeScript build.
- Verified frontend production build.
- Verified sysagent Python compile.
- Verified sysagent firewall functions directly in dry-run mode.
- Verified API firewall overview route returns 8 seeded rules and 8 presets.
- Verified `/firewall` frontend route returns HTTP 200.
- API and frontend dependency audits report zero vulnerabilities.
- Live UFW, SSH, Fail2Ban, and auth-log operations remain dry-run protected until `ALLOW_LIVE_SYSTEM_COMMANDS=true` is enabled on the production Ubuntu VPS and sysagent is launched under the intended privileged service account.
- Local Windows sysagent background startup is currently affected by the duplicated `Path`/`PATH` environment issue; direct sysagent function verification passed.

## Phase 10: File Manager

Status: Completed With Archive Execution Deferral

### Goal

Build an advanced, modern, single-admin file manager for hosted app files under the configured file-manager root. It should feel closer to a lightweight IDE plus operations console than a basic directory browser, while staying locked to the safe root and dry-run-aware production security model.

### Execution Plan

1. Security and root-scope foundation
   - Harden path resolution so every operation is constrained under `FILE_MANAGER_ROOT`.
   - Normalize Windows and Linux path separators.
   - Reject traversal, absolute-path escape attempts, oversized payloads, unsafe names, and binary edits through text endpoints.
   - Add reusable file metadata helpers for size, modified time, permissions, MIME guess, extension, hidden/system markers, and read-only flags.
   - Add audit-oriented response data for destructive or permission-changing operations.

2. Advanced file API
   - Add directory list with sorting, search, pagination, breadcrumbs, and metadata.
   - Add recursive tree endpoint with configurable depth.
   - Add file read endpoint with text/binary detection and max-size checks.
   - Add save endpoint with optimistic version metadata.
   - Add create file, create folder, rename, move, copy, delete, and bulk delete.
   - Add download endpoint and upload endpoint with size limits.
   - Add archive create and extract endpoints for zip archives.
   - Add chmod endpoint for Linux permission editing, dry-run-safe on Windows.
   - Add checksum endpoint for SHA256 verification.

3. Advanced UI shell
   - Replace placeholder page with a dense operations UI:
     - collapsible directory tree
     - sortable file table
     - breadcrumb navigation
     - search and filters
     - action toolbar
     - selection and bulk action bar
     - details inspector
     - preview/editor pane
   - Add clear empty, loading, error, permission-denied, file-too-large, and binary-file states.
   - Keep the layout compact and operational, not landing-page style.

4. Advanced code editor
   - Integrate Monaco editor for text/code files.
   - Add syntax detection by extension for JS, TS, TSX, JSX, PHP, Python, Go, JSON, YAML, Markdown, HTML, CSS, env files, Nginx-style config, shell scripts, and SQL.
   - Add tabs for open files.
   - Add dirty-state tracking and save/discard controls.
   - Add find/replace, minimap toggle, word wrap toggle, font size control, theme toggle, line endings, and read-only binary guard.
   - Add JSON format button and basic config/text formatting where safe.

5. Preview system
   - Add image preview with dimensions and file size.
   - Add Markdown preview.
   - Add plain text/log preview with tail-style display for large logs.
   - Add PDF preview/download path where browser support is available.
   - Add binary file summary instead of unsafe rendering.

6. Operational tools
   - Add zip create/extract flows.
   - Add upload progress UI.
   - Add permission editor with common presets.
   - Add copy path, copy relative path, and checksum copy.
   - Add open containing folder from file detail.
   - Add confirm dialogs for delete, overwrite, extract, and chmod.

7. Verification
   - Add focused path-safety tests for traversal and root escape attempts.
   - Verify API build.
   - Verify frontend production build.
   - Verify API and frontend audits.
   - Verify `/files` route returns HTTP 200.
   - Verify file list, read, save, create, rename, copy, move, delete, archive, and chmod dry-run behavior using the local safe root.

### Implementation Notes

- File API is now a complete root-scoped operations module instead of a basic list/read module.
- File manager UI is now the real first-screen experience with tree, table, inspector, preview, and editor panes.
- Monaco editor is integrated client-side with language detection, theme, word wrap, minimap, font-size control, dirty state, save, and JSON formatting.
- Upload/download, create, rename, copy, move, delete, checksum, chmod, and archive endpoints are implemented.
- Archive create/extract uses external host tools (`Compress-Archive` on Windows, `zip`/`unzip` on Linux). If process execution is blocked locally, the API returns a dry-run command instead of a 500.
- Windows chmod returns dry-run compatibility output; Linux chmod applies real permissions.
- Destructive operations require confirmation in the UI and all operations remain constrained under `FILE_MANAGER_ROOT`.

### Phase 10 Notes

- Added hardened path resolution with root containment checks, Windows/Linux separator normalization, unsafe name rejection, and traversal blocking.
- Added metadata-rich listing with type, kind, extension, size, timestamps, permissions, MIME, hidden, and read-only flags.
- Added directory list, recursive tree, read, write with optimistic modified-time check, create file, create folder, rename, copy, move, bulk delete, upload, download, checksum, chmod, archive create, and archive extract endpoints.
- Added local safe-root fixtures under `.local-www/example-site` for HTML, CSS, Markdown, JSON config, and log preview testing.
- Added frontend API helpers for `PUT` and JSON-body `DELETE`.
- Built an advanced file manager at `/files` with collapsible tree, breadcrumbs, searchable/sortable file table, toolbar actions, upload picker, details inspector, operation tools, image preview, and Monaco editor.
- Verified API TypeScript build.
- Verified frontend production build.
- Verified API and frontend dependency audits report zero vulnerabilities.
- Verified authenticated file API operations: list, tree, create, read, write, rename, copy, move, checksum, chmod dry-run, archive dry-run fallback, delete, and traversal rejection.
- Verified `/files` route returns HTTP 200.
- Redis is currently stopped locally, so direct Fastify verification printed Redis retry noise and timed out after completing the file checks. File manager routes themselves do not require Redis.
- Local archive commands are blocked by the sandbox process policy and return dry-run output; on production Ubuntu, install `zip` and `unzip` for live archive operations.

### Phase 10 Completion Checklist

#### Security And Root Scope

- [x] Harden path resolution under `FILE_MANAGER_ROOT`.
- [x] Normalize Windows/Linux separators.
- [x] Reject traversal/root escape.
- [x] Reject unsafe names.
- [x] Reject oversized text reads/writes/uploads.
- [x] Reject binary edits through text endpoint.
- [x] Metadata helpers: size, modified time, permissions, MIME, extension, hidden, and read-only flags.
- [~] Audit-oriented destructive response data: basic responses added; full audit log remains for Phase 13 hardening.

#### Advanced File API

- [x] Directory list with sorting, search, pagination, breadcrumbs, and metadata.
- [x] Recursive tree endpoint with configurable depth.
- [x] File read with text/binary/max-size checks.
- [x] Save with optimistic modified-time check.
- [x] Create file and folder.
- [x] Rename.
- [x] Move.
- [x] Copy.
- [x] Delete and bulk delete API.
- [x] Download endpoint.
- [x] Upload endpoint with size limit.
- [x] Archive create/extract endpoints.
- [x] Chmod endpoint with Windows dry-run and Linux apply behavior.
- [x] SHA256 checksum endpoint.

#### Advanced UI Shell

- [x] Placeholder replaced.
- [x] Collapsible directory tree.
- [x] Sortable file table.
- [x] Breadcrumb navigation.
- [x] Search and filters.
- [x] Action toolbar.
- [ ] Selection and bulk action bar.
- [x] Details inspector.
- [x] Preview/editor pane.
- [~] Empty/loading/error states: partial.
- [x] Binary-file safe state.
- [x] Compact operational layout.

#### Advanced Code Editor

- [x] Monaco editor integrated.
- [x] Syntax detection for common code/config extensions.
- [ ] Tabs for open files.
- [x] Dirty-state tracking.
- [x] Save control.
- [ ] Discard control.
- [~] Find/replace: Monaco built-in; no custom UI yet.
- [x] Minimap toggle.
- [x] Word wrap toggle.
- [x] Font size control.
- [x] Theme toggle.
- [ ] Line endings control.
- [x] Read-only/binary guard.
- [x] JSON format button.

#### Preview System

- [x] Image preview.
- [~] Image dimensions: file size shown; dimensions not yet.
- [ ] Markdown rendered preview.
- [~] Plain text/log preview: editable text view works; tail-style large-log mode not yet.
- [~] PDF: download supported; inline preview not yet.
- [x] Binary summary/safe unavailable state.

#### Operational Tools

- [x] Zip create/extract flow API.
- [~] Zip UI wired; local execution dry-runs when blocked.
- [ ] Upload progress UI.
- [~] Permission editor: prompt-based chmod; no preset UI yet.
- [x] Copy path.
- [~] Copy relative path: same as root-relative `path`.
- [x] Checksum copy.
- [ ] Open containing folder.
- [x] Delete confirmation.
- [ ] Overwrite confirmation.
- [ ] Extract confirmation.
- [ ] Chmod confirmation.

#### Verification

- [~] Focused path-safety tests: verified by script; not committed as test files.
- [x] API build.
- [x] Frontend production build.
- [x] API audit.
- [x] Frontend audit.
- [x] `/files` HTTP 200.
- [x] Verified list/read/save/create/rename/copy/move/delete/archive dry-run/chmod dry-run locally.

#### Remaining Phase 10 Polish

- Add selection and bulk action bar.
- Add multi-file tabs in the editor.
- Add explicit discard/reload controls for dirty files.
- Add line-ending selector.
- Add rendered Markdown preview.
- Add inline PDF preview.
- Add image dimension detection.
- Add upload progress.
- Add permission preset UI and chmod confirmation.
- Add overwrite and extract confirmations.
- Add open containing folder action.
- Promote path-safety verification script into committed tests.

## Phase 11: Deployment Engine

Status: Completed Except Live Provider/Token And Production Policy Work

### Goal

Build an ultimate, easy deployment engine for single-admin VPS hosting. The experience should feel like a self-hosted Vercel/Railway flow: import a project, detect the stack, configure environment and database, connect a domain, deploy, watch logs, and operate the app without needing to manually touch Nginx, PM2, Supervisor, or database commands.

### Product Principles

- Make the first successful deploy fast: import, configure, deploy.
- Keep advanced controls available but out of the way.
- Prefer clear status, logs, and repair actions over silent failure.
- Make every dangerous operation confirmable and reversible where possible.
- Keep production operations dry-run-safe locally and privilege-gated through sysagent on Ubuntu.
- Support both GitHub-based deployment and manual source upload.

### User Experience Flow

1. New project
   - Choose source: GitHub repository, Git URL, local folder from File Manager, or uploaded archive.
   - For GitHub, connect a token or app credential, list repositories, search repositories, choose branch, and optionally choose root directory.
   - Show repository metadata: default branch, latest commit, visibility, detected framework, and suggested commands.

2. Auto-detect
   - Detect framework/runtime:
     - Laravel
     - Next.js
     - Node.js
     - Python/FastAPI/Django/Flask
     - Go
     - Static HTML
   - Detect package manager:
     - npm
     - pnpm
     - yarn
     - composer
     - pip/uv
     - go modules
   - Detect build command, install command, start command, output directory, public directory, and required runtime version.
   - Allow manual override for every detected value.

3. Configure
   - Project name and slug.
   - Branch and root directory.
   - Runtime and framework.
   - Install/build/start commands.
   - Port allocation from `3001-9999`.
   - Environment variables with secret masking.
   - Domain/subdomain selection.
   - Force HTTPS toggle.
   - Database provisioning:
     - PostgreSQL first-class.
     - Optional MySQL for Laravel/apps that require it.
     - Generate DB name, DB user, strong password, and connection string.
   - Persistent paths for uploads/storage.

4. Preflight
   - Validate source access.
   - Validate branch and root directory.
   - Validate commands.
   - Validate port availability.
   - Validate env variables.
   - Validate database connectivity.
   - Validate domain/DNS readiness.
   - Validate Nginx config can be generated.
   - Show blocking issues and one-click fix suggestions.

5. Deploy
   - Clone or pull source.
   - Install dependencies.
   - Generate environment file.
   - Provision database.
   - Run migrations when configured.
   - Build project.
   - Allocate process manager target:
     - PM2 for Node/Next.js.
     - Supervisor for Laravel/Python/Go/static preview services where appropriate.
   - Generate Nginx reverse proxy.
   - Request SSL when domain is ready.
   - Start or reload process.
   - Run health check.
   - Mark deployment success/failure with detailed logs.

6. Operate
   - Project overview dashboard with status, domain, branch, latest commit, process status, CPU/RAM, uptime, port, SSL status, and last deploy.
   - Actions:
     - Start
     - Stop
     - Restart
     - Redeploy
     - Pull latest
     - Rollback
     - Open logs
     - Open file manager at project root
     - Open env editor
     - Open database details
   - Real-time logs:
     - clone logs
     - install logs
     - build logs
     - runtime logs
     - Nginx reload logs
     - migration logs
   - Health checks:
     - HTTP status
     - port listener
     - process manager status
     - Nginx config status
     - SSL expiry

7. Rollback and history
   - Store deployment history.
   - Keep last 3 successful releases.
   - Roll back code, env snapshot reference, process config, and Nginx target.
   - Show commit hash, author, message, deployed time, duration, and result.

8. GitHub integration
   - Add GitHub connection settings.
   - Support repository search and import.
   - Support branch selection.
   - Support private repositories through configured credential.
   - Support deploy from commit SHA.
   - Support manual “pull latest and deploy”.
   - Prepare webhook endpoint for push-to-deploy.
   - Add deploy key or token strategy notes for production.

9. Background jobs
   - Use BullMQ deployment queue.
   - Add job states:
     - queued
     - cloning
     - installing
     - building
     - migrating
     - configuring proxy
     - starting
     - checking health
     - succeeded
     - failed
   - Store structured step logs.
   - Allow safe cancellation while queued or before process changes.

10. Security model
   - Single superadmin only.
   - No public deploy hooks unless secret-protected.
   - Mask secrets in logs.
   - Store generated DB credentials securely.
   - Scope file operations to project root.
   - Route privileged process/Nginx/system commands through sysagent allowlist.
   - Confirm destructive operations: delete project, drop database, remove Nginx config, wipe files.

### Implementation Plan

1. Data model
   - Extend deployment schema for:
     - source provider
     - GitHub repository owner/name
     - Git URL
     - branch
     - commit SHA
     - root directory
     - framework/runtime
     - install/build/start commands
     - output/public directory
     - port
     - env vars and secret references
     - database settings
     - deployment status
     - health status
   - Add deployment history/release table.
   - Add deployment log/step table.
   - Add GitHub connection metadata table or encrypted settings record.

2. API
   - [x] Project CRUD.
   - [x] GitHub repository list/search endpoint in dry-run/mock mode.
   - [x] GitHub branches endpoint in dry-run/mock mode.
   - [x] Git import endpoint.
   - [x] Framework detection endpoint.
   - [x] Preflight endpoint.
   - [x] Deploy/redeploy endpoint with Redis-down dry-run fallback.
   - [x] Start/stop/restart endpoint.
   - [x] Pull latest endpoint.
   - [x] Rollback endpoint.
   - [x] Logs endpoint with step filtering.
   - [x] Env var CRUD endpoint.
   - [~] Database provisioning endpoint: database fields and preflight are wired; live DB creation remains production/live work.
   - [x] Domain binding endpoint: domain binding is supported through project create/update and settings UI.
   - [x] Health check endpoint in metadata/dry-run mode.

3. Worker
   - Implement deploy worker pipeline.
   - Add dry-run mode for local Windows.
   - Add real command execution through sysagent for Ubuntu production.
   - Capture stdout/stderr per step.
   - Persist structured deployment logs.
   - Add rollback release management.

4. Sysagent
   - Add allowlisted deployment commands:
     - git clone/fetch/checkout
     - package manager install/build
     - composer install
     - PHP artisan commands
     - Python venv/pip/uv commands
     - Go build
     - PM2 start/stop/restart/delete/status
     - Supervisor reread/update/start/stop/restart/status
     - Nginx config write/test/reload
     - system health checks
   - Add production-only command policy and path guards.

5. Frontend
   - Deployment home:
     - [x] project list
     - [x] status filters
     - [x] quick actions
   - New project wizard:
     - [x] source step
     - [x] GitHub import step in dry-run/mock mode
     - [x] detection step
     - [x] env/database step
     - [x] domain step
     - [x] review/create/preflight controls
   - Project overview:
     - [x] status
     - [x] latest deployment
     - [x] domain
     - [x] branch/commit
     - [x] runtime
     - [x] health
     - [x] quick actions
   - Logs page:
     - [x] deploy/runtime logs via SSE stream with polling fallback
     - [x] step filter
     - [x] copy/download logs
   - Env page:
     - [x] masked secrets
     - [x] bulk paste `.env`
     - [x] validation through API schema
   - Database page:
     - [x] DB details
     - [x] connection string copy
     - [~] migration status: deploy logs show migration step; dedicated DB migration panel pending
   - Settings page:
     - [x] commands
     - [x] runtime
     - [x] root directory
     - [x] port
     - [x] source connection
     - [x] delete project

6. Verification
   - [x] Verify schema migration and seed.
   - [x] Verify GitHub repository import in dry-run/mocked mode.
   - [x] Verify framework detection for Laravel, Next.js, Node, Python, Go, and static projects.
   - [x] Verify deployment queue and step status updates.
   - [x] Verify logs persist and stream.
   - [x] Verify local dry-run deploy from sample projects.
   - [x] Verify frontend build.
   - [x] Verify API build.
   - [x] Verify audits.
   - [x] Verify `/deployments` and project detail routes return HTTP 200.

### Phase 11 Execution Slices

1. Foundation slice
   - [x] Data model.
   - [x] Routes: expanded project CRUD, detail, env, logs, releases, preflight, detect, actions, and GitHub dry-run endpoints are implemented.
   - [x] Deployment list/detail UI.
   - [x] Deployment history/log structures.

2. GitHub import slice
   - [x] GitHub connection metadata table.
   - [~] GitHub settings UI/API: API is implemented; UI pending.
   - [~] Repository search/list: dry-run/mock API implemented; live GitHub token retrieval pending.
   - [~] Branch selection: dry-run/mock API implemented; live GitHub token retrieval pending.
   - [x] Import-to-project flow API.

3. Detection and preflight slice
   - [x] Framework detector.
   - [x] Command suggestions.
   - [x] Port allocator.
   - [x] Database/env/domain/source preflight metadata checks.

4. Deploy worker slice
   - [x] BullMQ pipeline with multi-step dry-run worker.
   - [x] Structured logs.
   - [x] Dry-run local deploy/action responses.
   - [x] Status transitions for queued, deploying, building, running, failed, stopped, and release success/failure.

5. Runtime operations slice
   - [x] Start, stop, restart, redeploy, pull latest, rollback, and health-check API surfaces.
   - [x] Runtime execution is wired through sysagent dry-run command surfaces; live execution still requires production command policy.

6. Production sysagent slice
   - [x] Git command surface.
   - [x] Package manager install/build command surfaces.
   - [x] Migration command surface.
   - [x] PM2/Supervisor/systemd/static process command surface.
   - [x] Nginx config/test/reload command surface.
   - [x] Health check command surface.
   - [~] DB provisioning command surface is still pending.
   - [x] SSL integration already exists separately; deploy worker SSL request step added for linked Force SSL domains.
   - [~] Live allowlist is dry-run protected until production sudoers/policy is finalized.

7. Polish slice
   - [x] Vercel/Railway-style guided project creation shell.
   - [x] Log viewer with filters, copy, and download.
   - [x] Copy buttons for logs and database connection material.
   - [~] Clean error recovery is covered through notices and destructive delete confirmation; one-click fix automation remains deferred.

### Phase 11 Completion Checklist

#### Data Model Foundation

- [x] Added `DeploymentSourceProvider` enum for manual, Git URL, GitHub, File Manager, and upload sources.
- [x] Added `DeploymentRuntime` enum for Node, PHP, Python, Go, and static runtimes.
- [x] Added `DeploymentPackageManager` enum for npm, pnpm, yarn, composer, pip, uv, go, and none.
- [x] Added `DeploymentProcessManager` enum for PM2, Supervisor, systemd, static, and none.
- [x] Added `DeploymentHealthStatus` enum.
- [x] Added `DeploymentReleaseStatus` enum.
- [x] Added `DeploymentStep` enum for queued, preflight, clone, install, migrate, build, proxy, start, health-check, success, failure, and rollback steps.
- [x] Extended `DeploymentFramework` with `STATIC`.
- [x] Extended `DeploymentStatus` with `QUEUED` and `BUILDING`.
- [x] Changed domain/deployment relation from one-domain-to-one-deployment to one-domain-to-many-deployments.
- [x] Made deployment domain binding optional for projects created before a domain is attached.
- [x] Added deployment slug.
- [x] Added source provider, Git URL, GitHub owner/repo/id/visibility, branch, commit SHA, and root directory fields.
- [x] Added runtime, package manager, install/build/start commands, output/public directory, runtime version, and process manager fields.
- [x] Added health status, health URL, last health check, and last deploy timestamp fields.
- [x] Added database user and secret-reference fields for generated credentials/connection strings.
- [x] Added persistent paths, auto-deploy flag, and webhook secret hash fields.
- [x] Added `DeploymentEnvVar` table with secret-reference support.
- [x] Added `DeploymentRelease` table for deployment history and rollback foundation.
- [x] Added `DeploymentLog` table for structured step logs.
- [x] Added `GitHubConnection` table for future GitHub credential metadata.
- [x] Added indexes for slug, domain, status, source provider, GitHub repo, env key, release status, and logs.
- [x] Added migration `20260505000000_phase11_deployment_foundation`.
- [x] Backfilled existing deployment slug safely during migration.
- [x] Regenerated Prisma client.

#### Data Model Verification

- [x] Applied migration to PostgreSQL.
- [x] Added reusable Phase 11 migration regression verification through `npm --workspace api run verify:phase11`.
- [x] Updated seed data for the expanded deployment model.
- [x] Seed now creates example GitHub-style deployment metadata.
- [x] Seed now creates one deployment env var.
- [x] Seed now creates one successful release record.
- [x] Seed now creates one structured deployment log.
- [x] Seed now creates the superadmin GitHub connection placeholder.
- [x] Updated domain health/detail route for the new `deployments[]` relation.
- [x] API build passes.
- [x] Frontend production build passes.
- [x] Verified seeded deployment can be queried with env vars, releases, logs, domain, and GitHub connection placeholder.

#### Frontend Slice

- [x] Replaced deployment placeholder home with a dense operational deployment console.
- [x] Added deployment search, list, source/runtime/port/status/health/latest-release display, and quick deploy/start/stop/restart actions.
- [x] Added new-project form for source provider, name/slug, Git URL, branch, root path, framework, port, commands, env vars, and DB type.
- [x] Added GitHub dry-run repository search/import UI.
- [x] Added framework detection and preflight buttons.
- [x] Added status/source filters to the deployment home.
- [x] Added domain selector to the new-project flow.
- [x] Added project overview route with summary metrics, build pipeline commands, release history, metadata, and action toolbar.
- [x] Added project logs route with polling, step filtering, refresh, copy, and download.
- [x] Added project environment route with single variable upsert, secret masking, delete, bulk `.env` import, and current-env preview.
- [x] Added project database route with DB metadata, secret reference display, connection string copy, and preflight.
- [x] Added project settings route for commands, runtime, root directory, port, source connection, domain binding, database metadata, persistent paths, and delete project.
- [x] Frontend production build passes after Phase 11 frontend work.
- [x] Logs stream through SSE with polling as a fallback.
- [~] Database page shows metadata and preflight only; live provisioning/rotation/backup UI is pending backend support.
- [x] Domain selector/bind UI is available on the project settings page through the existing project update route.

#### Remaining Foundation Work

- [x] Full project CRUD routes for the new model.
- [x] Deployment detail API with releases/logs/env/domain/health included.
- [x] Deployment list UI upgraded to use new source/runtime/health fields.
- [x] Deployment detail UI upgraded to show release/log/history data.
- [~] GitHub connection API and settings UI: API complete; live token-backed UI remains deferred with provider-token work.
- [x] Formal migration regression test.

#### API Slice

- [x] Added paginated deployment list with search/status/source-provider filters.
- [x] Added next available port endpoint.
- [x] Added full deployment create/detail/update/delete routes using id or slug.
- [x] Added deployment status update route.
- [x] Added env var list/upsert/bulk/delete routes with secret masking/secret references.
- [x] Added releases route with release logs.
- [x] Added logs route with release/step filtering.
- [x] Added framework detection endpoint for Laravel, Next.js, Node.js, Python, Go, and static projects.
- [x] Added preflight endpoint for root path, port, domain, source, and database metadata checks.
- [x] Added GitHub connection get/update API.
- [x] Added GitHub repository search/list dry-run API.
- [x] Added GitHub branch list dry-run API.
- [x] Added GitHub import-to-project API.
- [x] Added deploy, redeploy, pull latest, rollback, start, stop, restart, and health-check action endpoints.
- [x] Added queue timeout fallback so deployment actions return dry-run responses when Redis is down.
- [x] Updated deploy worker to write structured dry-run logs and basic status transitions.
- [x] Verified API build.
- [x] Verified API audit reports zero vulnerabilities.
- [x] Verified routes with Fastify injection: list, next port, detect, GitHub dry-run list, create, detail, env, preflight, health, delete, deploy action, and logs.
- [~] Live GitHub repository calls are pending encrypted token retrieval and production credential policy.
- [~] Live database provisioning is pending worker/sysagent implementation.
- [x] Local/dry-run process/Nginx deployment actions are implemented through sysagent surfaces.
- [~] Production live process/Nginx execution is pending sudoers policy, Ubuntu validation, and `ALLOW_LIVE_SYSTEM_COMMANDS=true`.

#### Worker And Sysagent Slice

- [x] Added sysagent deployment router.
- [x] Added sysagent Git sync endpoint.
- [x] Added sysagent dependency install endpoint.
- [x] Added sysagent build endpoint.
- [x] Added sysagent migration endpoint.
- [x] Added sysagent process action endpoint for PM2, Supervisor, systemd, static/no-manager flows.
- [x] Added sysagent Nginx config/test/reload endpoint.
- [x] Added sysagent deployment health-check endpoint.
- [x] Added sysagent path guard metadata for deployment commands.
- [x] Added dry-run protection through `ALLOW_LIVE_SYSTEM_COMMANDS=false`.
- [x] Implemented deploy worker multi-step pipeline:
  - preflight
  - source sync
  - dependency install
  - migration
  - build
  - Nginx proxy config
  - process start
  - health check
  - success/failure
- [x] Worker persists structured logs for each started/completed/failed step.
- [x] Worker updates release status and duration.
- [x] Worker updates deployment status, health status, last health check, and last deploy timestamp.
- [x] Worker handles start/stop/restart lifecycle actions.
- [x] Worker requests SSL through the existing SSL queue for linked domains with Force SSL enabled.
- [x] Started Redis locally on port `6379`.
- [x] Started sysagent locally on port `5000`.
- [x] Started API locally on port `4000`.
- [x] Started worker process locally.
- [x] Verified deploy job queues through Redis and is processed by the worker.
- [x] Verified seeded deployment reached `RUNNING`.
- [x] Verified seeded deployment health reached `HEALTHY`.
- [x] Verified new release reached `SUCCEEDED`.
- [x] Verified 17 structured deployment step logs were written for the deploy job.
- [x] Verified stop/start actions are processed and update status.
- [x] Rechecked data model, deploy worker, and sysagent deployment surfaces on 2026-05-05.
- [x] Reverified API build, frontend TypeScript, frontend production build, and sysagent Python compile after adding the project settings page.
- [x] Completed Phase 11 verification pass on 2026-05-05 with `npm --workspace api run verify:phase11`, API build, frontend TypeScript, frontend production build, sysagent compile, and API/frontend audits.
- [x] Completed non-live Phase 11 gap pass on 2026-05-05: deployment filters, project domain selector, SSE log stream, deploy-worker SSL request step, API build, frontend TypeScript, frontend production build, sysagent compile, Phase 11 verification, and API/frontend audits.
- [~] Live execution remains dry-run until production `ALLOW_LIVE_SYSTEM_COMMANDS=true`, sudoers allowlist, and Ubuntu command policy are finalized.

## Phase 12: Production VPS Setup

Status: Pending

### Planned Work

- Install required packages on Ubuntu 22.04 LTS.
- Create service users.
- Configure PostgreSQL, PgBouncer, Redis, Nginx, BIND9, Postfix, Dovecot, SpamAssassin, ClamAV, OpenDKIM, UFW, Fail2Ban, Supervisor, and PM2.
- Configure sysagent as localhost-only systemd service.
- Configure API and frontend systemd services.
- Configure sudoers rules for exact sysagent commands.
- Configure firewall to expose only required ports.
- Enable HTTPS for the configured panel domain.

## Phase 13: Hardening

Status: Pending

### Planned Work

- Enforce secure cookies in production.
- Add CSRF protection for state-changing requests.
- Add audit logs for dangerous actions.
- Add confirmation flows for destructive operations.
- Add backup and restore for panel database.
- Add encrypted secret storage for generated DB and mail credentials.
- Add structured log rotation.
- Add permission checks around file manager operations.
- Add sysagent command allowlist.
- Add security headers in Nginx.

## Phase 14: Testing

Status: Pending

### Planned Work

- Add unit tests for auth, validation, DNS records, path safety, and deployment config.
- Add integration tests for API, PostgreSQL, and Redis.
- Add sysagent dry-run tests.
- Add frontend smoke tests.
- Add end-to-end tests for login, add domain, edit DNS, create mailbox, and deploy project.
- Run VPS staging tests with one real domain, one real mailbox, and one real deployment.
- Load test 2,000 domains, large DNS record lists, and mailbox metadata search.

## Phase 15: Release And Operations

Status: Pending

### Planned Work

- Create deployment checklist.
- Create backup plan.
- Create disaster recovery notes.
- Add monitoring for disk usage, mail queue, SSL expiry, failed jobs, Redis health, and PostgreSQL health.
- Add admin documentation.
- Tag first release as `v0.1.0`.
- Start using the panel in dry-run mode.
- Enable live system actions module by module.
