import { type FormEvent, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { zonedTimeToUtc, type Task, type TaskPriority } from "@talorys/shared";
import { ArrowUpRight, CalendarDays, CheckCircle2, Circle, CircleDot, Flag, Plus, X } from "lucide-react";
import { TaskEditor } from "../components/TaskEditor";
import { Badge, Button, EmptyState, ErrorNotice, Input, PageHeader, Spinner } from "../components/ui";
import { keys, useApiMutation, useProjects, useTasks, useTimezone } from "../hooks/queries";
import { api } from "../lib/api";
import { cn, formatDue } from "../lib/utils";
import { type MessageKey, useI18n } from "../lib/i18n";

type Tab = "today" | "overdue" | "upcoming" | "completed";

function endOfLocalDay(tz: string, offsetDays = 0): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  const d = new Date(Date.UTC(+p.year!, +p.month! - 1, +p.day! + offsetDays));
  return zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 23, 59, tz).toISOString();
}

const PRIORITY_TONE: Record<TaskPriority, "neutral" | "accent" | "warning" | "danger"> = {
  low: "neutral",
  medium: "neutral",
  high: "warning",
  urgent: "danger",
};

const PRIORITY_KEYS = {
  low: "tasks.priorityLow",
  medium: "tasks.priorityMedium",
  high: "tasks.priorityHigh",
  urgent: "tasks.priorityUrgent",
} as const satisfies Record<TaskPriority, MessageKey>;

const TAB_KEYS = {
  today: "tasks.tabToday",
  overdue: "tasks.tabOverdue",
  upcoming: "tasks.tabUpcoming",
  completed: "tasks.tabCompleted",
} as const satisfies Record<Tab, MessageKey>;

