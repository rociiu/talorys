import type { ChatMessage } from "@talorys/shared";
import type { I18n } from "./i18n";

const ENABLED_KEY = "talorys.chatAlerts";
const PREVIEW_LENGTH = 140;

export type ChatAlertKind = "needs-you" | "reply" | "failed";

export interface ChatAlert {
  kind: ChatAlertKind;
  /** Text under the title; empty for a turn that needs the owner, whose reply may not explain why. */
  body: string;
  url: string;
  tag: string;
}

function preview(markdown: string): string {
  const plain = markdown.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  return plain.length > PREVIEW_LENGTH ? `${plain.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…` : plain;
}

/** A turn that ended without a saved reply. It has no conversation yet if the very first request failed. */
export function failedTurnAlert(conversationId: string | null, error: string | null): ChatAlert {
  return {
    kind: "failed",
    body: preview(error ?? ""),
    url: conversationId ? `/chat/${conversationId}` : "/chat",
    tag: `chat-${conversationId ?? "new"}`,
  };
}

/** What to tell the owner about a finished turn. A turn they stopped themselves says nothing. */
export function chatAlertFor(message: Pick<ChatMessage, "conversation_id" | "content" | "status" | "error" | "tools">): ChatAlert | null {
  if (message.status === "error") return failedTurnAlert(message.conversation_id, message.error);
  if (message.status !== "complete") return null;
  const where = { url: `/chat/${message.conversation_id}`, tag: `chat-${message.conversation_id}` };
  const waiting = message.tools?.some((t) => t.approval?.status === "pending" || t.plan?.status === "pending");
  return waiting ? { kind: "needs-you", body: "", ...where } : { kind: "reply", body: preview(message.content), ...where };
}

export function chatAlertsEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

function remember(on: boolean) {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, "1");
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    /* storage unavailable (private mode); alerts stay off */
  }
}

/** Asks permission (must run from a click) and registers the worker that shows the alerts. */
export async function enableChatAlerts(): Promise<boolean> {
  if ((await Notification.requestPermission()) !== "granted") return false;
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  remember(true);
  return true;
}

export function disableChatAlerts() {
  remember(false);
}

/** Shows an alert if this device opted in and the owner is looking elsewhere. Never throws. */
async function showAlert(alert: ChatAlert | null, t: I18n["t"]): Promise<void> {
  try {
    if (!alert || !chatAlertsEnabled() || document.hasFocus() || Notification.permission !== "granted") return;
    const titles = { "needs-you": t("chatAlerts.needsYou"), reply: t("chatAlerts.reply"), failed: t("chatAlerts.failed") };
    // Phones only allow notifications shown through the service worker.
    const reg = await navigator.serviceWorker.getRegistration("/");
    if (!reg) return;
    // Replacing a notification with the same tag makes no sound or banner, so close the old one first.
    for (const old of await reg.getNotifications({ tag: alert.tag })) old.close();
    await reg.showNotification(titles[alert.kind], {
      body: alert.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: alert.tag,
      data: { url: alert.url },
    });
  } catch (error) {
    console.warn("Chat alert failed", error);
  }
}

export function notifyChatTurn(message: ChatMessage, t: I18n["t"]): Promise<void> {
  return showAlert(chatAlertFor(message), t);
}

/** For a turn that ended without a `done` event: a lost connection or a request the server refused. */
export function notifyChatFailure(conversationId: string | null, error: string | null, t: I18n["t"]): Promise<void> {
  return showAlert(failedTurnAlert(conversationId, error), t);
}
