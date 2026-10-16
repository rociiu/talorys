# Remote access

Machine clients can call your private Talorys install with a **personal access token** (PAT). Tokens are named, scoped (`read` or `write`), shown once at creation, stored only as hashes, and revoked from Settings.

This is **not** an MCP server. CORS stays closed: use a server-side client (`curl`, Home Assistant, a CLI, a cron job). Browsers on other origins cannot call these routes.

Cookie + CSRF session access already works for the owner UI and for scripted session clients. Remote access adds **named, scoped, revocable** personal access tokens so an integration does not need the full owner session.

## Turning it on and creating a token

1. Open **Settings → Security → Remote access**.
2. Turn **Remote access** on (off by default).
3. Enter a name (1–64 characters), leave scope at **`read`** unless you need writes, then **Generate token**.
4. **Copy the token immediately.** It starts with `tal_` and is shown only once. Closing the panel loses the plaintext forever. The panel also shows a ready-to-run `curl` example for your install.
5. Store it in your client’s secret store (not in git, chat, or CI logs).

Admin routes (`/api/remote/*`) require the browser session and CSRF header. Tokens cannot manage other tokens.

## Scopes

| Scope | Allowed |
| --- | --- |
| `read` (default) | `GET` / `HEAD` on the allowlist only. Writes return **403**. |
| `write` | Everything `read` can do, plus `POST` / `PATCH` / `DELETE` on allowlisted collections. **Owner-level** on that surface: replace content and delete. |

Named tokens are the least-privilege knob (`home-assistant` = read, `voice-capture` = write). There is no third “capture” scope in v1.

## Allowlist

Default deny. A Bearer token may call only these method + pathname pairs (matched as sent; no decoding of percent-encoding or trailing slashes into an allowed route):

| Method | Path |
| --- | --- |
| `GET` | `/api/health` |
| `GET` | `/api/semantic/search` |
| `GET`, `POST` | `/api/tasks`, `/api/notes`, `/api/automations`, `/api/memories` |
| `GET`, `PATCH`, `DELETE` | `/api/tasks/:id`, `/api/notes/:id`, `/api/automations/:id`, `/api/memories/:id` |

`:id` must be a UUID. Path segments that are always denied even if they look like an id: `reviews`, `history`, `correct`, `status`, `notifications`, `import`, `export`.

### Deny summary

Anything else returns **403** for a valid token (or **401** if the token is bad / feature off), including: chat, settings, projects, import/export, password, push, `/api/remote/*`, `/api/memories/reviews`, semantic reindex, and every other owner route.

### D13 — automation kinds

With Bearer `write` you may create / edit / enable / reschedule **`reminder`** and **`task_digest` only**. Creating or changing an **`agent_prompt`** automation returns **403** (“Access tokens cannot create or change AI prompt automations.”). Deleting any automation (including `agent_prompt`) is allowed. The cookie UI is unchanged.

## Requests

```http
Authorization: Bearer <token>
Content-Type: application/json
```

No `x-talorys-request` CSRF header. No cookies required. JSON request and response bodies match the existing `/api` handlers.

Auth ordering: if `Authorization` is present, it must be a valid Bearer token. An invalid or revoked token is **401** and never falls through to a session cookie.

## Dates

- Task `due_at`: ISO-8601 with offset (or as the tasks API already accepts).
- One-time automation schedules use **local wall-clock** in the owner timezone (`Settings` → timezone).
- “Today” for digests: use the today bounds from `GET /api/tasks?view=today` and the `timezone` field on `GET /api/automations`.

## Errors

| Status | Meaning |
| --- | --- |
| 200 / 201 | Success (create often 201). |
| 400 | Validation / bad body or query. |
| 401 | Missing, invalid, or revoked Bearer, or Remote access turned off (tokens suspended). |
| 403 | Scope mismatch, route not on allowlist, D13 `agent_prompt` deny, create while off or at max tokens. |
| 404 | Unknown id. |
| 409 | Semantic recall disabled on search; other handler conflicts as today. |
| 429 | Soft per-token rate limit or failed-Bearer throttle; honor `Retry-After` when present. |
| 5xx | Server / Durable Object error. |

## List caps and truncation

**One successful list response is not all records.** Clients must not assume completeness. There is no pagination redesign in v1.

