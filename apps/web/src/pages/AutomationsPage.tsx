import { useMemo, useState } from "react";
import { type Automation, type AutomationKind, type ScheduleSpec, describeSchedule } from "@talorys/shared";
import { AlarmClock, Bell, Bot, CalendarClock, ListChecks, Plus, Trash2 } from "lucide-react";
import { Badge, Button, Card, ConfirmDialog, Dialog, EmptyState, ErrorNotice, Input, Label, PageHeader, Select, Spinner, Switch, Textarea } from "../components/ui";
import { keys, useApiMutation, useAutomations } from "../hooks/queries";
import { api } from "../lib/api";
import { cn, formatDateTime, relativeTime } from "../lib/utils";

const KIND_META: Record<AutomationKind, { label: string; icon: typeof Bell; hint: string }> = {
  reminder: { label: "미리 알림", icon: Bell, hint: "알림 센터에 메시지를 표시합니다 (AI 미사용)." },
  task_digest: { label: "할 일 요약", icon: ListChecks, hint: "오늘 마감 및 지연된 할 일을 요약합니다 (AI 미사용)." },
  agent_prompt: { label: "AI 루틴", icon: Bot, hint: "읽기 전용 도구로 프롬프트를 자동 실행합니다 (Workers AI 사용)." },
};

const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

