# Architecture Summary

This project follows the architecture in `VPS_Panel_Architecture.docx`.

## Phase 1 Modules

- Authentication: single superadmin, bcrypt hash in `.env`, JWT cookie session.
- Domains: CRUD, status, SSL flags, default DNS record generation.
- DNS: BIND9-oriented record model and API surface.
- Mail: mailbox accounts, aliases, message metadata, queue placeholders.
- Firewall: persisted UFW rules plus sysagent live-apply integration.
- File Manager: `/var/www` scoped API with path traversal protection.
- Deployments: framework, port, environment, database metadata, and worker queue.

## Build Order

1. Finish auth form submission and session guard in the frontend.
2. Wire frontend pages to Fastify route data with TanStack Query.
3. Add Prisma migrations and seed data.
4. Implement live sysagent command policies on a disposable VPS.
5. Add BIND9 zone writer, Nginx vhost writer, and Certbot queue workers.
6. Add mail service implementation with IMAP sync and SMTP send queue.

## Production Guardrails

- Bind `sysagent` to `127.0.0.1`.
- Keep privileged operations behind exact sudoers rules.
- Use PgBouncer for API connections.
- Scope file manager operations to `/var/www`.
- Keep mail private keys readable only by OpenDKIM.
