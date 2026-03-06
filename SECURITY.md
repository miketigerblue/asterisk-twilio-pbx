# Security Policy

## Scope

This project is a **lab / portfolio PBX** that bridges SIP telephony to AI voice agents. It handles real network protocols (SIP/TLS/SRTP), API keys, and phone numbers. Treat any deployment as you would a production voice service.

## Reporting a vulnerability

If you discover a security issue, **please do not open a public GitHub issue**.

Instead, email: **security@tigerblue.dev**

Include:
- A description of the vulnerability
- Steps to reproduce or proof of concept
- The affected component (Asterisk config, bridge, Twilio Functions, Ansible, Docker)
- Any suggested fix

I will acknowledge receipt within 48 hours and aim to provide an initial assessment within 7 days.

## What counts as a security issue

- Secrets or credentials exposed in code or logs
- Authentication or authorisation bypass (HMAC tokens, SIP auth, ANI allowlist)
- SIP/RTP media interception or injection paths
- Docker container escape or privilege escalation
- Denial of service against the bridge or PBX
- Tool-call gating bypass (budget limits, argument validation)

## Security design

For details on the project's security architecture, see:
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Section 7: Security Architecture
- [RUNBOOK.md](./RUNBOOK.md) — Secrets management, port exposure, Asterisk hardening

## Supported versions

Only the latest commit on `main` is supported. This is a portfolio project, not a versioned product.
