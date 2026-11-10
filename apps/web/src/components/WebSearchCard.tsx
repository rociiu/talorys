import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { GITHUB_URL, type Settings, type WebSearchPolicy, type WebSearchSettings } from "@talorys/shared";
import { Card, ErrorNotice, Select } from "./ui";
import { keys, useApiMutation, useWebSearchStatus } from "../hooks/queries";
import { api } from "../lib/api";

const DOCS_URL = `${GITHUB_URL}/blob/main/docs/web-search.md`;

const AUTO_WARNING =
  "Searches run without asking. Talorys tells the model to keep personal details out of queries, but it can't guarantee that, so you'll only see what was sent afterwards in the chat.";

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-5 text-fg-subtle">{hint}</div>}
      </div>
      {children && <div className="shrink-0 sm:w-64">{children}</div>}
    </div>
  );
}

/** Settings → Integrations: the built-in web search, off until the owner picks a provider with a key. */
export function WebSearchCard({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const status = useWebSearchStatus();
  const save = useApiMutation(
    (webSearch: Partial<WebSearchSettings>) => api<{ settings: Settings }>("/settings", { method: "PATCH", body: { webSearch } }),
    { success: "Settings saved", onSuccess: (r) => qc.setQueryData(keys.settings, r.settings) },
  );
  const ws = settings.webSearch;
  const providers = status.data?.providers ?? [];
  const missing = providers.filter((p) => !p.configured);

  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-medium uppercase tracking-wider text-fg-subtle">Web search</h2>
      <Card>
        <div className="divide-y divide-border">
          {status.error ? (
            <div className="px-5 py-4">
              <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />
            </div>
          ) : (
            <>
              <Row
                label="Search provider"
                hint={
                  <>
                    Lets Talorys look things up on the web in chat, never in scheduled routines. Only the query is sent to the provider, and
                    Talorys never opens pages. Off by default.{" "}
                    <a href={DOCS_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-fg">
                      How it works
                    </a>
                  </>
                }
              >
                <Select
                  aria-label="Web search provider"
                  value={ws.provider}
                  disabled={save.isPending || !status.data}
                  onChange={(e) => save.mutate({ provider: e.target.value as WebSearchSettings["provider"] })}
                >
                  <option value="off">Off</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.configured && ws.provider !== p.id}>
                      {p.name}
                      {p.configured ? "" : " (no API key)"}
                    </option>
                  ))}
                </Select>
              </Row>
              {ws.provider !== "off" && (
                <Row label="Before each search" hint="Asking first shows every query on an approval card, and nothing is sent until you approve it.">
                  <div className="space-y-2">
                    <Select
                      aria-label="Before each web search"
                      value={ws.policy}
                      disabled={save.isPending}
                      onChange={(e) => save.mutate({ policy: e.target.value as WebSearchPolicy })}
                    >
                      <option value="approve">Ask me first</option>
                      <option value="auto">Search without asking</option>
                    </Select>
                    {ws.policy === "auto" && <p className="text-xs leading-5 text-warning">{AUTO_WARNING}</p>}
                  </div>
                </Row>
              )}
              {missing.length > 0 && (
                <Row
                  label="Adding an API key"
                  hint={
                    <>
                      Sign up with the provider, then set the key as a Worker secret, for example{" "}
                      {missing.map((p, i) => (
                        <span key={p.id}>
                          {i > 0 && " or "}
                          <code className="rounded bg-subtle px-1 font-mono">npx wrangler secret put {p.secret}</code>
                        </span>
                      ))}
                      . Both providers have free monthly allowances.
                    </>
                  }
                />
              )}
            </>
          )}
        </div>
      </Card>
    </section>
  );
}
