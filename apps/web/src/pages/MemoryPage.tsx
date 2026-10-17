import { useEffect, useMemo, useState } from "react";
import { MEMORY_CATEGORIES, type Memory, type MemoryCategory, type MemoryReview, type MemoryReviewAction } from "@talorys/shared";
import { Archive, ArchiveRestore, Brain, Clock, GitCompare, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorNotice, Input, Label, PageHeader, Select, Spinner, Textarea } from "../components/ui";
import { type MemoryStatusFilter, useApiMutation, useMemories, useMemoryHistory, useMemoryReviews } from "../hooks/queries";
import { useToast } from "../hooks/toast";
import { api } from "../lib/api";
import { cn, relativeTime } from "../lib/utils";

const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preference: "Preferences",
  fact: "Facts",
  goal: "Goals",
  project: "Projects",
  habit: "Habits",
  person: "People",
  other: "Other",
};

const FILTERS: { value: MemoryStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Current" },
  { value: "historical", label: "Historical" },
  { value: "review", label: "Needs review" },
];

interface WriteResponse {
  memory: Memory;
  superseded?: Memory[];
  reviews?: number;
}

/** Explains what Smart Memory did with a save, in plain words. */
function writeMessage(r: WriteResponse): string {
  const parts = ["Memory saved"];
  if (r.superseded?.length) parts.push(`${r.superseded.length === 1 ? "the older version was" : `${r.superseded.length} older versions were`} kept as history`);
  if (r.reviews) parts.push("it may conflict with an older memory — review it below");
  return parts.join(" · ");
}

const sourceLabel = (m: Memory) =>
  m.source === "agent" ? "Learned in chat" : m.source === "import" ? "Imported" : m.source === "remote" ? "Added by access token" : "Added manually";

