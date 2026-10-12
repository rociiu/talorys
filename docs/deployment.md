# Deployment

## One command

```bash
npx create-talorys@latest
```

### Steps the installer performs

| Step | Implementation |
| --- | --- |
| Check Node.js ≥ 22, templates, bundled Wrangler | `requirements.ts`, `scaffold.ts` |
| Detect global `wrangler` / `cf` (informational) | `requirements.ts` |
| Verify login or open browser OAuth (`wrangler login`) | `install.ts › ensureAuthenticated` |
| Choose account (`wrangler whoami --json`) | `install.ts › chooseAccount` |
| Allocate collision-free names | `install.ts › allocateNames` |
| Prompt for password (hidden, strength-checked) | `ui.ts`, `secrets.ts` |
| Write manifest `talorys.json` (no secrets) | `manifest.ts` |
| Write Worker bundle, frontend, generated `wrangler.jsonc` files | `scaffold.ts`, `config.ts` |
| Check the Workers AI model exists (no inference) | `wrangler ai models schema` |
| Deploy the private Worker (creates the SQLite DO on first deploy) | `wrangler deploy` |
| Store `OWNER_PASSWORD_HASH` and `SESSION_SECRET` via stdin | `wrangler secret bulk` |
| Create/reconcile the Pages project and deploy it | `wrangler pages project create`, `wrangler pages deploy` |
| Verify through the public URL | `verify.ts` |

The Worker is always deployed before Pages, because the Pages service binding
refers to it.

### Generated Worker config

```jsonc
{
  "name": "talorys-<id>-agent",
  "main": "worker.js",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": false,
  "preview_urls": false,
  "ai": { "binding": "AI" },
  "durable_objects": { "bindings": [{ "name": "TalorysAgent", "class_name": "TalorysAgent" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["TalorysAgent"] }],
  "vars": { "TALORYS_INSTALLATION_ID": "…", "TALORYS_DEPLOYED_VERSION": "…", "TALORYS_DEFAULT_TIMEZONE": "…", "TALORYS_AGENT_NAME": "…" }
}
```

### Generated Pages config

```jsonc
{
  "name": "talorys-<id>-web",
  "pages_build_output_dir": "./dist",
  "compatibility_date": "2026-10-01",
  "services": [{ "binding": "AGENT", "service": "talorys-<id>-agent" }]
}
```

## One Worker, without Pages

`apps/agent/wrangler.standalone.jsonc` deploys the agent Worker with the web UI
as static assets, so one Worker serves both. Use it with tools that deploy a
single Worker:

```bash
npm run build -w @talorys/web
cd apps/agent
npx wrangler secret put OWNER_PASSWORD -c wrangler.standalone.jsonc
npx wrangler secret put SESSION_SECRET -c wrangler.standalone.jsonc   # 32+ random characters
npx wrangler deploy -c wrangler.standalone.jsonc
```

`OWNER_PASSWORD` is the plain password, for deploys that cannot hash it
beforehand. It must pass the installer's strength check (10+ characters, mixed
classes or 16+ characters, no common words); a weak one counts as not configured
and `/api/health` reports `"password": false`. When `OWNER_PASSWORD_HASH` is set,
it takes precedence.

In this mode, changing `SESSION_SECRET` also discards a password changed in the
UI: login reverts to `OWNER_PASSWORD`, and every device is signed out.

The config names the Worker `talorys`, and `wrangler deploy` replaces any Worker
of that name in the account. Change `name` (or pass `--name`) to deploy under
another one.

## Idempotency and recovery

- The manifest records the installation id; re-runs reuse the same names.
- Secrets that already exist are never overwritten (the password is not re-asked).
- Existing Pages projects are reused; Workers are updated in place.
- Failures mark the manifest `failed` with completed steps; re-running resumes.
- The installer never runs delete commands.
- A non-empty directory without a manifest is refused, so nothing unrelated is overwritten.
- New resource names are checked against existing Workers and Pages projects.

## Updates

`npx create-talorys@latest update` refreshes artifacts, keeps the same names
and Durable Object class, appends (never edits) migrations, keeps secrets, and
re-verifies. Schema migrations run transactionally inside the Durable Object.

## Permissions

OAuth login (default) uses Wrangler's standard scopes. API tokens need Workers
Scripts:Edit, Cloudflare Pages:Edit, Workers AI:Read and Account Settings:Read.
A Global API Key is never required.

## Publishing the npm package (maintainers)

```bash
npm run build -w create-talorys   # builds dist/ and templates/
npm run test:pack                 # verifies the tarball outside the monorepo
cd packages/create-talorys && npm publish
```

`TALORYS_VERSION` in `packages/shared/src/constants.ts` must equal the package version.

## Real-account smoke test

```bash
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npm run test:smoke
# add TALORYS_SMOKE_AI=1 to include one streamed Workers AI chat turn
```
