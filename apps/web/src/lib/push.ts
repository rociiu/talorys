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

async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  if (registration.active) return registration;
  const worker = registration.installing ?? registration.waiting;
  if (!worker) throw new Error("The service worker registration has no worker to activate.");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => worker.removeEventListener("statechange", onStateChange);
    const onStateChange = () => {
      if (registration.active) {
        cleanup();
        resolve();
      } else if (worker.state === "redundant") {
        cleanup();
        reject(new Error("The Talorys service worker became redundant before activation."));
      }
    };
    worker.addEventListener("statechange", onStateChange);
    onStateChange();
  });
  return registration;
}

function exception(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError", message: String(error) };
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
    subscription = current ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }));
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
  remember(null);
  if (!sub) return api<PushStatus>("/push");
  const status = await api<PushStatus>("/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
  return status;
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
