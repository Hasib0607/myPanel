# myPanel Phase-Wise Work Structure

## Phase 0: Emergency Stability

Goal: keep the panel and the currently live website stable while future deploy work is refactored.

Tasks:
- Reserve the panel from hosted-project overwrites.
- Keep the WHM-style admin listener isolated on port 8453 through Nginx.
- Keep the cPanel-style account listener isolated on port 3138 through Nginx.
- Keep panel frontend/API/sysagent/worker ports internal and documented.
- Rename the panel Nginx file to a protected name such as `00-vps-panel.conf`.
- Rename hosted site configs to domain-scoped names such as `domain-priceinbd.store.conf`.
- Remove duplicate/conflicting Nginx site configs.
- Add/keep service health checks for Nginx, Redis, Postgres, API, frontend, workers, and sysagent.
- Snapshot the current working `priceinbd.store` state.

Deliverables:
- Admin panel always opens on `http://IP:8453`.
- Account panel always opens on `http://IP:3138`.
- Website and panel no longer overwrite each other.
- Broken hosted-site config cannot break the panel config.

Account split status:
- WHM/admin APIs require `superadmin` JWT role and use the `panel_session` cookie.
- cPanel/account APIs require `account` JWT role and use the separate `account_session` cookie.
- WHM account management includes create/edit/detail pages, search/filter, package limits, assignment/unassignment for domains/deployments/mailboxes, activity history, suspend behavior, and delete policy for linked resources.
- Account creation scaffolds `/var/www/accounts/<username>/public_html` plus default hosting folders through sysagent.
- Account dashboard on `/account` is scoped to the signed-in account and exposes only account-owned domains, files, mailboxes, deployments, usage, and profile/password controls.
- Account file APIs are locked to the account home root and reject path traversal.

## Phase 1: Port Reservation And Allocation

Status: in progress. API allocation/validation and installer defaults are implemented; run `npm run migrate:deployment-ports --workspace api` once on the server after deploying this phase to move old unsafe deployment metadata.

Goal: no project can ever use panel or infrastructure ports.

Tasks:
- Add reserved ports: `22, 25, 53, 80, 443, 993, 2083, 3000, 3010, 4000, 5000, 5432, 6379`.
- Move deployment port pool to `10000-19999`.
- Reject reserved or already-used ports in create/edit APIs.
- Backfill old deployments away from unsafe ports.
- Make deployment port auto-assigned by default in UI.

Deliverables:
- New projects get safe `10000+` ports.
- Panel ports cannot be selected or overwritten.

## Phase 2: Runtime Detection

Status: implemented. Runtime detection now runs during deploy after source sync, updates deployment commands from real source files, and injects the assigned port into generated start commands.

Goal: Git projects automatically get the correct build/start commands.

Tasks:
- Read `package.json` after clone/pull.
- Detect Next.js, Vite, CRA, plain Node, static build, or raw static HTML.
- Generate framework-specific commands.
- Fail clearly when no valid runtime is found.

Deliverables:
- User selects GitHub repo and deploy starts with the right command.

## Phase 3: PM2 Process Management

Status: implemented. PM2 start/restart now replaces any existing process for the same deployment, runs from the deployment cwd, injects `PORT`, `HOST`, and `HOSTNAME`, saves PM2 state, and verifies the process is online.

Goal: no duplicate or ghost PM2 processes.

Tasks:
- PM2 start must use `cwd`, `PORT`, `HOST`, `HOSTNAME`, and deployment slug.
- Delete/restart exact existing process before start.
- Save PM2 process list.
- Verify PM2 process is online.

Deliverables:
- Start/stop/restart buttons control the actual app.

## Phase 4: Domain Hosting Modes

Goal: domains can serve either `public_html`, Git projects, or redirects.

Tasks:
- Add `PUBLIC_HTML`, `DEPLOYMENT_PROXY`, and `REDIRECT` hosting modes.
- Scaffold cPanel-style folders on domain create.
- Bind domains/subdomains to deployments or document roots.
- File manager opens the correct domain root.

Deliverables:
- Static public_html sites and Git apps both work.

Status:
- Implemented domain hosting modes in the database, API publish path, sysagent redirect vhost writer, and Domains UI settings.
- `PUBLIC_HTML` publishes `/var/www/<domain>/<documentRoot>`, `DEPLOYMENT_PROXY` publishes to the selected deployment port, and `REDIRECT` writes a 301 vhost.

