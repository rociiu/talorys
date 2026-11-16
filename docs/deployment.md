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
| Store `OWNER_PASSWORD_HASH`, `SESSION_SECRET` and the Web Push keys (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`) via stdin | `wrangler secret bulk` |
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

Push notifications are optional here; see [Push notifications](#push-notifications)
to add the keys. To connect MCP servers that need a token, also set
`MCP_CREDENTIAL_KEY` (see [Remote MCP servers](mcp.md#configuration)). For web
search, set `TAVILY_API_KEY` or `EXA_API_KEY` (see [Web search](web-search.md)).

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

## Push notifications

Web Push needs a VAPID key pair stored as two Worker secrets. The installer
creates them on a fresh install, and `npx create-talorys@latest update` adds
them to an installation made before push existed. Existing keys are never
replaced, because new keys would disconnect every subscribed device.

Without the keys everything else works: `/api/health` reports `"push": false`
and Settings shows push as unavailable. To add them by hand (for example to a
one-Worker deploy), generate a P-256 pair in the usual base64url form, such as
with `npx web-push generate-vapid-keys`, and store both:

```bash
npx wrangler secret put VAPID_PUBLIC_KEY    # add -c wrangler.standalone.jsonc for a one-Worker deploy
npx wrangler secret put VAPID_PRIVATE_KEY
```

The optional `VAPID_SUBJECT` (`mailto:you@example.com` or an `https://` URL)
is the contact push services see. It defaults to the app's own URL as recorded
when each device subscribed. Set it with `npx wrangler secret put VAPID_SUBJECT`;
a plain variable would be dropped when an update regenerates the Worker config.

### Verify a deployment on real Chrome

Mocked `PushManager` tests cannot prove connectivity to Google's push service.
After deploying the Worker and frontend from the same release, verify both
Windows Chrome and physical Android Chrome over HTTPS:

1. Sign in and open **Settings → General → Push notifications**. In Chrome's
   site settings, set Notifications to **Ask** for the Talorys origin. Confirm
   `/sw.js` loads, and in `chrome://serviceworker-internals` or DevTools confirm
   the root-scope worker is activated.
2. Turn on **Push notifications on this device**. The status should progress
   through **Turning on…** to **On** only after the browser grants permission
   and `POST /api/push/subscriptions` succeeds. The device list should gain one
   device marked **This device**, not a duplicate on repeated attempts.
3. Reload the page. The status should check the existing browser subscription
   and return to **On**. Remove that device from another session and reload:
   the switch must return to **Off** even though Chrome retains its browser
   subscription. Turning it on must reuse that subscription.
4. Use **Send a test**, including once with Talorys closed. Confirm a system
   notification arrives and its click opens the same-origin Talorys app.
5. Turn the switch off. Both the device row and browser subscription should be
   removed. Re-enable and repeat the test notification.
6. In DevTools, block the subscription request or make it fail once. A visible
   **backend** error must remain until dismissed, and **Retry** must make one
   new request; there must be no automatic retry loop. Also test denied
   notification permission and confirm the site-settings guidance appears.
7. To check the storage regression, deny storage writes in the test profile
   (or temporarily throw from `Storage.prototype.setItem` in DevTools), then
   register. The current session must still show **On** after backend success;
   after restoring storage, reload must reconcile to the same state.

On Android, use production Chrome with Google services and network access
available. If Chrome reports `Registration failed - push service error`, check
Google Play services, restricted data/battery settings, VPN/firewall policy,
and ordinary connectivity before treating it as a Talorys backend failure.
On Windows, similarly check Chrome background operation and enterprise policy.

Cloudflare Web Analytics is independent of registration. With the existing
`script-src 'self'` policy, Cloudflare's optional injected beacon may report a
CSP violation while push still works; do not relax the application CSP to hide
that message. Test with the analytics injection temporarily disabled if the
extra console messages make diagnosis unclear. Never include subscription
endpoints, keys, cookies, or session tokens in bug reports.

Test VAPID rotation only on a disposable staging installation: after rotating
keys, the old browser subscription must not be shown as confirmed; one manual
attempt should replace it and register the new endpoint without exceeding the
device limit. Existing production keys should not be rotated for this test.

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
