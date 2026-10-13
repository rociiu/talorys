import { expect, type Page, test } from "@playwright/test";

const PASSWORD = process.env.TALORYS_DEV_PASSWORD || "talorys-dev-password";
const CSRF = { "x-talorys-request": "1" };

async function login(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("Owner password").fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("What would you like to do today?")).toBeVisible();
}

/** A syntactically valid subscription; nothing is ever sent to it in this test. */
async function fakeSubscription(page: Page) {
  return page.evaluate(async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return { endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${Date.now()}`, keys: { p256dh: b64(raw), auth: b64(crypto.getRandomValues(new Uint8Array(16))) }, label: "E2E laptop" };
  });
}

test.describe("Push notifications", () => {
  test("serves the service worker and manifest, and manages devices in Settings", async ({ page }) => {
    await login(page);
    const sw = await page.request.get("/sw.js");
    expect(sw.status()).toBe(200);
    expect(await sw.text()).toContain("showNotification");
    const manifest = await (await page.request.get("/manifest.webmanifest")).json();
    expect(manifest).toMatchObject({ display: "standalone", start_url: "/" });

    const status = await (await page.request.get("/api/push")).json();
    expect(status.available).toBe(true);
    for (const d of status.devices) await page.request.delete(`/api/push/subscriptions/${d.id}`, { headers: CSRF });
    const added = await page.request.post("/api/push/subscriptions", { headers: CSRF, data: await fakeSubscription(page) });
    expect(added.status()).toBe(200);

    await page.getByRole("link", { name: "Settings" }).first().click();
    await expect(page.getByRole("heading", { name: "Push notifications" })).toBeVisible();
    const toggle = page.getByRole("switch", { name: "Push notifications on this device" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    // Headless Chromium always reports notifications as denied (granting does not change it),
    // so this checks the blocked state; subscribing for real needs a headed browser.
    await expect(page.getByText(/Notifications are blocked for this site/)).toBeVisible();
    await expect(toggle).toBeDisabled();
    await expect(page.getByText("E2E laptop")).toBeVisible();
    await expect(page.getByText("1 of 10 devices registered.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send test" })).toBeEnabled();

    await page.getByRole("button", { name: "Remove E2E laptop" }).click();
    await expect(page.getByText("E2E laptop")).toHaveCount(0);
    await expect(page.getByText("0 of 10 devices registered.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send test" })).toBeDisabled();
  });

  test("notification clicks only open paths on the app's own origin", async ({ page }) => {
    await page.goto("/");
    const source = await (await page.request.get("/sw.js")).text();
    const fn = source.match(/function safePath\(url\) \{[\s\S]*?\n\}/)?.[0];
    expect(fn).toBeTruthy();
    const results = await page.evaluate((code) => {
      const safePath = new Function(`${code}; return safePath;`)();
      const inputs = ["/tasks?x=1#a", "/", "//evil.example", "/\\evil.example", "/\\/evil.example", "https://evil.example", "javascript:alert(1)", 42];
      return inputs.map((input) => safePath(input));
    }, fn!);
    expect(results).toEqual(["/tasks?x=1#a", "/", "/", "/", "/", "/", "/", "/"]);
  });
});
