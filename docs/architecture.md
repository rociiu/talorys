# Architecture

## Components

| Component | Location | Runs on |
| --- | --- | --- |
| Web app (React, Vite, Tailwind, TanStack Query, React Router) | `apps/web/src` | Cloudflare Pages (static) |
| API proxy | `apps/web/functions/api/[[path]].ts` | Pages Function |
| Agent Worker (Hono API + `TalorysAgent`) | `apps/agent/src` | Cloudflare Workers + Durable Objects |
| Shared schemas, recurrence, crypto | `packages/shared` | Bundled into all of the above |
| Installer | `packages/create-talorys` | The owner's machine (Node.js) |

## Request flow

1. The browser loads static assets from `https://<project>.pages.dev`.
2. Calls to `/api/*` (same origin, cookie auth) invoke the Pages Function.
3. The function forwards the **original request** to `env.AGENT.fetch(request)` —
   a service binding to the private Worker. URL, method, headers and body are
   preserved, so the Worker can validate `Origin`. Responses (including SSE
   streams) are returned without buffering.
4. The Worker forwards `/api/*` to `getAgentByName(env.TalorysAgent, "personal-agent")`.
   The instance name is fixed server-side; clients cannot address other agents.
   WebSocket upgrades are refused (the app uses HTTP + SSE only).
5. `TalorysAgent.onRequest` runs the Hono app next to its SQLite database.

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
  Memories come from keyword recall (`agent/memory.ts`) or, when enabled,
  semantic recall (`semantic/`), then are labelled current / unsure / past and
  kept within a token budget of 20% of the context limit (max 1,500 tokens).

## Memory history

`apps/agent/src/memory/` — see [memory-history.md](memory-history.md) for the
user-facing description.

| Module | Responsibility |
| --- | --- |
| `conflict.ts` | Deterministic relationship rules; optional Clef (Workers AI decision model) check: request, response validation, decision |
| `lifecycle.ts` | Supersede / status changes / history / review resolution; cycle prevention; stated-date extraction |
| `intent.ts` | Detects questions about the past |
| `service.ts` | `MemoryHistoryService`: write paths, conflict pipeline, complete deletion (incl. semantic vectors), prompt labels |

Write paths (`POST/PATCH /api/memories`, `/correct`, the `remember` and
`update_memory` tools) save the memory first, then run conflict detection. It
never runs per chat message and uses no AI unless the owner enables the
AI conflict check. Then rule hits and semantically similar memories
(`semantic/neighbors.ts`) only nominate, and one Clef call per save decides. Both recall paths leave past (`historical`) memories out unless
the question is about the past; then earlier versions of the recalled facts are
added.

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
duplicate-call (loop) detection, owner approval for destructive actions
(bound to a hash of the target as it was proposed), and read-only access for
scheduled runs. Tools only use the service layer — no
shell, code execution, network or credentials.

## Data model

`tal_settings`, `tal_conversations`, `tal_messages`, `tal_memories`,
`tal_projects`, `tal_tasks`, `tal_notes`, `tal_automations`,
`tal_automation_runs`, `tal_notifications`, `tal_activity`, `tal_sessions`,
`tal_login_attempts`, `tal_usage_daily`, `tal_memory_reviews`, plus FTS tables. Migration 3 added `tal_messages.source` (chat or import); migration 4 added memory lifecycle
columns (`status`, `superseded_by`, `valid_from`, `valid_until`) and the
`tal_memory_reviews` table; existing memories default to `active`.

## Free-tier choices

No KV/D1/R2/Vectorize/Workflows. One Durable Object holds everything. Static
assets are served without invoking Functions (Pages routes only `/api/*` to the
function). Reminders and digests are deterministic. Chat context is bounded and
summarized only after enough history overflows.
