import { type FormEvent, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { zonedTimeToUtc, type Task, type TaskCategory, type TaskPriority } from "@talorys/shared";
import { ArrowUpRight, CalendarDays, CheckCircle2, Circle, CircleDot, Flag, Plus, X } from "lucide-react";
import { TaskEditor } from "../components/TaskEditor";
import { Badge, Button, EmptyState, ErrorNotice, Input, PageHeader, Spinner } from "../components/ui";
import { taskDataKeys, useApiMutation, useProjects, useTask, useTaskCategory, useTimezone } from "../hooks/queries";
import { api } from "../lib/api";
import { cn, formatDue } from "../lib/utils";
import { type MessageKey, useI18n } from "../lib/i18n";

function endOfLocalDay(tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return zonedTimeToUtc(+p.year!, +p.month!, +p.day!, 23, 59, tz).toISOString();
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
  unscheduled: "tasks.tabUnscheduled",
  open: "tasks.tabOpen",
  completed: "tasks.tabCompleted",
} as const satisfies Record<TaskCategory, MessageKey>;

const TABS = Object.keys(TAB_KEYS) as TaskCategory[];
const EMPTY_KEYS = {
  today: "tasks.emptyToday",
  overdue: "tasks.emptyOverdue",
  upcoming: "tasks.emptyUpcoming",
  unscheduled: "tasks.emptyUnscheduled",
  open: "tasks.emptyOpen",
  completed: "tasks.emptyCompleted",
} as const satisfies Record<TaskCategory, MessageKey>;

export default function TasksPage() {
  const i18n = useI18n();
  const { t } = i18n;
  const tz = useTimezone();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("project");
  const tab = TABS.find((name) => name === searchParams.get("view")) ?? "today";
  const limit = tab === "completed" ? 200 : 500;
  const requestedPage = Number(searchParams.get("page"));
  const page = Number.isSafeInteger(requestedPage * limit) && Number.isInteger(requestedPage) ? Math.max(1, requestedPage) : 1;
  const offset = (page - 1) * limit;
  const { data, isLoading, error, refetch } = useTaskCategory(tab, projectId, limit, offset);
  const editing = useTask(searchParams.get("task"));
  const projects = useProjects();
  const [quick, setQuick] = useState("");
  const project = projects.data?.find((p) => p.id === projectId);
  const addForToday = tab === "today" || tab === "overdue";

  const create = useApiMutation(
    (title: string) => api("/tasks", { method: "POST", body: { title, due_at: addForToday ? endOfLocalDay(tz) : null, project_id: projectId } }),
    { invalidate: taskDataKeys, onSuccess: () => {
      setQuick("");
      if (tab === "overdue") changeTab("today");
      if (tab === "upcoming") changeTab("unscheduled");
    } },
  );
  const toggle = useApiMutation(
    (task: Task) => api(`/tasks/${task.id}`, { method: "PATCH", body: { status: task.status === "done" ? "todo" : "done" } }),
    { invalidate: taskDataKeys },
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

  function changeTab(nextTab: TaskCategory) {
    if (tab === nextTab) return;
    const next = new URLSearchParams(searchParams);
    next.set("view", nextTab);
    next.delete("page");
    setSearchParams(next);
  }

  function changePage(nextPage: number) {
    const next = new URLSearchParams(searchParams);
    if (nextPage === 1) next.delete("page");
    else next.set("page", String(nextPage));
    setSearchParams(next);
  }

  const list = data?.tasks ?? [];
  const total = data?.counts[tab];
  const projectName = (id: string | null) => projects.data?.find((p) => p.id === id)?.name;
  const now = Date.now();

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

      <div role="tablist" className="mb-5 flex flex-wrap gap-1 rounded-lg bg-muted p-1">
        {TABS.map((name) => (
          <button
            type="button"
            key={name}
            role="tab"
            aria-selected={tab === name}
            onClick={() => changeTab(name)}
            className={cn(
              "grow whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === name ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg",
            )}
          >
            {t(TAB_KEYS[name])}{data && <span className="ml-1.5 text-xs text-fg-subtle">{data.counts[name]}</span>}
          </button>
        ))}
      </div>

      {tab !== "completed" && (
        <form onSubmit={submitQuick} className="mb-4 flex gap-2">
          <Input
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            placeholder={addForToday ? t("tasks.addForToday") : t("tasks.addOne")}
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
          {offset && total ? t("tasks.emptyPage") : t(EMPTY_KEYS[tab])}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
          {list.map((task) => {
            const overdue = task.status !== "done" && task.due_at && Date.parse(task.due_at) < now;
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

      {!error && total !== undefined && (page > 1 || total > limit) && (
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" disabled={page === 1} onClick={() => changePage(page - 1)}>{t("tasks.previousPage")}</Button>
          <Button variant="secondary" disabled={offset + limit >= total} onClick={() => changePage(page + 1)}>{t("tasks.nextPage")}</Button>
        </div>
      )}
      {editing.error && (
        <div className="mt-4 space-y-2">
          <ErrorNotice error={editing.error} onRetry={() => void editing.refetch()} />
          <Button variant="secondary" onClick={closeTask}>{t("common.close")}</Button>
        </div>
      )}
      <TaskEditor task={editing.data ?? null} onClose={closeTask} tz={tz} />
    </div>
  );
}
