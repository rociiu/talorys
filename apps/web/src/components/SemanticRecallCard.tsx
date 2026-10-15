import { type ReactNode, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Trash2 } from "lucide-react";
import { Button, Card, ConfirmDialog, ErrorNotice, Input, Switch } from "./ui";
import { useApiMutation } from "../hooks/queries";
import { api } from "../lib/api";
import { statusRefetchInterval } from "./semanticPolling";
import { isValidCap } from "./semanticCaps";

// Local mirrors of the /api/semantic/* responses (apps/agent/src/semantic/routes.ts).
interface SemanticConfig {
  enabled: boolean;
  model: string;
  maxEmbeddingsPerDay: number;
  maxItemEmbeddingsPerDay: number;
}

interface SemanticStatus {
  enabled: boolean;
  ever_enabled: boolean;
  embedder: "workers-ai" | "mock" | "none";
  vectors: number;
  pending: number;
  embeddings_today: number;
  cap: number;
  items?: { vectors: number; pending: number; by_type: { task: number; note: number; automation: number }; items_today: number; items_cap: number; indexing: boolean };
}

interface ReindexReport {
  embedded: number;
  pending: number;
  capped: boolean;
  error?: string;
  surfaces?: { embedded: number; pending: number };
}

const DEFAULT_CAP = 500;
const DEFAULT_ITEM_CAP = 50;
const EMBEDDERS: Record<SemanticStatus["embedder"], string> = { "workers-ai": "Workers AI", mock: "Mock (local dev)", none: "Not available" };

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-5 text-fg-subtle">{hint}</p>}
      </div>
      <div className="shrink-0 sm:w-64">{children}</div>
    </div>
  );
}

/**
 * Settings card for semantic memory recall: the opt-in switch, the daily embedding cap,
 * index status (polled while memories are pending or an item pass runs) and the reindex and delete actions.
 */
