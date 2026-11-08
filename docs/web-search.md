# Web search

Talorys can look things up on the public web in chat ("is the museum open on
Monday?", "what's new in Node 24?") through a built-in `web_search` tool. It is
**off by default**. While it is off, there is no tool, the prompt still says
Talorys can't browse the web, and nothing is sent anywhere.

## Providers

| Provider | Secret | Free allowance (check the provider's pricing) |
|---|---|---|
| [Tavily](https://tavily.com) | `TAVILY_API_KEY` | 1,000 credits a month, no card |
| [Exa](https://exa.ai) | `EXA_API_KEY` | Monthly free credits |

Both are third-party services with their own terms and privacy policies. Their
free allowances aren't part of Cloudflare's free plan, and Talorys never
switches you to a paid plan.

## Turning it on

1. Create an API key with the provider.
2. Store it as a Worker secret (it takes effect right away):

   ```bash
   npx wrangler secret put TAVILY_API_KEY   # or EXA_API_KEY; add -c wrangler.standalone.jsonc for a one-Worker deploy
   ```

3. In **Settings → Integrations → Web search**, pick the provider. A provider
   without a key can't be selected.
4. Choose what happens before each search:
   - **Ask me first** (default): the query appears on an approval card and is
     sent only after you approve it. The results reach the model on your next
     message, so reply (for example "go on") after approving.
   - **Search without asking**: searches run at once and appear in the chat's
     tool activity.

To turn it off, pick **Off**. To remove a key, run
`npx wrangler secret delete TAVILY_API_KEY`.

## What is sent and returned

- Only the query, with fixed options, goes to one fixed endpoint
  (`https://api.tavily.com/search` or `https://api.exa.ai/search`). The tool
  never opens pages, so the model can't make the Worker request a URL of its
  choosing.
- Up to 5 results come back as a title, link, short excerpt (500 characters)
  and, when known, a date. Only http(s) links are kept.
- At most 2 searches per chat turn, within the usual tool-call limit. Scheduled
  routines never search.
- The activity log records the provider and the outcome, not the query.

## Privacy

A search query leaves your account. The tool description and system prompt
tell the model to write short, general queries without your name, notes,
memories or other personal details, but a model can still get this wrong,
especially if a note or a search result contains instructions meant to trick
it. That is why the default asks before each search. See
[security.md](security.md#web-search).

A backup import never changes this setting, and keys are never exported.
