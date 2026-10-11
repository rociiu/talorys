# Deployment

## One command

```bash
npx create-talorys@latest
```

### Steps the installer performs

| Step | Implementation |
| --- | --- |
| Check Node.js ≥ 22, templates, bundled `cf` | `requirements.ts`, `scaffold.ts` |
| Detect global `wrangler` / `cf` (informational) | `requirements.ts` |
| Verify login or open browser OAuth (`cf auth login`) | `install.ts › ensureAuthenticated` |
| Choose account (`cf auth whoami`) | `install.ts › chooseAccount` |
| Allocate a collision-free Worker name (`cf workers scripts search`) | `install.ts › allocateNames` |
| Prompt for password (hidden, strength-checked) | `ui.ts`, `secrets.ts` |
| Write manifest `talorys.json` (no secrets) | `manifest.ts` |
| Write the Build Output: Worker config, bundle and web app | `scaffold.ts`, `config.ts` |
| Check the Workers AI model exists (no inference) | `cf ai get-model-schema` |
| Deploy the Worker with static assets, uploading any missing `OWNER_PASSWORD_HASH` / `SESSION_SECRET` with it (creates the SQLite DO on first deploy) | `cf deploy --prebuilt --secrets-file` |
| Verify through the workers.dev URL `cf deploy` reports | `verify.ts` |

`cf` reads secrets only from files. The installer writes them to a private
(`0600`) file in a fresh system temp directory, outside the project, and
deletes it as soon as the command returns. Secrets never appear in command
arguments or in the Talorys directory.

### Generated project

The deployable files are a prebuilt [`cf` Build Output](https://www.npmjs.com/package/cf)
that `cf deploy --prebuilt` reads from the project directory:

```
talorys/
├─ talorys.json                         manifest (no secrets)
└─ .cloudflare/output/v0/
   ├─ config.json                       pins the account
   └─ workers/default/
      ├─ worker.config.json             generated Worker config
      ├─ bundle/worker.js               prebuilt Worker bundle
      └─ assets/                        prebuilt web app, including _headers
```

### Generated Worker config

```jsonc
{
  "name": "talorys-<id>",
  "compatibilityDate": "2026-10-01",
  "compatibilityFlags": ["nodejs_compat"],
  "workersDev": true,
  "previewUrls": false,
  "observability": { "enabled": true },
  "assets": { "notFoundHandling": "single-page-application", "runWorkerFirst": ["/api/*"] },
  "env": {
    "AI": { "type": "ai" },
    "TalorysAgent": { "type": "durable-object", "worker": "talorys-<id>", "exportName": "TalorysAgent" },
    "TALORYS_INSTALLATION_ID": { "type": "text", "value": "…" }
    // … TALORYS_DEPLOYED_VERSION, TALORYS_DEFAULT_TIMEZONE, TALORYS_AGENT_NAME
  },
  "exports": { "TalorysAgent": { "type": "durable-object", "storage": "sqlite" } },
  "manifest": { "type": "partial", "mainModule": "worker.js", "modules": {} }
}
```

Secrets are deliberately not declared: `cf` keeps a Worker's existing secrets on
every deploy, and the installer uploads missing ones with the deploy itself.
The Durable Object class is declared with `exports`, Cloudflare's declarative
lifecycle (no migration tags). Never remove it or give it a `state`; that is
how a namespace, and the owner's data, is deleted.

Installations created before the single-Worker release keep their Worker name
(`talorys-<id>-agent`), because the Durable Object namespace belongs to it.

## Idempotency and recovery

- The manifest records the installation id; re-runs reuse the same names.
- Secrets that already exist are never overwritten (the password is not re-asked).
- Workers are updated in place.
- Failures mark the manifest `failed` with completed steps; re-running resumes.
- The installer never runs delete commands.
- A non-empty directory without a manifest is refused, so nothing unrelated is overwritten.
- New Worker names are checked against existing Workers.
- The installer never touches the old Pages project of a migrating installation;
  it tells the owner how to delete it.
- `cf` treats every run as non-interactive: if Cloudflare reports the Worker was
  changed outside a deploy, `cf` aborts (exit 1) instead of overwriting it, and
  the installer reports that nothing was deployed.

## Updates

`npx create-talorys@latest update` refreshes artifacts, keeps the same names
and Durable Object class, keeps secrets, and re-verifies. Schema migrations run
transactionally inside the Durable Object.

### From the two-resource layout

Installations created by create-talorys 0.1.x had a Pages project
(`talorys-<id>-web`) proxying `/api/*` to a private Worker, both deployed with
Wrangler, and the Durable Object was created by a `v1` migration. Their next
`update` redeploys the same Worker with `cf`: static assets, a workers.dev route,
and the same class declared through `exports`, which keeps the existing
namespace and its data. The update then verifies the result. The old Pages
project is left alone for the owner to delete. Full guide:
[migrating-to-a-single-worker.md](migrating-to-a-single-worker.md).

## Permissions

Browser login (default) uses `cf auth login`, Cloudflare's OAuth flow; `cf`
keeps its own login, separate from Wrangler's. API tokens
(`CLOUDFLARE_API_TOKEN`) need Workers Scripts:Edit, Workers AI:Read and Account
Settings:Read. Pages access is not needed, not even to migrate an older
installation. A Global API Key is never required.

The account needs a workers.dev subdomain. Accounts that never used Workers may
not have one yet; the installer explains how to choose it (free) and resumes
when re-run.

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

## Real-account migration test

Run this before releasing anything that changes how existing installations are
deployed. It installs with create-talorys 0.1.4 (Wrangler, Pages + private
Worker), writes a task and a memory, updates with this build (`cf`, one
Worker), then signs in at the new URL with the same password and reads them
back. It finishes with a second update.

```bash
npm run build
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npm run test:smoke:migrate
```

The token also needs Cloudflare Pages:Edit, but only for the 0.1.4 install step.
