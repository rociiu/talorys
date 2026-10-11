import { type ReactNode, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { checkPasswordStrength, GITHUB_URL, LIMIT_CEILINGS, type Limits, type Settings, TALORYS_VERSION } from "@talorys/shared";
import { Download, ExternalLink, LogOut, Monitor, Moon, Sun, Upload } from "lucide-react";
import { Badge, Button, Card, ConfirmDialog, ErrorNotice, Input, Label, PageHeader, Select, Spinner, Switch } from "../components/ui";
import { SemanticRecallCard } from "../components/SemanticRecallCard";
import { keys, useApiMutation, useSessions, useSettings, useSystemInfo, useUsage } from "../hooks/queries";
import { useSession } from "../hooks/session";
import { useToast, errorMessage } from "../hooks/toast";
import { api, ApiError } from "../lib/api";
import { applyTheme } from "../lib/theme";
import { cn, relativeTime } from "../lib/utils";

const TABS = ["일반", "AI", "개인정보", "보안", "정보"] as const;
type Tab = (typeof TABS)[number];

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-medium uppercase tracking-wider text-fg-subtle">{title}</h2>
      <Card>
        <div className="divide-y divide-border">{children}</div>
      </Card>
    </section>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("일반");
  const { data: settings, isLoading, error, refetch } = useSettings();
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
      <PageHeader title="설정" />
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {TABS.map((t) => (
          <button type="button"
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === t ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg",
            )}
          >
            {t}
          </button>
        ))}
      </div>
      {error ? (
        <ErrorNotice error={error} onRetry={() => void refetch()} />
      ) : isLoading || !settings ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-8 animate-fade-in">
          {tab === "일반" && <GeneralTab settings={settings} />}
          {tab === "AI" && <AiTab settings={settings} />}
          {tab === "개인정보" && <PrivacyTab />}
          {tab === "보안" && <SecurityTab />}
          {tab === "정보" && <AboutTab />}
        </div>
      )}
    </div>
  );
}

function useSaveSettings() {
  const qc = useQueryClient();
  return useApiMutation((patch: Partial<Omit<Settings, "limits">> & { limits?: Partial<Limits> }) => api<{ settings: Settings }>("/settings", { method: "PATCH", body: patch }), {
    success: "설정이 저장되었습니다.",
    onSuccess: (r) => {
      qc.setQueryData(keys.settings, r.settings);
      void qc.invalidateQueries({ queryKey: ["session"] });
      void qc.invalidateQueries({ queryKey: keys.automations });
    },
  });
}

function GeneralTab({ settings }: { settings: Settings }) {
  const save = useSaveSettings();
  const [name, setName] = useState(settings.agentName);
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [settings.timezone];
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const THEME_LABELS: Record<string, string> = { system: "시스템", light: "라이트", dark: "다크" };

  return (
    <Section title="일반">
      <Row label="에이전트 이름" hint="에이전트의 호칭입니다.">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && name !== settings.agentName) save.mutate({ agentName: name.trim() });
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="에이전트 이름" />
          <Button type="submit" variant="outline" disabled={!name.trim() || name === settings.agentName}>
            저장
          </Button>
        </form>
      </Row>
      <Row
        label="시간대"
        hint={
          settings.timezone !== browserTz ? (
            <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => save.mutate({ timezone: browserTz })}>
              이 기기의 시간대 사용 ({browserTz})
            </button>
          ) : (
            "마감일과 일정 계산에 사용됩니다. 변경 시 자동화 일정이 재설정됩니다."
          )
        }
      >
        <Select value={settings.timezone} onChange={(e) => save.mutate({ timezone: e.target.value })} aria-label="시간대">
          {(zones.includes(settings.timezone) ? zones : [settings.timezone, ...zones]).map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="테마">
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
          {(
            [
              ["system", Monitor],
              ["light", Sun],
              ["dark", Moon],
            ] as const
          ).map(([value, Icon]) => (
            <button type="button"
              key={value}
              onClick={() => {
                applyTheme(value);
                save.mutate({ theme: value });
              }}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium",
                settings.theme === value ? "bg-surface shadow-sm" : "text-fg-muted",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {THEME_LABELS[value] ?? value}
            </button>
          ))}
        </div>
      </Row>
    </Section>
  );
}

