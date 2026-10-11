import { type ReactNode, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Trash2 } from "lucide-react";
import { Button, Card, ConfirmDialog, ErrorNotice, Input, Switch } from "./ui";
import { useApiMutation } from "../hooks/queries";
import { api } from "../lib/api";

// Local mirrors of the /api/semantic/* responses (apps/agent/src/semantic/routes.ts).
interface SemanticConfig {
  enabled: boolean;
  model: string;
  maxEmbeddingsPerDay: number;
}

interface SemanticStatus {
  enabled: boolean;
  ever_enabled: boolean;
  embedder: "workers-ai" | "mock" | "none";
  vectors: number;
  pending: number;
  embeddings_today: number;
  cap: number;
}

interface ReindexReport {
  embedded: number;
  pending: number;
  capped: boolean;
  error?: string;
}

const DEFAULT_CAP = 500;
const EMBEDDERS: Record<SemanticStatus["embedder"], string> = { "workers-ai": "Workers AI", mock: "Mock (로컬 개발)", none: "사용 불가" };

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
 * index status (polled while memories are pending) and the reindex and delete actions.
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
    refetchInterval: (q) => ((q.state.data?.pending ?? 0) > 0 ? 3000 : false),
  });
  const savedCap = config.data?.config?.maxEmbeddingsPerDay ?? DEFAULT_CAP;
  const [cap, setCap] = useState(savedCap);
  useEffect(() => setCap(savedCap), [savedCap]);
  const savedModel = config.data?.config?.model ?? "";
  const [model, setModel] = useState(savedModel);
  useEffect(() => setModel(savedModel), [savedModel]);

  const saveConfig = useApiMutation((patch: Partial<SemanticConfig>) => api<{ config: SemanticConfig }>("/semantic/config", { method: "PUT", body: patch }), {
    success: (r) => (r.config.enabled ? "의미 기반 기억 검색 설정이 저장되었습니다." : "의미 기반 기억 검색이 비활성화되었습니다."),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["semantic"] }),
  });
  const reindex = useApiMutation(() => api<ReindexReport>("/semantic/reindex", { method: "POST" }), {
    invalidate: [["semantic"]],
    success: (r) => `재색인 완료: ${r.embedded}개 임베딩, ${r.pending}개 대기`,
  });
  const wipe = useApiMutation(() => api("/semantic/data", { method: "DELETE", body: { confirm: "DELETE" } }), {
    invalidate: [["semantic"]],
    success: "의미 데이터가 삭제되었습니다.",
    onSuccess: () => setConfirmDelete(false),
  });

  const validCap = Number.isInteger(cap) && cap >= 1 && cap <= 10_000;
  const submitCap = () => {
    if (validCap && cap !== savedCap) saveConfig.mutate({ maxEmbeddingsPerDay: cap });
  };
  const s = status.data;
  const stats: [string, string][] = s
    ? [
        ["임베더", EMBEDDERS[s.embedder] ?? s.embedder],
        ["벡터 수", String(s.vectors)],
        ["대기 중", String(s.pending)],
        ["오늘 임베딩 사용량", `${s.embeddings_today} / ${s.cap}`],
      ]
    : [["상태", "로딩 중…"]];
  const busy = reindex.isPending || wipe.isPending;

  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-medium uppercase tracking-wider text-fg-subtle">의미 기반 기억 검색</h2>
      <Card>
        <div className="divide-y divide-border">
          <Row label="의미 기반 기억 검색" hint={`Workers AI 임베딩을 사용하여 의미 단위로 기억을 검색합니다 (일 최대 ${savedCap}회). 기본적으로 비활성화되어 있습니다.`}>
            <div className="flex justify-end">
              <Switch
                checked={enabled}
                onChange={(v) => saveConfig.mutate({ enabled: v })}
                label="의미 기반 기억 검색"
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
                <div role="group" aria-label="의미 기반 검색 상태" className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
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
              <Row label="임베딩 모델" hint="기본값: @cf/baai/bge-m3. Workers AI 텍스트 임베딩 모델이어야 합니다.">
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (model.trim() !== savedModel) saveConfig.mutate({ model: model.trim() });
                  }}
                >
                  <Input value={model} onChange={(e) => setModel(e.target.value)} aria-label="임베딩 모델 id" className="font-mono text-xs" />
                  <Button type="submit" variant="outline" disabled={!model.trim() || model.trim() === savedModel}>
                    저장
                  </Button>
                </form>
              </Row>
              <Row label="일일 최대 임베딩 수" hint="AI 요청 한도와 별도로 계산됩니다. 한도 소진 시 키워드 검색으로 전환됩니다.">
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitCap();
                  }}
                >
                  <Input type="number" min={1} max={10_000} step={1} value={cap} onChange={(e) => setCap(Number(e.target.value))} onBlur={submitCap} aria-label="일일 최대 임베딩 수" />
                  <Button type="submit" variant="outline" disabled={!validCap || cap === savedCap} loading={saveConfig.isPending}>
                    저장
                  </Button>
                </form>
              </Row>
              <Row label="인덱스 재구성" hint="모든 기억을 다시 임베딩합니다. 일일 임베딩 예산이 소모됩니다.">
                <Button variant="outline" className="w-full justify-center" loading={reindex.isPending} disabled={busy} onClick={() => reindex.mutate(undefined)}>
                  <RefreshCw className="h-4 w-4" /> 재색인
                </Button>
              </Row>
            </>
          )}
          {config.data?.ever_enabled && (
            <Row label="의미 데이터 삭제" hint="검색 인덱스를 제거하고 기능을 끕니다. 저장된 기억은 유지됩니다.">
              <Button variant="outline" className="w-full justify-center text-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-4 w-4" /> 의미 데이터 삭제
              </Button>
            </Row>
          )}
        </div>
      </Card>
      <ConfirmDialog
        open={confirmDelete}
        title="의미 데이터를 삭제할까요?"
        message="검색 인덱스를 제거하고 기능을 끕니다. 저장된 기억은 유지됩니다."
        confirmLabel="삭제"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => wipe.mutate(undefined)}
        loading={wipe.isPending}
      />
    </section>
  );
}
