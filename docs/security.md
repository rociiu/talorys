# Security

Talorys is single-user. The threat model assumes the internet can reach your
`workers.dev` URL; only the owner should be able to read or change data.

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

One Worker serves the web app and the API at its workers.dev URL;
`preview_urls` is disabled so no other version is reachable. Static assets are
public by design and contain no secrets. Only `/api/*` runs Worker code, and
authorization is enforced there for every route except `GET /api/health`,
`POST /api/auth/login` and `GET /api/auth/session`. Anything else that reaches
the Worker gets a 404. The agent instance name is fixed server-side.

(Earlier versions put a Pages Function in front of a Worker without a public
URL. That function forwarded every request unchanged and added no checks, so
the reachable surface was the same as today.)

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
  scheduled AI runs.
- No shell, code execution, outbound HTTP, credentials or deployment tools exist.

## Installer

- Commands are spawned with argument arrays (no shell).
- `cf` reads secrets only from files: the installer writes them to a private
  (`0600`) file in a fresh system temp directory and deletes it as soon as the
  command returns. They never appear in arguments or the project directory.
- `cf` telemetry is disabled for every command it runs.
- `talorys.json` is checked to contain no secret-like values before writing.
- Error output is sanitized of token-like strings.

## Reporting

Please report vulnerabilities privately via GitHub Security Advisories.
