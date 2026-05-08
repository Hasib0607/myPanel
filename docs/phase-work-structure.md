# myPanel Phase-Wise Work Structure

## Phase 0: Emergency Stability

Goal: keep the panel and the currently live website stable while future deploy work is refactored.

Tasks:
- Reserve the panel from hosted-project overwrites.
- Keep the panel listener isolated on port 2083 through Nginx.
- Keep panel frontend/API/sysagent/worker ports internal and documented.
- Rename the panel Nginx file to a protected name such as `00-vps-panel.conf`.
- Rename hosted site configs to domain-scoped names such as `domain-priceinbd.store.conf`.
- Remove duplicate/conflicting Nginx site configs.
- Add/keep service health checks for Nginx, Redis, Postgres, API, frontend, workers, and sysagent.
- Snapshot the current working `priceinbd.store` state.

Deliverables:
- Panel always opens on `http://IP:2083`.
- Website and panel no longer overwrite each other.
- Broken hosted-site config cannot break the panel config.

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

## Phase 8: GitHub Import And Auto Deploy

Goal: GitHub repo select to deploy.

Tasks:
- Fix token storage and repo listing.
- Import selected repo into `/var/www/deployments/<slug>`.
- Assign safe port, detect runtime, build/start, bind domain, write Nginx.
- Add webhook for push auto deploy.

Deliverables:
- No manual SSH deploy after setup.

## Phase 9: Installer And Fresh VPS

Goal: one-command fresh server install.

Tasks:
- Install required packages.
- Create users/permissions.
- Write systemd services and protected Nginx panel config.
- Enable services and run smoke tests.

Deliverables:
- New VPS setup is repeatable.

## Phase 10: UI Polish

Goal: understandable production workflow.

Tasks:
- Improve deployment cards, domain mode UI, logs modal, SSL status, and publish status.

Deliverables:
- Admin can see what is live, where, and why.
