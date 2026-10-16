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

### UI text and languages

UI text lives in `apps/web/src/lib/i18n/en.ts`. Components read it through
`useI18n()`: `t("key")` for plain strings and attributes, `rich("key", {...})`
when a parameter is an element such as `<code>`. Placeholders are written as
`{name}` and their names are type-checked against the English text. A plural
message is an object keyed by `Intl.PluralRules` categories (`one`, `few`,
`many`, `other`, ...) and takes `{count}`.

Pass `locale` from `useI18n()` to `formatDateTime`, `relativeTime`,
`toLocaleString` and other display formatters. With the default "Browser
default" language it is the browser's locale, so nothing changes for owners who
never pick a language.

To add a language:

1. Add its code to `LANGUAGES` in `packages/shared/src/constants.ts`.
2. Create `apps/web/src/lib/i18n/<code>.ts` exporting an object that
   `satisfies Translation`. Keys missing from it fall back to English; keys
   that don't exist in English are a type error.
3. Register it in `translations` in `apps/web/src/lib/i18n/core.ts` and add its
   name, in that language, to `LANGUAGE_NAMES` in `apps/web/src/lib/i18n/index.tsx`.

Text generated on the server stays in English for now: reminder, digest and
push notifications, and API error messages. The agent's system prompt and tool
descriptions are not translated; the model answers in the language the owner
writes in.

### Adding a migration

Append to `MIGRATIONS` in `apps/agent/src/db/migrations.ts` with the next
version. Never edit existing entries or drop owner data.
