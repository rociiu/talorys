import { expect, type Page, test } from "@playwright/test";

const PASSWORD = process.env.TALORYS_DEV_PASSWORD || "talorys-dev-password";

async function login(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("Owner password").fill(PASSWORD);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
}

const composer = (page: Page) => page.getByRole("textbox", { name: "Message", exact: true });

async function sendAndWait(page: Page, text: string) {
  await composer(page).fill(text);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
}

test.describe("chat when things go wrong", () => {
  test("a message that never reached the server goes back to the composer", async ({ page }) => {
    await login(page);
    await page.route("**/api/chat", (route) => route.abort("failed"));
    await composer(page).fill("carefully written message");
    await page.keyboard.press("Enter");

    await expect(page.getByText("Can't reach Talorys. Check your connection and try again.")).toBeVisible();
    await expect(composer(page)).toHaveValue("carefully written message");
    // Nothing was saved, so there is nothing to retry and no bubble pretending it was sent.
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
    await expect(page.locator("section .overflow-y-auto").getByText("carefully written message")).toHaveCount(0);

    await page.unroute("**/api/chat");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
    await expect(page.locator("section .overflow-y-auto").getByText("carefully written message")).toBeVisible();
  });

  test("the same holds in an existing conversation", async ({ page }) => {
    await login(page);
    await sendAndWait(page, "first message");
    await page.route("**/api/chat", (route) => route.abort("failed"));
    await composer(page).fill("second message");
    await page.keyboard.press("Enter");
    await expect(composer(page)).toHaveValue("second message");
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  });

  test("a reply in one conversation doesn't take over the composer in another", async ({ page }) => {
    await login(page);
    await sendAndWait(page, "conversation one");
    await page.getByRole("button", { name: "New chat" }).click();
    // The URL changes just before the page does, and a message sent in that gap would go to the old chat.
    await expect(page.getByRole("heading", { name: "New conversation" })).toBeVisible();
    await sendAndWait(page, "conversation two");
    const twoUrl = page.url();

    // Holds this request open, as a slow reply would.
    await page.route("**/api/chat", () => {});
    await composer(page).fill("slow reply here");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();

    const sidebar = page.locator("aside nav[aria-label='Conversations']");
    await sidebar.getByRole("button", { name: /^conversation one/ }).click();
    await expect(page.getByRole("heading", { name: "conversation one" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();

    await page.goto(twoUrl);
  });

  test("the conversation menu closes on Escape and on a press elsewhere", async ({ page }) => {
    await login(page);
    await sendAndWait(page, "menu test");
    const sidebar = page.locator("aside nav[aria-label='Conversations']");
    const options = sidebar.getByRole("button", { name: "Options for menu test" }).first();
    const rename = sidebar.getByRole("button", { name: "Rename" });

    await options.click();
    await expect(options).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(rename).toHaveCount(0);
    await expect(options).toBeFocused();

    await options.click();
    await expect(rename).toBeVisible();
    await page.getByRole("heading", { name: "menu test" }).click();
    await expect(rename).toHaveCount(0);
  });

  test("tabs are titled after what's open, and a locked tab forgets it", async ({ page }) => {
    await login(page);
    await sendAndWait(page, "titled conversation");
    await expect(page).toHaveTitle(/^titled conversation · /);
    await page.getByRole("link", { name: "Tasks" }).click();
    await expect(page).toHaveTitle(/^Tasks · /);
    await page.getByRole("button", { name: "Lock" }).click();
    await expect(page.getByPlaceholder("Owner password")).toBeVisible();
    await expect(page).toHaveTitle("Talorys");
  });
});

test.describe("a page chunk that won't load", () => {
  test("reloads once, then offers a way forward instead of a blank screen", async ({ page }) => {
    await login(page);
    let loads = 0;
    page.on("load", () => loads++);
    // What a tab left open across an update sees: the old chunk is gone.
    await page.route("**/src/pages/NotesPage.tsx*", (route) => route.abort("failed"));
    await page.getByRole("link", { name: "Notes" }).click();

    // The message can render just before the automatic reload starts, so wait for the reload first.
    await expect.poll(() => loads, { timeout: 15_000 }).toBe(1);
    await expect(page.getByText("Talorys was updated while this page was open.")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1_000);
    expect(loads).toBe(1); // The one automatic reload, not a loop.
    await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
    // The app around the failed page still works.
    await page.getByRole("link", { name: "Tasks" }).click();
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  });
});

test.describe("notes when saving fails", () => {
  test("shows one status and backs off instead of retrying every second", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Notes" }).click();
    await page.getByRole("button", { name: "New note" }).click();
    await expect(page.getByRole("textbox", { name: "Note title" })).toBeVisible();

    let attempts = 0;
    await page.route("**/api/notes/*", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      attempts++;
      await new Promise((r) => setTimeout(r, 100));
      await route.abort("failed").catch(() => {}); // Already released if the test has moved on.
    });
    await page.getByRole("textbox", { name: "Note title" }).fill("Unsaved title");
    await expect(page.getByText("Couldn't save")).toBeVisible();
    await page.waitForTimeout(6000);
    expect(attempts).toBeLessThanOrEqual(3); // 1s, then 2s and 4s apart; it was 6 or more before the backoff.
    await expect(page.getByRole("status").filter({ hasText: "Can't reach Talorys" })).toHaveCount(0);

    // It recovers by itself on the next attempt, once the connection is back.
    await page.unroute("**/api/notes/*");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 20_000 });
  });
});
