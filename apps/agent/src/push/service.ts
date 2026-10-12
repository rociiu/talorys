import { MAX_PUSH_DEVICES, type Notification, type PushStatus } from "@talorys/shared";
import { encryptPayload } from "./ece";
import { fromB64url } from "./encoding";
import type { PushSubscriptionRepository, PushSubscriptionRow } from "./repository";
import { importVapidKeys, type VapidKeys, vapidAuthorization } from "./vapid";

export interface PushEnv {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Notification id, so a click can open the app and mark it read. */
  id?: string;
  url: string;
}

export type SendOutcome = "sent" | "gone" | "failed";

/** Push services keep an undelivered message this long (seconds) while a device is offline. */
const TTL_SECONDS = 24 * 3600;
const SEND_TIMEOUT_MS = 10_000;

/** Short plain text for the system notification; the full Markdown stays in the app. */
export function toPushMessage(n: Pick<Notification, "id" | "title" | "body">): PushMessage {
  const plain = (text: string) => text.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  return { title: clip(plain(n.title), 100), body: clip(plain(n.body), 240), id: n.id, url: "/" };
}

/**
 * Delivers notifications to the owner's subscribed browsers with Web Push. Sending happens in
 * the background and never fails the work that created the notification: an automation run,
 * a reminder or a chat turn finishes the same whether or not any device was reached.
 */
export class PushService {
  /** Replaced in tests; push requests never follow redirects to another host. */
  fetcher: typeof fetch = (input, init) => fetch(input, init);
  private keys: Promise<VapidKeys | null> | null = null;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    readonly subscriptions: PushSubscriptionRepository,
    private readonly env: PushEnv,
    private readonly background: (work: Promise<unknown>) => void,
  ) {}

  configured(): boolean {
    return !!this.env.VAPID_PUBLIC_KEY && !!this.env.VAPID_PRIVATE_KEY;
  }

  status(): PushStatus {
    const available = this.configured();
    return { available, public_key: available ? this.env.VAPID_PUBLIC_KEY! : null, devices: this.subscriptions.devices(), max_devices: MAX_PUSH_DEVICES };
  }

  private vapid(): Promise<VapidKeys | null> {
    this.keys ??= importVapidKeys(this.env.VAPID_PUBLIC_KEY, this.env.VAPID_PRIVATE_KEY);
    return this.keys;
  }

  /** Called for every new notification. Returns at once; delivery continues in the background. */
  notify(n: Notification): void {
    if (!this.configured() || this.subscriptions.all().length === 0) return;
    const work: Promise<void> = this.sendToAll(toPushMessage(n))
      .then(() => undefined)
      .catch((error) => console.warn("Push delivery failed", error instanceof Error ? error.message : String(error)))
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
    this.background(work);
  }

  /** Resolves when every background delivery started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  /** Sends one message to every device. Gone subscriptions are removed, failures counted. */
  async sendToAll(message: PushMessage): Promise<Record<SendOutcome, number>> {
    const counts: Record<SendOutcome, number> = { sent: 0, gone: 0, failed: 0 };
    const keys = await this.vapid();
    if (!keys) return counts;
    const outcomes = await Promise.all(this.subscriptions.all().map((sub) => this.sendOne(sub, message, keys)));
    for (const o of outcomes) counts[o]++;
    return counts;
  }

  private async sendOne(sub: PushSubscriptionRow, message: PushMessage, keys: VapidKeys): Promise<SendOutcome> {
    let status: number;
    try {
      const body = await encryptPayload(new TextEncoder().encode(JSON.stringify(message)), {
        p256dh: fromB64url(sub.p256dh),
        auth: fromB64url(sub.auth),
      });
      const res = await this.fetcher(sub.endpoint, {
        method: "POST",
        headers: {
          authorization: await vapidAuthorization(sub.endpoint, keys, this.env.VAPID_SUBJECT || sub.origin),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(TTL_SECONDS),
          // Every notification is something the owner scheduled or asked for, so deliver promptly.
          urgency: "high",
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      status = res.status;
      await res.body?.cancel();
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) {
      this.subscriptions.recordSuccess(sub.id);
      return "sent";
    }
    // 404/410: the browser unsubscribed or the subscription expired; it will never work again.
    if (status === 404 || status === 410) {
      this.subscriptions.remove(sub.id);
      return "gone";
    }
    this.subscriptions.recordFailure(sub.id);
    return "failed";
  }
}