export default function AutomationsPage() {
  const { data, isLoading, error, refetch } = useAutomations();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const tz = data?.timezone ?? "Asia/Seoul";

  const toggle = useApiMutation(
    (a: Automation) => api(`/automations/${a.id}`, { method: "PATCH", body: { enabled: !a.enabled } }),
    { invalidate: [keys.automations] },
  );
  const remove = useApiMutation((id: string) => api(`/automations/${id}`, { method: "DELETE" }), {
    invalidate: [keys.automations],
    success: "일정이 삭제되었습니다.",
    onSuccess: () => setDeleting(null),
  });

  const { active, inactive, upcoming } = useMemo(() => {
    const all = data?.automations ?? [];
    return {
      active: all.filter((a) => a.enabled),
      inactive: all.filter((a) => !a.enabled),
      upcoming: all
        .filter((a) => a.enabled && a.next_run)
        .sort((a, b) => a.next_run!.localeCompare(b.next_run!))
        .slice(0, 5),
    };
  }, [data]);

  const row = (a: Automation) => {
    const meta = KIND_META[a.kind];
    const Icon = meta.icon;
    return (
      <li key={a.id} className="flex items-start gap-3 px-4 py-3">
        <div className={cn("mt-0.5 rounded-lg p-2", a.enabled ? "bg-accent-soft text-accent" : "bg-muted text-fg-subtle")}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-medium">{a.name}</p>
            {a.status === "failed" && <Badge tone="danger">최근 실행 실패</Badge>}
            {a.status === "completed" && <Badge>완료됨</Badge>}
            {a.status === "running" && <Badge tone="accent">실행 중</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-fg-muted">{a.schedule_description}</p>
          <p className="mt-0.5 text-xs text-fg-subtle">
            {a.next_run && a.enabled ? `다음: ${formatDateTime(a.next_run, tz)}` : a.status === "completed" ? "완료됨" : a.enabled ? "예약되지 않음" : "일시 중지됨"}
            {a.last_run && ` · 최근 실행 ${relativeTime(a.last_run)}`}
            {a.run_count > 0 && ` · ${a.run_count}회 실행`}
          </p>
          {a.last_error && <p className="mt-1 text-xs text-danger">{a.last_error}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {a.status !== "completed" && (
            <Switch checked={a.enabled} onChange={() => toggle.mutate(a)} label={a.enabled ? `${a.name} 일시 중지` : `${a.name} 재개`} />
          )}
          <Button variant="ghost" size="icon" onClick={() => setDeleting(a)} aria-label={`${a.name} 삭제`}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </li>
    );
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
      <PageHeader
        title="자동화"
        description={<>미리 알림과 루틴은 브라우저를 닫아도 정해진 시간에 실행됩니다. (기준 시간대: {tz})</>}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> 추가
          </Button>
        }
      />

      {error ? (
        <ErrorNotice error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : !data?.automations.length && !data?.runs.length ? (
        <EmptyState
          icon={<CalendarClock className="h-9 w-9" />}
          title="등록된 자동화가 없습니다"
          action={<Button variant="outline" onClick={() => setCreating(true)}>미리 알림 만들기</Button>}
        >
          대화창에서 “내일 오전 9시에 운동하라고 알려줘” 또는 “매주 금요일에 남은 할 일 검토해줘”와 같이 요청할 수 있습니다.
        </EmptyState>
      ) : (
        <div className="space-y-8">
          {upcoming.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">예정된 실행</h2>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {upcoming.map((a) => (
                  <div key={a.id} className="min-w-44 rounded-xl border border-border bg-surface px-4 py-3">
                    <AlarmClock className="h-4 w-4 text-accent" />
                    <p className="mt-2 truncate text-sm font-medium">{a.name}</p>
                    <p className="text-xs text-fg-subtle">{relativeTime(a.next_run)}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
          {active.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">활성 일정</h2>
              <Card>
                <ul className="divide-y divide-border">{active.map(row)}</ul>
              </Card>
            </section>
          )}
          {inactive.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">일시 중지 및 완료됨</h2>
              <Card>
                <ul className="divide-y divide-border">{inactive.map(row)}</ul>
              </Card>
            </section>
          )}
          <section>
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">최근 실행 기록</h2>
            {!data?.runs.length ? (
              <p className="text-sm text-fg-subtle">아직 실행된 기록이 없습니다.</p>
            ) : (
              <Card>
                <ul className="divide-y divide-border">
                  {data.runs.slice(0, 20).map((r) => (
                    <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{r.automation_name}</p>
                        <p className={cn("truncate text-xs", r.status === "error" ? "text-danger" : "text-fg-subtle")}>
                          {r.error ?? r.result ?? (r.status === "running" ? "실행 중…" : "")}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <Badge tone={r.status === "success" ? "success" : r.status === "error" ? "danger" : "neutral"}>{r.status === "success" ? "성공" : r.status === "error" ? "오류" : r.status}</Badge>
                        <p className="mt-0.5 text-xs text-fg-subtle">{relativeTime(r.started_at)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>
          {!!data?.failed_runs.length && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-danger">실행 실패 기록</h2>
              <Card>
                <ul className="divide-y divide-border">
                  {data.failed_runs.map((r) => (
                    <li key={r.id} className="px-4 py-2.5 text-sm">
                      <p className="font-medium">
                        {r.automation_name} <span className="font-normal text-fg-subtle">· {formatDateTime(r.started_at, tz)}</span>
                      </p>
                      <p className="text-xs text-danger">{r.error}</p>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}
        </div>
      )}

      <AutomationForm open={creating} onClose={() => setCreating(false)} tz={tz} />
      <ConfirmDialog
        open={!!deleting}
        title="일정을 삭제할까요?"
        message={`“${deleting?.name}” 일정이 삭제되고 더 이상 실행되지 않습니다.`}
        confirmLabel="삭제"
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        loading={remove.isPending}
      />
    </div>
  );
}

function tomorrowAt9(): string {
  const d = new Date(Date.now() + 86400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
}

function AutomationForm({ open, onClose, tz }: { open: boolean; onClose: () => void; tz: string }) {
  const [kind, setKind] = useState<AutomationKind>("reminder");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [type, setType] = useState<ScheduleSpec["type"]>("once");
  const [at, setAt] = useState(tomorrowAt9());
  const [time, setTime] = useState("09:00");
  const [days, setDays] = useState<number[]>([1]);
  const [day, setDay] = useState(1);
  const [minutes, setMinutes] = useState(60);

  const schedule: ScheduleSpec =
    type === "once"
      ? { type, at }
      : type === "daily"
        ? { type, time }
        : type === "weekly"
          ? { type, days: days.length ? days : [1], time }
          : type === "monthly"
            ? { type, day, time }
            : { type, minutes };

  const reset = () => {
    setName("");
    setMessage("");
    setKind("reminder");
    setType("once");
    setAt(tomorrowAt9());
  };
  const create = useApiMutation(
    () => api("/automations", { method: "POST", body: { name: name.trim() || message.trim().slice(0, 80) || KIND_META[kind].label, kind, message, schedule } }),
    {
      invalidate: [keys.automations],
      success: "일정이 등록되었습니다.",
      onSuccess: () => {
        reset();
        onClose();
      },
    },
  );
  const needsMessage = kind !== "task_digest";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="새 자동화"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button onClick={() => create.mutate(undefined)} loading={create.isPending} disabled={needsMessage && !message.trim()}>
            생성
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(KIND_META) as AutomationKind[]).map((k) => {
            const Icon = KIND_META[k].icon;
            return (
              <button type="button"
                key={k}
                onClick={() => setKind(k)}
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-xs font-medium transition-colors",
                  kind === k ? "border-accent bg-accent-soft text-accent" : "border-border text-fg-muted hover:bg-subtle",
                )}
              >
                <Icon className="h-4 w-4" />
                {KIND_META[k].label}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-fg-subtle">{KIND_META[kind].hint}</p>
        <div>
          <Label htmlFor="auto-name" hint="선택 사항">
            이름
          </Label>
          <Input id="auto-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder={kind === "task_digest" ? "아침 우선순위" : "운동하기"} />
        </div>
        {needsMessage && (
          <div>
            <Label htmlFor="auto-message">{kind === "reminder" ? "알림 메시지" : "프롬프트"}</Label>
            <Textarea
              id="auto-message"
              rows={kind === "agent_prompt" ? 3 : 2}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={4000}
              placeholder={kind === "reminder" ? "운동할 시간입니다" : "남은 할 일을 검토하고 오늘의 우선순위 3가지를 제안해줘"}
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 sm:col-span-1">
            <Label htmlFor="auto-type">반복</Label>
            <Select id="auto-type" value={type} onChange={(e) => setType(e.target.value as ScheduleSpec["type"])}>
              <option value="once">한 번만</option>
              <option value="daily">매일</option>
              <option value="weekly">매주</option>
              <option value="monthly">매월</option>
              <option value="interval">N분마다</option>
            </Select>
          </div>
          <div className="col-span-2 sm:col-span-1">
            {type === "once" ? (
              <>
                <Label htmlFor="auto-at">일시</Label>
                <Input id="auto-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
              </>
            ) : type === "interval" ? (
              <>
                <Label htmlFor="auto-min">분</Label>
                <Input id="auto-min" type="number" min={15} max={44640} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
              </>
            ) : (
              <>
                <Label htmlFor="auto-time">시간</Label>
                <Input id="auto-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </>
            )}
          </div>
        </div>
        {type === "weekly" && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="요일 선택">
            {DAYS.map((d, i) => (
              <button type="button"
                key={d}
                onClick={() => setDays((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]))}
                aria-pressed={days.includes(i)}
                className={cn(
                  "h-9 w-11 rounded-lg border text-xs font-medium",
                  days.includes(i) ? "border-accent bg-accent-soft text-accent" : "border-border text-fg-muted",
                )}
              >
                {d}
              </button>
            ))}
          </div>
        )}
        {type === "monthly" && (
          <div>
            <Label htmlFor="auto-day" hint="해당 일자가 없는 달은 말일에 실행됩니다.">
              일
            </Label>
            <Input id="auto-day" type="number" min={1} max={31} value={day} onChange={(e) => setDay(Number(e.target.value))} />
          </div>
        )}
        <p className="rounded-lg bg-subtle px-3 py-2 text-xs text-fg-muted">
          {describeSchedule(schedule)} · {tz}
        </p>
      </div>
    </Dialog>
  );
}
