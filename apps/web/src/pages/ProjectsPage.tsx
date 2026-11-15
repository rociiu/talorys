import { type FormEvent, useState } from "react";
import { Link, useParams } from "react-router";
import type { Project } from "@talorys/shared";
import { ArrowLeft, ArrowUpRight, CheckCircle2, Circle, CircleDot, FolderKanban, MessageSquare, Plus } from "lucide-react";
import { Badge, Button, EmptyState, ErrorNotice, Input, PageHeader, Select, Spinner } from "../components/ui";
import { keys, useApiMutation, useProject, useProjects, useProjectTasks, useTimezone } from "../hooks/queries";
import { api, ApiError } from "../lib/api";
import { formatDue } from "../lib/utils";
import { useI18n } from "../lib/i18n";

const STATUS_KEYS = {
  active: "projects.statusActive",
  paused: "projects.statusPaused",
  completed: "projects.statusCompleted",
  archived: "projects.statusArchived",
} as const;

export default function ProjectsPage() {
  const { projectId } = useParams();
  if (projectId) return <ProjectDetail id={projectId} />;
  return <ProjectList />;
}

function ProjectList() {
  const { data: projects = [], isLoading, error, refetch } = useProjects();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const create = useApiMutation((title: string) => api("/projects", { method: "POST", body: { name: title } }), {
    invalidate: [keys.projects, keys.today],
    success: t("projects.created"),
    onSuccess: () => setName(""),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) create.mutate(name.trim());
  }
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 md:px-8">
      <PageHeader title={t("projects.title")} description={t("projects.description")} />
      <form onSubmit={submit} className="mb-6 flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder={t("projects.newName")} aria-label={t("projects.newName")} />
        <Button type="submit" disabled={!name.trim()} loading={create.isPending}><Plus className="h-4 w-4" />{t("projects.add")}</Button>
      </form>
      {error ? <ErrorNotice error={error} onRetry={() => void refetch()} /> : isLoading ? <div className="flex justify-center py-16"><Spinner /></div> : !projects.length ? (
        <EmptyState icon={<FolderKanban className="h-9 w-9" />} title={t("projects.emptyTitle")}>{t("projects.emptyBody")}</EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {projects.map((project) => (
            <li key={project.id}>
              <Link to={`/projects/${project.id}`} className="block h-full rounded-xl border border-border bg-surface p-4 transition-colors hover:border-border-strong hover:bg-subtle">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-medium [overflow-wrap:anywhere]">{project.name}</h2>
                  <Badge tone={project.status === "active" ? "accent" : "neutral"}>{t(STATUS_KEYS[project.status])}</Badge>
                </div>
                <p className="mt-2 line-clamp-2 text-sm text-fg-muted">{project.description || t("projects.noDescription")}</p>
                <span className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-accent">{t("projects.open")}<ArrowUpRight className="h-3.5 w-3.5" /></span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectDetail({ id }: { id: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const tz = useTimezone();
  const detail = useProject(id);
  const tasks = useProjectTasks(id);
  const update = useApiMutation((status: Project["status"]) => api(`/projects/${id}`, { method: "PATCH", body: { status } }), {
    invalidate: [keys.projects, [...keys.projectDetails, id], keys.today],
    success: t("projects.saved"),
  });
  if (detail.isLoading || tasks.isLoading) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (detail.error instanceof ApiError && detail.error.status === 404) return <EmptyState title={t("projects.notFound")} action={<Link to="/projects" className="text-accent hover:underline">{t("projects.viewAll")}</Link>} />;
  if (detail.error) return <div className="mx-auto max-w-3xl p-8"><ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} /></div>;
  if (tasks.error) return <div className="mx-auto max-w-3xl p-8"><ErrorNotice error={tasks.error} onRetry={() => void tasks.refetch()} /></div>;
  if (!detail.data) return null;

  const { project, task_counts } = detail.data;
  const open = tasks.data ?? [];
  const planningPrompt = t("projects.planPrompt", { project: project.name });
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 md:px-8">
      <Link to="/projects" className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-fg-muted hover:text-fg"><ArrowLeft className="h-4 w-4" />{t("projects.viewAll")}</Link>
      <PageHeader
        title={project.name}
        description={project.description || t("projects.noDescription")}
        actions={
          <Select value={project.status} onChange={(e) => update.mutate(e.target.value as Project["status"])} disabled={update.isPending} aria-label={t("projects.status")} className="w-auto">
            {(Object.keys(STATUS_KEYS) as Project["status"][]).map((status) => <option key={status} value={status}>{t(STATUS_KEYS[status])}</option>)}
          </Select>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface p-4"><p className="text-2xl font-semibold tabular-nums">{task_counts.open}</p><p className="mt-1 text-xs text-fg-muted">{t("projects.openTasks")}</p></div>
        <div className="rounded-xl border border-border bg-surface p-4"><p className="text-2xl font-semibold tabular-nums">{task_counts.completed}</p><p className="mt-1 text-xs text-fg-muted">{t("projects.completedTasks")}</p></div>
        <div className="col-span-2 flex items-center gap-2 rounded-xl border border-border bg-surface p-3 sm:col-span-1">
          <Link to={`/chat?prompt=${encodeURIComponent(planningPrompt)}`} className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg hover:opacity-90"><MessageSquare className="h-4 w-4" />{t("projects.plan")}</Link>
        </div>
      </div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t("projects.nextTasks")}</h2>
        <Link to={`/tasks?project=${id}&new=1`} className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"><Plus className="h-4 w-4" />{t("projects.addTask")}</Link>
      </div>
      {!open.length ? (
        <EmptyState icon={<CheckCircle2 className="h-9 w-9" />} title={t("projects.noOpenTasks")} action={<Link to={`/tasks?project=${id}&new=1`} className="text-sm font-medium text-accent hover:underline">{t("projects.addFirstTask")}</Link>}>{t("projects.noOpenBody")}</EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
          {open.map((task) => (
            <li key={task.id}>
              <Link to={`/tasks?project=${id}&task=${task.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-subtle">
                {task.status === "in_progress" ? <CircleDot className="mt-0.5 h-5 w-5 shrink-0 text-accent" /> : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-fg-subtle" />}
                <span className="min-w-0 flex-1"><span className="block text-[15px]">{task.title}</span>{task.due_at && <span className="mt-0.5 block text-xs text-fg-subtle">{formatDue(task.due_at, tz, i18n.locale)}</span>}</span>
                <ArrowUpRight className="mt-1 h-4 w-4 shrink-0 text-fg-subtle" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link to={`/tasks?project=${id}&view=open`} className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">{t("projects.allTasks")}<ArrowUpRight className="h-4 w-4" /></Link>
    </div>
  );
}
