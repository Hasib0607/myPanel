# AlmaLinux 9 Support Plan

Last updated: 2026-05-31

Goal: run the VPS panel on **Ubuntu 22.04** and **AlmaLinux 9** with the same sysagent behavior, installer flow, and deployment tooling.

**Missing / QA tracker:** [`docs/almalinux-missing-tracker.md`](almalinux-missing-tracker.md)

## Status Overview

| Phase | Scope | Status |
|-------|-------|--------|
| Phase 0 | OS detection + package maps in `sysagent/app/platform.py` | Done |
| Phase 1 | Wire sysagent routers to `platform.py` | Done |
| Phase 2 | AlmaLinux 9 installer + shared install logic | Done (pending live VPS QA) |
| Phase 3 | Shell scripts (vhost, update-panel, maintenance) | Done |
| Phase 4 | API/frontend hint cleanup | Done |
| Phase 5 | Docs + AlmaLinux QA checklist | Done |
| Phase 6 | Post-install validation + platform API | Done (live QA pending) |

---

## Phase 0 — Foundation (Done)

- `sysagent/app/platform.py` with OS detect, package maps, service units, paths, EPEL install plans
- Unit tests in `sysagent/tests/test_platform.py`
- Certbot, composer, and dovecot Alma mappings finalized

---

## Phase 1 — sysagent runtime (Done)

### Phase 1A — Package and services

- `system.py` → `install_plan_for()` + `service_checks()`
- `deployments.py` → `runtime_tool_install_plan()`
- `command.run_install_plan()`

### Phase 1B — Firewall and guardian

- `firewall_backend.py` — UFW + firewalld
- `guardian.py` — auth log, redis unit, IP block/unblock, firewall status key

---

## Phase 2 — AlmaLinux 9 installer (Done — live QA pending)

- `scripts/install/common.sh`
- `scripts/install/ubuntu-22.04.sh` (refactored)
- `scripts/install/alma-linux-9.sh`
- `scripts/install/install.sh`
- **panel_nginx_layout** in Alma installer (`sites-available`, `00-sites-enabled.conf`)
- firewalld + SELinux in Alma installer

---

## Phase 3 — Supporting shell scripts (Done)

- `scripts/nginx/create-vhost.sh`
- `scripts/deploy/update-panel.sh`
- `scripts/maintenance/phase0-stabilize.sh`
- `sysagent/app/nginx_paths.py` + `NGINX_SITES_*` env

---

## Phase 4 — API and frontend (Done)

- `api/src/routes/deployments.ts` generic install hints
- Firewall/guardian UI labels

---

## Phase 5 — Documentation (Done)

- `docs/one-click-install.md`
- `docs/operations.md` Alma section
- `README.md` supported OS
- `docs/almalinux-missing-tracker.md`
- `docs/almalinux-qa-checklist.md`

---

## Phase 6 — Validation and platform API (Done — live QA pending)

- `scripts/install/validate-install.sh` — post-install checks (services, HTTP, Redis, PG, nginx layout)
- `scripts/install/lib/os.sh` — shared OS detection for maintenance scripts
- `GET /system/platform` — exposes `platform_summary()` for debugging
- Installers invoke validation after smoke tests
- Optional fail2ban on Alma installer (EPEL)
