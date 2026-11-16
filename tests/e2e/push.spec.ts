import { expect, type Page, test } from "@playwright/test";

const PASSWORD = process.env.TALORYS_DEV_PASSWORD || "talorys-dev-password";
const CSRF = { "x-talorys-request": "1" };

async function login(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("Owner password").fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("link", { name: "Ask Talorys", exact: true })).toBeVisible();
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


test.describe("Push registration browser flow", () => {
  test("keeps the switch off after Android Chrome's push service error and retries only manually @mobile", async ({ page }) => {
    let backendRequests = 0;
    await page.route("**/api/push/subscriptions", async (route) => {
      backendRequests++;
      await route.continue();
    });
    await page.addInitScript(() => {
      const w = window as unknown as { pushSubscribeAttempts: number };
      w.pushSubscribeAttempts = 0;
      Object.defineProperty(window, "Notification", {
        value: { permission: "granted", requestPermission: async () => "granted" },
      });
      const registration = {
        active: { state: "activated" },
        pushManager: {
          getSubscription: async () => null,
          subscribe: async () => {
            w.pushSubscribeAttempts++;
            throw new DOMException("Registration failed - push service error", "AbortError");
          },
        },
      };
      navigator.serviceWorker.register = (async () => registration) as never;
      navigator.serviceWorker.getRegistration = (async () => registration) as never;
    });

    await login(page);
    await page.getByRole("link", { name: "Settings" }).first().click();
    const toggle = page.getByRole("switch", { name: "Push notifications on this device" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toBeEnabled();
    await toggle.click();

    await expect(page.getByRole("alert")).toContainText("Chrome could not register with its push service");
    await expect(page.getByRole("alert")).toContainText("Google services and network connectivity");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText("Notifications turned on for this device")).toHaveCount(0);
    await page.getByText("Diagnostic details").click();
    await expect(page.getByText("AbortError: Registration failed - push service error", { exact: true })).toBeVisible();
    await expect(page.getByText("Backend request attempted:")).toBeVisible();

    await page.getByRole("tab", { name: "About" }).click();
    await page.getByRole("tab", { name: "General" }).click();
    await expect(page.getByRole("alert")).toContainText("Chrome could not register with its push service");
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => (window as unknown as { pushSubscribeAttempts: number }).pushSubscribeAttempts)).toBe(1);
    expect(backendRequests).toBe(0);

    await page.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { pushSubscribeAttempts: number }).pushSubscribeAttempts)).toBe(2);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText("Notifications turned on for this device")).toHaveCount(0);
    expect(backendRequests).toBe(0);
  });
});


test.describe("Push registration persistence", () => {
  test("requires backend confirmation across reloads and reuses the browser subscription @mobile", async ({ page }) => {
    await login(page);
    const initial = await (await page.request.get("/api/push")).json() as {
      public_key: string;
      devices: { id: string }[];
    };
    for (const device of initial.devices) await page.request.delete(`/api/push/subscriptions/${device.id}`, { headers: CSRF });

    await page.addInitScript((publicKey) => {
      const w = window as unknown as { pushSubscribeAttempts: number; pushUnsubscribeAttempts: number; failPushUnsubscribe: boolean };
      w.pushSubscribeAttempts = 0;
      w.pushUnsubscribeAttempts = 0;
      w.failPushUnsubscribe = false;
      Object.defineProperty(window, "Notification", {
        value: { permission: "granted", requestPermission: async () => "granted" },
      });
      const base64 = publicKey.replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
      const applicationServerKey = Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
      const endpoint = "https://fcm.googleapis.com/fcm/send/persistence";
      const subscription = {
        endpoint,
        options: { userVisibleOnly: true, applicationServerKey },
        toJSON: () => ({ endpoint, keys: { p256dh: publicKey, auth: "AAAAAAAAAAAAAAAAAAAAAA" } }),
        unsubscribe: async () => {
          w.pushUnsubscribeAttempts++;
          if (w.failPushUnsubscribe) {
            w.failPushUnsubscribe = false;
            return false;
          }
          current = null;
          return true;
        },
      };
      let current: typeof subscription | null = subscription;
      const registration = {
        active: { state: "activated" },
        pushManager: {
          getSubscription: async () => current,
          subscribe: async () => {
            w.pushSubscribeAttempts++;
            current = subscription;
            return subscription;
          },
        },
      };
      navigator.serviceWorker.register = (async () => registration) as never;
      navigator.serviceWorker.getRegistration = (async () => registration) as never;
    }, initial.public_key);

    let failBackend = true;
    await page.route("**/api/push/subscriptions", async (route) => {
      if (failBackend && route.request().method() === "POST") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "Registration unavailable" } }) });
      } else {
        await route.continue();
      }
    });
    await page.reload();
    await page.getByRole("link", { name: "Settings" }).first().click();
    const toggle = page.getByRole("switch", { name: "Push notifications on this device" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toBeEnabled();

    await toggle.click();
    await expect(page.getByRole("alert")).toContainText("The browser subscribed, but Talorys could not register this device");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(await page.evaluate(() => (window as unknown as { pushSubscribeAttempts: number }).pushSubscribeAttempts)).toBe(0);

    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toBeEnabled();
    failBackend = false;
    await page.evaluate(() => {
      Storage.prototype.setItem = () => { throw new DOMException("Storage denied", "SecurityError"); };
      Storage.prototype.removeItem = () => { throw new DOMException("Storage denied", "SecurityError"); };
    });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(await page.evaluate(() => (window as unknown as { pushSubscribeAttempts: number }).pushSubscribeAttempts)).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { pushUnsubscribeAttempts: number }).pushUnsubscribeAttempts)).toBe(0);

    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const registered = await (await page.request.get("/api/push")).json() as { devices: { id: string }[] };
    expect(registered.devices).toHaveLength(1);
    await page.request.delete(`/api/push/subscriptions/${registered.devices[0]!.id}`, { headers: CSRF });
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toBeEnabled();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await page.evaluate(() => {
      (window as unknown as { failPushUnsubscribe: boolean }).failPushUnsubscribe = true;
    });
    await toggle.click();
    await expect(page.getByRole("alert")).toContainText("Talorys removed this device, but the browser could not remove its push subscription");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(await page.evaluate(() => (window as unknown as { pushUnsubscribeAttempts: number }).pushUnsubscribeAttempts)).toBe(2);
    const afterDisable = await (await page.request.get("/api/push")).json() as { devices: { id: string }[] };
    expect(afterDisable.devices).toEqual([]);
  });
});