const LIMIT_FIELDS: { key: keyof Limits; label: string; hint: string }[] = [
  { key: "maxOutputTokens", label: "최대 출력 토큰", hint: "AI 응답 1회당 상한 토큰 수입니다." },
  { key: "maxContextTokens", label: "최대 컨텍스트 토큰", hint: "모델에 전송되는 최근 대화 분량입니다. 이전 대화는 요약됩니다." },
  { key: "maxToolCalls", label: "요청당 최대 도구 호출 수", hint: "0으로 설정하면 도구 사용이 비활성화됩니다." },
  { key: "maxAgentIterations", label: "최대 추론 단계", hint: "요청 1회당 모델 왕복 횟수입니다." },
  { key: "maxAiRequestsPerDay", label: "일일 최대 AI 요청 수", hint: "Talorys가 강제하는 일일 최대 한도입니다." },
  { key: "maxScheduledAiRunsPerDay", label: "일일 최대 예약 AI 실행 수", hint: "AI 루틴 예산입니다. 일반 미리 알림은 AI를 사용하지 않습니다." },
];

function AiTab({ settings }: { settings: Settings }) {
  const save = useSaveSettings();
  const usage = useUsage();
  const [model, setModel] = useState(settings.model);
  const [limits, setLimits] = useState<Limits>(settings.limits);
  const [temperature, setTemperature] = useState(settings.temperature);
  const dirtyLimits = JSON.stringify(limits) !== JSON.stringify(settings.limits) || temperature !== settings.temperature;
  return (
    <>
      <Section title="모델">
        <Row label="Workers AI 모델" hint="기본값: @cf/zai-org/glm-4.7-flash. 도구 호출(Tool Calling)을 지원해야 합니다.">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (model !== settings.model) save.mutate({ model: model.trim() });
            }}
          >
            <Input value={model} onChange={(e) => setModel(e.target.value)} aria-label="모델 ID" className="font-mono text-xs" />
            <Button type="submit" variant="outline" disabled={model === settings.model}>
              저장
            </Button>
          </form>
        </Row>
        <Row label="대화에서 학습" hint="에이전트가 요청받지 않아도 지속적인 선호 사항을 기억합니다. 끄면 명시적인 기억 요청만 저장합니다.">
          <div className="flex justify-end">
            <Switch checked={settings.autoMemory} onChange={(v) => save.mutate({ autoMemory: v })} label="대화에서 학습" />
          </div>
        </Row>
        <Row label="데모 모드" hint="Workers AI 대신 오프라인 응답기를 사용합니다. AI 할당량이 소진되었을 때 유용합니다.">
          <div className="flex justify-end">
            <Switch checked={settings.demoMode} onChange={(v) => save.mutate({ demoMode: v })} label="데모 모드" />
          </div>
        </Row>
      </Section>

      <Section title="생성 및 실행 한도">
        <Row label="창의성 (Temperature)" hint="낮을수록 집중되고 일관된 응답을 제공합니다.">
          <div className="flex items-center gap-3">
            <input type="range" min={0} max={1.5} step={0.1} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} className="flex-1 accent-[var(--accent)]" aria-label="창의성 (Temperature)" />
            <span className="w-8 text-right text-sm tabular-nums">{temperature.toFixed(1)}</span>
          </div>
        </Row>
        {LIMIT_FIELDS.map((f) => (
          <Row key={f.key} label={f.label} hint={`${f.hint} (최대 ${LIMIT_CEILINGS[f.key]})`}>
            <Input
              type="number"
              min={0}
              max={LIMIT_CEILINGS[f.key]}
              value={limits[f.key]}
              onChange={(e) => setLimits({ ...limits, [f.key]: Number(e.target.value) })}
              aria-label={f.label}
            />
          </Row>
        ))}
        <div className="flex justify-end gap-2 px-5 py-3">
          <Button
            variant="ghost"
            disabled={!dirtyLimits}
            onClick={() => {
              setLimits(settings.limits);
              setTemperature(settings.temperature);
            }}
          >
            초기화
          </Button>
          <Button disabled={!dirtyLimits} loading={save.isPending} onClick={() => save.mutate({ limits, temperature })}>
            한도 저장
          </Button>
        </div>
      </Section>

      <Section title="사용량">
        {usage.isLoading || !usage.data ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
              {[
                ["오늘 AI 요청", `${usage.data.today.ai_requests} / ${usage.data.limits.maxAiRequestsPerDay}`],
                ["오늘 토큰 (추정)", (usage.data.today.input_tokens_estimate + usage.data.today.output_tokens_estimate).toLocaleString()],
                ["오늘 도구 호출", String(usage.data.today.tool_calls)],
                ["예약 AI 실행", `${usage.data.today.scheduled_ai_runs} / ${usage.data.limits.maxScheduledAiRunsPerDay}`],
              ].map(([label, value]) => (
                <div key={label} className="bg-surface px-5 py-4">
                  <p className="text-xs text-fg-subtle">{label}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
                </div>
              ))}
            </div>
            <Row label="최근 7일" hint="Talorys 자체 측정 추정치입니다.">
              <p className="text-right text-sm tabular-nums text-fg-muted">
                {usage.data.last_7_days.ai_requests}회 요청 · {usage.data.last_7_days.ai_errors}건 오류
              </p>
            </Row>
            <div className="px-5 py-4 text-xs leading-5 text-fg-subtle">
              <Badge tone="warning" className="mb-2">
                과금 데이터가 아닌 추정치입니다
              </Badge>
              <p>{usage.data.note}</p>
              <a href={usage.data.dashboard_url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-accent hover:underline">
                Cloudflare 대시보드에서 Workers AI 사용량 확인 <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </>
        )}
      </Section>
      <SemanticRecallCard />
    </>
  );
}

function PrivacyTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [confirm, setConfirm] = useState<"history" | "memories" | null>(null);
  const clear = useApiMutation(
    (what: "history" | "memories") => api(what === "history" ? "/conversations" : "/memories", { method: "DELETE", body: { confirm: "DELETE" } }),
    {
      invalidate: [["conversations"], ["memories"]],
      success: (r) => `${(r as { deleted: number }).deleted}개 항목을 삭제했습니다.`,
      onSuccess: () => setConfirm(null),
    },
  );

  async function onImport(file: File) {
    setImporting(true);
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error("백업 파일 크기는 25MB 이하여야 합니다.");
      const json = JSON.parse(await file.text());
      const r = await api<{ imported: Record<string, number> }>("/import", { method: "POST", body: json });
      toast(`${Object.entries(r.imported).map(([k, v]) => `${k} ${v}개`).join(", ")} 가져오기 완료`);
      await qc.invalidateQueries();
    } catch (error) {
      toast(error instanceof SyntaxError ? "올바른 JSON 파일이 아닙니다." : errorMessage(error), "error");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <>
      <Section title="데이터 관리">
        <div className="px-5 py-4 text-sm leading-6 text-fg-muted">
          Talorys가 저장하는 모든 데이터는 사용자의 Cloudflare 계정 내 Durable Object에 보관됩니다. 외부 개발자에게 어떤 정보도 전송되지 않으며, 대화 메시지는 Cloudflare Workers AI를 통해 처리됩니다.
        </div>
        <Row label="데이터 내보내기" hint="대화, 기억, 할 일, 메모, 프로젝트, 설정, 자동화 데이터를 talorys-backup.json 파일로 내보냅니다. 세션 및 인증 정보는 내보내지 않습니다.">
          <a href="/api/export" download="talorys-backup.json" className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium hover:bg-subtle">
            <Download className="h-4 w-4" /> 백업 다운로드
          </a>
        </Row>
        <Row label="데이터 가져오기" hint="백업 데이터를 기존 데이터와 병합합니다. 동일한 ID를 가진 기존 항목은 갱신되며, 삭제되는 항목은 없습니다.">
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && void onImport(e.target.files[0])} />
          <Button variant="outline" className="w-full justify-center" loading={importing} onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" /> 백업 파일 선택
          </Button>
        </Row>
      </Section>
      <Section title="위험 구역">
        <Row label="대화 기록 삭제" hint="모든 대화 및 메시지를 영구적으로 삭제합니다.">
          <Button variant="outline" className="w-full justify-center text-danger" onClick={() => setConfirm("history")}>
            기록 삭제
          </Button>
        </Row>
        <Row label="기억 초기화" hint="Talorys가 학습하고 저장한 모든 기억을 지웁니다.">
          <Button variant="outline" className="w-full justify-center text-danger" onClick={() => setConfirm("memories")}>
            기억 초기화
          </Button>
        </Row>
      </Section>
      <ConfirmDialog
        open={!!confirm}
        title={confirm === "history" ? "모든 대화를 삭제할까요?" : "모든 기억을 초기화할까요?"}
        message="이 작업은 되돌릴 수 없습니다. 필요 시 먼저 백업을 다운로드하세요."
        confirmLabel={confirm === "history" ? "모두 삭제" : "모두 초기화"}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && clear.mutate(confirm)}
        loading={clear.isPending}
      />
    </>
  );
}

