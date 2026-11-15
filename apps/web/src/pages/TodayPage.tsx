import { useState } from "react";
import { Link } from "react-router";
import { getZonedParts, type Task, type TodayProject, type TodaySuggestion } from "@talorys/shared";
import { AlarmClock, ArrowRight, ArrowUpRight, CalendarDays, CheckCircle2, Circle, CircleDot, Flag, FolderKanban, Lightbulb, MessageSquare, Plus, X } from "lucide-react";
import { OnboardingCard } from "../components/OnboardingCard";
import { TaskEditor } from "../components/TaskEditor";
import { Badge, Button, ErrorNotice } from "../components/ui";
import { keys, useApiMutation, useSettings, useToday } from "../hooks/queries";
import { api } from "../lib/api";
import { cn, formatDue, formatDateTime, relativeTime } from "../lib/utils";
import { useI18n } from "../lib/i18n";

export function greetingKey(hour: number): "today.goodMorning" | "today.goodAfternoon" | "today.goodEvening" {
  if (hour < 12) return "today.goodMorning";
  if (hour < 18) return "today.goodAfternoon";
  return "today.goodEvening";
}

export default function TodayPage() {
  const i18n = useI18n();
  const { t } = i18n;
  const today = useToday();
  const settings = useSettings();
  const [editing, setEditing] = useState<Task | null>(null);
  const [suggestionVisible, setSuggestionVisible] = useState(true);
  const toggle = useApiMutation(
    (task: Task) => api(`/tasks/${task.id}`, { method: "PATCH", body: { status: "done" } }),
    { invalidate: [keys.today, keys.tasks], success: t("today.completed") },
  );
  const data = today.data;
  const timezone = data?.timezone ?? settings.data?.timezone ?? "UTC";
  const hour = data ? getZonedParts(new Date(data.generated_at), data.timezone).hour : new Date().getHours();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 md:px-8 md:py-8">
      <header className="flex flex-wrap items-end justify-between gap-4 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">{t(greetingKey(hour))}</h1>
          <p className="mt-1 text-sm text-fg-muted">
            {data
              ? new Intl.DateTimeFormat(i18n.locale, { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${data.local_date}T12:00:00Z`))
              : t("today.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/tasks?new=1" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-sm font-medium hover:bg-subtle"><Plus className="h-4 w-4" />{t("today.addTask")}</Link>
          <Link to="/chat" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg hover:opacity-90"><MessageSquare className="h-4 w-4" />{t("today.ask")}</Link>
        </div>
      </header>

      {today.error ? (
        <div className="space-y-4">
          <ErrorNotice error={today.error} onRetry={() => void today.refetch()} />
          <p className="text-sm text-fg-muted">{t("today.errorHint")} <Link to="/tasks" className="font-medium text-accent hover:underline">{t("nav.tasks")}</Link> · <Link to="/automations" className="font-medium text-accent hover:underline">{t("nav.automations")}</Link></p>
        </div>
      ) : today.isLoading || !data ? (
        <TodayLoading />
      ) : (
        <div className="space-y-6 animate-fade-in">
          <OnboardingCard />
          {data.suggestion && suggestionVisible && <SuggestionCard suggestion={data.suggestion} onDismiss={() => setSuggestionVisible(false)} />}

          <section aria-label={t("today.overview")} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryCard to="/tasks?view=overdue" value={data.counts.overdue} label={t("today.overdue")} tone={data.counts.overdue ? "danger" : undefined} />
            <SummaryCard to="/tasks" value={data.counts.today} label={t("today.dueToday")} />
            <SummaryCard to="/tasks?view=upcoming" value={data.counts.upcoming} label={t("today.upcoming")} />
            <SummaryCard to="/tasks" value={data.counts.open} label={t("today.openTasks")} />
          </section>

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(17rem,1fr)]">
            <section aria-labelledby="focus-heading" className="overflow-hidden rounded-xl border border-border bg-surface">
              <SectionHeading id="focus-heading" title={t("today.focus")} description={t("today.focusHint")} action={<Link to="/tasks" className="text-xs font-medium text-accent hover:underline">{t("today.allTasks")}</Link>} />
              {data.focus.length ? (
                <ul className="divide-y divide-border border-t border-border">
                  {data.focus.map((task) => <TaskRow key={task.id} task={task} timezone={timezone} projects={data.projects} onOpen={() => setEditing(task)} onComplete={() => toggle.mutate(task)} completing={toggle.isPending && toggle.variables?.id === task.id} focus />)}
                </ul>
              ) : (
                <div className="border-t border-border px-5 py-8 text-center">
                  <CheckCircle2 className="mx-auto h-7 w-7 text-success" />
                  <p className="mt-3 text-sm font-medium">{t("today.focusEmpty")}</p>
                  <p className="mt-1 text-sm text-fg-muted">{t("today.focusEmptyHint")}</p>
                  <Link to="/tasks?new=1" className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"><Plus className="h-4 w-4" />{t("today.addFirstTask")}</Link>
                </div>
              )}
            </section>

            <section aria-labelledby="events-heading" className="overflow-hidden rounded-xl border border-border bg-surface">
              <SectionHeading id="events-heading" title={t("today.nextEvents")} description={t("today.nextEventsHint")} action={<Link to="/automations" className="text-xs font-medium text-accent hover:underline">{t("today.manage")}</Link>} />
              {data.automations.length ? (
                <ul className="divide-y divide-border border-t border-border">
                  {data.automations.map((automation) => {
                    const overdue = !!automation.next_run && automation.next_run < data.generated_at;
                    return (
                      <li key={automation.id}>
                        <Link to={`/automations?edit=${automation.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-subtle">
                          <AlarmClock className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" />
                          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{automation.name}</span><span className="mt-0.5 block text-xs text-fg-subtle">{formatDateTime(automation.next_run, timezone, i18n.locale)}</span></span>
                          {overdue && <Badge tone="warning">{t("today.overdue")}</Badge>}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="border-t border-border px-5 py-7 text-center"><p className="text-sm font-medium">{t("today.noEvents")}</p><p className="mt-1 text-xs leading-5 text-fg-muted">{t("today.noEventsHint")}</p><Link to="/automations?new=1" className="mt-3 inline-flex text-sm font-medium text-accent hover:underline">{t("today.createReminder")}</Link></div>
              )}
            </section>
          </div>

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(17rem,1fr)]">
            <section aria-labelledby="projects-heading" className="overflow-hidden rounded-xl border border-border bg-surface">
              <SectionHeading id="projects-heading" title={t("today.projects")} description={t("today.projectsHint")} action={<Link to="/projects" className="text-xs font-medium text-accent hover:underline">{t("today.allProjects")}</Link>} />
              {data.projects.length ? (
                <ul className="divide-y divide-border border-t border-border">{data.projects.map((project) => <ProjectRow key={project.id} project={project} timezone={timezone} />)}</ul>
              ) : (
                <div className="border-t border-border px-5 py-7 text-center"><FolderKanban className="mx-auto h-6 w-6 text-fg-subtle" /><p className="mt-2 text-sm font-medium">{t("today.noProjects")}</p><p className="mt-1 text-xs text-fg-muted">{t("today.noProjectsHint")}</p><Link to="/projects" className="mt-3 inline-flex text-sm font-medium text-accent hover:underline">{t("today.createProject")}</Link></div>
              )}
            </section>

            <TaskGroup title={t("today.upcomingTasks")} tasks={data.tasks.upcoming} timezone={timezone} projects={data.projects} onOpen={setEditing} onComplete={(task) => toggle.mutate(task)} completingId={toggle.isPending ? toggle.variables?.id : undefined} viewAll="/tasks?view=upcoming" empty={t("today.noUpcoming")} />
          </div>

          <section aria-labelledby="schedule-heading" className="rounded-xl border border-border bg-surface">
            <SectionHeading id="schedule-heading" title={t("today.taskSchedule")} description={t("today.taskScheduleHint")} />
            <div className="grid border-t border-border md:grid-cols-2">
              <TaskGroup title={t("today.overdueTasks")} tasks={data.tasks.overdue} timezone={timezone} projects={data.projects} onOpen={setEditing} onComplete={(task) => toggle.mutate(task)} completingId={toggle.isPending ? toggle.variables?.id : undefined} viewAll="/tasks?view=overdue" empty={t("today.noOverdue")} embedded />
              <TaskGroup title={t("today.todayTasks")} tasks={data.tasks.today} timezone={timezone} projects={data.projects} onOpen={setEditing} onComplete={(task) => toggle.mutate(task)} completingId={toggle.isPending ? toggle.variables?.id : undefined} viewAll="/tasks" empty={t("today.noToday")} embedded />
            </div>
          </section>
        </div>
      )}
      <TaskEditor task={editing} onClose={() => setEditing(null)} tz={timezone} />
    </div>
  );
}

