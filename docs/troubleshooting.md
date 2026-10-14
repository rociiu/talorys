# Troubleshooting

Start with:

```bash
npx create-talorys@latest doctor
```

## Installation

**The browser login does not open / times out.** Copy the URL Wrangler prints
into a browser. In SSH or containers, set `CLOUDFLARE_API_TOKEN` instead.

**"Multiple Cloudflare accounts are available."** Pass `--account-id <id>` in
non-interactive mode.

**"…lacks a required permission."** You need to be able to edit Workers and
Pages in the chosen account (see [deployment.md](deployment.md#permissions)).

**"The deployment did not pass its health checks yet."** New `pages.dev` sites
can take a few minutes to get DNS and certificates. Re-run the same command;
it resumes without duplicating anything.

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
directory. Stop stray `wrangler` processes; the dev scripts use separate
directories for the Worker and Pages.

**Port already in use** — stop other dev servers on 5173, 8787 or 8788.

## MCP servers

Open Settings → Tools to check a server's status, test the connection or refresh its tools. Discovery failures retain the server so you can replace credentials and retry. Secrets are never prefilled; use “Secret set · Replace” or clear authentication. Upstream failures show a generic error to avoid leaking headers.

A tool marked unsupported schema or name conflict is unavailable. Input schemas must fit 8 KiB and convert to Zod; provider names must be unique and fit 64 characters. Missing tools are no longer exposed. Changed schemas reset policy to Ask me first. Disabled servers and Off tools cannot run.

If approval reports a changed target, propose the call again after reviewing the current server configuration. Call limits can be adjusted within the displayed ceilings. MCP tools work only in interactive chat, and MCP servers must be re-added after restoring a backup.
