import { beforeEach, describe, expect, it } from "vitest";
import type { TalorysAgent } from "../src/agent/talorys-agent";
import { b64url } from "../src/push/encoding";
import { MAX_PUSH_FAILURES, PushSubscriptionRepository } from "../src/push/repository";
import { PushService, toPushMessage } from "../src/push/service";
import { inAgent, loggedIn } from "./helpers";
import { decryptAsBrowser, fakeBrowser, pushServiceStub } from "./push-helpers";

beforeEach(async () => {
  await inAgent((agent) => agent.services.db.run(`DELETE FROM tal_push_subscriptions`));
});

async function subscribe(agent: TalorysAgent, endpoint?: string) {
  const browser = await fakeBrowser(endpoint);
  agent.services.push.subscriptions.save({
    endpoint: browser.endpoint, p256dh: b64url(browser.p256dh), auth: b64url(browser.auth), label: "Test", origin: "https://me.pages.dev",
  });
  return browser;
}

describe("push delivery", () => {
  it("sends every new notification, encrypted for the device, with VAPID auth", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const browser = await subscribe(agent);
      const stub = pushServiceStub(201);
      s.push.fetcher = stub.fetcher;
      const n = s.notifications.create({ title: "Reminder", body: "**Call** the dentist", automation_id: null });
      await s.push.idle();
      expect(stub.sent).toHaveLength(1);
      const req = stub.sent[0]!;
      expect(req.url).toBe(browser.endpoint);
      expect(req.headers).toMatchObject({ "content-encoding": "aes128gcm", ttl: "86400", urgency: "high" });
      expect(req.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
      expect(new TextDecoder().decode(req.body)).not.toContain("dentist");
      expect(await decryptAsBrowser(req.body, browser)).toEqual({ title: "Reminder", body: "Call the dentist", id: n.id, url: "/" });
      expect(s.push.subscriptions.devices()[0]!.last_success_at).not.toBeNull();
    });
  });

  it("removes a subscription the push service reports as gone, and counts other failures", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      await subscribe(agent, "https://fcm.googleapis.com/fcm/send/gone");
      await subscribe(agent, "https://fcm.googleapis.com/fcm/send/flaky");
      s.push.fetcher = (async (url: RequestInfo | URL) => new Response(null, { status: String(url).endsWith("gone") ? 410 : 503 })) as typeof fetch;
      expect(await s.push.sendToAll(toPushMessage({ id: "x", title: "t", body: "b" }))).toEqual({ sent: 0, gone: 1, failed: 1 });
      const devices = s.push.subscriptions.devices();
      expect(devices).toHaveLength(1);
      expect(devices[0]!.failures).toBe(1);
      for (let i = 1; i < MAX_PUSH_FAILURES; i++) await s.push.sendToAll(toPushMessage({ id: "x", title: "t", body: "b" }));
      expect(s.push.subscriptions.devices()).toEqual([]);
    });
  });

  it("finishes a reminder automation even when every push send throws", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      await subscribe(agent);
      s.push.fetcher = (async () => {
        throw new Error("network down");
      }) as typeof fetch;
      const a = await s.automations.create({
        name: "Stretch", kind: "reminder", message: "Time to stretch", schedule: { type: "interval", minutes: 15 }, enabled: true,
      });
      await agent.runAutomation({ automationId: a.id }, { id: a.schedule_id! });
      await s.push.idle();
      expect(s.automations.get(a.id)).toMatchObject({ run_count: 1, last_error: null });
      expect(s.notifications.list({ limit: 1 })[0]).toMatchObject({ body: "Time to stretch", automation_id: a.id });
      expect(s.push.subscriptions.devices()[0]!.failures).toBe(1);
      await s.automations.delete(a.id);
    });
  });

  it("does nothing without VAPID keys, and does not send when nobody subscribed", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const unconfigured = new PushService(new PushSubscriptionRepository(s.db), {}, () => {});
      expect(unconfigured.status()).toMatchObject({ available: false, public_key: null });
      const stub = pushServiceStub();
      s.push.fetcher = stub.fetcher;
      s.notifications.create({ title: "Nobody listening", body: "x" });
      await s.push.idle();
      expect(stub.sent).toEqual([]);
    });
  });

  it("sends a test notification from the API", async () => {
    const c = await loggedIn();
    const browser = await fakeBrowser();
    await c.json("/api/push/subscriptions", { method: "POST", body: browser.json });
    const stub = pushServiceStub(201);
    await inAgent((agent) => { agent.services.push.fetcher = stub.fetcher; });
    const res = await c.json("/api/push/test", { method: "POST" });
    expect(res.result).toEqual({ sent: 1, gone: 0, failed: 0 });
    expect(await decryptAsBrowser(stub.sent[0]!.body, browser)).toMatchObject({ body: "Test notification: push works on this device." });
  });

  it("shortens long or Markdown bodies for the system notification", () => {
    const m = toPushMessage({ id: "n1", title: "Digest", body: `**Overdue (3)**\n- ${"a".repeat(400)}` });
    expect(m.body.startsWith("Overdue (3) - aaa")).toBe(true);
    expect(m.body).toHaveLength(240);
    expect(m.body.endsWith("…")).toBe(true);
  });
});