test.describe("Push registration operation states", () => {
  test("prevents duplicate clicks and turns on after backend confirmation when storage is unavailable @mobile", async ({ page }) => {
    await login(page);
    const initial = await (await page.request.get("/api/push")).json() as { public_key: string; devices: { id: string }[] };
    for (const device of initial.devices) await page.request.delete(`/api/push/subscriptions/${device.id}`, { headers: CSRF });

    await page.addInitScript((publicKey) => {
      const w = window as unknown as { pushSubscribeAttempts: number; resolvePushSubscription: (() => void) | null };
      w.pushSubscribeAttempts = 0;
      w.resolvePushSubscription = null;
      Object.defineProperty(window, "Notification", {
        value: { permission: "granted", requestPermission: async () => "granted" },
      });
      const base64 = publicKey.replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
      const applicationServerKey = Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
      const endpoint = "https://fcm.googleapis.com/fcm/send/new-browser-subscription";
      const subscription = {
        endpoint,
        options: { userVisibleOnly: true, applicationServerKey },
        toJSON: () => ({ endpoint, keys: { p256dh: publicKey, auth: "AAAAAAAAAAAAAAAAAAAAAA" } }),
        unsubscribe: async () => {
          window.name = "";
          current = null;
          return true;
        },
      };
      let current: typeof subscription | null = window.name === "push-active" ? subscription : null;
      const registration = {
        active: { state: "activated" },
        pushManager: {
          getSubscription: async () => current,
          subscribe: async () => {
            w.pushSubscribeAttempts++;
            return new Promise<typeof subscription>((resolve) => {
              w.resolvePushSubscription = () => {
                current = subscription;
                window.name = "push-active";
                resolve(subscription);
              };
            });
          },
        },
      };
      navigator.serviceWorker.register = (async () => registration) as never;
      navigator.serviceWorker.getRegistration = (async () => registration) as never;
    }, initial.public_key);

    await page.reload();
    await page.getByRole("link", { name: "Settings" }).first().click();
    const toggle = page.getByRole("switch", { name: "Push notifications on this device" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toBeEnabled();
    await page.evaluate(() => {
      Storage.prototype.setItem = () => { throw new DOMException("Storage denied", "SecurityError"); };
      Storage.prototype.removeItem = () => { throw new DOMException("Storage denied", "SecurityError"); };
    });

    await toggle.click();
    await expect(page.getByText("Turning on…", { exact: true }).first()).toBeVisible();
    await expect(toggle).toBeDisabled();
    await toggle.evaluate((element) => (element as HTMLButtonElement).click());
    expect(await page.evaluate(() => (window as unknown as { pushSubscribeAttempts: number }).pushSubscribeAttempts)).toBe(1);
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await page.evaluate(() => (window as unknown as { resolvePushSubscription: () => void }).resolvePushSubscription());
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("On", { exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { pushSubscribeAttempts: number }).pushSubscribeAttempts)).toBe(1);
    const registered = await (await page.request.get("/api/push")).json() as { devices: { id: string }[] };
    expect(registered.devices).toHaveLength(1);

    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});

test.describe("Push Content Security Policy", () => {
  test("runs the application and root service worker with script-src self", async ({ page }) => {
    const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
    const violations: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("Content Security Policy")) violations.push(message.text());
    });
    let vitePreamble = "";
    await page.route("**/@test-vite-preamble", async (route) => {
      await route.fulfill({ contentType: "text/javascript", body: vitePreamble });
    });
    await page.route("**/", async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const response = await route.fetch();
      // Move Vite's development-only inline React preamble to a same-origin script for this CSP test.
      const html = await response.text();
      const preamble = html.match(/<script type="module">([\s\S]*?)<\/script>/);
      vitePreamble = preamble?.[1] ?? "";
      const body = html.replace(/<script type="module">[\s\S]*?<\/script>/, '<script type="module" src="/@test-vite-preamble"></script>');
      await route.fulfill({ response, body, headers: { ...response.headers(), "content-security-policy": csp } });
    });

    await login(page);
    const scope = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      return registration.scope;
    });
    expect(scope).toBe("http://localhost:5173/");
    const headers = await (await page.request.get("/_headers")).text();
    expect(headers).toContain(`Content-Security-Policy: ${csp}`);
    expect(headers).not.toContain("unsafe-eval");
    expect(headers).not.toContain("static.cloudflareinsights.com");
    expect(violations).toEqual([]);
  });
});
