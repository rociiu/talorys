# Troubleshooting

Start with:

```bash
npx create-talorys@latest doctor
```

## Installation

**The browser login does not open / times out.** Open the URL `cf` prints and
enter the code it shows. In SSH or containers, set `CLOUDFLARE_API_TOKEN`
instead. `cf` keeps its own login, so you may be asked to sign in even if
Wrangler is already logged in.

**"Multiple Cloudflare accounts are available."** Pass `--account-id <id>` in
non-interactive mode.

**"…lacks a required permission."** You need to be able to edit Workers in the
chosen account (see [deployment.md](deployment.md#permissions)).

**"…has no workers.dev subdomain yet."** Open Workers & Pages in the Cloudflare
dashboard (or the onboarding link in the error), choose a subdomain, and re-run.

**"The deployment did not pass its health checks yet."** A new `workers.dev`
address can take a few minutes to get DNS and certificates. Re-run the same
command; it resumes without duplicating anything.

**"…the Worker was changed outside the installer since the last update."** `cf`
refused to overwrite a Worker that Cloudflare reports was changed outside a
deploy (for example in the dashboard), because it cannot ask you without a
terminal. Nothing was deployed. Run `npx cf deploy --prebuilt` in your Talorys
directory, review and confirm, then run the update again.

**"Cloudflare refused the Durable Object configuration."** Nothing was deployed
and no data changed. Please open an issue with the details shown.

**The old `pages.dev` site still shows Talorys.** After migrating to a single
Worker, the old Pages project keeps serving the previous web app until you
delete it: `npx cf pages delete talorys-<id>-web`. Your custom domain, if any,
can be moved to the Worker: see
[migrating-to-a-single-worker.md](migrating-to-a-single-worker.md#custom-domains).

**"…already exists and is not a Talorys installation."** Choose another
directory with `--dir`. The installer never overwrites unrelated folders.

**"SQLite-backed Durable Objects are not available."** Check the account's
Workers settings; SQLite Durable Objects are included on the Free plan.

## Using Talorys

**"Your Cloudflare account has used its Workers AI allocation for today."**
The daily free Neuron allocation is exhausted. Chat resumes after the reset;
tasks, notes, memories and reminders keep working. Exact usage is in the
Cloudflare dashboard (Workers AI).

**"Talorys reached its daily limit of N AI requests."** That's Talorys' own
guardrail; raise it in Settings → AI.

**"Too many failed attempts."** Wait 15 minutes, or reset the password with
`npx create-talorys@latest reset-password`.

**Reminders fire at the wrong time.** Check Settings → General → Timezone.
Changing it re-schedules all automations.

**"The configured AI model is not available."** Set a supported Workers AI
model with tool calling in Settings → AI (default `@cf/zai-org/glm-4.7-flash`).

## Development

**`database is locked: SQLITE_BUSY`** — two local runtimes share a state
directory. Stop stray `wrangler` processes; the dev and e2e scripts use
separate state directories.

**Port already in use** — stop other dev servers on 5173 or 8787.
