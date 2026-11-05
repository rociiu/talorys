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
    const w = window as unknown as { shown: unknown[]; focused: boolean };
    w.shown = [];
    w.focused = false;
    document.hasFocus = () => w.focused;
    const FakeNotification = { permission: "granted", requestPermission: async () => "granted" };
    Object.defineProperty(window, "Notification", { value: FakeNotification });
    const reg = { showNotification: async (title: string, options: object) => void w.shown.push({ title, ...options }) };
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
