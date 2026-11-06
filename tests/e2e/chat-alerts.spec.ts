import { expect, type Page, test } from "@playwright/test";

const PASSWORD = process.env.TALORYS_DEV_PASSWORD || "talorys-dev-password";

async function login(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("Owner password").fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("What would you like to do today?")).toBeVisible();
}

/** Headless Chromium always denies notifications, so permission and display are stubbed; focus is controlled by the test. */
async function stubNotifications(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { shown: { tag?: string }[]; closedTags: string[]; focused: boolean };
    w.shown = [];
    w.closedTags = [];
    w.focused = false;
    document.hasFocus = () => w.focused;
    const FakeNotification = { permission: "granted", requestPermission: async () => "granted" };
    Object.defineProperty(window, "Notification", { value: FakeNotification });
    const reg = {
      showNotification: async (title: string, options: { tag?: string }) => void w.shown.push({ title, ...options } as never),
      getNotifications: async ({ tag }: { tag: string }) =>
        w.shown.filter((n) => n.tag === tag && !w.closedTags.includes(tag)).slice(-1).map(() => ({ close: () => void w.closedTags.push(tag) })),
    };
    navigator.serviceWorker.getRegistration = (async () => reg) as never;
  });
}

async function sendAndWait(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Copy response" }).last()).toBeVisible({ timeout: 20_000 });
}

test.describe("Chat alerts", () => {
  test("alerts when a reply finishes in an unfocused window, once switched on", async ({ page }) => {
    await stubNotifications(page);
    await login(page);
    await sendAndWait(page, "first message");
    expect(await page.evaluate(() => (window as unknown as { shown: unknown[] }).shown)).toEqual([]);

    await page.getByRole("link", { name: "Settings" }).first().click();
    const toggle = page.getByRole("switch", { name: "Chat alerts on this device" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await page.getByRole("link", { name: "Chat" }).first().click();
    await sendAndWait(page, "second message");
    await expect.poll(() => page.evaluate(() => (window as unknown as { shown: unknown[] }).shown.length)).toBe(1);
    const [alert] = await page.evaluate(() => (window as unknown as { shown: { title: string; data: { url: string } }[] }).shown);
    expect(alert!.title).toBe("Your reply is ready");
    expect(alert!.data.url).toMatch(/^\/chat\/[\w-]+$/);
  });

  test("closes the previous alert in a conversation so the next one is announced", async ({ page }) => {
    await stubNotifications(page);
    await login(page);
    await page.evaluate(() => localStorage.setItem("talorys.chatAlerts", "1"));
    await sendAndWait(page, "first message");
    await expect.poll(() => page.evaluate(() => (window as unknown as { shown: unknown[] }).shown.length)).toBe(1);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("second message");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => (window as unknown as { shown: unknown[] }).shown.length), { timeout: 20_000 }).toBe(2);
    const { shown, closedTags } = await page.evaluate(() => {
      const w = window as unknown as { shown: { tag: string }[]; closedTags: string[] };
      return { shown: w.shown.map((n) => ({ tag: n.tag })), closedTags: w.closedTags };
    });
    expect(closedTags).toEqual([shown[0]!.tag]);
    expect(shown[1]!.tag).toBe(shown[0]!.tag);
  });

  test("alerts when the connection is lost before a turn finishes", async ({ page }) => {
    await stubNotifications(page);
    await login(page);
    await page.evaluate(() => localStorage.setItem("talorys.chatAlerts", "1"));
    await page.route("**/api/chat", (route) => route.abort());
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("doomed message");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => (window as unknown as { shown: unknown[] }).shown.length)).toBe(1);
    const [alert] = await page.evaluate(() => (window as unknown as { shown: { title: string; data: { url: string } }[] }).shown);
    expect(alert!.title).toBe("A reply could not be finished");
    expect(alert!.data.url).toBe("/chat");
  });

  test("a stream that closes without finishing shows why and frees the composer", async ({ page }) => {
    await login(page);
    const sse = (body: string) => ({ status: 200, contentType: "text/event-stream", body });
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    const errorFrame = `event: error\ndata: ${JSON.stringify({ type: "error", code: "CONFLICT", message: "Nothing to retry." })}\n\n`;

    await page.route("**/api/chat", (route) => route.fulfill(sse(errorFrame)));
    await box.fill("refused message");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600); // Outlasts the timer that clears a finished stream.
    await expect(page.getByText("Nothing to retry.")).toBeVisible();
    await page.unroute("**/api/chat");

    await page.route("**/api/chat", (route) => route.fulfill(sse(": stream open\n\n")));
    await box.fill("cut off message");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    await expect(page.getByText("Connection lost.")).toBeVisible();
    await page.unroute("**/api/chat");

    await sendAndWait(page, "working again");
  });

  test("stays quiet while the window has focus", async ({ page }) => {
    await stubNotifications(page);
    await login(page);
    await page.evaluate(() => {
      (window as unknown as { focused: boolean }).focused = true;
      localStorage.setItem("talorys.chatAlerts", "1");
    });
    await sendAndWait(page, "focused message");
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { shown: unknown[] }).shown)).toEqual([]);
  });
});
