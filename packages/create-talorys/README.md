# create-talorys

Deploy [Talorys](https://github.com/rociiu/talorys) — a private, single-user AI
agent — into **your own Cloudflare account** with one command:

```bash
npx create-talorys@latest
```

The installer signs you in to Cloudflare (browser OAuth), asks for an agent name
and an owner password, then deploys a single Worker that serves the web app and
the API with a SQLite Durable Object, configures secrets, verifies the live
deployment and prints your `workers.dev` URL.

It ships Cloudflare's [`cf`](https://www.npmjs.com/package/cf) CLI and prebuilt artifacts, so no build tools are needed.

| Chat | Tasks |
| --- | --- |
| ![Chat](https://raw.githubusercontent.com/rociiu/talorys/main/docs/screenshots/chat.png) | ![Tasks](https://raw.githubusercontent.com/rociiu/talorys/main/docs/screenshots/tasks.png) |
| **Memory** | **Automations** |
| ![Memory](https://raw.githubusercontent.com/rociiu/talorys/main/docs/screenshots/memory.png) | ![Automations](https://raw.githubusercontent.com/rociiu/talorys/main/docs/screenshots/automations.png) |

## Commands

| Command | Description |
| --- | --- |
| `npx create-talorys@latest [dir]` | Install, or safely resume an interrupted install |
| `npx create-talorys@latest update` | Update an existing installation (keeps all data) |
| `npx create-talorys@latest status` | Show deployment info and health |
| `npx create-talorys@latest doctor` | Diagnose common problems |
| `npx create-talorys@latest reset-password` | Set a new owner password (signs out all devices) |

Options: `--dir <path>`, `--account-id <id>`, `--name <agent name>`, `--yes`.
Environment: `TALORYS_OWNER_PASSWORD` (non-interactive), `CLOUDFLARE_API_TOKEN`.

Re-running is idempotent: existing resources are reconciled, existing passwords
are kept, and data is never deleted. The local `talorys.json` manifest contains
no secrets.

Installed with 0.1.x (Pages project + private Worker)? `update` migrates you
to one Worker deployed with `cf`, keeping all data; you then delete the old
Pages project yourself. See the
[migration guide](https://github.com/rociiu/talorys/blob/main/docs/migrating-to-a-single-worker.md).

MIT licensed.