export default function MemoryPage() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [filter, setFilter] = useState<MemoryStatusFilter>("all");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, isLoading, error, refetch } = useMemories(debounced || undefined, filter);
  const reviews = useMemoryReviews();
  const [editing, setEditing] = useState<Memory | "new" | null>(null);
  const [correcting, setCorrecting] = useState<Memory | null>(null);
  const [historyOf, setHistoryOf] = useState<Memory | null>(null);
  const [deleting, setDeleting] = useState<Memory | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<MemoryCategory, Memory[]>();
    for (const m of data?.memories ?? []) {
      const list = map.get(m.category) ?? [];
      list.push(m);
      map.set(m.category, list);
    }
    return MEMORY_CATEGORIES.filter((c) => map.has(c)).map((c) => [c, map.get(c)!] as const);
  }, [data]);

  const remove = useApiMutation((id: string) => api(`/memories/${id}`, { method: "DELETE" }), {
    invalidate: [["memories"]],
    success: "Memory deleted",
    onSuccess: () => setDeleting(null),
  });
  const setStatus = useApiMutation(
    ({ id, status }: { id: string; status: Memory["status"] }) => api(`/memories/${id}/status`, { method: "POST", body: { status } }),
    {
      invalidate: [["memories"]],
      success: "Memory updated",
    },
  );

  const reviewList = reviews.data ?? [];
  const counts = data?.counts;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
      <PageHeader
        title="Memory"
        description={
          <>
            What Talorys knows about you. Only the most relevant current memories are shared with the AI in each conversation; past facts are used only
            when you ask about the past.
            {data ? ` ${data.total} saved.` : ""}
          </>
        }
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> Add memory
          </Button>
        }
      />
      <div className="mb-4 flex gap-1 overflow-x-auto rounded-lg bg-muted p-1" role="tablist" aria-label="Memory status">
        {FILTERS.map((f) => {
          const count = f.value === "active" ? counts?.active : f.value === "historical" ? counts?.historical : f.value === "review" ? counts?.review : undefined;
          return (
            <button
              type="button"
              key={f.value}
              role="tab"
              aria-selected={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                "flex-1 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium",
                filter === f.value ? "bg-surface shadow-sm" : "text-fg-muted hover:text-fg",
              )}
            >
              {f.label}
              {count ? <span className="ml-1 text-fg-subtle">{count}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="relative mb-6">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memories" className="pl-9" aria-label="Search memories" />
      </div>

      {(filter === "review" || filter === "all") && reviewList.length > 0 && <ReviewPanel reviews={reviewList} />}

      {error ? (
        <ErrorNotice error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : grouped.length === 0 ? (
        filter === "review" && reviewList.length > 0 ? null : (
          <EmptyState
            icon={<Brain className="h-9 w-9" />}
            title={debounced ? "No matching memories" : filter === "all" ? "Nothing remembered yet" : "Nothing here"}
            action={!debounced && filter === "all" && <Button variant="outline" onClick={() => setEditing("new")}>Add your first memory</Button>}
          >
            {debounced
              ? "Try a different search."
              : filter === "historical"
                ? "When a fact changes, the old version is kept here."
                : filter === "review"
                  ? "No possible conflicts right now."
                  : filter === "active"
                    ? "No current memories."
                    : 'Tell Talorys things like "Remember that I prefer morning meetings", or add them here.'}
          </EmptyState>
        )
      ) : (
        <div className="space-y-8">
          {grouped.map(([category, items]) => (
            <section key={category}>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">
                {CATEGORY_LABELS[category]} <span className="ml-1 normal-case tracking-normal">· {items.length}</span>
              </h2>
              <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
                {items.map((m) => (
                  <li key={m.id} className="group flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className={cn("text-[15px] leading-6", m.status === "historical" && "text-fg-muted")}>
                        {m.content}
                        {m.status === "historical" && <Badge className="ml-2 align-middle">Past</Badge>}
                        {m.status === "uncertain" && <Badge tone="warning" className="ml-2 align-middle">Unsure</Badge>}
                      </p>
                      <p className="mt-0.5 text-xs text-fg-subtle">
                        {sourceLabel(m)} · {relativeTime(m.updated_at)}
                        {m.valid_from && ` · since ${m.valid_from}`}
                        {m.valid_until && ` · until ${m.valid_until}`}
                        {m.superseded_by && (
                          <>
                            {" · "}
                            <button type="button" className="text-accent hover:underline" onClick={() => setHistoryOf(m)}>
                              Replaced by a newer memory
                            </button>
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                      <Button variant="ghost" size="icon" onClick={() => setHistoryOf(m)} aria-label="Memory history" title="History">
                        <Clock className="h-4 w-4" />
                      </Button>
                      {m.status !== "historical" && (
                        <Button variant="ghost" size="icon" onClick={() => setCorrecting(m)} aria-label="Update this fact" title="This changed — save a new version">
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                      )}
                      {m.status === "historical" ? (
                        <Button variant="ghost" size="icon" onClick={() => setStatus.mutate({ id: m.id, status: "active" })} aria-label="Restore as current" title="Restore as current">
                          <ArchiveRestore className="h-4 w-4" />
                        </Button>
                      ) : (
                        <Button variant="ghost" size="icon" onClick={() => setStatus.mutate({ id: m.id, status: "historical" })} aria-label="Mark as past" title="No longer true — keep as history">
                          <Archive className="h-4 w-4" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" onClick={() => setEditing(m)} aria-label="Edit memory" title="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setDeleting(m)} aria-label="Delete memory" title="Delete">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <MemoryEditor memory={editing} onClose={() => setEditing(null)} />
      <CorrectDialog memory={correcting} onClose={() => setCorrecting(null)} />
      <HistoryDialog memory={historyOf} onClose={() => setHistoryOf(null)} />
      <ConfirmDialog
        open={!!deleting}
        title="Forget this memory?"
        message={
          <>
            Talorys will permanently delete: “{deleting?.content}”. To keep it as a past fact instead, use “Mark as past”.
          </>
        }
        confirmLabel="Forget"
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        loading={remove.isPending}
      />
    </div>
  );
}

function ReviewPanel({ reviews }: { reviews: MemoryReview[] }) {
  const resolve = useApiMutation(
    ({ id, action }: { id: string; action: MemoryReviewAction }) => api(`/memories/reviews/${id}`, { method: "POST", body: { action } }),
    { invalidate: [["memories"]], success: "Done" },
  );
  return (
    <section className="mb-8 space-y-2" aria-label="Possible conflicts">
      <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-fg-subtle">
        <GitCompare className="h-3.5 w-3.5" /> Possible conflicts · {reviews.length}
      </h2>
      {reviews.map((r) => (
        <div key={r.id} className="rounded-xl border border-warning/40 bg-surface px-4 py-3">
          <p className="text-xs text-fg-subtle">{r.reason}</p>
          <dl className="mt-2 grid gap-1 text-sm">
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-fg-subtle">Newer</dt>
              <dd>{r.memory.content}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-fg-subtle">Older</dt>
              <dd>{r.other.content}</dd>
            </div>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => resolve.mutate({ id: r.id, action: "keep_both" })}>
              Keep both
            </Button>
            <Button size="sm" onClick={() => resolve.mutate({ id: r.id, action: "mark_historical" })}>
              Mark older as past
            </Button>
            <Button size="sm" variant="outline" onClick={() => resolve.mutate({ id: r.id, action: "replace" })}>
              Replace older
            </Button>
            <Button size="sm" variant="ghost" onClick={() => resolve.mutate({ id: r.id, action: "cancel" })}>
              Discard newer
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}

function HistoryDialog({ memory, onClose }: { memory: Memory | null; onClose: () => void }) {
  const { data, isLoading } = useMemoryHistory(memory?.id ?? null);
  const current = data ? (data.next.at(-1) ?? data.memory) : null;
  const earlier = data ? [...data.previous, ...(data.next.length ? [data.memory, ...data.next.slice(0, -1)] : [])].reverse() : [];
  return (
    <Dialog open={!!memory} onClose={onClose} title="Memory history">
      {isLoading || !data || !current ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-fg-subtle">{current.status === "historical" ? "Latest" : "Current"}</p>
            <p className="mt-1 leading-6">“{current.content}”</p>
            <p className="text-xs text-fg-subtle">
              Saved {relativeTime(current.created_at)}
              {current.valid_from && ` · since ${current.valid_from}`}
            </p>
          </div>
          {earlier.length > 0 ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-fg-subtle">Previously</p>
              <ul className="mt-1 space-y-2">
                {earlier.map((m) => (
                  <li key={m.id} className="text-fg-muted">
                    “{m.content}”
                    <span className="block text-xs text-fg-subtle">
                      Saved {relativeTime(m.created_at)}
                      {m.valid_until && ` · until ${m.valid_until}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-fg-subtle">No earlier versions.</p>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** Saves a newer version of a fact; the old one is kept as history. */
function CorrectDialog({ memory, onClose }: { memory: Memory | null; onClose: () => void }) {
  const [content, setContent] = useState("");
  const toast = useToast();
  useEffect(() => setContent(memory?.content ?? ""), [memory]);
  const save = useApiMutation(() => api<WriteResponse>(`/memories/${memory!.id}/correct`, { method: "POST", body: { content } }), {
    invalidate: [["memories"]],
    onSuccess: (r) => {
      toast(writeMessage(r));
      onClose();
    },
  });
  return (
    <Dialog
      open={!!memory}
      onClose={onClose}
      title="Update this fact"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={!content.trim() || content.trim() === memory?.content}>
            Save new version
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-fg-muted">
          Use this when something changed. Talorys will remember the new version as current and keep “{memory?.content}” as a past fact.
        </p>
        <div>
          <Label htmlFor="memory-correct">What's true now?</Label>
          <Textarea id="memory-correct" rows={3} value={content} onChange={(e) => setContent(e.target.value)} maxLength={2000} autoFocus />
        </div>
      </div>
    </Dialog>
  );
}

function MemoryEditor({ memory, onClose }: { memory: Memory | "new" | null; onClose: () => void }) {
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<MemoryCategory>("other");
  const toast = useToast();
  useEffect(() => {
    if (memory && memory !== "new") {
      setContent(memory.content);
      setCategory(memory.category);
    } else {
      setContent("");
      setCategory("preference");
    }
  }, [memory]);
  const save = useApiMutation(
    () =>
      memory === "new"
        ? api<WriteResponse>("/memories", { method: "POST", body: { content, category } })
        : api<WriteResponse>(`/memories/${(memory as Memory).id}`, { method: "PATCH", body: { content, category } }),
    {
      invalidate: [["memories"]],
      onSuccess: (r) => {
        toast(writeMessage(r));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open={!!memory}
      onClose={onClose}
      title={memory === "new" ? "Add memory" : "Edit memory"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={!content.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="memory-content">What should Talorys remember?</Label>
          <Textarea id="memory-content" rows={3} value={content} onChange={(e) => setContent(e.target.value)} maxLength={2000} autoFocus placeholder="Prefers concise answers" />
          {memory !== "new" && memory && (
            <p className="mt-1 text-xs text-fg-subtle">Fixing a typo? Edit here. Did the fact change? Use “Update this fact” to keep the old version as history.</p>
          )}
        </div>
        <div>
          <Label htmlFor="memory-category">Category</Label>
          <Select id="memory-category" value={category} onChange={(e) => setCategory(e.target.value as MemoryCategory)}>
            {MEMORY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </div>
        <Badge tone="accent">Stored only in your Cloudflare account</Badge>
      </div>
    </Dialog>
  );
}
