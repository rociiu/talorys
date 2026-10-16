import { createContext, type ReactNode, useCallback, useContext, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, onUnauthorized } from "../lib/api";
import { applyTheme } from "../lib/theme";
import { applyLanguage, type LanguagePreference } from "../lib/i18n";

interface SessionState {
  authenticated: boolean;
  configured: boolean;
  agent_name?: string;
  theme?: "system" | "light" | "dark";
  language?: LanguagePreference;
}

interface SessionContextValue {
  session: SessionState | undefined;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["session"],
    queryFn: () => api<SessionState>("/auth/session"),
    staleTime: 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (query.data?.theme) applyTheme(query.data.theme);
  }, [query.data?.theme]);

  useEffect(() => {
    if (query.data?.language) applyLanguage(query.data.language);
  }, [query.data?.language]);

  useEffect(
    () =>
      onUnauthorized(() => {
        qc.setQueryData<SessionState>(["session"], (s) => (s ? { ...s, authenticated: false } : s));
      }),
    [qc],
  );

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST", body: {} });
    } finally {
      // Drop all private data from memory, then show the lock screen immediately.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
      qc.setQueryData<SessionState>(["session"], (s) => ({ configured: true, ...s, authenticated: false }));
    }
  }, [qc]);

  return (
    <SessionContext.Provider value={{ session: query.data, loading: query.isLoading, error: query.error, refresh: query.refetch, logout }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}
