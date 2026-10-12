import { z } from "zod";

/** Most devices one owner can register for push; each notification is sent to every one. */
export const MAX_PUSH_DEVICES = 10;

/** A browser subscribed to Web Push. The endpoint and keys stay on the server. */
export interface PushDevice {
  id: string;
  label: string;
  /** Host of the push service (e.g. fcm.googleapis.com), shown to tell devices apart. */
  service: string;
  created_at: string;
  last_success_at: string | null;
  failures: number;
}

export interface PushStatus {
  /** False until the Worker has VAPID keys; everything else keeps working without them. */
  available: boolean;
  public_key: string | null;
  devices: PushDevice[];
  max_devices: number;
}

const b64url = (min: number, max: number) =>
  z.string().min(min).max(max).regex(/^[A-Za-z0-9_-]+=*$/, "Must be base64url");

/** The browser's PushSubscription.toJSON(), plus an optional device label. */
export const pushSubscribeSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({ p256dh: b64url(86, 90), auth: b64url(20, 24) }),
  label: z.string().trim().max(100).optional(),
});

export const pushUnsubscribeSchema = z.object({ endpoint: z.string().url().max(2048) });
