import { useState } from "react";
import { Card, Switch } from "./ui";
import { chatAlertsEnabled, disableChatAlerts, enableChatAlerts } from "../lib/chatAlerts";
import { pushBlocker } from "../lib/push";
import { useI18n } from "../lib/i18n";

/** Settings card for this device's alerts about chat replies. Works without push keys. */
export function ChatAlertsCard() {
  const { t } = useI18n();
  const [on, setOn] = useState(chatAlertsEnabled);
  const [busy, setBusy] = useState(false);
  const [blocker, setBlocker] = useState(pushBlocker);

  async function toggle(next: boolean) {
    if (!next) {
      disableChatAlerts();
      setOn(false);
      return;
    }
    setBusy(true);
    try {
      setOn(await enableChatAlerts());
    } catch {
      setOn(false);
    } finally {
      setBusy(false);
      setBlocker(pushBlocker());
    }
  }

  const hint = blocker === "ios-not-installed" ? t("chatAlerts.blockedIos")
    : blocker === "unsupported" ? t("chatAlerts.blockedUnsupported")
    : blocker === "denied" ? t("chatAlerts.blockedDenied")
    : t("chatAlerts.hint");
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-medium uppercase tracking-wider text-fg-subtle">{t("chatAlerts.heading")}</h2>
      <Card>
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("chatAlerts.label")}</p>
            <p className="mt-0.5 text-xs leading-5 text-fg-subtle">{hint}</p>
          </div>
          <div className="shrink-0">
            <Switch checked={on && !blocker} onChange={(next) => void toggle(next)} label={t("chatAlerts.switch")} disabled={!!blocker || busy} />
          </div>
        </div>
      </Card>
    </section>
  );
}