function SecurityTab() {
  const { logout } = useSession();
  const sessions = useSessions();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmNext, setConfirmNext] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const strength = next ? checkPasswordStrength(next) : null;
  const change = useApiMutation(() => api("/auth/password", { method: "POST", body: { current_password: current, new_password: next } }), {
    invalidate: [keys.sessions],
    success: "비밀번호가 변경되었습니다. 다른 기기에서 로그아웃되었습니다.",
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirmNext("");
    },
  });
  const revoke = useApiMutation((id: string) => api(`/auth/sessions/${id}`, { method: "DELETE" }), { invalidate: [keys.sessions], success: "세션이 로그아웃되었습니다." });
  const revokeOthers = useApiMutation(() => api("/auth/sessions/revoke-others", { method: "POST", body: {} }), {
    invalidate: [keys.sessions],
    success: "다른 세션들을 모두 로그아웃했습니다.",
  });
  useEffect(() => setFormError(change.error instanceof ApiError ? change.error.message : null), [change.error]);

  return (
    <>
      <Section title="비밀번호 변경">
        <form
          className="space-y-4 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (next !== confirmNext) return setFormError("새 비밀번호가 일치하지 않습니다.");
            if (strength) return setFormError(strength);
            setFormError(null);
            change.mutate(undefined);
          }}
        >
          <input type="text" autoComplete="username" value="owner" readOnly hidden />
          <div>
            <Label htmlFor="pw-current">현재 비밀번호</Label>
            <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="pw-new">새 비밀번호</Label>
              <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
              {next && <p className={cn("mt-1 text-xs", strength ? "text-warning" : "text-success")}>{strength ?? "사용 가능한 비밀번호입니다"}</p>}
            </div>
            <div>
              <Label htmlFor="pw-confirm">새 비밀번호 확인</Label>
              <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirmNext} onChange={(e) => setConfirmNext(e.target.value)} />
            </div>
          </div>
          {formError && <p className="text-sm text-danger">{formError}</p>}
          <div className="flex justify-end">
            <Button type="submit" loading={change.isPending} disabled={!current || !next || !confirmNext}>
              비밀번호 변경
            </Button>
          </div>
        </form>
      </Section>
      <Section title="활성 세션">
        {sessions.isLoading ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : (
          sessions.data?.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {describeAgent(s.user_agent)} {s.current && <Badge tone="accent">현재 기기</Badge>}
                </p>
                <p className="text-xs text-fg-subtle">
                  로그인: {relativeTime(s.created_at)} · 최근 활동: {relativeTime(s.last_seen_at)}
                </p>
              </div>
              {!s.current && (
                <Button variant="ghost" size="sm" onClick={() => revoke.mutate(s.id)}>
                  로그아웃
                </Button>
              )}
            </div>
          ))
        )}
        <div className="flex flex-wrap justify-end gap-2 px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => revokeOthers.mutate(undefined)} loading={revokeOthers.isPending}>
            다른 세션 모두 로그아웃
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void logout()}>
            <LogOut className="h-3.5 w-3.5" /> 현재 기기 잠금
          </Button>
        </div>
      </Section>
      <p className="px-1 text-xs leading-5 text-fg-subtle">
        비밀번호를 잊으셨나요? 터미널에서 <code className="rounded bg-muted px-1">npx create-talorys@latest reset-password</code> 명령을 실행하세요. 모든 기기에서 즉시 로그아웃됩니다.
      </p>
    </>
  );
}

function describeAgent(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "브라우저";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${os} 환경의 ${browser}` : browser;
}

function AboutTab() {
  const info = useSystemInfo();
  return (
    <Section title="Talorys 정보">
      <Row label="버전">
        <p className="text-right font-mono text-sm">{info.data?.deployed_version ?? TALORYS_VERSION}</p>
      </Row>
      <Row label="배포 환경" hint="사용자 고유 Cloudflare 계정. Pages 프론트엔드 → 서비스 바인딩 → 비공개 Worker → Durable Object">
        <div className="space-y-1 text-right text-xs text-fg-muted">
          {info.data ? (
            <>
              <p>설치 ID: <span className="font-mono">{info.data.installation_id ?? "local"}</span></p>
              <p>스키마 v{info.data.schema_version} · {info.data.environment}</p>
              <p>AI: {info.data.ai_provider === "workers-ai" ? "Cloudflare Workers AI" : info.data.ai_provider === "mock" ? "데모 응답기" : "사용 불가"}</p>
            </>
          ) : (
            <Spinner className="ml-auto h-4 w-4" />
          )}
        </div>
      </Row>
      <Row label="소스 코드" hint="MIT 라이선스 기반의 무료 오픈소스입니다.">
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="flex items-center justify-end gap-1 text-sm text-accent hover:underline">
          GitHub <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </Row>
      <Row label="업데이트" hint="Talorys 디렉터리에서 실행하세요. 기존 데이터는 안전하게 보존됩니다.">
        <code className="block rounded bg-muted px-2 py-1 text-right text-xs">npx create-talorys@latest update</code>
      </Row>
    </Section>
  );
}
