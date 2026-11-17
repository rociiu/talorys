import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmPushRegistration, enablePush, PushRegistrationError } from "../src/lib/push";

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

function fakeWorker(initialState: string) {
  const listeners = new Set<() => void>();
  return {
    state: initialState,
    listeners,
    addEventListener: vi.fn((_event: string, listener: () => void) => void listeners.add(listener)),
    removeEventListener: vi.fn((_event: string, listener: () => void) => void listeners.delete(listener)),
    emit() {
      for (const listener of [...listeners]) listener();
    },
  };
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
  const removeDeviceId = vi.fn();
  const successResponse = () => new Response(JSON.stringify({ device, status }), { status: 200, headers: { "content-type": "application/json" } });
  const pendingRegistration = (worker: ReturnType<typeof fakeWorker>, location: "active" | "installing" | "waiting") => {
    const updateListeners = new Set<() => void>();
    return {
      active: location === "active" ? worker : null,
      installing: location === "installing" ? worker : null,
      waiting: location === "waiting" ? worker : null,
      pushManager: { getSubscription, subscribe },
      updateListeners,
      addEventListener: vi.fn((_event: string, listener: () => void) => void updateListeners.add(listener)),
      removeEventListener: vi.fn((_event: string, listener: () => void) => void updateListeners.delete(listener)),
    };
  };

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
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: removeDeviceId });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses an activated worker, subscribes with the VAPID key, and registers the browser subscription", async () => {
    await expect(enablePush(PUBLIC_KEY)).resolves.toEqual({ device, status });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(subscribe).toHaveBeenCalledTimes(1);
    const options = subscribe.mock.calls[0]![0] as PushSubscriptionOptions;
    expect(options.userVisibleOnly).toBe(true);
    expect(Buffer.from(options.applicationServerKey as ArrayBuffer).toString("base64url")).toBe(PUBLIC_KEY);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe("/api/push/subscriptions");
    expect(removeDeviceId).toHaveBeenCalledWith("talorys.pushDevice");
  });

  it("reuses an existing subscription with the same VAPID key without clearing its device ID", async () => {
    const unsubscribe = vi.fn(async () => true);
    getSubscription.mockResolvedValue(browserSubscription(keyBuffer(PUBLIC_KEY), unsubscribe));
    await enablePush(PUBLIC_KEY);
    expect(subscribe).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(removeDeviceId).not.toHaveBeenCalled();
  });

  it.each([keyBuffer(OTHER_KEY), null])("replaces a subscription when its VAPID key does not match", async (existingKey) => {
    const unsubscribe = vi.fn(async () => true);
    getSubscription.mockResolvedValue(browserSubscription(existingKey, unsubscribe));
    await enablePush(PUBLIC_KEY);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe("/api/push/subscriptions/replace");
    expect(JSON.parse(fetcher.mock.calls[0]![1]?.body as string)).toMatchObject({
      ...subscriptionJson,
      old_endpoint: subscriptionJson.endpoint,
    });
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

  it("waits for an activating worker and subscribes only after activation", async () => {
    const worker = fakeWorker("activating");
    const pending = pendingRegistration(worker, "active");
    register.mockResolvedValue(pending);
    const attempt = enablePush(PUBLIC_KEY);
    await vi.waitFor(() => expect(worker.listeners.size).toBe(1));
    expect(subscribe).not.toHaveBeenCalled();

    worker.state = "activated";
    worker.emit();
    await attempt;
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(worker.listeners.size).toBe(0);
    expect(pending.updateListeners.size).toBe(0);
  });

  it("does not miss activation while the state listener is being attached", async () => {
    const worker = fakeWorker("activating");
    worker.addEventListener.mockImplementation((_event: string, listener: () => void) => {
      worker.listeners.add(listener);
      worker.state = "activated";
    });
    const pending = pendingRegistration(worker, "active");
    register.mockResolvedValue(pending);

    await enablePush(PUBLIC_KEY);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(worker.listeners.size).toBe(0);
    expect(pending.updateListeners.size).toBe(0);
  });

  it("follows an installing worker through installed and activating states", async () => {
    const worker = fakeWorker("installing");
    const pending = pendingRegistration(worker, "installing");
    register.mockResolvedValue(pending);
    const attempt = enablePush(PUBLIC_KEY);
    await vi.waitFor(() => expect(worker.listeners.size).toBe(1));

    worker.state = "installed";
    pending.installing = null;
    pending.waiting = worker;
    worker.emit();
    expect(subscribe).not.toHaveBeenCalled();
    worker.state = "activating";
    pending.waiting = null;
    pending.active = worker;
    worker.emit();
    expect(subscribe).not.toHaveBeenCalled();
    worker.state = "activated";
    worker.emit();
    await attempt;
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(worker.listeners.size).toBe(0);
  });

  it("rejects a redundant worker with service worker diagnostics", async () => {
    const worker = fakeWorker("installing");
    const pending = pendingRegistration(worker, "installing");
    register.mockResolvedValue(pending);
    const attempt = enablePush(PUBLIC_KEY).catch((reason: unknown) => reason);
    await vi.waitFor(() => expect(worker.listeners.size).toBe(1));
    worker.state = "redundant";
    worker.emit();

    const error = await attempt;
    expect(error).toBeInstanceOf(PushRegistrationError);
    expect((error as PushRegistrationError).message).toContain("became redundant");
    expect((error as PushRegistrationError).diagnostics.stage).toBe("service-worker");
    expect(subscribe).not.toHaveBeenCalled();
    expect(worker.listeners.size).toBe(0);
  });

  it("bounds activation waits and cleans up listeners on timeout", async () => {
    vi.useFakeTimers();
    const worker = fakeWorker("installing");
    const pending = pendingRegistration(worker, "installing");
    register.mockResolvedValue(pending);
    const attempt = enablePush(PUBLIC_KEY).catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.listeners.size).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);

    const error = await attempt;
    expect(error).toBeInstanceOf(PushRegistrationError);
    expect((error as PushRegistrationError).message).toContain("did not activate within 15 seconds");
    expect((error as PushRegistrationError).diagnostics.stage).toBe("service-worker");
    expect(subscribe).not.toHaveBeenCalled();
    expect(worker.listeners.size).toBe(0);
    expect(pending.updateListeners.size).toBe(0);
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

  it("keeps the confirmed device ID when disabling fails", async () => {
    const unsubscribe = vi.fn(async () => true);
    getSubscription.mockResolvedValue(browserSubscription(keyBuffer(PUBLIC_KEY), unsubscribe));
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: { message: "Unavailable" } }), { status: 500 }));
    const { disablePush } = await import("../src/lib/push");

    await expect(disablePush()).rejects.toThrow("Unavailable");
    expect(removeDeviceId).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("returns backend confirmation even when localStorage writes fail", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new DOMException("Storage denied", "SecurityError"); }, removeItem: removeDeviceId });
    await expect(enablePush(PUBLIC_KEY)).resolves.toEqual({ device, status });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("confirms a reloaded browser subscription by endpoint without trusting the stored device ID", async () => {
    getSubscription.mockResolvedValue(browserSubscription(keyBuffer(PUBLIC_KEY)));
    fetcher.mockResolvedValue(new Response(JSON.stringify({ device, status }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(confirmPushRegistration(PUBLIC_KEY)).resolves.toMatchObject({ device, status });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe("/api/push/subscriptions/current");
    expect(JSON.parse(fetcher.mock.calls[0]![1]?.body as string)).toEqual({ endpoint: subscriptionJson.endpoint });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("does not show a stale stored device as registered after backend deletion", async () => {
    getSubscription.mockResolvedValue(browserSubscription(keyBuffer(PUBLIC_KEY)));
    fetcher.mockResolvedValue(new Response(JSON.stringify({ device: null, status: { ...status, devices: [] } }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(confirmPushRegistration(PUBLIC_KEY)).resolves.toMatchObject({ device: null });
    expect(removeDeviceId).toHaveBeenCalledWith("talorys.pushDevice");
  });

  it("clears a missing local device ID when no browser subscription remains", async () => {
    getSubscription.mockResolvedValue(null);
    await expect(confirmPushRegistration(PUBLIC_KEY)).resolves.toEqual({ subscription: null, device: null, status: null });
    expect(fetcher).not.toHaveBeenCalled();
    expect(removeDeviceId).toHaveBeenCalledWith("talorys.pushDevice");
  });

  it("requires manual re-registration after a VAPID rotation without destroying the old subscription", async () => {
    const unsubscribe = vi.fn(async () => true);
    getSubscription.mockResolvedValue(browserSubscription(keyBuffer(OTHER_KEY), unsubscribe));
    await expect(confirmPushRegistration(PUBLIC_KEY)).resolves.toMatchObject({ device: null });
    expect(fetcher).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("keeps the browser subscription and remembered ID after a partial disable failure", async () => {
    const unsubscribe = vi.fn(async () => false);
    getSubscription.mockResolvedValue(browserSubscription(keyBuffer(PUBLIC_KEY), unsubscribe));
    fetcher.mockResolvedValue(new Response(JSON.stringify({ ...status, devices: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    const { disablePush } = await import("../src/lib/push");
    await expect(disablePush()).rejects.toThrow("Talorys removed this device, but the browser could not remove its push subscription");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(removeDeviceId).not.toHaveBeenCalled();
  });
});
