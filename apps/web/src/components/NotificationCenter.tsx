import { BellOff, Trash2 } from "lucide-react";
import { Button, Dialog, EmptyState, Spinner } from "./ui";
import { Markdown } from "./Markdown";
import { keys, useApiMutation, useNotifications } from "../hooks/queries";
import { api } from "../lib/api";
import { cn, relativeTime } from "../lib/utils";
import { useI18n } from "../lib/i18n";

/** In-app notification center for reminders and automation results. */
export function NotificationCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const i18n = useI18n();
  const { data, isLoading } = useNotifications();
  const markRead = useApiMutation((id?: string) => api("/notifications/read", { method: "POST", body: id ? { id } : {} }), {
    invalidate: [keys.notifications],
  });
  const remove = useApiMutation((id: string) => api(`/notifications/${id}`, { method: "DELETE" }), { invalidate: [keys.notifications] });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Notifications"
      wide
      footer={
        (data?.unread ?? 0) > 0 ? (
          <Button variant="outline" size="sm" onClick={() => markRead.mutate(undefined)} loading={markRead.isPending}>
            Mark all as read
          </Button>
        ) : undefined
      }
    >
      {isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : !data?.notifications.length ? (
        <EmptyState icon={<BellOff className="h-8 w-8" />} title="No notifications">
          Reminders and automation results will appear here.
        </EmptyState>
      ) : (
        <ul className="-mx-2 divide-y divide-border">
          {data.notifications.map((n) => (
            <li key={n.id} className={cn("group flex gap-3 rounded-lg px-2 py-3", !n.read_at && "bg-accent-soft/60")}>
              <span className={cn("mt-2 h-2 w-2 shrink-0 rounded-full", n.read_at ? "bg-transparent" : "bg-accent")} />
              <div className="min-w-0 flex-1" onClick={() => !n.read_at && markRead.mutate(n.id)}>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="font-medium">{n.title}</p>
                  <time className="shrink-0 text-xs text-fg-subtle">{relativeTime(n.created_at, i18n)}</time>
                </div>
                <div className="mt-1 text-sm text-fg-muted">
                  <Markdown content={n.body} compact />
                </div>
              </div>
              <button type="button"
                onClick={() => remove.mutate(n.id)}
                className="self-start rounded p-1 text-fg-subtle opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 focus:opacity-100"
                aria-label="Delete notification"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
