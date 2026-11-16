import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enablePush, PushRegistrationError } from "../src/lib/push";

const PUBLIC_KEY = Buffer.from([4, ...new Array(64).fill(1)]).toString("base64url");
const OTHER_KEY = Buffer.from([4, ...new Array(64).fill(2)]).toString("base64url");
const device = { id: "device-1", label: "Chrome on Android", service: "fcm.googleapis.com", created_at: "now", last_success_at: null, failures: 0 };
const status = { available: true, public_key: PUBLIC_KEY, devices: [device], max_devices: 10 };
const subscriptionJson = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test",
  keys: { p256dh: PUBLIC_KEY, auth: Buffer.from(new Array(16).fill(3)).toString("base64url") },
};

const keyBuffer = (key: string) => {
  const bytes = Buffer.from(key, "base64url");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

function browserSubscription(key: ArrayBuffer | null, unsubscribe = vi.fn(async () => true)) {
  return {
    endpoint: subscriptionJson.endpoint,
    options: { userVisibleOnly: true, applicationServerKey: key },
    toJSON: () => subscriptionJson,
    unsubscribe,
  } as unknown as PushSubscription;
}

async function registrationError() {
  const error = await enablePush(PUBLIC_KEY).catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(PushRegistrationError);
  return error as PushRegistrationError;
}

describe("push registration", () => {
  const subscribe = vi.fn();
  const getSubscription = vi.fn();
  const register = vi.fn();
  const requestPermission = vi.fn();
  const fetcher = vi.fn();
  const registration = { active: { state: "activated" }, pushManager: { getSubscription, subscribe } };
  const successResponse = () => new Response(JSON.stringify({ device, status }), { status: 200, headers: { "content-type": "application/json" } });

  beforeEach(() => {
    vi.clearAllMocks();
    getSubscription.mockResolvedValue(null);
    subscribe.mockResolvedValue(browserSubscription(keyBuffer(PUBLIC_KEY)));
    register.mockResolvedValue(registration);
    requestPermission.mockResolvedValue("granted");
    fetcher.mockResolvedValue(successResponse());
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    vi.stubGlobal("navigator", { serviceWorker: { register, getRegistration: async () => registration } });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("subscribes with the VAPID key and registers the browser subscription", async () => {
    await expect(enablePush(PUBLIC_KEY)).resolves.toEqual({ device, status });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(subscribe).toHaveBeenCalledTimes(1);
    const options = subscribe.mock.calls[0]![0] as PushSubscriptionOptions;
    expect(options.userVisibleOnly).toBe(true);
    expect(Buffer.from(options.applicationServerKey as ArrayBuffer).toString("base64url")).toBe(PUBLIC_KEY);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe("/api/push/subscriptions");
  });

  it("reuses an existing subscription with the same VAPID key", async () => {
    const unsubscribe = vi.fn(async () => true);
    getSubscription.mockResolvedValue(browserSubscription(keyBuffer(PUBLIC_KEY), unsubscribe));
    await enablePush(PUBLIC_KEY);
    expect(subscribe).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([keyBuffer(OTHER_KEY), null])("replaces a subscription when its VAPID key does not match", async (existingKey) => {
    const unsubscribe = vi.fn(async () => true);
    getSubscription.mockResolvedValue(browserSubscription(existingKey, unsubscribe));
    await enablePush(PUBLIC_KEY);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid VAPID key before changing an existing subscription", async () => {
    const unsubscribe = vi.fn(async () => true);
    getSubscription.mockResolvedValue(browserSubscription(keyBuffer(OTHER_KEY), unsubscribe));
    const error = await enablePush("not-a-key").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PushRegistrationError);
    expect((error as PushRegistrationError).diagnostics.stage).toBe("browser-subscription");
    expect(register).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("classifies service worker registration failures before using push", async () => {
    register.mockRejectedValue(new DOMException("Worker script unavailable", "NetworkError"));
    const error = await registrationError();
    expect(error.diagnostics).toMatchObject({
      stage: "service-worker",
      exceptionName: "NetworkError",
      exceptionMessage: "Worker script unavailable",
      permission: "granted",
      serviceWorkerActive: false,
      existingSubscription: false,
      backendAttempted: false,
    });
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves AbortError diagnostics and does not retry subscribe", async () => {
    subscribe.mockRejectedValue(new DOMException("Subscription aborted", "AbortError"));
    const error = await registrationError();
    expect(error.diagnostics).toMatchObject({
      stage: "browser-subscription",
      exceptionName: "AbortError",
      exceptionMessage: "Subscription aborted",
      serviceWorkerActive: true,
      existingSubscription: false,
      backendAttempted: false,
    });
    expect(error.cause).toBeInstanceOf(DOMException);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("explains Android Chrome's push service error without assigning a root cause", async () => {
    subscribe.mockRejectedValue(new DOMException("Registration failed - push service error", "AbortError"));
    const error = await registrationError();
    expect(error.message).toContain("Chrome could not register with its push service");
    expect(error.message).toContain("Google services and network connectivity");
    expect(error.message).not.toContain("FCM is unavailable");
    expect(error.diagnostics.exceptionMessage).toBe("Registration failed - push service error");
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("classifies backend failure and preserves the new browser subscription for manual retry", async () => {
    const unsubscribe = vi.fn(async () => true);
    const subscription = browserSubscription(keyBuffer(PUBLIC_KEY), unsubscribe);
    subscribe.mockResolvedValue(subscription);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: { message: "Registration refused" } }), { status: 400 }));
    const error = await registrationError();
    expect(error.message).toContain("The browser subscribed, but Talorys could not register this device");
    expect(error.diagnostics).toMatchObject({ stage: "backend", backendAttempted: true, exceptionName: "Error" });
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);

    getSubscription.mockResolvedValue(subscription);
    fetcher.mockResolvedValue(successResponse());
    await enablePush(PUBLIC_KEY);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("classifies denied permission without registering a worker", async () => {
    requestPermission.mockResolvedValue("denied");
    const error = await registrationError();
    expect(error.diagnostics).toMatchObject({ stage: "permission", permission: "denied", exceptionName: null, backendAttempted: false });
    expect(register).not.toHaveBeenCalled();
  });
});