function TodayLoading() {
  const { t } = useI18n();
  return <div role="status" aria-label={t("common.loading")} className="grid gap-4 sm:grid-cols-2"><div className="h-56 rounded-xl border border-border bg-surface" /><div className="h-56 rounded-xl border border-border bg-surface" /><div className="h-32 rounded-xl border border-border bg-surface sm:col-span-2" /><span className="sr-only">{t("common.loading")}</span></div>;
}

function SummaryCard({ to, value, label, tone }: { to: string; value: number; label: string; tone?: "danger" }) {
  return <Link to={to} className="rounded-xl border border-border bg-surface px-4 py-3 transition-colors hover:border-border-strong hover:bg-subtle"><p className={cn("text-2xl font-semibold tabular-nums", tone === "danger" && "text-danger")}>{value}</p><p className="mt-0.5 text-xs text-fg-muted">{label}</p></Link>;
}

function SectionHeading({ id, title, description, action }: { id: string; title: string; description?: string; action?: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-3 px-4 py-3.5"><div><h2 id={id} className="text-sm font-semibold">{title}</h2>{description && <p className="mt-0.5 text-xs text-fg-subtle">{description}</p>}</div>{action}</div>;
}

function TaskRow({ task, timezone, projects, onOpen, onComplete, completing, focus }: { task: Task; timezone: string; projects: TodayProject[]; onOpen: () => void; onComplete: () => void; completing?: boolean; focus?: boolean }) {
  const i18n = useI18n();
  const { t } = i18n;
  const overdue = !!task.due_at && task.due_at < new Date().toISOString();
  const project = projects.find((item) => item.id === task.project_id);
  return (
    <li className={cn("flex items-start gap-3 px-4 hover:bg-subtle", focus ? "py-4" : "py-3")}>
      <button type="button" onClick={onComplete} disabled={completing} className="mt-0.5 shrink-0 text-fg-subtle hover:text-accent disabled:opacity-50" aria-label={t("tasks.complete", { title: task.title })}>
        {task.status === "in_progress" ? <CircleDot className="h-5 w-5 text-accent" /> : <Circle className="h-5 w-5" />}
      </button>
      <div className="min-w-0 flex-1">
        <button type="button" onClick={onOpen} className="block max-w-full text-left"><span className={cn("block [overflow-wrap:anywhere]", focus ? "text-[15px] font-medium" : "text-sm")}>{task.title}</span></button>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
          {task.due_at && <span className={cn("inline-flex items-center gap-1", overdue && "font-medium text-danger")}><CalendarDays className="h-3 w-3" />{formatDue(task.due_at, timezone, i18n.locale)}</span>}
          {task.project_id && <Link to={`/projects/${task.project_id}`} className="inline-flex items-center gap-0.5 text-accent hover:underline">{project?.name ?? t("tasks.viewProject")}<ArrowUpRight className="h-3 w-3" /></Link>}
          {(task.priority === "high" || task.priority === "urgent") && <span className={cn("inline-flex items-center gap-1", task.priority === "urgent" ? "text-danger" : "text-warning")}><Flag className="h-3 w-3" />{t(task.priority === "urgent" ? "tasks.priorityUrgent" : "tasks.priorityHigh")}</span>}
        </div>
      </div>
      <Button variant="ghost" size="icon" onClick={onOpen} aria-label={t("today.openTask", { title: task.title })} className="-mr-2 h-8 w-8"><ArrowUpRight className="h-4 w-4" /></Button>
    </li>
  );
}

function TaskGroup({ title, tasks, timezone, projects, onOpen, onComplete, completingId, viewAll, empty, embedded }: { title: string; tasks: Task[]; timezone: string; projects: TodayProject[]; onOpen: (task: Task) => void; onComplete: (task: Task) => void; completingId?: string; viewAll: string; empty: string; embedded?: boolean }) {
  const { t } = useI18n();
  return (
    <section className={cn(!embedded && "overflow-hidden rounded-xl border border-border bg-surface", embedded && "min-w-0 border-border first:max-md:border-b md:first:border-r")}>
      <div className="flex items-center justify-between gap-3 px-4 py-3"><h2 className="text-sm font-semibold">{title}<span className="ml-1.5 text-xs font-normal text-fg-subtle">{tasks.length}</span></h2><Link to={viewAll} className="text-xs font-medium text-accent hover:underline">{t("today.viewAll")}</Link></div>
      {tasks.length ? <ul className="divide-y divide-border border-t border-border">{tasks.map((task) => <TaskRow key={task.id} task={task} timezone={timezone} projects={projects} onOpen={() => onOpen(task)} onComplete={() => onComplete(task)} completing={completingId === task.id} />)}</ul> : <p className="border-t border-border px-4 py-6 text-center text-xs text-fg-subtle">{empty}</p>}
    </section>
  );
}

function ProjectRow({ project, timezone }: { project: TodayProject; timezone: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <li>
      <Link to={`/projects/${project.id}`} className="flex items-start gap-3 px-4 py-4 hover:bg-subtle">
        <FolderKanban className="mt-0.5 h-5 w-5 shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{project.name}</span><span className="mt-1 block text-xs text-fg-muted">{t("today.projectTasks", { count: project.open_tasks })} · {t("today.projectActivity", { when: relativeTime(project.last_activity_at, i18n) })}</span>{project.next_due_at && <span className="mt-1 block text-xs text-fg-subtle">{t("today.nextDue", { due: formatDue(project.next_due_at, timezone, i18n.locale) })}</span>}</span>
        {project.overdue_tasks > 0 ? <Badge tone="danger">{t("today.projectOverdue", { count: project.overdue_tasks })}</Badge> : project.due_soon_tasks > 0 ? <Badge tone="warning">{t("today.projectDueSoon", { count: project.due_soon_tasks })}</Badge> : <ArrowUpRight className="mt-0.5 h-4 w-4 text-fg-subtle" />}
      </Link>
    </li>
  );
}

function SuggestionCard({ suggestion, onDismiss }: { suggestion: TodaySuggestion; onDismiss: () => void }) {
  const { t } = useI18n();
  let title: string;
  let body: string;
  let to: string;
  let action: string;
  if (suggestion.kind === "review_overdue") {
    title = t("today.suggestionTitle");
    body = t("today.suggestionOverdue", { count: suggestion.count });
    to = "/tasks?view=overdue";
    action = t("today.reviewTasks");
  } else if (suggestion.kind === "plan_project") {
    title = t("today.suggestionTitle");
    body = t("today.suggestionPlan", { count: suggestion.count, project: suggestion.project_name });
    const prompt = t("today.planPrompt", { project: suggestion.project_name, count: suggestion.count });
    to = `/chat?prompt=${encodeURIComponent(prompt)}`;
    action = t("today.askForPlan");
  } else if (suggestion.kind === "review_project") {
    title = t("today.suggestionTitle");
    body = t("today.suggestionProject", { count: suggestion.count, project: suggestion.project_name });
    to = `/projects/${suggestion.project_id}`;
    action = t("today.reviewProject");
  } else {
    title = t("today.suggestionStartTitle");
    body = t("today.suggestionStart");
    to = "/tasks?new=1";
    action = t("today.addFirstTask");
  }
  return (
    <section aria-label={title} className="relative flex items-start gap-3 rounded-xl border border-accent/25 bg-accent-soft px-4 py-3.5">
      <Lightbulb className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1 pr-6"><h2 className="text-sm font-semibold">{title}</h2><p className="mt-0.5 text-sm leading-5 text-fg-muted">{body}</p><Link to={to} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">{action}<ArrowRight className="h-3.5 w-3.5" /></Link></div>
      <button type="button" onClick={onDismiss} className="absolute right-2 top-2 rounded-md p-1.5 text-fg-subtle hover:bg-surface hover:text-fg" aria-label={t("common.dismiss")}><X className="h-4 w-4" /></button>
    </section>
  );
}
