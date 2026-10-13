import { expect, type Page, test } from "@playwright/test";

const PASSWORD = process.env.TALORYS_DEV_PASSWORD || "talorys-dev-password";

async function login(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("Owner password").fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("What would you like to do today?")).toBeVisible();
}

test.describe("Talorys owner experience", () => {
  test("login rejects a wrong password and has no signup", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Talorys", exact: true })).toBeVisible();
    await expect(page.getByText(/sign ?up|register|create account/i)).toHaveCount(0);
    await page.getByPlaceholder("Owner password").fill("definitely-wrong-1");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByRole("alert")).toContainText("Incorrect password");
  });

  test("chat streams a reply, shows tool activity and persists across reloads", async ({ page }) => {
    await login(page);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("add task e2e review the roadmap");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
    await expect(page.getByLabel("Actions taken").getByText(/Adding task/)).toBeVisible();
    await expect(page.getByText('Added the task "e2e review the roadmap".')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Added the task "e2e review the roadmap".')).toBeVisible();
    await expect(page.getByRole("heading", { name: "add task e2e review the roadmap" })).toBeVisible();
  });

  test("the first message of a new chat shows once while the reply streams @mobile", async ({ page }) => {
    await login(page);
    const text = "tell me something about e2e duplicate bubbles";
    const loaded = page.waitForResponse((r) => /\/api\/conversations\/[0-9a-f-]{36}$/.test(r.url()));
    await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
    await page.keyboard.press("Enter");
    // The saved conversation loads mid-stream and already contains the owner's message.
    await loaded;
    const bubbles = page.locator("section .overflow-y-auto").getByText(text, { exact: true });
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
    // Count once rather than retrying: the duplicate only lasts until the reply finishes.
    expect(await bubbles.count()).toBe(1);
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    await expect(bubbles).toHaveCount(1);
  });

  test("deleting through chat waits for the owner to approve the exact task", async ({ page }) => {
    await login(page);
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await composer.fill("add task e2e approve-me");
    await page.keyboard.press("Enter");
    await expect(page.getByText('Added the task "e2e approve-me".')).toBeVisible();
    // The reply text lands before the turn finishes; the composer ignores Enter until it does.
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    await composer.fill("delete task e2e approve-me");
    await page.keyboard.press("Enter");
    const card = page.getByRole("group", { name: "Approval needed" });
    await expect(card.getByText("Delete task “e2e approve-me”?")).toBeVisible();
    await expect(page.getByText(`I've asked to delete "e2e approve-me". Approve it above if you want it gone.`)).toBeVisible();
    // The card survives a reload and nothing has been deleted yet.
    await page.reload();
    await expect(card.getByText("Delete task “e2e approve-me”?")).toBeVisible();
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Delete task “e2e approve-me” · Approved and done/)).toBeVisible();
    await page.getByRole("link", { name: "Tasks" }).first().click();
    await expect(page.getByText("e2e approve-me")).toHaveCount(0);
  });

  test("a proposed note rewrite shows the exact new text before approval", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Notes" }).first().click();
    await page.getByRole("button", { name: "New note" }).click();
    await page.getByLabel("Note title").fill("e2e Rewrite me");
    await page.getByLabel("Note content").fill("Original packing list");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const noteUrl = page.url();
    const noteId = new URL(noteUrl).pathname.split("/").pop();
    await page.getByRole("link", { name: "Chat" }).first().click();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill(`rewrite note ${noteId} as: Only the charger now`);
    await page.keyboard.press("Enter");
    const card = page.getByRole("group", { name: "Approval needed" });
    await expect(card.getByText("Rewrite note “e2e Rewrite me” (21 → 20 characters)?")).toBeVisible();
    await expect(card.getByRole("region", { name: "Proposed text" })).toHaveText("Only the charger now");
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Rewrite note “e2e Rewrite me” .* · Approved and done/)).toBeVisible();
    await page.goto(noteUrl);
    await expect(page.getByRole("textbox", { name: "Note content" })).toHaveValue("Only the charger now");
  });

  test("conversations can be renamed and deleted", async ({ page }) => {
    await login(page);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("list tasks");
    await page.keyboard.press("Enter");
    await expect(page.getByText(/open tasks|no open tasks/i).first()).toBeVisible();
    const sidebar = page.getByRole("navigation", { name: "Conversations" });
    await sidebar.getByRole("button", { name: "Options for list tasks" }).first().click();
    await page.getByRole("button", { name: "Rename" }).click();
    await page.getByLabel("Title").fill("Renamed by e2e");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(sidebar.getByText("Renamed by e2e")).toBeVisible();
    await sidebar.getByRole("button", { name: "Options for Renamed by e2e" }).click();
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(sidebar.getByText("Renamed by e2e")).toHaveCount(0);
  });

  test("tasks can be added, completed and edited without AI", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Tasks" }).first().click();
    await page.getByLabel("New task title").fill("e2e water the plants");
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByText("e2e water the plants")).toBeVisible();
    await page.getByRole("button", { name: "Complete “e2e water the plants”" }).click();
    await page.getByRole("tab", { name: /completed/i }).click();
    await expect(page.getByText("e2e water the plants")).toBeVisible();
    await page.getByText("e2e water the plants").click();
    await page.getByLabel("Title").fill("e2e water the plants twice");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("e2e water the plants twice")).toBeVisible();
    await page.getByText("e2e water the plants twice").click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("dialog")).toContainText("“e2e water the plants twice” will be permanently deleted.");
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("e2e water the plants twice")).toHaveCount(0);
  });

  test("memories can be added, searched, edited and deleted", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Memory" }).first().click();
    await page.getByRole("button", { name: "Add memory" }).click();
    await page.getByLabel("What should Talorys remember?").fill("Enjoys e2e jazz on Sundays");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Enjoys e2e jazz on Sundays")).toBeVisible();
    await page.getByLabel("Search memories").fill("jazz");
    await expect(page.getByText("Enjoys e2e jazz on Sundays")).toBeVisible();
    await page.getByRole("button", { name: "Delete memory" }).first().click();
    await page.getByRole("button", { name: "Forget" }).click();
    await expect(page.getByText("Enjoys e2e jazz on Sundays")).toHaveCount(0);
  });

  test("memory history keeps replaced facts as past and asks about unclear conflicts", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Memory" }).first().click();
    const add = async (content: string) => {
      await page.getByRole("button", { name: "Add memory" }).click();
      await page.getByLabel("What should Talorys remember?").fill(content);
      await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    };
    await add("I own a Volkswagen history-e2e");
    await add("I sold my Volkswagen history-e2e and bought a Tesla");
    await page.getByRole("tab", { name: /Historical/ }).click();
    const old = page.getByRole("listitem").filter({ hasText: "I own a Volkswagen history-e2e" });
    await expect(old.getByText("Past")).toBeVisible();
    await old.getByRole("button", { name: "Replaced by a newer memory" }).click();
    const history = page.getByRole("dialog");
    await expect(history).toContainText("Current");
    await expect(history).toContainText("I sold my Volkswagen history-e2e and bought a Tesla");
    await expect(history).toContainText("Previously");
    await history.getByRole("button", { name: "Close" }).click();

    await page.getByRole("tab", { name: /All/ }).click();
    await add("I live in Lima history-e2e");
    await add("I live in Quito history-e2e");
    const conflicts = page.getByRole("region", { name: "Possible conflicts" });
    await expect(conflicts).toContainText("I live in Lima history-e2e");
    await conflicts.getByRole("button", { name: "Keep both" }).click();
    await expect(conflicts).toHaveCount(0);
  });

  test("notes support Markdown editing and search", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Notes" }).first().click();
    await page.getByRole("button", { name: "New note" }).click();
    await page.getByLabel("Note title").fill("e2e Packing list");
    await page.getByLabel("Note content").fill("## Bring\n- passport\n- charger");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByRole("heading", { name: "Bring" })).toBeVisible();
    await page.getByLabel("Search notes").fill("passport");
    await expect(page.getByRole("button", { name: /e2e Packing list/ })).toBeVisible();
  });

  test("note autosave settles and edits survive switching notes", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Notes" }).first().click();
    await page.getByRole("button", { name: "New note" }).click();
    // A title with surrounding spaces is stored trimmed; autosave must not loop.
    await page.getByLabel("Note title").fill("  e2e Spaced title  ");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    let patches = 0;
    page.on("request", (r) => {
      if (r.method() === "PATCH" && r.url().includes("/api/notes/")) patches++;
    });
    await page.waitForTimeout(2500);
    expect(patches).toBe(0);

    // Typing then switching notes immediately (before autosave fires) keeps the edit.
    await page.getByRole("button", { name: "New note" }).click();
    await expect(page.getByLabel("Note title")).toHaveValue("Untitled");
    await page.getByLabel("Note title").fill("e2e Quick switch");
    await page.getByRole("button", { name: /e2e Spaced title/ }).click();
    await expect(page.getByRole("button", { name: /e2e Quick switch/ })).toBeVisible();
  });

  test("notes support todos that can be toggled", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Notes" }).first().click();
    await page.getByRole("button", { name: "New note" }).click();
    await page.getByLabel("Note title").fill("e2e Errands");
    const editor = page.getByLabel("Note content");
    await editor.click();
    await page.getByRole("button", { name: "Add todo" }).click();
    await page.keyboard.type("buy milk");
    await page.keyboard.press("Enter");
    await page.keyboard.type("call mom");
    await expect(editor).toHaveValue("- [ ] buy milk\n- [ ] call mom");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(editor).toHaveValue("- [ ] buy milk\n- [x] call mom");
    await page.screenshot({ path: "test-results/notes-writer.png" });
    await page.getByRole("button", { name: "Preview" }).click();
    await page.getByRole("checkbox", { name: "Mark as done" }).click();
    await expect(page.getByRole("checkbox", { name: "Mark as not done" })).toHaveCount(2);
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /e2e Errands.*2\/2/ })).toBeVisible();
  });

  test("automations can be scheduled, paused and deleted", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Automations" }).first().click();
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByLabel("Reminder message").fill("e2e stand up and stretch");
    await page.getByLabel("Repeat").selectOption("daily");
    await page.getByLabel("Time").fill("07:30");
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("e2e stand up and stretch").first()).toBeVisible();
    await expect(page.getByText("Every day at 07:30")).toBeVisible();
    await page.getByRole("switch", { name: /Pause/ }).first().click();
    await expect(page.getByText("Paused").first()).toBeVisible();
    await page.getByRole("button", { name: /Delete e2e stand up/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Every day at 07:30")).toHaveCount(0);
  });

  test("settings show AI limits, usage estimates and sessions", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Settings" }).first().click();
    await page.getByRole("tab", { name: "AI" }).click();
    await expect(page.getByLabel("Model id")).toHaveValue("@cf/zai-org/glm-4.7-flash");
    await expect(page.getByText("Estimates, not billing data")).toBeVisible();
    await page.getByRole("tab", { name: "Security" }).click();
    await expect(page.getByText("This device", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Privacy" }).click();
    await expect(page.getByRole("link", { name: "Download backup" })).toHaveAttribute("href", "/api/export");
  });

  test("lock signs out", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "Lock" }).click();
    await expect(page.getByPlaceholder("Owner password")).toBeVisible();
    await page.goto("/tasks");
    await expect(page.getByPlaceholder("Owner password")).toBeVisible();
  });

  test("mobile navigation uses a bottom bar @mobile", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile only");
    await login(page);
    const nav = page.getByRole("navigation", { name: "Main" }).last();
    await expect(nav).toBeVisible();
    await nav.getByRole("link", { name: "Tasks" }).click();
    await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
    await nav.getByRole("link", { name: "Schedules" }).click();
    await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(page.viewportSize()!.width);
  });
});
