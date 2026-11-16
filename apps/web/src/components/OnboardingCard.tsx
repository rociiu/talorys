import { useState } from "react";
import { Link } from "react-router";
import { ArrowUpRight, Brain, CalendarClock, CheckSquare, MessageSquare, Puzzle, X } from "lucide-react";
import { useI18n } from "../lib/i18n";

const STORAGE_KEY = "talorys.onboarding.v1.dismissed";

function dismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function OnboardingCard() {
  const { t } = useI18n();
  const [visible, setVisible] = useState(() => !dismissed());
  if (!visible) return null;
  const close = () => {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // The guide can still be dismissed for this render when storage is unavailable.
    }
    setVisible(false);
  };
  const prompt = t("onboarding.chatExample");
  return (
    <section aria-labelledby="welcome-heading" className="relative mb-6 rounded-xl border border-border bg-surface p-5">
      <button type="button" onClick={close} className="absolute right-3 top-3 rounded-md p-1.5 text-fg-subtle hover:bg-muted hover:text-fg" aria-label={t("common.dismiss")}><X className="h-4 w-4" /></button>
      <div className="pr-8">
        <h2 id="welcome-heading" className="text-base font-semibold">{t("onboarding.title")}</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-fg-muted">{t("onboarding.body")}</p>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <OnboardingAction icon={<CheckSquare className="h-4 w-4" />} title={t("onboarding.taskTitle")} body={t("onboarding.taskBody")} action={t("onboarding.taskAction")} to="/tasks?new=1" />
        <OnboardingAction icon={<CalendarClock className="h-4 w-4" />} title={t("onboarding.reminderTitle")} body={t("onboarding.reminderBody")} action={t("onboarding.reminderAction")} to="/automations?new=1" />
        <OnboardingAction icon={<MessageSquare className="h-4 w-4" />} title={t("onboarding.chatTitle")} body={t("onboarding.chatBody")} action={t("onboarding.chatAction")} to={`/chat?prompt=${encodeURIComponent(prompt)}`} />
      </div>
      <div className="mt-4 grid gap-3 border-t border-border pt-4 text-xs leading-5 sm:grid-cols-2">
        <div className="flex items-start gap-2"><Brain className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" /><p className="text-fg-muted"><span className="font-medium text-fg">{t("onboarding.memoryTitle")}. </span>{t("onboarding.memoryBody")} <Link to="/memory" className="font-medium text-accent hover:underline">{t("onboarding.memoryAction")}</Link></p></div>
        <div className="flex items-start gap-2"><Puzzle className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" /><p className="text-fg-muted"><span className="font-medium text-fg">{t("onboarding.integrationsTitle")}. </span>{t("onboarding.integrationsBody")} <Link to="/settings" className="font-medium text-accent hover:underline">{t("onboarding.integrationsAction")}</Link></p></div>
      </div>
    </section>
  );
}

function OnboardingAction({ icon, title, body, action, to }: { icon: React.ReactNode; title: string; body: string; action: string; to: string }) {
  return (
    <Link to={to} className="group rounded-lg border border-border bg-bg p-3.5 transition-colors hover:border-border-strong hover:bg-subtle">
      <div className="flex items-center gap-2 text-accent">{icon}<h3 className="text-sm font-medium text-fg">{title}</h3></div>
      <p className="mt-2 text-xs leading-5 text-fg-muted">{body}</p>
      <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent">{action}<ArrowUpRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" /></span>
    </Link>
  );
}
