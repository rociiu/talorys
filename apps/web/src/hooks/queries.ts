import type {
  Automation,
  AutomationRun,
  Conversation,
  ChatMessage,
  Memory,
  MemoryHistory,
  MemoryReview,
  Note,
  Notification,
  Project,
  RemoteTokenInfo,
  SessionInfo,
  Settings,
  Task,
  UsageReport,
} from "@talorys/shared";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { errorMessage, useToast } from "./toast";

export const keys = {
  settings: ["settings"] as const,
  conversations: (q?: string) => ["conversations", q ?? ""] as const,
  conversation: (id: string) => ["conversation", id] as const,
  tasks: ["tasks"] as const,
  memories: (q?: string, status?: string) => ["memories", q ?? "", status ?? "all"] as const,
  memoryReviews: ["memories", "reviews"] as const,
  memoryHistory: (id: string) => ["memories", "history", id] as const,
  notes: (q?: string) => ["notes", q ?? ""] as const,
  projects: ["projects"] as const,
  automations: ["automations"] as const,
  notifications: ["notifications"] as const,
  usage: ["usage"] as const,
  sessions: ["sessions"] as const,
  system: ["system"] as const,
  update: ["system", "update"] as const,
  remoteStatus: ["remote", "status"] as const,
  remoteTokens: ["remote", "tokens"] as const,
};

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: () => api<{ settings: Settings }>("/settings").then((r) => r.settings), staleTime: 60_000 });
}

/** Owner timezone with a safe fallback while settings load. */
export function useTimezone(): string {
  return useSettings().data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function useConversations(q?: string) {
  return useQuery({
    queryKey: keys.conversations(q),
    queryFn: () => api<{ conversations: Conversation[] }>(`/conversations${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => r.conversations),
  });
}

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: keys.conversation(id ?? ""),
    queryFn: () => api<{ conversation: Conversation; messages: ChatMessage[]; streaming?: boolean }>(`/conversations/${id}`),
    enabled: !!id,
    // A reply started elsewhere (another tab, or before a reload) is still generating: poll until it lands.
    refetchInterval: (query) => (query.state.data?.streaming ? 1500 : false),
  });
}

export function useTasks() {
  // Open and completed tasks are fetched separately so a long completed history can't push
  // open tasks past the page limit.
  return useQuery({
    queryKey: keys.tasks,
    queryFn: async () => {
      const [open, completed] = await Promise.all([
        api<{ tasks: Task[] }>("/tasks?status=open&limit=500"),
        api<{ tasks: Task[] }>("/tasks?view=completed&limit=200"),
      ]);
      return [...open.tasks, ...completed.tasks];
    },
  });
}

export type MemoryStatusFilter = "all" | "active" | "historical" | "review";

export function useMemories(q?: string, status: MemoryStatusFilter = "all") {
  return useQuery({
    queryKey: keys.memories(q, status),
    queryFn: () => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (status !== "all") params.set("status", status);
      const qs = params.toString();
      return api<{ memories: Memory[]; total: number; counts?: { active: number; historical: number; review: number } }>(`/memories${qs ? `?${qs}` : ""}`);
    },
    placeholderData: (prev) => prev,
  });
}

export function useMemoryReviews() {
  return useQuery({ queryKey: keys.memoryReviews, queryFn: () => api<{ reviews: MemoryReview[] }>("/memories/reviews").then((r) => r.reviews) });
}

export function useMemoryHistory(id: string | null) {
  return useQuery({
    queryKey: keys.memoryHistory(id ?? ""),
    queryFn: () => api<MemoryHistory>(`/memories/${id}/history`),
    enabled: !!id,
  });
}

export function useNotes(q?: string) {
  return useQuery({
    queryKey: keys.notes(q),
    queryFn: () => api<{ notes: Note[] }>(`/notes${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => r.notes),
    placeholderData: (prev) => prev,
  });
}

export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: () => api<{ projects: Project[] }>("/projects").then((r) => r.projects) });
}

export function useAutomations() {
  return useQuery({
    queryKey: keys.automations,
    queryFn: () => api<{ automations: Automation[]; runs: AutomationRun[]; failed_runs: AutomationRun[]; timezone: string }>("/automations"),
    refetchInterval: 60_000,
  });
}

/** One automation's run history, newest first, paged with "Load more". */
export function useAutomationRuns(id: string | null, status?: AutomationRun["status"]) {
  return useInfiniteQuery({
    queryKey: [...keys.automations, id, "runs", status ?? "all"],
    enabled: !!id,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "25" });
      if (status) params.set("status", status);
      if (pageParam) params.set("before", pageParam);
      return api<{ runs: AutomationRun[]; has_more: boolean }>(`/automations/${id}/runs?${params}`);
    },
    getNextPageParam: (last) => (last.has_more ? last.runs[last.runs.length - 1]?.started_at : undefined),
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: keys.notifications,
    queryFn: () => api<{ notifications: Notification[]; unread: number }>("/notifications"),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useUsage(refetchInterval: number | false = false) {
  return useQuery({ queryKey: keys.usage, queryFn: () => api<UsageReport>("/usage"), refetchInterval });
}

export function useSessions() {
  return useQuery({ queryKey: keys.sessions, queryFn: () => api<{ sessions: SessionInfo[] }>("/auth/sessions").then((r) => r.sessions) });
}

export function useSystemInfo() {
  return useQuery({
    queryKey: keys.system,
    queryFn: () =>
      api<{ version: string; deployed_version: string | null; installation_id: string | null; schema_version: number; ai_binding: boolean; ai_provider: string; environment: string }>("/system"),
  });
}

export interface UpdateStatus {
  enabled: boolean;
  current: string;
  latest: string | null;
  update_available: boolean;
  checked_at: string | null;
}

/** Whether a newer release is published. The server caches the lookup for a day. */
export function useUpdateStatus() {
  return useQuery({ queryKey: keys.update, queryFn: () => api<UpdateStatus>("/system/update"), staleTime: 60 * 60_000, retry: false });
}

export function useRemoteStatus() {
  return useQuery({ queryKey: keys.remoteStatus, queryFn: () => api<{ enabled: boolean; max_tokens: number }>("/remote/status") });
}

export function useRemoteTokens() {
  return useQuery({ queryKey: keys.remoteTokens, queryFn: () => api<{ tokens: RemoteTokenInfo[] }>("/remote/tokens").then((r) => r.tokens) });
}

/**
 * Generic mutation with toast feedback and cache invalidation.
 */
export function useApiMutation<TVars, TResult = unknown>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: { invalidate?: readonly (readonly unknown[])[]; success?: string | ((r: TResult) => string); onSuccess?: (r: TResult, v: TVars) => void } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result, vars) => {
      await Promise.all((opts.invalidate ?? []).map((key) => qc.invalidateQueries({ queryKey: key as unknown[] })));
      if (opts.success) toast(typeof opts.success === "function" ? opts.success(result) : opts.success);
      opts.onSuccess?.(result, vars);
    },
    onError: (error) => toast(errorMessage(error), "error"),
  });
}