## Phase 5: Nginx Generator

Goal: safe deterministic Nginx config generation.

Tasks:
- Never touch panel config from domain/project paths.
- Generate domain-scoped config names.
- Write temp config, enable symlink, run `nginx -t`, rollback on failure, reload only on success.
- Support static roots and app proxies.

Deliverables:
- Bad app/domain config cannot take down Nginx or panel.

Status:
- Implemented shared safe Nginx publishing for static roots, redirects, and deployment proxies.
- Panel configs are protected from domain/project writes; generated configs must be `domain-*` or `deployment-*`.
- New configs are written to a temp file, test-enabled, checked with `nginx -t`, promoted only after a clean test, and rolled back if test or reload fails.

## Phase 6: Health And Truthful Status

Status: implemented. Deploy/start/restart now assert live health checks before marking projects `RUNNING/HEALTHY`, stop marks health down, manual health checks call sysagent, and failed curl/port checks keep the project failed/down.

Goal: UI status reflects reality.

Tasks:
- Check PM2 online, port listening, HTTP 2xx/3xx, and Nginx test.
- Fail deployment if health fails.
- Never mark failed health as healthy.

Deliverables:
- No fake `RUNNING/HEALTHY`.

## Phase 7: SSL Automation

Goal: safe one-click HTTPS.

Tasks:
- Install and verify Certbot.
- Confirm domain A record points to VPS.
- Issue SSL only after HTTP config works.
- Enable force HTTPS only after certificate exists.

Deliverables:
- `https://domain.com` works safely.

Status:
- Added SSL preflight checks for Certbot, public A records pointing to the VPS, and live HTTP ACME challenge reachability.
- Nginx static, proxy, and redirect configs now preserve `/.well-known/acme-challenge/` so Certbot webroot validation works across hosting modes.
- SSL jobs now re-publish HTTPS according to the domain hosting mode instead of overwriting app proxy domains with static hosting.
- Force HTTPS is only applied after certificate files exist and the 443 Nginx config passes `nginx -t`.

## Phase 8: GitHub Import And Auto Deploy

Goal: GitHub repo select to deploy.

Tasks:
- Fix token storage and repo listing.
- Import selected repo into `/var/www/deployments/<slug>`.
- Assign safe port, detect runtime, build/start, bind domain, write Nginx.
- Add webhook for push auto deploy.

Deliverables:
- No manual SSH deploy after setup.

Status:
- GitHub tokens are validated against GitHub before saving and stored through the encrypted secret vault.
- Repository import defaults to auto deploy, assigns a managed project port, and can create or update the repo webhook.
- Deploy workers inject the GitHub token only through Git's environment-based auth header, so clone/fetch works for private repos without leaking PATs in logs.
- Source sync, install, build, migrate, PM2 start, and health checks now fail the release when the underlying command fails.
- GitHub push webhooks verify per-project secrets and queue a release for matching auto-deploy projects.

## Phase 9: Installer And Fresh VPS

Goal: one-command fresh server install.

Tasks:
- Install required packages.
- Create users/permissions.
- Write systemd services and protected Nginx panel config.
- Enable services and run smoke tests.

Deliverables:
- New VPS setup is repeatable.

Status:
- Ubuntu installer installs Node.js, system packages, Certbot, PostgreSQL, Redis, BIND9, PM2, Python sysagent dependencies, and build tools.
- Installer creates the panel user, `/opt/vps-panel`, `/var/www`, `/var/www/deployments`, app env plus API/frontend env links, database, systemd services, protected panel Nginx listener, sudoers, and PM2 startup.
- Panel frontend is pinned to the configured panel frontend port, while projects use the managed deployment port pool.
- Installer runs smoke tests for sysagent, API, frontend, panel proxy, Redis, PostgreSQL, Nginx, and required services before reporting success.
- AlmaLinux 9 support is tracked separately in `docs/almalinux-support-plan.md` (Phase 2 includes `panel_nginx_layout`: create `sites-available` / `sites-enabled` on Alma because native Nginx uses `conf.d/` only).

## Phase 10: UI Polish

Goal: understandable production workflow.

Tasks:
- Improve deployment cards, domain mode UI, logs modal, SSL status, and publish status.

Deliverables:
- Admin can see what is live, where, and why.
