# create-talorys

Deploy [Talorys](https://github.com/rociiu/talorys) — a private, single-user AI
agent — into **your own Cloudflare account** with one command:

```bash
npx create-talorys@latest
```

The installer signs you in to Cloudflare (browser OAuth), asks for an agent name
and an owner password, then deploys a private Worker with a SQLite Durable
Object, configures secrets, deploys the Cloudflare Pages frontend with a service
binding, verifies the live deployment and prints your `pages.dev` URL.

It ships its own Wrangler and prebuilt artifacts, so no build tools are needed.

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

Installer error details mask Authorization headers and token/key values, including
quoted values with escaped quotes.

MIT licensed.
