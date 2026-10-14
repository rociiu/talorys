# Contributing to Talorys

Thanks for your interest! Bug reports, docs fixes and focused pull requests
are all welcome.

## Principles

Talorys is a **single-user, self-hosted** agent that must stay within the
Cloudflare free plan. Changes should keep these properties:

- No telemetry, analytics or calls to services run by Talorys developers.
- No paid Cloudflare services enabled automatically, and no automatic switch
  to a paid model.
- Secrets, API tokens and AI/storage bindings never reach browser code.
- The agent gets no shell, code execution, arbitrary HTTP or deployment tools.
  Owner-connected MCP calls must use the guarded client and ToolExecutor; never bypass URL validation, limits or approval.
  New tools need a Zod schema, a permission level, and owner confirmation for
  destructive actions.
- The installer stays idempotent and never deletes user data.
- Durable Object migrations are append-only: never edit an existing migration.

For anything larger than a bug fix, please open an issue first to discuss it.

## Development setup

Requires Node.js 22+.

```bash
npm install
npm run dev
```

This runs the agent Worker, the Pages Function proxy and the Vite UI locally
with a mock AI provider; no Cloudflare account is needed. Open
http://localhost:5173 and sign in with `talorys-dev-password`. See
[docs/development.md](docs/development.md) for details.

## Before opening a pull request

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

If you changed the installer, also run `npm run test:pack`.

- Add or update tests for behaviour changes.
- Update the docs when you change user-facing behaviour.
- Keep pull requests focused, with a clear description of what and why.

## Reporting bugs

Open an issue with steps to reproduce, expected and actual behaviour, and the
output of `npx create-talorys@latest doctor` if it relates to a deployment.
Remove any personal data first.

**Security issues:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
