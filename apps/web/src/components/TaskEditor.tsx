import { useState } from "react";
import { Link } from "react-router";
import { TASK_PRIORITIES, type Task, type TaskPriority, zonedTimeToUtc } from "@talorys/shared";
import { ArrowUpRight, Trash2 } from "lucide-react";
import { Button, ConfirmDialog, Dialog, Input, Label, Select, Textarea } from "./ui";
import { taskDataKeys, useApiMutation, useProjects } from "../hooks/queries";
import { api } from "../lib/api";
import { toLocalInput } from "../lib/utils";
import { type MessageKey, useI18n } from "../lib/i18n";

const PRIORITY_KEYS = {
  low: "tasks.priorityLow",
  medium: "tasks.priorityMedium",
  high: "tasks.priorityHigh",
  urgent: "tasks.priorityUrgent",
} as const satisfies Record<TaskPriority, MessageKey>;

function localInputToIso(value: string, tz: string): string | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return zonedTimeToUtc(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, tz).toISOString();
}

export function TaskEditor({ task, onClose, tz }: { task: Task | null; onClose: () => void; tz: string }) {
  const { t } = useI18n();
  const projects = useProjects();
  const [form, setForm] = useState({ title: "", description: "", priority: "medium" as TaskPriority, status: "todo" as Task["status"], due: "", project_id: "" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lastId, setLastId] = useState<string | null>(null);
  if (task && task.id !== lastId) {
    setLastId(task.id);
    setForm({
      title: task.title,
      description: task.description,
      priority: task.priority,
      status: task.status,
      due: toLocalInput(task.due_at, tz),
      project_id: task.project_id ?? "",
    });
  }
  const close = () => {
    setLastId(null);
    onClose();
  };
  const save = useApiMutation(
    () =>
      api(`/tasks/${task!.id}`, {
        method: "PATCH",
        body: {
          title: form.title,
          description: form.description,
          priority: form.priority,
          status: form.status,
          // Keep the original instant when the minute-only editor did not change it.
          due_at: form.due === toLocalInput(task!.due_at, tz) ? undefined : localInputToIso(form.due, tz),
          project_id: form.project_id || null,
        },
      }),
    { invalidate: taskDataKeys, success: t("tasks.saved"), onSuccess: close },
  );
  const remove = useApiMutation(() => api(`/tasks/${task!.id}`, { method: "DELETE" }), {
    invalidate: taskDataKeys,
    success: t("tasks.deleted"),
    onSuccess: () => {
      setConfirmDelete(false);
      close();
    },
  });

  return (
    <>
      <Dialog
        open={!!task && !confirmDelete}
        onClose={close}
        title={t("tasks.edit")}
        footer={
          <div className="flex w-full justify-between">
            <Button variant="ghost" className="text-danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4" /> {t("common.delete")}
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={close}>{t("common.cancel")}</Button>
              <Button onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={!form.title.trim()}>{t("common.save")}</Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="task-title">{t("tasks.fieldTitle")}</Label>
            <Input id="task-title" value={form.title} maxLength={300} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="task-desc">{t("tasks.fieldNotes")}</Label>
            <Textarea id="task-desc" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="task-status">{t("tasks.fieldStatus")}</Label>
              <Select id="task-status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Task["status"] })}>
                <option value="todo">{t("tasks.statusTodo")}</option>
                <option value="in_progress">{t("tasks.statusInProgress")}</option>
                <option value="done">{t("tasks.statusDone")}</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="task-priority">{t("tasks.fieldPriority")}</Label>
              <Select id="task-priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })}>
                {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{t(PRIORITY_KEYS[p])}</option>)}
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="task-due" hint={tz}>{t("tasks.fieldDue")}</Label>
              <Input id="task-due" type="datetime-local" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="task-project" hint={t("tasks.optional")}>{t("tasks.fieldProject")}</Label>
              <Select id="task-project" value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}>
                <option value="">{t("tasks.noProject")}</option>
                {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
              {form.project_id && (
                <Link to={`/projects/${form.project_id}`} onClick={close} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
                  {t("tasks.viewProject")} <ArrowUpRight className="h-3 w-3" />
                </Link>
              )}
            </div>
          </div>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        title={t("tasks.deleteTitle")}
        message={t("tasks.deleteMessage", { title: task?.title ?? "" })}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate(undefined)}
        loading={remove.isPending}
      />
    </>
  );
}
