# Architecture

## Components

| Component | Location | Runs on |
| --- | --- | --- |
| Web app (React, Vite, Tailwind, TanStack Query, React Router) | `apps/web/src` | Workers Static Assets of the Talorys Worker |
| Talorys Worker (Hono API + `TalorysAgent`) | `apps/agent/src` | Cloudflare Workers + Durable Objects |
| Shared schemas, recurrence, crypto | `packages/shared` | Bundled into all of the above |
| Installer | `packages/create-talorys` | The owner's machine (Node.js); deploys with the bundled `cf` CLI |

## Request flow

One Worker serves everything at `https://<worker>.<subdomain>.workers.dev`.
Its config declares the built web app as static assets (shown here as in
`apps/agent/wrangler.jsonc`; the installer generates the same settings for
`cf`):

```jsonc
"assets": {
  "directory": "../web/dist",
  "not_found_handling": "single-page-application",
  "run_worker_first": ["/api/*"]
}
```

1. The browser requests the app. Cloudflare serves matching files from the
   asset store directly, with the headers from `_headers` (CSP, HSTS, caching),
   without invoking the Worker. Unknown paths (client-side routes such as
   `/tasks`) get `index.html`.
2. Calls to `/api/*` (same origin, cookie auth) run the Worker's `fetch`
   handler, because `run_worker_first` routes them past the asset store.
3. The Worker forwards `/api/*` to `getAgentByName(env.TalorysAgent, "personal-agent")`.
   The instance name is fixed server-side; clients cannot address other agents.
   WebSocket upgrades are refused (the app uses HTTP + SSE only).
4. `TalorysAgent.onRequest` runs the Hono app next to its SQLite database.
   Responses, including SSE chat streams, are returned without buffering.

## TalorysAgent

`apps/agent/src/agent/talorys-agent.ts` extends the Agents SDK `Agent` class.

- **Storage**: Durable Object SQLite via `ctx.storage.sql`, wrapped by
  `db/database.ts` and per-entity repositories in `db/repositories/`. Talorys
  tables are prefixed `tal_` and never touch the SDK's `cf_agents_*` tables.
- **Migrations**: `db/migrations.ts` — versioned, append-only, each applied in a
  transaction with its version bump. Run lazily on first use after every deploy.
- **Full-text search**: FTS5 external-content indexes for memories and notes,
  kept in sync with triggers. Tasks and conversations use escaped `LIKE`.
- **Scheduling**: each enabled automation owns exactly one pending one-shot SDK
  schedule (`this.schedule(date, "runAutomation", { automationId })`). When it
  fires, `AutomationService.fire` runs it, records the run, and computes the next
  occurrence in the owner's timezone. `onStart` reconciles lost or interrupted
  schedules (a run missed by < 24 h executes once). Finishing an active run
  preserves owner pauses, deletions and replacement schedules; duplicate callbacks
  do not execute again while that run is active.
- **Agent turns**: `agent/runner.ts` builds context (system prompt, relevant
  memories, running summary, recent history within the token budget), calls the
  provider with tools, streams events, persists the result and records usage.

## AI provider abstraction

`ai/provider.ts` defines `AIProvider` (`generate`, `stream`, `generateWithTools`).

- `CloudflareWorkersAIProvider` (`ai/workers-ai.ts`) uses the AI SDK with the
  official `workers-ai-provider`. Reasoning ("thinking") is disabled to save
  Neurons. On the final allowed step, or once the tool budget is spent,
  `toolChoice: "none"` forces a text answer.
- `MockAIProvider` (`ai/mock.ts`) is deterministic, used for local development,
  tests and the opt-in Demo mode. It routes simple intents through the real tool
  pipeline.

Adding a provider (OpenRouter, Gemini, …) means implementing `AIProvider` and
selecting it in `TalorysAgent.aiProvider()`.

## Tools

Tools live in `apps/agent/src/tools/` and are registered in `tools/index.ts`.
Each has a unique name, description, Zod input schema, permission
(`read` | `write` | `destructive`), per-turn cap, UI label and typed result.
`ToolExecutor` enforces validation, the global call budget, per-tool caps,
duplicate-call (loop) detection, explicit confirmation for destructive actions,
and read-only access for scheduled runs. Tools only use the service layer — no
shell, code execution, network or credentials.

## Data model

`tal_settings`, `tal_conversations`, `tal_messages`, `tal_memories`,
`tal_projects`, `tal_tasks`, `tal_notes`, `tal_automations`,
`tal_automation_runs`, `tal_notifications`, `tal_activity`, `tal_sessions`,
`tal_login_attempts`, `tal_usage_daily`, plus FTS tables.

## Free-tier choices

No KV/D1/R2/Vectorize/Workflows. One Worker, one Durable Object. Static asset
requests are free and never invoke the Worker; only `/api/*` counts against the
Workers request allowance, once per call. Reminders and digests are deterministic. Chat context is bounded and
summarized only after enough history overflows.
