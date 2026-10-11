import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";
import { useSession } from "./hooks/session";
import { AppShell } from "./components/AppShell";
import { LoginPage } from "./pages/LoginPage";
import { ChatPage } from "./pages/ChatPage";
import { Spinner, ErrorNotice } from "./components/ui";
import { Logo } from "./components/Logo";

const MemoryPage = lazy(() => import("./pages/MemoryPage"));
const TasksPage = lazy(() => import("./pages/TasksPage"));
const NotesPage = lazy(() => import("./pages/NotesPage"));
const AutomationsPage = lazy(() => import("./pages/AutomationsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));

function FullScreen({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-full flex-col items-center justify-center gap-6 p-6">{children}</div>;
}

export function App() {
  const { session, loading, error, refresh } = useSession();

  if (loading) {
    return (
      <FullScreen>
        <Logo className="h-10 w-10" />
        <Spinner />
      </FullScreen>
    );
  }
  if (error || !session) {
    return (
      <FullScreen>
        <Logo className="h-10 w-10" />
        <div className="w-full max-w-sm">
          <ErrorNotice error={error ?? new Error("Talorys 서버에 연결할 수 없습니다.")} onRetry={() => void refresh()} />
        </div>
      </FullScreen>
    );
  }
  if (!session.authenticated) return <LoginPage configured={session.configured} />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/chat" replace />} />
        <Route path="chat/:conversationId?" element={<ChatPage />} />
        <Route path="memory" element={<Lazy><MemoryPage /></Lazy>} />
        <Route path="tasks" element={<Lazy><TasksPage /></Lazy>} />
        <Route path="notes/:noteId?" element={<Lazy><NotesPage /></Lazy>} />
        <Route path="automations" element={<Lazy><AutomationsPage /></Lazy>} />
        <Route path="settings" element={<Lazy><SettingsPage /></Lazy>} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Route>
    </Routes>
  );
}

function Lazy({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center p-16">
          <Spinner />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}
