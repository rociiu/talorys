import { useEffect, useMemo, useState } from "react";
import { MEMORY_CATEGORIES, type Memory, type MemoryCategory } from "@talorys/shared";
import { Brain, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorNotice, Input, Label, PageHeader, Select, Spinner, Textarea } from "../components/ui";
import { keys, useApiMutation, useMemories } from "../hooks/queries";
import { api } from "../lib/api";
import { relativeTime } from "../lib/utils";

const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preference: "선호 사항",
  fact: "사실",
  goal: "목표",
  project: "프로젝트",
  habit: "습관",
  person: "인물",
  other: "기타",
};

export default function MemoryPage() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, isLoading, error, refetch } = useMemories(debounced || undefined);
  const [editing, setEditing] = useState<Memory | "new" | null>(null);
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
    success: "기억이 삭제되었습니다.",
    onSuccess: () => setDeleting(null),
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
      <PageHeader
        title="기억"
        description={
          <>
            에이전트가 기억하고 있는 정보입니다. 대화 시 가장 관련성 높은 기억만 선별되어 전달됩니다.
            {data ? ` 총 ${data.total}개 저장됨.` : ""}
          </>
        }
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> 기억 추가
          </Button>
        }
      />
      <div className="relative mb-6">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="기억 검색" className="pl-9" aria-label="기억 검색" />
      </div>

      {error ? (
        <ErrorNotice error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : grouped.length === 0 ? (
        <EmptyState
          icon={<Brain className="h-9 w-9" />}
          title={debounced ? "일치하는 기억이 없습니다" : "저장된 기억이 없습니다"}
          action={!debounced && <Button variant="outline" onClick={() => setEditing("new")}>첫 번째 기억 추가하기</Button>}
        >
          {debounced ? "다른 검색어를 입력해 보세요." : '대화 중 "간결한 답변을 선호한다고 기억해줘"처럼 요청하거나 여기서 직접 추가할 수 있습니다.'}
        </EmptyState>
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
                      <p className="text-[15px] leading-6">{m.content}</p>
                      <p className="mt-0.5 text-xs text-fg-subtle">
                        {m.source === "agent" ? "대화에서 학습됨" : m.source === "import" ? "가져옴" : "직접 추가됨"} · {relativeTime(m.updated_at)}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                      <Button variant="ghost" size="icon" onClick={() => setEditing(m)} aria-label="기억 수정">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setDeleting(m)} aria-label="기억 삭제">
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
      <ConfirmDialog
        open={!!deleting}
        title="이 기억을 삭제할까요?"
        message={<>에이전트가 다음 내용을 더 이상 기억하지 않습니다: “{deleting?.content}”</>}
        confirmLabel="삭제"
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        loading={remove.isPending}
      />
    </div>
  );
}

function MemoryEditor({ memory, onClose }: { memory: Memory | "new" | null; onClose: () => void }) {
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<MemoryCategory>("other");
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
        ? api("/memories", { method: "POST", body: { content, category } })
        : api(`/memories/${(memory as Memory).id}`, { method: "PATCH", body: { content, category } }),
    { invalidate: [["memories"], keys.memories()], success: "기억이 저장되었습니다.", onSuccess: onClose },
  );
  return (
    <Dialog
      open={!!memory}
      onClose={onClose}
      title={memory === "new" ? "기억 추가" : "기억 수정"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={!content.trim()}>
            저장
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="memory-content">기억할 내용을 입력하세요</Label>
          <Textarea id="memory-content" rows={3} value={content} onChange={(e) => setContent(e.target.value)} maxLength={2000} autoFocus placeholder="간결한 답변 선호" />
        </div>
        <div>
          <Label htmlFor="memory-category">카테고리</Label>
          <Select id="memory-category" value={category} onChange={(e) => setCategory(e.target.value as MemoryCategory)}>
            {MEMORY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </div>
        <Badge tone="accent">프라이빗 클라우드에만 안전하게 저장됩니다</Badge>
      </div>
    </Dialog>
  );
}
