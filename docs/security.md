# Security

Talorys is single-user. The threat model assumes the internet can reach your
`pages.dev` URL; only the owner should be able to read or change data.

## Authentication

- The owner password is hashed **on the installer's machine** with
  PBKDF2-HMAC-SHA256 (100,000 iterations — the Workers maximum — 16-byte random
  salt) and stored as the `OWNER_PASSWORD_HASH` Worker secret. The plaintext
  never leaves the machine, is never written to disk and is never logged.
- A 256-bit `SESSION_SECRET` is generated locally and stored as a Worker secret.
- Sessions are random 256-bit tokens in an `HttpOnly; Secure; SameSite=Strict;
  Path=/` cookie named `__Host-talorys_session`. The database stores only
  `HMAC(SESSION_SECRET, token)`; a storage leak cannot be replayed.
- Sessions expire after 30 days, or 14 days of inactivity. Logout and
  "sign out other sessions" revoke server-side. At most 20 sessions are kept.
- Changing the password in the UI signs out other devices.
- `reset-password` (CLI) replaces the secret; the Durable Object detects the
  changed fingerprint, discards any UI-set password and revokes every session.
- There is no signup, setup or ownership-claim endpoint.

## Brute force

5 failed logins per client IP (`CF-Connecting-IP`) within 15 minutes lock that
client; 25 failures overall lock login globally for the window. Responses
include `Retry-After`. Password changes are subject to the same limiter.

## CSRF

Every non-GET request must carry `x-talorys-request: 1` (cross-site forms cannot
set custom headers, and no CORS is ever granted), an `Origin` equal to the
request origin (or a same-origin `Sec-Fetch-Site`), and the cookie is
`SameSite=Strict`.

## Backend exposure

The Worker is deployed with `workers_dev: false` and `preview_urls: false`. It is
reachable only through the Pages service binding. Authorization is enforced in
the Worker for every route except `GET /api/health`, `POST /api/auth/login` and
`GET /api/auth/session`. The agent instance name is fixed server-side.

## XSS and browser hardening

- React escapes output; Markdown is rendered without raw HTML; remote images in
  model output are not loaded; links open with `noopener noreferrer`.
- `_headers` sets a strict CSP (`script-src 'self'`, `connect-src 'self'`,
  `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, HSTS and a
  restrictive `Permissions-Policy`.
- No secrets or bindings exist in browser code (the build checks for this).

## Prompt injection and tool safety

- The system prompt marks notes, memories, tool results and history as data.
- Destructive tools (`delete_task`, `delete_note`, `forget_memory`,
  `cancel_automation`) require `confirmed: true` **and** an explicit confirmation
  in the owner's latest message — enforced in code, not just in the prompt.
- Scheduled AI runs get read-only tools plus `notify_owner`.
- Per-request limits: tool calls, per-tool caps, duplicate-call detection,
  reasoning steps, output and context tokens; daily caps on AI requests and
  scheduled AI runs. Every model call (each tool-loop step and each history
  summary) is counted against the daily cap before it is made, and the SDK's
  automatic retries are off so no call goes uncounted.
- No shell, code execution, outbound HTTP, credentials or deployment tools exist.

## Installer

- Commands are spawned with argument arrays (no shell).
- Secrets go to Wrangler via stdin only.
- `talorys.json` is checked to contain no secret-like values before writing.
- Error output is sanitized of token-like strings.

## Reporting

Please report vulnerabilities privately via GitHub Security Advisories.
