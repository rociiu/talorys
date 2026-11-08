# Changelog

All notable changes to Talorys are listed here. Versions match the `create-talorys` package.

## Unreleased

### Added

- **Chat alerts**: a system notification when a reply finishes or needs approval while the window is out of focus
- A notification when a scheduled automation fails, sent once until it succeeds again
- **Web search (optional)**: a built-in `web_search` tool in chat backed by Tavily or Exa, with your own key as a Worker secret (`TAVILY_API_KEY` or `EXA_API_KEY`). Off by default (Settings → Integrations). Each query asks for approval unless you choose otherwise, only the query is sent, it's never used by scheduled routines, and a backup import can't turn it on. See [docs/web-search.md](docs/web-search.md).

### Fixed

- A chat message that never reached the server goes back to the composer instead of being lost, and Retry only appears when there's something to retry
- A reply generating in one conversation no longer replaces Send with Stop in the others, where Stop cancelled the wrong reply
- A failed page load or render shows a way to reload instead of a blank screen, and a tab left open across an update reloads itself
- Note autosave backs off when saves fail, with one "Couldn't save" status instead of a stream of errors
- The note's project picker no longer collapses to a blank box, and automation names are no longer cut to a few letters on phones
- Connection failures read "Can't reach Talorys" instead of "Failed to fetch"
- `create-talorys reset-password` now clears a login lockout, as the docs said it did, and `Retry-After` reflects the client's own failures

### Changed

- Accessibility: higher contrast for secondary text, warning and success colors and off switches; finished replies are announced to screen readers; dialogs have names; the conversation menu closes on Escape or a press elsewhere; Copy stays visible when focused; browser tabs are titled after what's open
- `GET /api/health` shows the exact version and schema only to a signed-in session or access token
- Importing a backup no longer changes the agent name, which goes into the system prompt

## 0.1.8 — 2026-11-03

### Added

- **Korean** as the second interface language, with the web UI translated (#64, #76, #77, #79, #83, #93)

- **AI task planning.** Ask Talorys to plan a goal ("Help me prepare for my trip to Japan") and it proposes a structured plan as a card in chat: tasks with priorities, optional due dates (suggested dates are marked as suggestions) and an optional existing or new project. You can edit titles, descriptions, priorities and dates, remove tasks or change the project, then confirm or cancel. Nothing is created until you confirm; confirming creates every task (and the new project) in one transaction, at most once, even if the button is pressed twice or in two tabs. Plans expire after 24 hours, survive reloads, and use no extra AI requests for editing or confirming.

- **Remote MCP servers.** Connect remote MCP servers (Streamable HTTP, with no authentication, a bearer token, or OAuth sign-in with PKCE and dynamic client registration) in Settings → Integrations and choose which of their tools Talorys may use in chat. Tools start off; each enabled tool either asks for your approval on every call (the default) or runs without asking. Calls share the chat's tool limits, are never made by scheduled routines, and send only the call's arguments to the server. Tokens are stored encrypted. See [docs/mcp.md](docs/mcp.md).

### Changed

- A new one-off reminder defaults to 9:00 tomorrow, and the empty chat greets you for the hour, both in your timezone (#100, #101)
- Code blocks show the full language name (#97)
- Dependency updates (#74, #75, #105, #106)

### Fixed

- Importing a backup keeps newer local edits to tasks, notes and projects, and a conversation renamed after the backup was made (#96, #104)
- A checkbox inside a code sample or fenced block no longer becomes a task (#69, #90)
- Only the clicked nested task is toggled (#95)
- An in-progress task is not listed under both today and upcoming (#99)
- A past time is rounded the same way as the same time ahead (#98)
- A monthly schedule says when it falls back to the last day of shorter months (#71)
- A one-off automation whose time passes after a timezone change is paused (#87)
- Approval cards stay accurate after pending actions are pruned (#81)
- Editing a memory deletes its old activity line (#88)
- Each IPv4-mapped client keeps its own login limit (#89)
- A family emoji is not split when a conversation title is cut (#91)
- An unlabeled provider key is redacted in installer output (#92)

### Upgrading

- Migration 12 adds the `tal_mcp_servers` and `tal_mcp_tools` tables and a `result` column on pending actions. `npx create-talorys@latest update` adds the new `MCP_CREDENTIAL_KEY` secret; without it, only MCP servers without authentication can be added. Backups include MCP server names and URLs (never tokens); imported servers arrive turned off.
- Migration 11 adds the `tal_task_plan_drafts` table. Existing data is untouched. Plan drafts are not included in backups, and plan cards in imported conversations are dropped, like approval cards.

## 0.1.7 — 2026-10-19

### Added

- Personal access tokens, so external tools and other AI assistants can use your Talorys (#60)
- Notifications are delivered as Web Push (#28)
- Chat finds tasks, notes and automations by meaning, not only by exact words (#50, #53)
- Automations can be edited after they are created (#52)
- Better automation scheduling and a run history (#63)
- Memory conflicts can be decided with Clef; without Clef they go to review (#22, #41)
- Token provenance tracking and model-specific estimates of AI consumption (#30)
- A project website on GitHub Pages, linked from the README, and an Install with Appflare button (#23, #47, #48)

### Fixed

- Automation runs no longer overlap or get stuck (#65)
- Rescheduling an automation to a time that has passed is rejected (#56)
- Reminder and AI automation messages stay required when editing (#55)
- Weekly schedules are described without repeated weekdays (#54)
- Impossible dates in offset timestamps are rejected (#66)
- A task is resolved by its exact title before partial matches (#59)
- Notes searches keep the project filter (#67)
- Truncated conversation titles and reminder names no longer split an emoji (#68)
- Project names stay visible in the Projects dialog (#49)
- The layout stays steady when a text field takes focus on a phone (#38)
- Follow-ups from the release audit for push and automations (#72)

### Security

- Installer error details redact bearer tokens and quoted values (#57)
- A malformed session cookie is treated as signed out (#58)
- Request bodies stop being read as soon as they pass the size limit (#40)
- The owner can still sign in during a distributed attack; IPv6 addresses are grouped by /64 (#39)
- Notification clicks stay on the app's own origin (#36)

### Upgrading

- A `.dev.vars` created before push existed gets Web Push keys added automatically (#37)
