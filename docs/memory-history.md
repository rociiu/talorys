# Memory history

Personal facts change. Memory history lets Talorys keep up:

- When you say "I sold my Volkswagen and bought a Tesla", the Tesla becomes
  current and the Volkswagen is kept as a **past fact**. Ask "What car do I
  drive?" and you get the Tesla; ask "What did I drive before?" and the
  Volkswagen is still there.
- When two memories *might* conflict but it isn't clear ("I live in Paris" after
  "I live in London"), Talorys keeps both and asks you on the Memory page.
- Nothing is silently overwritten, and nothing is deleted unless you ask.

It works with keyword recall and with [semantic recall](semantic-recall.md),
uses no AI by default, and needs no extra Cloudflare service.

## Statuses

Every memory has a status:

- **Current** — what Talorys treats as true now.
- **Historical** ("Past") — was true before; kept for questions about the past.
- **Unsure** — flagged as possibly outdated.

Memories that existed before this feature are all current.

## How changes are detected

When you save or edit a memory (on the Memory page, or when Talorys uses the
`remember` / `update_memory` tools in chat), Talorys looks for related current
memories — ones sharing words, or about the same single-valued topic (where you
live, your car, your job, your diet, your relationship) — and decides:

| New memory vs. old | Example | Result |
| --- | --- | --- |
| Explicit replacement | "I moved from London to New York" vs. "I live in London" | Old becomes past, linked to the new one |
| Explicit change of a one-value topic | "I moved permanently to Paris" vs. "I live in London" | Old becomes past |
| More detailed version | "Prefers green tea in the morning with honey" vs. "Prefers green tea in the morning" | Old becomes past |
| Same topic, unclear | "I live in Paris" vs. "I live in London" | **Both kept**; shown under *Needs review* |
| Addition / unrelated | "I visited Paris" vs. "I live in London" | Nothing changes |

Automatic changes need explicit wording ("sold", "moved", "no longer",
"replaced", …) and are always reversible: **Restore as current** undoes them.
Detection only runs when a memory is written, never on every chat message.

When Talorys rewords a memory with `update_memory`, the new wording is saved as a
new memory and the old one becomes a past fact linked to it, the same as
**Correct** on the Memory page, so the agent can never erase what you told it.

Dates are only recorded when you state them ("since 2024", "in March 2025",
"as of 2026-02-01"). Talorys never treats the save time as the date a fact
became true.

### Optional AI double-check

**Settings → AI → Memory history → Double-check conflicts with AI** (off by
default) asks the chat model about *unclear* cases only, at most once per save,
counted against your daily AI request limit. It can dismiss a false alarm or
explain one; it can never replace or delete a memory, and its answer is
validated before use.

Turning off **Memory conflict review** disables detection entirely; memories
are then saved exactly as before.

## Reviewing conflicts

On the **Memory** page, *Possible conflicts* shows the newer and older memory
side by side:

- **Keep both** — both stay current.
- **Mark older as past** — the older one becomes history.
- **Replace older** — the older one is permanently deleted.
- **Discard newer** — the newer one is permanently deleted.

## Managing memories

Use the filters **All · Current · Historical · Needs review**. For each memory:

- **Update this fact** (↻) — something changed: save the new version and keep
  the old one as history.
- **Edit** (✎) — fix a typo in place (no history).
- **Mark as past / Restore as current**.
- **History** (🕒) — "Current: … / Previously: …".
- **Delete** — permanent.

## What the AI sees

Each chat turn includes a small set of relevant memories (at most 8, within 20%
of **Max context tokens** and never more than 1,500 tokens), in labelled
sections: *current*, *possibly outdated*, and *historical — not current*. Each
is marked as data, not instructions. Past facts are only included when your
question is about the past ("before", "previously", "used to", "did I…"), along
with what replaced them.

With [semantic recall](semantic-recall.md) on, the same rules apply to the
meaning-based results: past facts are left out of present-tense questions.

## Backups

- Backups include each memory's status, dates and "replaced by" link. The
  backup format version is unchanged (v1); older Talorys versions ignore the new
  fields.
- Older backups import unchanged; their memories become current.
- Imported links are checked: links to missing memories, self-links and cycles
  are dropped.
- Importing is idempotent, and a memory you edited after the backup was made is
  not overwritten by the older copy.
- Pending conflict reviews are not part of backups.

## Deleting

Deleting a memory removes the memory, its full-text index entry, its semantic
vector (if any), any conflict reviews, links from other memories, and the
activity-log line that quoted it. History never brings deleted data back. A
memory that the deleted one had replaced stays historical; you can restore it.

## Known limitations

- Change detection uses English wording rules and a handful of topics. Other
  changes are kept side by side or flagged for review rather than replaced.
- "Questions about the past" are detected from English wording.
- Without semantic recall, a question about the past only finds old facts that
  share words with it (plus earlier versions of what it finds).
