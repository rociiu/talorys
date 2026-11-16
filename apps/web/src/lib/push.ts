import type { PushDevice, PushStatus } from "@talorys/shared";
import { api } from "./api";

/** Why this browser cannot turn on push right now, or null when it can. */
export type PushBlocker = "unsupported" | "ios-not-installed" | "denied" | null;
export type PushRegistrationStage = "permission" | "service-worker" | "browser-subscription" | "backend";

export interface PushRegistrationDiagnostics {
  stage: PushRegistrationStage;
  exceptionName: string | null;
  exceptionMessage: string | null;
  permission: NotificationPermission;
  serviceWorkerActive: boolean;
  existingSubscription: boolean;
  backendAttempted: boolean;
}

export class PushRegistrationError extends Error {
  override readonly name = "PushRegistrationError";

  constructor(
    message: string,
    readonly diagnostics: PushRegistrationDiagnostics,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}

const DEVICE_KEY = "talorys.pushDevice";

export function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function pushBlocker(): PushBlocker {
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  // iOS and iPadOS only offer Web Push to web apps opened from the Home Screen.
  if (isIos() && !standalone) return "ios-not-installed";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return null;
}

/** This browser's current push subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+=*$/.test(base64url) || base64url.length % 4 === 1) {
    throw new Error("The deployment's VAPID public key is not valid base64url.");
  }
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4) {
    throw new Error("The deployment's VAPID public key is not an uncompressed P-256 public key.");
  }
  return bytes;
}

const ACTIVATION_TIMEOUT_MS = 15_000;

async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  if (registration.active?.state === "activated") return registration;
  await new Promise<void>((resolve, reject) => {
    const workers = new Set<ServiceWorker>();
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const onStateChange = () => check();
    const onUpdate = () => check();
    const cleanup = () => {
      clearTimeout(timeout);
      registration.removeEventListener("updatefound", onUpdate);
      for (const worker of workers) worker.removeEventListener("statechange", onStateChange);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (settled) return;
      const candidates = [registration.active, registration.installing, registration.waiting].filter((worker): worker is ServiceWorker => !!worker);
      for (const worker of candidates) {
        if (!workers.has(worker)) {
          workers.add(worker);
          worker.addEventListener("statechange", onStateChange);
        }
      }
      if (registration.active?.state === "activated") {
        finish();
      } else if (candidates.length === 0) {
        finish(new Error("The service worker registration has no worker to activate."));
      } else if (candidates.every((worker) => worker.state === "redundant")) {
        finish(new Error("The Talorys service worker became redundant before activation."));
      }
    };
    registration.addEventListener("updatefound", onUpdate);
    timeout = setTimeout(() => finish(new Error("The Talorys service worker did not activate within 15 seconds. Try again.")), ACTIVATION_TIMEOUT_MS);
    check();
  });
  return registration;
}

function exception(error: unknown): { name: string; message: string } {
  const original = error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError", message: String(error) };
  return {
    ...original,
    message: original.message.replace(/https?:\/\/\S+/gi, "[redacted URL]").replace(/\bBearer\s+\S+/gi, "Bearer [redacted]"),
  };
}

function registrationError(stage: PushRegistrationStage, error: unknown, state: Omit<PushRegistrationDiagnostics, "stage" | "exceptionName" | "exceptionMessage">): PushRegistrationError {
  const original = exception(error);
  let message: string;
  if (stage === "browser-subscription" && /Registration failed - push service error/i.test(original.message)) {
    message = "Chrome could not register with its push service. Check Google services and network connectivity on this device, then try again.";
  } else if (stage === "backend") {
    message = `The browser subscribed, but Talorys could not register this device: ${original.message}`;
  } else if (stage === "service-worker") {
    message = `Talorys could not start its notification service worker: ${original.message}`;
  } else if (stage === "permission") {
    message = `Could not request notification permission: ${original.message}`;
  } else {
    message = `The browser could not create a push subscription: ${original.message}`;
  }
  return new PushRegistrationError(message, { stage, ...state, exceptionName: original.name, exceptionMessage: original.message }, error);
}

/** Asks permission (must run from a click), subscribes this browser, and registers it with Talorys. */
export async function enablePush(publicKey: string): Promise<{ device: PushDevice; status: PushStatus }> {
  const state = {
    permission: Notification.permission,
    serviceWorkerActive: false,
    existingSubscription: false,
    backendAttempted: false,
  };
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
    state.permission = permission;
  } catch (error) {
    throw registrationError("permission", error, state);
  }
  if (permission !== "granted") {
    throw new PushRegistrationError("Notifications were not allowed for this site.", { stage: "permission", ...state, exceptionName: null, exceptionMessage: null });
  }

