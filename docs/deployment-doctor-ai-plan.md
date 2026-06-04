# Deployment Doctor AI Plan

## Goal

Add an OpenAI-powered diagnosis and repair-planning layer to Deployment Doctor while keeping command execution inside the panel's existing allowlisted sysagent, approval, audit, cooldown, and verification boundaries.

The model must never receive secrets or execute unrestricted shell commands.

## Phase 1: Superadmin AI Settings

- Add a dedicated Deployment Doctor AI section under `/settings`.
- Store the OpenAI API key in the encrypted `Secret` table, never plaintext panel environment.
- Add enable/disable, model, mode (`observe`, `suggest`, `auto-safe`), maximum calls per deployment, repair-attempt limits, and usage budget controls.
- Add a connection test and last-call status.

## Phase 2: Sanitized Diagnosis Context

- Collect failed deployment logs, framework/runtime/package metadata, linked domain status, selected database engine, Nginx/process health, previous Doctor findings, and prior repair outcomes.
- Redact environment secrets, database passwords, GitHub tokens, API keys, and credentials before sending context.
- Limit log size and retain the original evidence fingerprint locally.

## Phase 3: Structured Repair Planner

- Use the OpenAI Responses API with strict structured output/function calling.
- Require category, root cause, confidence, risk, action key, verification steps, and fallback action.
- Only allow action keys registered in the panel repair catalog.
- Prefer deterministic Deployment Doctor rules before requesting AI diagnosis.

## Phase 4: Execution Policy

- Safe read-only checks and known health/redeploy actions may auto-run.
- Controlled allowlisted runtime, Nginx, Supervisor, and permission repairs follow existing policy.
- Database mutations, package removals, firewall changes, and unknown/custom actions require superadmin approval.
- Reject shell metacharacters, unknown executables, paths outside managed deployment roots, and unbounded commands.

## Phase 5: Repair Loop

1. Execute the approved catalog action.
2. Capture command output and result.
3. Re-run health, public route, asset, and framework checks.
4. Stop repeated identical failures using fingerprints, cooldowns, and attempt limits.
5. Try a validated fallback or queue approval.
6. Roll back when a previously healthy release becomes unhealthy.

## Phase 6: Learned Deterministic Rules

- Store successful AI diagnosis/action/verification combinations.
- Present repeated successful repairs as rule candidates.
- Require superadmin approval before promoting a candidate into deterministic Doctor behavior.
- Use promoted rules before OpenAI to reduce latency and cost.

## Phase 7: UI and Auditability

- Show AI root cause, confidence, risk, proposed action, evidence summary, approval state, execution timeline, and verification result.
- Show AI usage and cost summaries.
- Keep every AI decision and executed action in deployment logs and audit logs.

## Phase 8: Rollout

- Add response-schema, secret-redaction, prompt-injection, command-policy, and failure-fixture tests.
- Roll out in `observe`, then `suggest`, then `auto-safe` mode.
- Keep the existing deterministic Doctor fully operational when OpenAI is unavailable.

## Safety Invariants

- AI cannot execute raw shell.
- AI cannot access stored secrets.
- AI cannot bypass approval requirements.
- AI failure cannot fail an otherwise valid deployment.
- Account and deployment ownership boundaries remain enforced.
