import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { Bell, Brain, CalendarClock, CheckSquare, LogOut, type LucideIcon, MessageSquare, NotebookPen, Settings } from "lucide-react";
import { ErrorBoundary } from "./ErrorBoundary";
import { Logo } from "./Logo";
import { NotificationCenter } from "./NotificationCenter";
import { useKeyboardOpenFlag } from "../hooks/keyboard";
import { usePageTitle } from "../hooks/pageTitle";
import { useSession } from "../hooks/session";
import { useNotifications, useSettings } from "../hooks/queries";
import { cn } from "../lib/utils";
import { type MessageKey, useI18n } from "../lib/i18n";

type NavKey = Extract<MessageKey, `nav.${string}`>;

const NAV: readonly { to: string; label: NavKey; mobileLabel?: NavKey; icon: LucideIcon }[] = [
  { to: "/chat", label: "nav.chat", icon: MessageSquare },
  { to: "/memory", label: "nav.memory", icon: Brain },
  { to: "/tasks", label: "nav.tasks", icon: CheckSquare },
  { to: "/notes", label: "nav.notes", icon: NotebookPen },
  { to: "/automations", label: "nav.automations", mobileLabel: "nav.automationsShort", icon: CalendarClock },
];

export function AppShell() {
  const { t } = useI18n();
  const { logout } = useSession();
  const settings = useSettings();
  const notifications = useNotifications();
  const [notifOpen, setNotifOpen] = useState(false);
  useKeyboardOpenFlag();
  const location = useLocation();
  const navigate = useNavigate();
  // A clicked notification asks this window to open the conversation it is about.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "talorys.navigate" && typeof event.data.path === "string") navigate(event.data.path);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [navigate]);
  const unread = notifications.data?.unread ?? 0;
  const agentName = settings.data?.agentName ?? "Talorys";
  const isChat = location.pathname.startsWith("/chat");
  // Chat titles itself after the open conversation.
  const section = location.pathname.startsWith("/settings") ? "nav.settings" : NAV.find((n) => location.pathname.startsWith(n.to))?.label;
  usePageTitle(isChat || !section ? null : t(section));

  const bell = (
    <button type="button"
      onClick={() => setNotifOpen(true)}
      className="relative rounded-lg p-2 text-fg-muted transition-colors hover:bg-muted hover:text-fg"
      aria-label={unread ? t("notifications.titleUnread", { count: unread }) : t("notifications.title")}
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
        <nav className="flex-1 space-y-0.5 px-3 py-2" aria-label={t("nav.main")}>
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
              {t(label)}
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
            {t("nav.settings")}
          </NavLink>
          <button type="button"
            onClick={() => void logout()}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-fg-muted transition-colors hover:bg-muted hover:text-fg"
          >
            <LogOut className="h-4 w-4" />
            {t("nav.lock")}
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
            <NavLink to="/settings" className="rounded-lg p-2 text-fg-muted hover:bg-muted" aria-label={t("nav.settings")}>
              <Settings className="h-[18px] w-[18px]" />
            </NavLink>
          </div>
        </header>

        <main className={cn("min-h-0 flex-1", isChat ? "overflow-hidden" : "overflow-y-auto pb-20 md:pb-0")}>
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>

        {/* Mobile bottom navigation */}
        <nav
          aria-label={t("nav.main")}
          className="mobile-nav fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        >
          {NAV.map(({ to, label, mobileLabel, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn("flex flex-col items-center gap-1 py-2 text-[11px] font-medium", isActive ? "text-accent" : "text-fg-subtle")
              }
            >
              <Icon className="h-5 w-5" />
              {t(mobileLabel ?? label)}
            </NavLink>
          ))}
        </nav>
      </div>

      <NotificationCenter open={notifOpen} onClose={() => setNotifOpen(false)} />
    </div>
  );
}
