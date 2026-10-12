import { MAX_PUSH_DEVICES, type PushDevice } from "@talorys/shared";
import { type Database, newId, now } from "../db/database";
import { ValidationError } from "../api/errors";

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  /** The app's origin when the device subscribed; the VAPID contact when none is configured. */
  origin: string;
  created_at: string;
  last_success_at: string | null;
  failures: number;
}

/** Consecutive failed sends after which a subscription is dropped (gone ones go at once). */
export const MAX_PUSH_FAILURES = 10;

export class PushSubscriptionRepository {
  constructor(private readonly db: Database) {}

  all(): PushSubscriptionRow[] {
    return this.db.all<PushSubscriptionRow>(`SELECT * FROM tal_push_subscriptions ORDER BY created_at`);
  }

  devices(): PushDevice[] {
    return this.all().map((r) => ({
      id: r.id,
      label: r.label,
      service: new URL(r.endpoint).hostname,
      created_at: r.created_at,
      last_success_at: r.last_success_at,
      failures: r.failures,
    }));
  }

  /** Adds a device, or refreshes the keys of one already subscribed with the same endpoint. */
  save(input: { endpoint: string; p256dh: string; auth: string; label: string; origin: string }): PushDevice {
    const existing = this.db.one<{ id: string }>(`SELECT id FROM tal_push_subscriptions WHERE endpoint = ?`, input.endpoint);
    const id = existing?.id ?? newId();
    if (existing) {
      this.db.run(
        `UPDATE tal_push_subscriptions SET p256dh = ?, auth = ?, label = ?, origin = ?, failures = 0 WHERE id = ?`,
        input.p256dh, input.auth, input.label, input.origin, id,
      );
    } else {
      const count = this.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_push_subscriptions`)?.n ?? 0;
      if (count >= MAX_PUSH_DEVICES) throw new ValidationError(`At most ${MAX_PUSH_DEVICES} devices can receive notifications. Remove one first.`);
      this.db.run(
        `INSERT INTO tal_push_subscriptions (id, endpoint, p256dh, auth, label, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, input.endpoint, input.p256dh, input.auth, input.label, input.origin, now(),
      );
    }
    return this.devices().find((d) => d.id === id)!;
  }

  remove(id: string): boolean {
    return this.db.run(`DELETE FROM tal_push_subscriptions WHERE id = ?`, id).changes > 0;
  }

  removeByEndpoint(endpoint: string): boolean {
    return this.db.run(`DELETE FROM tal_push_subscriptions WHERE endpoint = ?`, endpoint).changes > 0;
  }

  recordSuccess(id: string): void {
    this.db.run(`UPDATE tal_push_subscriptions SET last_success_at = ?, failures = 0 WHERE id = ?`, now(), id);
  }

  /** Counts a failed send; a subscription that keeps failing is dropped. */
  recordFailure(id: string): void {
    this.db.run(`UPDATE tal_push_subscriptions SET failures = failures + 1 WHERE id = ?`, id);
    this.db.run(`DELETE FROM tal_push_subscriptions WHERE id = ? AND failures >= ?`, id, MAX_PUSH_FAILURES);
  }
}
