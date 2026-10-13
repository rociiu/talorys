import { MAX_PUSH_DEVICES } from "@talorys/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { client, inAgent, loggedIn } from "./helpers";
import { fakeBrowser } from "./push-helpers";
import { endpointProblem } from "../src/push/endpoint";
import { deviceLabel } from "../src/push/routes";

beforeEach(async () => {
  await inAgent((agent) => agent.services.db.run(`DELETE FROM tal_push_subscriptions`));
});

describe("push endpoint validation", () => {
  it.each([
    ["http://fcm.googleapis.com/x", /https/],
    ["https://user:pw@fcm.googleapis.com/x", /credentials/],
    ["https://fcm.googleapis.com:8443/x", /default https port/],
    ["https://127.0.0.1/x", /known browser push service/],
    ["https://2130706433/x", /known browser push service/],
    ["https://[::1]/x", /known browser push service/],
    ["https://localhost/x", /known browser push service/],
    ["https://printer.local/x", /known browser push service/],
    ["https://example.com/push", /known browser push service/],
    ["https://fcm.googleapis.com.example.com/x", /known browser push service/],
    ["https://evilpush.apple.com.example.net/x", /known browser push service/],
    ["https://notpush.apple.com/x", /known browser push service/],
    ["not a url", /valid URL/],
  ])("refuses %s", (url, reason) => {
    expect(endpointProblem(url)).toMatch(reason);
  });

  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QGx",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ])("accepts %s", (url) => {
    expect(endpointProblem(url)).toBeNull();
  });
});

describe("push API", () => {
  it("requires a session and the CSRF header", async () => {
    const anon = client();
    expect((await anon.call("/api/push")).status).toBe(401);
    const c = await loggedIn();
    const browser = await fakeBrowser();
    const res = await c.call("/api/push/subscriptions", { method: "POST", body: browser.json, headers: { "x-talorys-request": "0" } });
    expect(res.status).toBe(403);
    expect((await c.json("/api/push")).devices).toEqual([]);
  });

  it("reports that push is available and exposes only the public key", async () => {
    const c = await loggedIn();
    const status = await c.json("/api/push");
    expect(status.available).toBe(true);
    expect(status.public_key).toMatch(/^[\w-]{87}$/);
    expect(status.max_devices).toBe(MAX_PUSH_DEVICES);
    expect(JSON.stringify(status)).not.toContain("PRIVATE");
    const health = await client().json("/api/health");
    expect(health.push).toBe(true);
  });

  it("subscribes, refreshes the same endpoint, and removes devices", async () => {
    const c = await loggedIn();
    const browser = await fakeBrowser();
    const first = await c.json("/api/push/subscriptions", { method: "POST", body: { ...browser.json, label: "My phone" } });
    expect(first.device).toMatchObject({ label: "My phone", service: "fcm.googleapis.com", failures: 0, last_success_at: null });
    expect(JSON.stringify(first)).not.toContain(browser.endpoint);
    const again = await c.json("/api/push/subscriptions", { method: "POST", body: browser.json });
    expect(again.device.id).toBe(first.device.id);
    expect(again.status.devices).toHaveLength(1);

    const other = await fakeBrowser("https://updates.push.services.mozilla.com/wpush/v2/xyz");
    const second = await c.json("/api/push/subscriptions", { method: "POST", body: other.json });
    expect(second.status.devices).toHaveLength(2);

    const afterDelete = await c.json(`/api/push/subscriptions/${first.device.id}`, { method: "DELETE" });
    expect(afterDelete.devices.map((d: { id: string }) => d.id)).toEqual([second.device.id]);
    expect((await c.call(`/api/push/subscriptions/${first.device.id}`, { method: "DELETE" })).status).toBe(404);

    const afterUnsub = await c.json("/api/push/unsubscribe", { method: "POST", body: { endpoint: other.endpoint } });
    expect(afterUnsub.devices).toEqual([]);
  });

  it("rejects unsafe endpoints and malformed keys without storing anything", async () => {
    const c = await loggedIn();
    const browser = await fakeBrowser("https://10.0.0.5/push");
    const res = await c.call("/api/push/subscriptions", { method: "POST", body: browser.json });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/known browser push service/);
    const good = await fakeBrowser();
    const badKeys = await c.call("/api/push/subscriptions", { method: "POST", body: { ...good.json, keys: { p256dh: "x", auth: good.json.keys.auth } } });
    expect(badKeys.status).toBe(400);
    expect((await c.json("/api/push")).devices).toEqual([]);
  });

  it(`caps subscriptions at ${MAX_PUSH_DEVICES} devices`, async () => {
    const c = await loggedIn();
    for (let i = 0; i < MAX_PUSH_DEVICES; i++) {
      const res = await c.call("/api/push/subscriptions", { method: "POST", body: (await fakeBrowser()).json });
      expect(res.status).toBe(200);
    }
    const over = await c.call("/api/push/subscriptions", { method: "POST", body: (await fakeBrowser()).json });
    expect(over.status).toBe(400);
    expect((await c.json("/api/push")).devices).toHaveLength(MAX_PUSH_DEVICES);
  });

  it("never puts push subscriptions in a backup", async () => {
    const c = await loggedIn();
    const browser = await fakeBrowser();
    await c.json("/api/push/subscriptions", { method: "POST", body: browser.json });
    const backup = await (await c.call("/api/export")).text();
    expect(backup).not.toContain(browser.endpoint);
    expect(backup).not.toContain(browser.json.keys.auth);
  });

  it("labels devices from the user agent", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("Edge on Windows");
    expect(deviceLabel("")).toBe("Browser");
  });
});
