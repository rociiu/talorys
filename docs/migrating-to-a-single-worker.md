# Migrating to a single Worker

Talorys used to deploy two Cloudflare resources with Wrangler:

- a **Pages project** (`talorys-<id>-web`) that served the React app, with a
  Pages Function forwarding `/api/*` over a service binding; and
- a **private Worker** (`talorys-<id>-agent`) that ran the API and the
  `TalorysAgent` Durable Object holding all your data.

It now deploys **one Worker** with [`cf`](https://www.npmjs.com/package/cf),
Cloudflare's new CLI. That Worker:

- serves the web app as
  [static assets](https://developers.cloudflare.com/workers/static-assets/),
- runs the API and the Durable Object, and
- is reachable at `https://<worker>.<your-subdomain>.workers.dev`.

New installations get this layout automatically. Existing installations move
over on their next `update`. This page explains what happens and the few things
you need to do.

## TL;DR

```bash
cd talorys            # the directory with talorys.json
npx create-talorys@latest update
```

1. If `cf` asks you to sign in, approve it in the browser. `cf` keeps its own
   login, separate from Wrangler's.
2. Open the new URL the installer prints and sign in once more.
3. When you have moved your bookmarks and devices over, delete the old Pages
   project:

```bash
npx cf pages delete talorys-<id>-web
```

If your Pages project has a **custom domain**, read
[Custom domains](#custom-domains) first.

## What is kept

| | |
| --- | --- |
| Conversations, memories, tasks, notes, automations, settings | **Kept.** The update redeploys the **same** Worker (`talorys-<id>-agent`) with the same `TalorysAgent` class, so its Durable Object namespace and SQLite data stay where they are (see [How your data is kept](#how-your-data-is-kept)). |
| Owner password and session secret | **Kept.** `cf` keeps a Worker's existing secrets on every deploy. You are not asked for your password. |
| Reminders and automations | **Kept.** They live in the Durable Object and keep firing during and after the update. |
| Worker name | **Kept.** Renaming the Worker would detach it from its data, so migrated installations keep the `-agent` suffix. New installations are named `talorys-<id>`. |
| `talorys.json` | Updated in place. `public_url` becomes the workers.dev URL. `migrated_to_worker_at` records when the move happened. `pages_project_name` is kept as a record. |

## What changes

- **Your URL.** The app moves from `https://talorys-<id>-web.pages.dev` to
  `https://talorys-<id>-agent.<your-subdomain>.workers.dev`. Nothing redirects
  from the old address to the new one.
- **You sign in once more.** Session cookies belong to a site's origin, so your
  browsers have no session for the new address yet.
- **The old Pages site keeps running until you delete it.** It still serves the
  *previous* web app, and its Pages Function still forwards to your Worker. It
  will drift out of date as Talorys updates, so delete it once you have
  switched over. The installer never deletes anything itself.
- **The Worker is now public.** It has a workers.dev route instead of being
  reachable only through the Pages service binding. This does not widen what
  is exposed. The Pages Function forwarded every `/api/*` request unchanged and
  added no checks; authentication, CSRF and Origin checks have always run in
  the Worker. See [security.md](security.md#backend-exposure).
- **Fewer moving parts.** Each API call now runs one Worker invocation instead
  of a Pages Function plus a service-binding call. Static assets are served
  without running any Worker code.
- **`cf` instead of Wrangler.** The installer bundles `cf` and runs
  `cf deploy --prebuilt`. Credentials come from `CLOUDFLARE_API_TOKEN`, or from
  `cf`'s own browser login on the first run.
- **The local directory.** The old `agent/` and `web/` folders are replaced by a
  prebuilt `cf` Build Output in `.cloudflare/output/v0/`, containing the Worker
  config, the bundle and the web app. Only files the installer generated are
  removed; anything else you put in those folders stays.

## What the update does, in order

1. Writes the Build Output and removes the old generated files.
2. Deploys the existing Worker with `cf deploy --prebuilt`, adding static
   assets and a workers.dev route, and declaring the Durable Object class
   (details below).
3. Checks the new URL:
   - the web app loads;
   - the API answers;
   - anonymous requests are rejected;
   - storage and secrets are healthy.
4. Records the move in `talorys.json` and prints the new URL. The old Pages site
   is not touched at any point.

If any step fails, the update stops and reports why. Nothing is deleted, and the
old Pages site keeps working as before because it forwards to the same Worker.
Fix the cause and run `update` again.

## How your data is kept

Wrangler created your Durable Object with a *migration* (`tag: "v1"`,
`new_sqlite_classes: ["TalorysAgent"]`). `cf` uses Cloudflare's newer
declarative form, `exports`:

```json
"exports": { "TalorysAgent": { "type": "durable-object", "storage": "sqlite" } }
```

Cloudflare documents switching an existing Worker from migrations to
`exports` as supported without any data migration. The provisioned namespace
stays in place, and the deploy reports the class as kept. If a deploy ever
left out a class the Worker still has, Cloudflare refuses that deploy rather
than deleting the namespace. The installer never sets a `state` on the class,
because an explicit `"deleted"` state is the only way `exports` removes a
namespace.

Two consequences:

- **No rollback to 0.1.x.** Once a Worker has been deployed with `exports`,
  Cloudflare no longer accepts the `migrations` form that create-talorys 0.1.x
  (Wrangler) sends, so you can't go back to the old installer for this
  Worker. Your data is not affected by this.
- **Optional backup first.** Settings → Privacy → Download backup gives you a
  JSON export you can import into any Talorys installation.

## Before you start

- **A workers.dev subdomain.** Accounts that only ever used Pages may never
  have chosen one. If the installer reports *"this Cloudflare account has no
  workers.dev subdomain yet"*:
  1. Open **Workers & Pages** in the Cloudflare dashboard (or the onboarding
     link in the error).
  2. Pick a subdomain.
  3. Re-run the update.
- **API tokens.** If you use `CLOUDFLARE_API_TOKEN`, the token needs Workers
  Scripts: Edit, Workers AI: Read and Account Settings: Read. Pages access is
  no longer needed.

## Custom domains

If you attached your own domain (for example `agent.example.com`) to the Pages
project, it keeps pointing at the old Pages site, which serves the previous web
app. To move the domain to the Worker:

1. Run the update as above and check the app at the new workers.dev URL.
2. In the Cloudflare dashboard, open **Workers & Pages → talorys-<id>-web →
   Custom domains** and remove `agent.example.com`.
3. Open **Workers & Pages → talorys-<id>-agent → Settings → Domains & Routes →
   Add → Custom domain** and add `agent.example.com`. Cloudflare creates the DNS
   record and certificate. The domain's zone must be in the same account.

Custom domains you add in the dashboard survive later updates. The generated
config declares no routes, and `cf` leaves existing ones alone. The installer
still reports the workers.dev URL. Your domain and the workers.dev URL both
serve the same app, but each has its own cookies, so pick one and sign in
there.

## Deleting the old Pages project

Once your bookmarks and devices use the new URL, delete the Pages project:

```bash
npx cf pages delete talorys-<id>-web
```

The exact command is also in the generated `README.md` in your Talorys
directory, and `npx create-talorys@latest status` reminds you of it. Deleting the
Pages project does not affect the Worker or your data.

## If the update stops with "changed outside the installer"

`cf` refuses, without a terminal, to overwrite a Worker that Cloudflare reports
was last changed outside a deploy, for example from the dashboard. Nothing is
deployed in that case. To fix it:

1. Run `npx cf deploy --prebuilt` in your Talorys directory.
2. Review the prompt and confirm.
3. Run `npx create-talorys@latest update` again.

Please also open an issue so we can make this smoother.
