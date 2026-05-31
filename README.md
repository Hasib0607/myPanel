# VPS Hosting Control Panel

Custom single-admin VPS management suite based on `VPS_Panel_Architecture.docx`.

This repository is structured as a monorepo with three application services:

- `frontend/`: Next.js 14 App Router interface for dashboard, domains, DNS, mail, firewall, files, and deployments.
- `api/`: Node.js Fastify API for panel data, authentication, queues, and orchestration.
- `sysagent/`: Python FastAPI localhost-only system agent for privileged VPS operations.

The current implementation is a Phase 1 foundation scaffold: it defines the project layout, database model, route contracts, safe service adapters, and user interface shells needed to build each module incrementally.

## Quick Start

1. Copy `.env.example` to `.env` and fill in secrets.
2. Start PostgreSQL and Redis with Docker Compose if you are developing locally.
3. Install dependencies in each service.
4. Run migrations from `api/`.
5. Start `api`, `sysagent`, and `frontend`.

```powershell
docker compose up -d postgres redis pgbouncer
cd api; npm install; npm run prisma:generate; npm run dev
cd ../sysagent; python -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt; .\.venv\Scripts\uvicorn app.main:app --reload --host 127.0.0.1 --port 5000
cd ../frontend; npm install; npm run dev
```

On a production VPS, run `sysagent` bound to `127.0.0.1` only and place Nginx in front of the frontend and API as described in the architecture document.

## Supported production OS

- Ubuntu 22.04 LTS
- AlmaLinux 9.x

One-command install:

```bash
export REPO_URL="https://github.com/YOUR_OWNER/YOUR_REPO.git"
export APP_BRANCH="main"
export VPS_IP="YOUR_SERVER_IP"
bash scripts/install/install.sh
```

See `docs/one-click-install.md` and `docs/almalinux-missing-tracker.md` for OS-specific notes and remaining live QA items.

## Service Ports

- Frontend: `3000`
- Main API: `4000`
- System Agent: `5000`
- PostgreSQL: `5432`
- PgBouncer: `6432`
- Redis: `6379`

## Safety Notes

The system agent currently exposes dry-run friendly command adapters. Before enabling live execution on a VPS, review the sudoers policy and only allow the exact commands the panel needs.