| Resource | Cap |
| --- | --- |
| Tasks | Default **200**, max **500** (`limit` query). |
| Notes | Default **500**; with `q`, search defaults to **50**. |
| Memories | Default **500**; with `q`, search defaults to **100**. |
| Automations | Full list in one response (plus recent runs metadata). |

## Search contract

`GET /api/semantic/search?q=…`

- Omit `types` → **memory hits only**.
- `types` is a comma list from `memory`, `task`, `note`, `automation` (and any other types the handler accepts).
- `limit` default **10**, capped at **50** (applied per type when types are listed; results are concatenated).
- Semantic recall **off** → **409**. Clients must handle that; there is no special “keyword while off” mode for remote.
- Hits are thin (ids / scores / short fields). Follow up with `GET /api/…/:id` for full bodies.
- Completed tasks and inactive automations are **not** filtered out of item search.

## Rate limits and max tokens

| Limit | Value |
| --- | --- |
| Max tokens per install | **20** (`MAX_REMOTE_TOKENS`). Create returns **403** at the cap. |
| Soft per-token requests | **120** per **60s** window. Counted in Durable Object memory, so the window resets when the DO restarts (cold start / eviction) as well as when the minute elapses. |
| Failed Bearer attempts | **10** per client IP in **15 minutes**, then **429** even with a correct token. The client key is `CF-Connecting-IP` (IPv6 grouped by **/64**), so another host on the same /64 or NAT can lock out a legitimate token for up to 15 minutes. Separate from browser login lockout. |

Write mutations are attributed in the activity log in a **coalesced** way: at most one `remote.request` row per token per 15-minute window; full write volume is kept in a per-token daily counter so a busy automation cannot flush owner history out of the 1000-row activity log.

## Credential lifecycle

| Event | Effect |
| --- | --- |
| Revoke one | Hash deleted; Bearer **401** immediately. |
| Revoke all | Every token deleted; Bearer **401**. |
| Password change (UI) | All remote tokens revoked. |
| CLI `reset-password` | All remote tokens revoked (with sessions). |
| `SESSION_SECRET` rotation | Stored hashes no longer verify; regenerate tokens. |
| Feature off | Bearer always **401**. Tokens **remain stored but suspended** until turned on again. Create disabled; list + revoke (+ revoke all) still work in the UI. |
| Backups | Token rows are **not** included. Restoring a backup **never** enables Remote access or resurrects tokens. |

## Four scenes

Placeholders: `$TALORYS_URL` (origin, no trailing slash) and `$TALORYS_TOKEN` (plaintext PAT). Never commit or log the token.

### Scene 1 — Home Assistant read

Read-only token. List automations and search for one by meaning (filter kinds/names client-side).

```bash
curl -sS -H "Authorization: Bearer $TALORYS_TOKEN" \
  "$TALORYS_URL/api/automations"

curl -sS -H "Authorization: Bearer $TALORYS_TOKEN" \
  "$TALORYS_URL/api/semantic/search?q=trash&types=automation"
```

A **409** on search means semantic recall is off — use the automations list and filter locally.

### Scene 2 — CLI note patch

Write token. Patch an existing note by id.

```bash
curl -sS -X PATCH \
  -H "Authorization: Bearer $TALORYS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"Updated from CLI"}' \
  "$TALORYS_URL/api/notes/<note-id>"
```

### Scene 3 — Voice capture

Write token. Create a task; dedupe retries client-side (no server idempotency keys in v1).

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $TALORYS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Pick up dry cleaning"}' \
  "$TALORYS_URL/api/tasks"
```

### Scene 4 — Morning digest

Read token. Today’s tasks plus automations whose `next_run` falls in today (compare using the response `timezone` and today’s bounds).

```bash
curl -sS -H "Authorization: Bearer $TALORYS_TOKEN" \
  "$TALORYS_URL/api/tasks?view=today"

curl -sS -H "Authorization: Bearer $TALORYS_TOKEN" \
  "$TALORYS_URL/api/automations"
```

## Smoke script

Dependency-free check (Node ≥ 22):

```bash
TALORYS_URL="$TALORYS_URL" TALORYS_TOKEN="$TALORYS_TOKEN" \
  node scripts/remote-smoke.mjs
```

Modes:

- default — create a throwaway task, get/list/search, delete it
- `--read-only` — lists + search; asserts `POST` → 403
- `--expect-revoked` — asserts `GET /api/tasks` → 401

Prints only `ok <step>` / `FAIL <step>: <status>` lines — never the token. Exit **2** if env is missing.
