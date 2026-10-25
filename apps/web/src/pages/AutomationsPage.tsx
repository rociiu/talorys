import { useMemo, useState } from "react";
import { type Automation, type AutomationKind, type AutomationRun, type ScheduleSpec, describeSchedule, getZonedParts, scheduleSpecSchema, upcomingRuns } from "@talorys/shared";
import { AlarmClock, Bell, Bot, CalendarClock, ChevronDown, History, ListChecks, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { Badge, Button, Card, ConfirmDialog, Dialog, EmptyState, ErrorNotice, Input, Label, PageHeader, Select, Spinner, Switch, Textarea } from "../components/ui";
import { keys, useApiMutation, useAutomationRuns, useAutomations } from "../hooks/queries";
import { api } from "../lib/api";
import { cn, formatDateTime, relativeTime } from "../lib/utils";
import { useI18n } from "../lib/i18n";

const KIND_META: Record<AutomationKind, { label: string; icon: typeof Bell; hint: string }> = {
  reminder: { label: "Reminder", icon: Bell, hint: "Shows your message in the notification center. No AI used." },
  task_digest: { label: "Task digest", icon: ListChecks, hint: "Summarizes overdue and due-today tasks. No AI used." },
  agent_prompt: { label: "AI routine", icon: Bot, hint: "Runs a prompt with read-only tools. Uses Workers AI and counts toward the daily scheduled-AI budget." },
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function AutomationsPage() {
  const i18n = useI18n();
  const { data, isLoading, error, refetch } = useAutomations();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const [history, setHistory] = useState<Automation | null>(null);
  const [runFilter, setRunFilter] = useState<RunFilter>("all");
  const tz = data?.timezone ?? "UTC";

  const toggle = useApiMutation(
    (a: Automation) => api(`/automations/${a.id}`, { method: "PATCH", body: { enabled: !a.enabled } }),
    { invalidate: [keys.automations] },
  );
  const remove = useApiMutation((id: string) => api(`/automations/${id}`, { method: "DELETE" }), {
    invalidate: [keys.automations],
    success: "Schedule deleted",
    onSuccess: () => setDeleting(null),
  });

  const runNow = useApiMutation(
    (a: Automation) => api<{ run: AutomationRun }>(`/automations/${a.id}/run`, { method: "POST" }),
    {
      invalidate: [keys.automations, keys.notifications],
      success: ({ run }) => (run.status === "error" ? `Run failed: ${run.error ?? "unknown error"}` : run.status === "skipped" ? "Run skipped" : "Ran successfully"),
    },
  );

  const recentRuns = useMemo(() => {
    if (!data) return [];
    if (runFilter === "error") return data.failed_runs;
    return runFilter === "all" ? data.runs : data.runs.filter((r) => r.status === runFilter);
  }, [data, runFilter]);
  const byId = useMemo(() => new Map((data?.automations ?? []).map((a) => [a.id, a])), [data]);

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
            {a.status === "failed" && <Badge tone="danger">Last run failed</Badge>}
            {a.status === "completed" && <Badge>Completed</Badge>}
            {a.status === "running" && <Badge tone="accent">Running</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-fg-muted">{a.schedule_description}</p>
          <p className="mt-0.5 text-xs text-fg-subtle">
            {a.next_run && a.enabled ? `Next: ${formatDateTime(a.next_run, tz, i18n.locale)} (${relativeTime(a.next_run, i18n)})` : a.status === "completed" ? "Finished" : a.enabled ? "Not scheduled" : "Paused"}
            {a.last_run && ` · Last run ${relativeTime(a.last_run, i18n)}`}
            {a.run_count > 0 && ` · ${a.run_count} run${a.run_count === 1 ? "" : "s"}`}
          </p>
          {a.last_error && <p className="mt-1 text-xs text-danger">{a.last_error}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => runNow.mutate(a)}
            disabled={a.status === "running" || (runNow.isPending && runNow.variables?.id === a.id)}
            aria-label={`Run ${a.name} now`}
            title="Run now"
          >
            {runNow.isPending && runNow.variables?.id === a.id ? <Spinner className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setHistory(a)} aria-label={`Run history for ${a.name}`} title="Run history">
            <History className="h-4 w-4" />
          </Button>
          {a.status !== "completed" && (
            <Switch checked={a.enabled} onChange={() => toggle.mutate(a)} label={a.enabled ? `Pause ${a.name}` : `Resume ${a.name}`} />
          )}
          <Button variant="ghost" size="icon" onClick={() => setEditing(a)} aria-label={`Edit ${a.name}`}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setDeleting(a)} aria-label={`Delete ${a.name}`}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </li>
    );
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
      <PageHeader
        title="Automations"
        description={<>Reminders and routines run inside your Cloudflare account, even when this page is closed. Times use {tz}.</>}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New
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
          title="No automations yet"
          action={<Button variant="outline" onClick={() => setCreating(true)}>Create a reminder</Button>}
        >
          Try asking in chat: “Remind me tomorrow at 9 AM to exercise” or “Every Friday, review my unfinished tasks.”
        </EmptyState>
      ) : (
        <div className="space-y-8">
          {upcoming.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">Upcoming</h2>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {upcoming.map((a) => (
                  <div key={a.id} className="min-w-44 rounded-xl border border-border bg-surface px-4 py-3">
                    <AlarmClock className="h-4 w-4 text-accent" />
                    <p className="mt-2 truncate text-sm font-medium">{a.name}</p>
                    <p className="text-xs text-fg-subtle">{relativeTime(a.next_run, i18n)}</p>
                    <p className="text-xs text-fg-subtle">{formatDateTime(a.next_run, tz, i18n.locale)}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
          {active.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">Active schedules</h2>
              <Card>
                <ul className="divide-y divide-border">{active.map(row)}</ul>
              </Card>
            </section>
          )}
          {inactive.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">Paused & completed</h2>
              <Card>
                <ul className="divide-y divide-border">{inactive.map(row)}</ul>
              </Card>
            </section>
          )}
          <section>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">Recent executions</h2>
              <RunFilterTabs value={runFilter} onChange={setRunFilter} />
            </div>
            {!recentRuns.length ? (
              <p className="text-sm text-fg-subtle">{runFilter === "all" ? "Nothing has run yet." : `No ${RUN_FILTERS[runFilter].toLowerCase()} runs.`}</p>
            ) : (
              <Card>
                <ul className="divide-y divide-border">
                  {recentRuns.slice(0, 20).map((r) => {
                    const owner = byId.get(r.automation_id);
                    return <RunItem key={r.id} run={r} tz={tz} showName onOpenHistory={owner ? () => setHistory(owner) : undefined} />;
                  })}
                </ul>
              </Card>
            )}
          </section>
        </div>
      )}

      <AutomationForm key={editing?.id ?? "new"} open={creating || !!editing} onClose={() => (editing ? setEditing(null) : setCreating(false))} tz={tz} automation={editing} />
      <RunHistoryDialog key={history?.id ?? "none"} automation={history} tz={tz} onClose={() => setHistory(null)} />
      <ConfirmDialog
        open={!!deleting}
        title="Delete schedule?"
        message={`“${deleting?.name}” will stop running and be removed.`}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        loading={remove.isPending}
      />
    </div>
  );
}

