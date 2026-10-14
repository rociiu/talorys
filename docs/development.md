# Development

```bash
npm install
npm run dev
```

| Process | Port | Purpose |
| --- | --- | --- |
| `wrangler dev --local` (apps/agent) | 8787 | Agent Worker + Durable Object (state in `.wrangler/state`) |
| `wrangler pages dev` (apps/web) | 8788 | Real Pages Function + `AGENT` service binding |
| Vite | 5173 | UI with HMR; proxies `/api` to 8788 |

`scripts/dev-setup.mjs` creates `apps/agent/.dev.vars` (git-ignored) with
`TALORYS_ENV=development`, the mock AI provider, a local password hash and a
session secret and a Web Push key pair (browsers allow push on `localhost`). Set `TALORYS_DEV_PASSWORD` before the first run to choose the
password, or delete the file to regenerate. A file made before push existed gets a
Web Push key pair added on the next run; nothing else in it changes.

### Real Workers AI locally

```bash
npx wrangler login
npm run dev:remote-ai -w @talorys/agent   # instead of dev:agent
```

### Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Web build, Worker bundle (dry run), CLI + templates |
| `npm test` | Shared, agent (inside workerd), Pages Function and installer tests |
| `npm run test:e2e` | Playwright UI tests on an isolated local stack |
| `npm run test:pack` | `npm pack` the installer and run it outside the monorepo |
| `npm run test:smoke` | Optional real Cloudflare deployment test |
| `npm run typecheck` | TypeScript across all workspaces |
| `npm run lint` | Biome |

### Mock AI intents

`remember …`, `add task …`, `add note …`, `complete task …`, `list tasks`,
`remind me in N minutes to …`, `search …`. Anything else gets an echo reply.

### Semantic recall

With the mock AI provider (or demo mode), [semantic recall](semantic-recall.md)
uses the mock embedder instead of Workers AI: a deterministic hashed bag of
words plus a small concept table (car/tesla/oil, vegetarian/dinner,
peanut/allergic, city/denver, heights/mountains/knee). It exercises the full
code path offline but does not produce real semantic similarity. The Settings
card shows "Mock (local dev)" as the embedder. Use `dev:remote-ai` to try real
embeddings.

### Adding a tool

1. Create `apps/agent/src/tools/<name>.ts` with `defineTool({...})` entries.
2. Register them in `apps/agent/src/tools/index.ts`.
3. Add tests in `apps/agent/test/`.

### Adding a migration

Append to `MIGRATIONS` in `apps/agent/src/db/migrations.ts` with the next
version. Never edit existing entries or drop owner data.
