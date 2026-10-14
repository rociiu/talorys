import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { Bell, Brain, CalendarClock, CheckSquare, LogOut, MessageSquare, NotebookPen, Settings } from "lucide-react";
import { Logo } from "./Logo";
import { NotificationCenter } from "./NotificationCenter";
import { useKeyboardOpenFlag } from "../hooks/keyboard";
import { useSession } from "../hooks/session";
import { useNotifications, useSettings } from "../hooks/queries";
import { cn } from "../lib/utils";

const NAV = [
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/memory", label: "Memory", icon: Brain },
  { to: "/tasks", label: "Tasks", icon: CheckSquare },
  { to: "/notes", label: "Notes", icon: NotebookPen },
  { to: "/automations", label: "Automations", icon: CalendarClock },
] as const;

export function AppShell() {
  const { logout } = useSession();
  const settings = useSettings();
  const notifications = useNotifications();
  const [notifOpen, setNotifOpen] = useState(false);
  useKeyboardOpenFlag();
  const location = useLocation();
  const unread = notifications.data?.unread ?? 0;
  const agentName = settings.data?.agentName ?? "Talorys";
  const isChat = location.pathname.startsWith("/chat");

  const bell = (
    <button type="button"
      onClick={() => setNotifOpen(true)}
      className="relative rounded-lg p-2 text-fg-muted transition-colors hover:bg-muted hover:text-fg"
      aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
    >
      <Bell className="h-[18px] w-[18px]" />
      {unread > 0 && (
        <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-fg">
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </button>
  );

  return (
    <div className="flex h-full">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-subtle md:flex">
        <div className="flex h-14 items-center justify-between px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <Logo />
            <span className="truncate text-[15px] font-semibold tracking-tight">{agentName}</span>
          </div>
          {bell}
        </div>
        <nav className="flex-1 space-y-0.5 px-3 py-2" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive ? "bg-surface text-fg shadow-sm ring-1 ring-border" : "text-fg-muted hover:bg-muted hover:text-fg",
                )
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="space-y-0.5 border-t border-border px-3 py-3">
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive ? "bg-surface text-fg shadow-sm ring-1 ring-border" : "text-fg-muted hover:bg-muted hover:text-fg",
              )
            }
          >
            <Settings className="h-4 w-4" />
            Settings
          </NavLink>
          <button type="button"
            onClick={() => void logout()}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-fg-muted transition-colors hover:bg-muted hover:text-fg"
          >
            <LogOut className="h-4 w-4" />
            Lock
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface/80 px-4 backdrop-blur md:hidden">
          <div className="flex items-center gap-2">
            <Logo className="h-6 w-6" />
            <span className="font-semibold tracking-tight">{agentName}</span>
          </div>
          <div className="flex items-center">
            {bell}
            <NavLink to="/settings" className="rounded-lg p-2 text-fg-muted hover:bg-muted" aria-label="Settings">
              <Settings className="h-[18px] w-[18px]" />
            </NavLink>
          </div>
        </header>

        <main className={cn("min-h-0 flex-1", isChat ? "overflow-hidden" : "overflow-y-auto pb-20 md:pb-0")}>
          <Outlet />
        </main>

        {/* Mobile bottom navigation */}
        <nav
          aria-label="Main"
          className="mobile-nav fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        >
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn("flex flex-col items-center gap-1 py-2 text-[11px] font-medium", isActive ? "text-accent" : "text-fg-subtle")
              }
            >
              <Icon className="h-5 w-5" />
              {label === "Automations" ? "Schedules" : label}
            </NavLink>
          ))}
        </nav>
      </div>

      <NotificationCenter open={notifOpen} onClose={() => setNotifOpen(false)} />
    </div>
  );
}
