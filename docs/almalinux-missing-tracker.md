# AlmaLinux Support — Missing Items Tracker

**Single source of truth** for open gaps. Update as phases complete.

Last updated: 2026-05-31

---

## Phase status

| Phase | Scope | Code | Live QA |
|-------|-------|------|---------|
| 0 | `platform.py` foundation | Done | N/A |
| 1 | sysagent OS wiring | Done | Pending |
| 2 | Installers (`common.sh`, Alma/Ubuntu, `install.sh`) | Done | Pending |
| 3 | Shell scripts + nginx paths | Done | Pending |
| 4 | API + frontend hints/labels | Done | N/A |
| 5 | Documentation | Done | N/A |
| 6 | Validation (`validate-install.sh`, `/system/platform`) | Done | Pending |

---

## Completed (code)

### Phase 2
- [x] `scripts/install/common.sh`
- [x] `scripts/install/ubuntu-22.04.sh` refactor
- [x] `scripts/install/alma-linux-9.sh` (CRB, EPEL, firewalld, SELinux, nginx layout)
- [x] `scripts/install/install.sh` OS dispatcher
- [x] Optional **fail2ban** on Alma (EPEL)
- [x] Post-install validation hook in both installers

### Phase 3
- [x] `scripts/install/lib/os.sh` shared detection
- [x] `scripts/nginx/create-vhost.sh` env paths
- [x] `scripts/deploy/update-panel.sh` env paths
- [x] `scripts/maintenance/phase0-stabilize.sh` OS-aware
- [x] `sysagent/app/nginx_paths.py` + `.env` vars

### Phase 4
- [x] `api/src/routes/deployments.ts` generic hints
- [x] `api/src/routes/dashboard.ts` — install via sysagent only (removed Ubuntu package list)
- [x] Firewall/guardian UI generic labels

### Phase 5
- [x] `docs/one-click-install.md`
- [x] `docs/operations.md` Alma section
- [x] `README.md`
- [x] `docs/almalinux-qa-checklist.md`

### Phase 6
- [x] `scripts/install/validate-install.sh`
- [x] `GET /system/platform` sysagent endpoint
- [x] Installers run validation after smoke tests

---

## Still open — requires AlmaLinux 9 VPS

Manual steps: [`docs/almalinux-qa-checklist.md`](almalinux-qa-checklist.md)

- [ ] Fresh install: `bash scripts/install/install.sh`
- [ ] `bash scripts/install/validate-install.sh` → exit 0
- [ ] Panel `:8453` / `:3138` login
- [ ] `curl http://127.0.0.1:5000/system/platform` → `family=rhel`
- [ ] Nginx sites-available layout + vhost deploy
- [ ] firewalld rule from panel Firewall page
- [ ] Guardian auth log + redis unit + IP block
- [ ] PHP/Go/Composer runtime-tools on Alma
- [ ] BIND/named DNS zone
- [ ] Self-update webhook
- [x] Remove `panel_nginx_layout` from `INCOMPLETE_ON_ALMA`

---

## Known limitations

| Item | Notes |
|------|--------|
| firewalld numbered delete | Best-effort; ports 1..n, rich rules 100+ |
| fail2ban on Alma | Optional EPEL; may be inactive if install skipped |
| Composer fallback | Only if EPEL `dnf install composer` fails |
| SELinux custom ports | `semanage` may need manual run on some hosts |
| Dev machine | Cannot run full Alma install/QA locally |

---

## Quick commands (on server)

```bash
bash scripts/install/validate-install.sh
curl -fsS http://127.0.0.1:5000/system/platform | python3 -m json.tool
cd sysagent && python3 -m unittest discover -s tests -v
firewall-cmd --list-all
systemctl is-active named redis postgresql nginx vps-panel-api
```