export default function TasksPage() {
  const i18n = useI18n();
  const { t } = i18n;
  const tz = useTimezone();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("project");
  const initialView = searchParams.get("view");
  const [tab, setTab] = useState<Tab>(initialView === "overdue" || initialView === "upcoming" || initialView === "completed" ? initialView : "today");
  const { data: tasks, isLoading, error, refetch } = useTasks(projectId ?? undefined);
  const projects = useProjects();
  const [quick, setQuick] = useState("");
  const project = projects.data?.find((p) => p.id === projectId);
  const editing = tasks?.find((task) => task.id === searchParams.get("task")) ?? null;

  const sections = useMemo(() => {
    const todayEnd = endOfLocalDay(tz);
    const nowIso = new Date().toISOString();
    const open = (tasks ?? []).filter((task) => task.status !== "done");
    return {
      overdue: open.filter((task) => task.due_at && task.due_at < nowIso),
      today: open.filter((task) => (task.due_at && task.due_at <= todayEnd) || (!task.due_at && task.status === "in_progress")),
      upcoming: open.filter((task) => !((task.due_at && task.due_at <= todayEnd) || (!task.due_at && task.status === "in_progress"))),
      completed: (tasks ?? []).filter((task) => task.status === "done").sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? "")),
    };
  }, [tasks, tz]);

  const create = useApiMutation(
    (title: string) => api("/tasks", { method: "POST", body: { title, due_at: tab === "today" || tab === "overdue" ? endOfLocalDay(tz) : null, project_id: projectId } }),
    { invalidate: [keys.tasks, keys.today], onSuccess: () => setQuick("") },
  );
  const toggle = useApiMutation(
    (task: Task) => api(`/tasks/${task.id}`, { method: "PATCH", body: { status: task.status === "done" ? "todo" : "done" } }),
    { invalidate: [keys.tasks, keys.today] },
  );

  function submitQuick(e: FormEvent) {
    e.preventDefault();
    if (quick.trim()) create.mutate(quick.trim());
  }

  function openTask(task: Task) {
    const next = new URLSearchParams(searchParams);
    next.set("task", task.id);
    setSearchParams(next);
  }

  function closeTask() {
    const next = new URLSearchParams(searchParams);
    next.delete("task");
    setSearchParams(next, { replace: true });
  }

  function changeTab(nextTab: Tab) {
    setTab(nextTab);
    if (searchParams.has("view")) {
      const next = new URLSearchParams(searchParams);
      next.delete("view");
      setSearchParams(next, { replace: true });
    }
  }

  const list = sections[tab];
  const projectName = (id: string | null) => projects.data?.find((p) => p.id === id)?.name;
  const nowIso = new Date().toISOString();

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
      <PageHeader
        title={project ? project.name : t("tasks.title")}
        description={project ? project.description || t("tasks.projectTasks") : t("tasks.description")}
        actions={project ? <Link to={`/projects/${project.id}`} className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-sm font-medium hover:bg-subtle">{t("tasks.viewProject")} <ArrowUpRight className="h-4 w-4" /></Link> : undefined}
      />

      {projectId && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-subtle px-3 py-2 text-sm">
          <span className="truncate">{t("tasks.filteredProject", { name: project?.name ?? projectId })}</span>
          <Link to="/tasks" className="inline-flex shrink-0 items-center gap-1 font-medium text-accent hover:underline"><X className="h-3.5 w-3.5" />{t("tasks.clearFilter")}</Link>
        </div>
      )}

      <div role="tablist" className="mb-5 flex gap-1 overflow-x-auto rounded-lg bg-muted p-1">
        {(["today", "overdue", "upcoming", "completed"] as Tab[]).map((name) => (
          <button
            type="button"
            key={name}
            role="tab"
            aria-selected={tab === name}
            onClick={() => changeTab(name)}
            className={cn(
              "min-w-0 flex-1 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === name ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg",
            )}
          >
            {t(TAB_KEYS[name])}<span className="ml-1.5 text-xs text-fg-subtle">{sections[name].length}</span>
          </button>
        ))}
      </div>

      {tab !== "completed" && (
        <form onSubmit={submitQuick} className="mb-4 flex gap-2">
          <Input
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            placeholder={tab === "today" || tab === "overdue" ? t("tasks.addForToday") : t("tasks.addOne")}
            maxLength={300}
            aria-label={t("tasks.newTitle")}
            autoFocus={searchParams.get("new") === "1"}
          />
          <Button type="submit" loading={create.isPending} disabled={!quick.trim()} aria-label={t("tasks.addTask")}>
            <Plus className="h-4 w-4" /><span className="hidden sm:inline">{t("tasks.add")}</span>
          </Button>
        </form>
      )}

      {error ? (
        <ErrorNotice error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : list.length === 0 ? (
        <EmptyState icon={<CheckCircle2 className="h-9 w-9" />} title={tab === "completed" ? t("tasks.emptyCompletedTitle") : t("tasks.emptyTitle")}>
          {tab === "today" ? t("tasks.emptyToday") : tab === "overdue" ? t("tasks.emptyOverdue") : tab === "upcoming" ? t("tasks.emptyUpcoming") : t("tasks.emptyCompleted")}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
          {list.map((task) => {
            const overdue = task.status !== "done" && task.due_at && task.due_at < nowIso;
            const due = task.due_at ? formatDue(task.due_at, tz, i18n.locale) : "";
            return (
              <li key={task.id} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-subtle">
                <button
                  type="button"
                  onClick={() => toggle.mutate(task)}
                  disabled={toggle.isPending && toggle.variables?.id === task.id}
                  className="mt-0.5 text-fg-subtle transition-colors hover:text-accent disabled:opacity-50"
                  aria-label={task.status === "done" ? t("tasks.markNotDone", { title: task.title }) : t("tasks.complete", { title: task.title })}
                >
                  {task.status === "done" ? <CheckCircle2 className="h-5 w-5 text-accent" /> : task.status === "in_progress" ? <CircleDot className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
                </button>
                <button type="button" onClick={() => openTask(task)} className="min-w-0 flex-1 text-left">
                  <p className={cn("text-[15px] leading-6", task.status === "done" && "text-fg-subtle line-through")}>{task.title}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
                    {task.due_at && <span className={cn("inline-flex items-center gap-1", overdue && "font-medium text-danger")}><CalendarDays className="h-3 w-3" />{overdue ? t("tasks.overdue", { due }) : due}</span>}
                    {projectName(task.project_id) && <span>{projectName(task.project_id)}</span>}
                    {task.description && <span className="max-w-[16rem] truncate">{task.description}</span>}
                  </div>
                </button>
                {(task.priority === "high" || task.priority === "urgent") && task.status !== "done" && (
                  <Badge tone={PRIORITY_TONE[task.priority]} className="mt-0.5"><Flag className="mr-1 h-3 w-3" />{t(PRIORITY_KEYS[task.priority])}</Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <TaskEditor task={editing} onClose={closeTask} tz={tz} />
    </div>
  );
}