export function SemanticRecallCard() {
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const config = useQuery({
    queryKey: ["semantic", "config"],
    queryFn: () => api<{ config: SemanticConfig | null; ever_enabled: boolean }>("/semantic/config"),
  });
  const enabled = config.data?.config?.enabled === true;
  const status = useQuery({
    queryKey: ["semantic", "status"],
    queryFn: () => api<SemanticStatus>("/semantic/status"),
    enabled,
    refetchOnMount: "always",
    refetchInterval: (q) => statusRefetchInterval(q.state.data),
  });
  const savedCap = config.data?.config?.maxEmbeddingsPerDay ?? DEFAULT_CAP;
  const [cap, setCap] = useState(savedCap);
  useEffect(() => setCap(savedCap), [savedCap]);
  const savedItemCap = config.data?.config?.maxItemEmbeddingsPerDay ?? DEFAULT_ITEM_CAP;
  const [itemCapInput, setItemCapInput] = useState(savedItemCap);
  useEffect(() => setItemCapInput(savedItemCap), [savedItemCap]);
  const savedModel = config.data?.config?.model ?? "";
  const [model, setModel] = useState(savedModel);
  useEffect(() => setModel(savedModel), [savedModel]);

  const saveConfig = useApiMutation((patch: Partial<SemanticConfig>) => api<{ config: SemanticConfig }>("/semantic/config", { method: "PUT", body: patch }), {
    success: (r) => (r.config.enabled ? "Semantic recall settings saved" : "Semantic recall turned off"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["semantic"] }),
  });
  const reindex = useApiMutation(() => api<ReindexReport>("/semantic/reindex", { method: "POST" }), {
    invalidate: [["semantic"]],
    success: (r) => `Reindexed: ${r.embedded} embedded, ${r.pending} pending`,
  });
  const wipe = useApiMutation(() => api("/semantic/data", { method: "DELETE", body: { confirm: "DELETE" } }), {
    invalidate: [["semantic"]],
    success: "Semantic data deleted",
    onSuccess: () => setConfirmDelete(false),
  });

  const validCap = isValidCap(cap);
  const submitCap = () => {
    if (validCap && cap !== savedCap) saveConfig.mutate({ maxEmbeddingsPerDay: cap });
  };
  const validItemCap = isValidCap(itemCapInput);
  const submitItemCap = () => {
    if (validItemCap && itemCapInput !== savedItemCap) saveConfig.mutate({ maxItemEmbeddingsPerDay: itemCapInput });
  };
  const s = status.data;
  const itemCap = s?.items?.items_cap ?? DEFAULT_ITEM_CAP;
  const stats: [string, string][] = s
    ? [
        ["Embedder", EMBEDDERS[s.embedder] ?? s.embedder],
        ["Vectors", String(s.vectors)],
        ["Pending", String(s.pending)],
        ["Embeddings today", `${s.embeddings_today} / ${s.cap}`],
      ]
    : [["Status", "Loading…"]];
  const itemsIndexed = s?.items ? s.items.by_type.task + s.items.by_type.note + s.items.by_type.automation : 0;
  const itemsPending = s?.items?.pending ?? 0;
  const busy = reindex.isPending || wipe.isPending;

  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-medium uppercase tracking-wider text-fg-subtle">Semantic memory recall</h2>
      <Card>
        <div className="divide-y divide-border">
          <Row label="Semantic memory recall" hint={`Finds memories, tasks, notes and reminders by meaning using Workers AI embeddings. Memories use up to ${savedCap} embeddings per day; tasks, notes and reminders have their own ${itemCap} per day. Off by default.`}>
            <div className="flex justify-end">
              <Switch
                checked={enabled}
                onChange={(v) => saveConfig.mutate({ enabled: v })}
                label="Semantic memory recall"
                disabled={config.isLoading || saveConfig.isPending}
              />
            </div>
          </Row>
          {config.error && (
            <div className="px-5 py-4">
              <ErrorNotice error={config.error} onRetry={() => void config.refetch()} />
            </div>
          )}
          {enabled && (
            <>
              {status.error ? (
                <div className="px-5 py-4">
                  <ErrorNotice error={status.error} onRetry={() => void status.refetch()} />
                </div>
              ) : (
                <div role="group" aria-label="Semantic recall status" className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
                  {stats.map(([label, value]) => (
                    <div key={label} className="bg-surface px-5 py-4">
                      <p className="text-xs text-fg-subtle">{label}</p>
                      <p className="mt-1 truncate text-sm font-medium tabular-nums" data-stat={label} title={value}>
                        {value}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              {s && !status.error && (
                <div className="flex items-center justify-between gap-3 px-5 py-4 text-sm">
                  <p className="text-xs text-fg-subtle">Tasks, notes, reminders</p>
                  <p className="font-medium tabular-nums">
                    {itemsIndexed} indexed, <span data-stat="Items pending">{itemsPending}</span> pending
                  </p>
                </div>
              )}
              {s?.items && !status.error && (
                <div className="flex items-center justify-between gap-3 px-5 py-4 text-sm">
                  <p className="text-xs text-fg-subtle">Item embeddings today</p>
                  <p className="font-medium tabular-nums" data-stat="Item embeddings today">
                    {s.items.items_today} / {itemCap}
                  </p>
                </div>
              )}
              <Row label="Embedding model" hint="Default: @cf/baai/bge-m3. Must be a Workers AI text embedding model.">
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (model.trim() !== savedModel) saveConfig.mutate({ model: model.trim() });
                  }}
                >
                  <Input value={model} onChange={(e) => setModel(e.target.value)} aria-label="Embedding model id" className="font-mono text-xs" />
                  <Button type="submit" variant="outline" disabled={!model.trim() || model.trim() === savedModel}>
                    Save
                  </Button>
                </form>
              </Row>
              <Row label="Max embeddings per day" hint="Separate from the AI request cap. Recall falls back to keywords when spent.">
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitCap();
                  }}
                >
                  <Input type="number" min={0} max={10_000} step={1} value={cap} onChange={(e) => setCap(Number(e.target.value))} onBlur={submitCap} aria-label="Max embeddings per day" />
                  <Button type="submit" variant="outline" disabled={!validCap || cap === savedCap} loading={saveConfig.isPending}>
                    Save
                  </Button>
                </form>
              </Row>
              <Row label="Max item embeddings per day" hint="For tasks, notes and reminders, counted apart from memories. Items saved after it is spent are found by keyword until the next day.">
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitItemCap();
                  }}
                >
                  <Input
                    type="number"
                    min={0}
                    max={10_000}
                    step={1}
                    value={itemCapInput}
                    onChange={(e) => setItemCapInput(Number(e.target.value))}
                    onBlur={submitItemCap}
                    aria-label="Max item embeddings per day"
                  />
                  <Button type="submit" variant="outline" disabled={!validItemCap || itemCapInput === savedItemCap} loading={saveConfig.isPending}>
                    Save
                  </Button>
                </form>
              </Row>
              <Row label="Reindex" hint="Re-embeds every memory. Uses the daily embedding budget.">
                <Button variant="outline" className="w-full justify-center" loading={reindex.isPending} disabled={busy} onClick={() => reindex.mutate(undefined)}>
                  <RefreshCw className="h-4 w-4" /> Reindex
                </Button>
              </Row>
            </>
          )}
          {config.data?.ever_enabled && (
            <Row label="Delete semantic data" hint="Removes the search index and turns the feature off. Your memories are kept.">
              <Button variant="outline" className="w-full justify-center text-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-4 w-4" /> Delete semantic data
              </Button>
            </Row>
          )}
        </div>
      </Card>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete semantic data?"
        message="Removes the search index and turns the feature off. Your memories are kept."
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => wipe.mutate(undefined)}
        loading={wipe.isPending}
      />
    </section>
  );
}