type RunFilter = "all" | "error" | "skipped";
const RUN_FILTERS: Record<RunFilter, string> = { all: "All", error: "Failed", skipped: "Skipped" };
const RUN_TONE = { success: "success", error: "danger", skipped: "warning", running: "accent" } as const;
const RUN_LABEL = { success: "Success", error: "Failed", skipped: "Skipped", running: "Running" } as const;

function RunFilterTabs({ value, onChange }: { value: RunFilter; onChange: (v: RunFilter) => void }) {
  return (
    <div className="flex gap-1 rounded-lg bg-subtle p-0.5" role="group" aria-label="Filter runs">
      {(Object.keys(RUN_FILTERS) as RunFilter[]).map((f) => (
        <button
          type="button"
          key={f}
          onClick={() => onChange(f)}
          aria-pressed={value === f}
          className={cn("rounded-md px-2 py-0.5 text-xs font-medium", value === f ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg")}
        >
          {RUN_FILTERS[f]}
        </button>
      ))}
    </div>
  );
}

function duration(run: AutomationRun): string {
  if (!run.finished_at) return "";
  const ms = Date.parse(run.finished_at) - Date.parse(run.started_at);
  if (!(ms >= 0)) return "";
  return ms < 1000 ? "<1s" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** One execution; click to expand the full output or error. */
function RunItem({ run, tz, showName, onOpenHistory }: { run: AutomationRun; tz: string; showName?: boolean; onOpenHistory?: () => void }) {
  const i18n = useI18n();
  const [open, setOpen] = useState(false);
  const detail = run.error ?? run.result ?? (run.status === "running" ? "Running…" : "");
  const took = duration(run);
  return (
    <li className="text-sm">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-subtle">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">
            {showName ? run.automation_name : formatDateTime(run.started_at, tz, i18n.locale)}
          </p>
          <p className={cn("text-xs", open ? "hidden" : "truncate", run.status === "error" ? "text-danger" : "text-fg-subtle")}>{detail}</p>
        </div>
        <div className="shrink-0 text-right">
          <Badge tone={RUN_TONE[run.status]}>{RUN_LABEL[run.status]}</Badge>
          <p className="mt-0.5 text-xs text-fg-subtle" title={formatDateTime(run.started_at, tz, i18n.locale)}>
            {relativeTime(run.started_at, i18n)}
            {took && ` · ${took}`}
          </p>
        </div>
        <ChevronDown className={cn("mt-1 h-4 w-4 shrink-0 text-fg-subtle transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-2 px-4 pb-3">
          {detail ? (
            <p className={cn("whitespace-pre-wrap break-words rounded-lg bg-subtle px-3 py-2 text-xs", run.status === "error" ? "text-danger" : "text-fg-muted")}>{detail}</p>
          ) : (
            <p className="text-xs text-fg-subtle">No output recorded.</p>
          )}
          <p className="text-xs text-fg-subtle">
            Started {formatDateTime(run.started_at, tz, i18n.locale)}
            {run.finished_at && ` · finished ${formatDateTime(run.finished_at, tz, i18n.locale)}`}
            {onOpenHistory && (
              <>
                {" · "}
                <button type="button" onClick={onOpenHistory} className="text-accent hover:underline">
                  All runs of this automation
                </button>
              </>
            )}
          </p>
        </div>
      )}
    </li>
  );
}

function RunHistoryDialog({ automation, tz, onClose }: { automation: Automation | null; tz: string; onClose: () => void }) {
  const [filter, setFilter] = useState<RunFilter>("all");
  const query = useAutomationRuns(automation?.id ?? null, filter === "all" ? undefined : filter);
  const runs = query.data?.pages.flatMap((p) => p.runs) ?? [];
  return (
    <Dialog open={!!automation} onClose={onClose} title={automation ? `Run history · ${automation.name}` : "Run history"}>
      {automation && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-fg-subtle">
              {automation.schedule_description}
              {automation.run_count > 0 && ` · ${automation.run_count} run${automation.run_count === 1 ? "" : "s"} in total`}
            </p>
            <RunFilterTabs value={filter} onChange={setFilter} />
          </div>
          {query.error ? (
            <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />
          ) : query.isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : !runs.length ? (
            <p className="py-6 text-center text-sm text-fg-subtle">{filter === "all" ? "This automation hasn't run yet." : `No ${RUN_FILTERS[filter].toLowerCase()} runs.`}</p>
          ) : (
            <Card>
              <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto">
                {runs.map((r) => (
                  <RunItem key={r.id} run={r} tz={tz} />
                ))}
              </ul>
            </Card>
          )}
          {query.hasNextPage && (
            <Button variant="outline" className="w-full" onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>
              Load more
            </Button>
          )}
        </div>
      )}
    </Dialog>
  );
}

/**
 * "YYYY-MM-DDTHH:MM" for 09:00 on the next calendar day in `timeZone`.
 * A one-off schedule is read in the owner's timezone, which may not be this browser's,
 * and a 24-hour jump can land on the day after tomorrow when daylight saving starts.
 */
export function tomorrowAt9(timeZone: string, now = new Date()): string {
  const today = getZonedParts(now, timeZone);
  const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}T09:00`;
}

function AutomationForm({ open, onClose, tz, automation }: { open: boolean; onClose: () => void; tz: string; automation?: Automation | null }) {
  const i18n = useI18n();
  // Remounted per automation (via `key`), so editing starts from the saved values.
  const initial = automation?.schedule;
  const [kind, setKind] = useState<AutomationKind>(automation?.kind ?? "reminder");
  const [name, setName] = useState(automation?.name ?? "");
  const [message, setMessage] = useState(automation?.message ?? "");
  const [type, setType] = useState<ScheduleSpec["type"]>(initial?.type ?? "once");
  const [at, setAt] = useState(initial?.type === "once" ? initial.at : tomorrowAt9(tz));
  const [time, setTime] = useState(initial && "time" in initial ? initial.time : "09:00");
  const [days, setDays] = useState<number[]>(initial?.type === "weekly" ? initial.days : [1]);
  const [day, setDay] = useState(initial?.type === "monthly" ? initial.day : 1);
  const [minutes, setMinutes] = useState(initial?.type === "interval" ? initial.minutes : 60);

  const schedule: ScheduleSpec =
    type === "once"
      ? { type, at }
      : type === "daily"
        ? { type, time }
        : type === "weekly"
          ? { type, days, time }
          : type === "monthly"
            ? { type, day, time }
            : { type, minutes };

  const preview = useMemo(() => {
    const parsed = scheduleSpecSchema.safeParse(schedule);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid schedule", runs: [] as Date[] };
    const runs = upcomingRuns(parsed.data, tz, new Date(), 3);
    if (!runs.length) return { error: type === "once" ? "That time is in the past. Choose a future time." : "This schedule never runs.", runs };
    return { error: null, runs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(schedule), tz]);

  const reset = () => {
    setName("");
    setMessage("");
    setKind("reminder");
    setType("once");
    setAt(tomorrowAt9(tz));
  };
  const save = useApiMutation(
    () => {
      const finalName = name.trim() || message.trim().slice(0, 80) || KIND_META[kind].label;
      if (!automation) return api("/automations", { method: "POST", body: { name: finalName, kind, message, schedule } });
      // Saving a finished one-off with a new schedule brings it back to life.
      const revive = automation.status === "completed" ? { enabled: true } : {};
      return api(`/automations/${automation.id}`, { method: "PATCH", body: { name: finalName, message, schedule, ...revive } });
    },
    {
      invalidate: [keys.automations],
      success: automation ? "Saved" : "Scheduled",
      onSuccess: () => {
        if (!automation) reset();
        onClose();
      },
    },
  );
  const needsMessage = kind !== "task_digest";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={automation ? "Edit automation" : "New automation"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={(needsMessage && !message.trim()) || !!preview.error}>
            {automation ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!automation && (
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
        )}
        <p className="text-xs text-fg-subtle">{KIND_META[kind].hint}</p>
        <div>
          <Label htmlFor="auto-name" hint="Optional">
            Name
          </Label>
          <Input id="auto-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder={kind === "task_digest" ? "Morning priorities" : "Exercise"} />
        </div>
        {needsMessage && (
          <div>
            <Label htmlFor="auto-message">{kind === "reminder" ? "Reminder message" : "Prompt"}</Label>
            <Textarea
              id="auto-message"
              rows={kind === "agent_prompt" ? 3 : 2}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={4000}
              placeholder={kind === "reminder" ? "Time to exercise" : "Review my unfinished tasks and suggest three priorities"}
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 sm:col-span-1">
            <Label htmlFor="auto-type">Repeat</Label>
            <Select id="auto-type" value={type} onChange={(e) => setType(e.target.value as ScheduleSpec["type"])}>
              <option value="once">Once</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="interval">Every N minutes</option>
            </Select>
          </div>
          <div className="col-span-2 sm:col-span-1">
            {type === "once" ? (
              <>
                <Label htmlFor="auto-at">When</Label>
                <Input id="auto-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
              </>
            ) : type === "interval" ? (
              <>
                <Label htmlFor="auto-min" hint="At least 15">Minutes</Label>
                <Input id="auto-min" type="number" min={15} max={44640} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
              </>
            ) : (
              <>
                <Label htmlFor="auto-time">Time</Label>
                <Input id="auto-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </>
            )}
          </div>
        </div>
        {type === "weekly" && (
          <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {([["Weekdays", [1, 2, 3, 4, 5]], ["Weekends", [0, 6]], ["Every day", [0, 1, 2, 3, 4, 5, 6]]] as const).map(([label, set]) => (
              <button
                type="button"
                key={label}
                onClick={() => setDays([...set])}
                className="rounded-full border border-border px-2.5 py-0.5 text-xs text-fg-muted hover:bg-subtle"
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days of week">
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
          </div>
        )}
        {type === "monthly" && (
          <div>
            <Label htmlFor="auto-day" hint="Months without this day use their last day.">
              Day of month
            </Label>
            <Input id="auto-day" type="number" min={1} max={31} value={day} onChange={(e) => setDay(Number(e.target.value))} />
          </div>
        )}
        <p className="rounded-lg bg-subtle px-3 py-2 text-xs text-fg-muted">
          <span className="font-medium text-fg">{type === "weekly" && !days.length ? "No days selected" : describeSchedule(schedule)}</span> · {tz}
          {preview.error ? (
            <span className="mt-1 block text-danger">{preview.error}</span>
          ) : (
            <span className="mt-1 block">
              {preview.runs.length === 1 ? "Runs " : "Next runs: "}
              {preview.runs.map((d) => `${formatDateTime(d.toISOString(), tz, i18n.locale)} (${relativeTime(d.toISOString(), i18n)})`).join(" · ")}
            </span>
          )}
        </p>
      </div>
    </Dialog>
  );
}