  let applicationServerKey: Uint8Array<ArrayBuffer>;
  try {
    applicationServerKey = keyBytes(publicKey);
  } catch (error) {
    throw registrationError("browser-subscription", error, state);
  }

  let registration: ServiceWorkerRegistration;
  try {
    registration = await activeRegistration();
    state.serviceWorkerActive = true;
  } catch (error) {
    throw registrationError("service-worker", error, state);
  }

  let subscription: PushSubscription;
  try {
    let current = await registration.pushManager.getSubscription();
    state.existingSubscription = !!current;
    const existingKey = current?.options.applicationServerKey;
    if (current && (!existingKey || !sameKey(existingKey, applicationServerKey))) {
      await current.unsubscribe();
      current = null;
    }
    if (current) {
      subscription = current;
    } else {
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      remember(null);
    }
  } catch (error) {
    throw registrationError("browser-subscription", error, state);
  }

  state.backendAttempted = true;
  try {
    const result = await api<{ device: PushDevice; status: PushStatus }>("/push/subscriptions", { method: "POST", body: subscription.toJSON() });
    remember(result.device.id);
    return result;
  } catch (error) {
    throw registrationError("backend", error, state);
  }
}

export async function disablePush(): Promise<PushStatus> {
  const sub = await currentSubscription();
  if (!sub) {
    const status = await api<PushStatus>("/push");
    remember(null);
    return status;
  }
  const status = await api<PushStatus>("/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } });
  let unsubscribed = false;
  try {
    unsubscribed = await sub.unsubscribe();
  } catch (error) {
    throw new Error("Talorys removed this device, but the browser could not remove its push subscription. Retry to finish turning notifications off.", { cause: error });
  }
  if (!unsubscribed) throw new Error("Talorys removed this device, but the browser could not remove its push subscription. Retry to finish turning notifications off.");
  remember(null);
  return status;
}

export interface PushConfirmation {
  subscription: PushSubscription | null;
  device: PushDevice | null;
  status: PushStatus | null;
}

/** Confirms the current browser subscription with the backend instead of trusting a stored device id. */
export async function confirmPushRegistration(publicKey: string): Promise<PushConfirmation> {
  const subscription = await currentSubscription();
  if (!subscription) {
    remember(null);
    return { subscription: null, device: null, status: null };
  }
  const existingKey = subscription.options.applicationServerKey;
  if (!existingKey || !sameKey(existingKey, keyBytes(publicKey))) {
    remember(null);
    return { subscription, device: null, status: null };
  }
  const result = await api<{ device: PushDevice | null; status: PushStatus }>("/push/subscriptions/current", {
    method: "POST",
    body: { endpoint: subscription.endpoint },
  });
  remember(result.device?.id ?? null);
  return { ...result, subscription };
}

export function forgetPushDevice() {
  remember(null);
}

function sameKey(a: ArrayBuffer, b: Uint8Array): boolean {
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** The device id this browser registered as, to mark it in the device list. */
export function thisDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

function remember(id: string | null) {
  try {
    if (id) localStorage.setItem(DEVICE_KEY, id);
    else localStorage.removeItem(DEVICE_KEY);
  } catch {
    /* storage unavailable (private mode); only the "this device" marker is lost */
  }
}
