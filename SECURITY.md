# Security Policy

Talorys runs in each user's own Cloudflare account, so a vulnerability can
expose someone's personal data. Thank you for reporting responsibly.

## Supported versions

Only the latest published version of `create-talorys`, and the agent it
deploys, receives security fixes. Users update with
`npx create-talorys@latest update`.

## Reporting a vulnerability

**Do not open a public issue.** Report privately through GitHub:
**Security → Report a vulnerability** on this repository
([private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).

Please include:

- affected component (installer, Worker, web app)
- steps to reproduce or a proof of concept
- impact, and any suggested fix

We aim to acknowledge reports within 3 business days and to publish a fix
and advisory within 30 days, depending on severity. We will credit you
unless you prefer otherwise.

## Scope

In scope, for example:

- authentication or session bypass, CSRF, login rate-limit bypass
- reaching the agent Worker, its storage or the AI binding without the owner session
- secrets or credentials leaked to the browser, logs, `talorys.json` or exports
- prompt injection that makes the agent perform write or destructive actions
  without owner confirmation, or escape its tool restrictions
- the installer deleting or overwriting data or unrelated Cloudflare resources
- anything that silently enables paid Cloudflare features

Out of scope:

- vulnerabilities in Cloudflare's platform (report them to
  [Cloudflare](https://hackerone.com/cloudflare))
- attacks that need an already compromised Cloudflare account or owner device
- exceeding free-tier quotas by the owner themselves
- missing hardening with no demonstrated impact

The design and threat model are described in [docs/security.md](docs/security.md).
