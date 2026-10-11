import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface ComputerSessionInfo {
  sessionId: string | null;
  status: "idle" | "running" | "stopped";
  controlMode: "ai_running" | "user_controlling";
  createdAt: string | null;
  lastActivityAt: string | null;
  currentUrl?: string;
  currentTitle?: string;
  history?: Array<{
    timestamp: string;
    action: string;
    result?: string;
  }>;
}

export function useComputerStatus() {
  return useQuery({
    queryKey: ["computer", "status"],
    queryFn: () => api<{ ok: boolean; session: ComputerSessionInfo }>("/computer/session/status"),
    refetchInterval: 3000, // Poll every 3 seconds for active mode/URL changes
    staleTime: 1000,
  });
}

export function useComputerActions() {
  const qc = useQueryClient();

  const startSession = useMutation({
    mutationFn: () => api<{ ok: boolean; session: ComputerSessionInfo }>("/computer/session/start", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["computer", "status"] }),
  });

  const stopSession = useMutation({
    mutationFn: () => api<{ ok: boolean; session: ComputerSessionInfo }>("/computer/session/stop", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["computer", "status"] }),
  });

  const takeControl = useMutation({
    mutationFn: () => api<{ ok: boolean; session: ComputerSessionInfo }>("/computer/session/take-control", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["computer", "status"] }),
  });

  const returnControl = useMutation({
    mutationFn: () => api<{ ok: boolean; session: ComputerSessionInfo }>("/computer/session/return-control", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["computer", "status"] }),
  });

  return {
    startSession,
    stopSession,
    takeControl,
    returnControl,
  };
}
