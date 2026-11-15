import { expect, type Page, test } from "@playwright/test";

const PASSWORD = process.env.TALORYS_DEV_PASSWORD || "talorys-dev-password";

async function login(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("Owner password").fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
}

const emptyToday = {
  generated_at: new Date().toISOString(),
  timezone: "UTC",
  local_date: "2026-11-15",
  counts: { open: 0, today: 0, overdue: 0, upcoming: 0 },
  focus: [],
  tasks: { today: [], overdue: [], upcoming: [] },
  projects: [],
  automations: [],
  suggestion: { kind: "create_first_task" },
};

test.describe("Today", () => {
  test("opens task details and completes work without AI", async ({ page }) => {
    await login(page);
    const welcome = page.getByRole("region", { name: "Welcome to your personal assistant" });
    if (await welcome.isVisible()) await welcome.getByRole("button", { name: "Dismiss" }).click();
    await page.getByRole("link", { name: "Add task", exact: true }).first().click();
    await page.getByLabel("New task title").fill("e2e Today focus");
    await page.getByRole("button", { name: "Add task" }).click();
    await page.getByRole("navigation", { name: "Main" }).first().getByRole("link", { name: "Today" }).click();

    const focus = page.getByRole("region", { name: "Your Focus" });
    await expect(focus.getByText("e2e Today focus")).toBeVisible();
    await focus.getByRole("button", { name: "Open “e2e Today focus”" }).click();
    await expect(page.getByRole("dialog", { name: "Edit task" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await focus.getByRole("button", { name: "Complete “e2e Today focus”" }).click();
    await expect(focus.getByText("e2e Today focus")).toHaveCount(0);
  });

  test("project planning pre-fills chat without sending or creating anything", async ({ page }) => {
    await login(page);
    await page.goto("/projects");
    await page.getByLabel("New project name").fill("e2e Today launch");
    await page.getByRole("button", { name: "Add project" }).click();
    await page.getByRole("link").filter({ hasText: "e2e Today launch" }).click();
    await expect(page.getByRole("heading", { name: "e2e Today launch" })).toBeVisible();
    let chatRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat") chatRequests++;
    });
    await page.getByRole("link", { name: "Plan with Talorys" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(/Help me prepare a plan for e2e Today launch/);
    await expect(page.getByText("What would you like to do today?")).toBeVisible();
    expect(chatRequests).toBe(0);
  });

  test("shows useful empty states and recovers from an API failure", async ({ page }) => {
    await login(page);
    await page.route("**/api/today", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyToday) }));
    await page.reload();
    await expect(page.getByText("Your day is clear")).toBeVisible();
    await expect(page.getByText("Nothing scheduled", { exact: true })).toBeVisible();
    await expect(page.getByText("No active projects")).toBeVisible();

    await page.unroute("**/api/today");
    await page.route("**/api/today", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Today is temporarily unavailable." } }) }));
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("Today is temporarily unavailable.");
    await page.unroute("**/api/today");
    await page.route("**/api/today", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(emptyToday) }));
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("Your day is clear")).toBeVisible();
  });

  test("mobile Today navigation fits the viewport @mobile", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile only");
    await login(page);
    await expect(page.getByRole("region", { name: "Your Focus" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Main" }).last();
    await expect(nav.getByRole("link")).toHaveCount(6);
    await nav.getByRole("link", { name: "Today" }).click();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(page.viewportSize()!.width);
  });
});

test("summary links select matching task categories and preserve browser history @mobile", async ({ page }) => {
  await login(page);
  const headers = { "x-talorys-request": "1" };
  const titles = {
    overdue: "e2e category overdue",
    today: "e2e category in progress",
    upcoming: "e2e category upcoming",
    unscheduled: "e2e category unscheduled",
    completed: "e2e category completed",
  };
  const now = Date.now();
  const taskIds: string[] = [];
  try {
    for (const data of [
      { title: titles.overdue, due_at: new Date(now - 3600_000).toISOString() },
      { title: titles.today, status: "in_progress" },
      { title: titles.upcoming, due_at: new Date(now + 2 * 86_400_000).toISOString() },
      { title: titles.unscheduled },
      { title: titles.completed, status: "done" },
    ]) {
      const response = await page.request.post("/api/tasks", { headers, data });
      expect(response.status()).toBe(201);
      taskIds.push((await response.json()).task.id);
    }

    for (const [view, label] of [["overdue", "Overdue"], ["today", "Today"], ["upcoming", "Upcoming"], ["open", "Open tasks"]] as const) {
      await page.goto("/");
      const summary = page.getByRole("region", { name: "Daily overview" });
      const card = summary.getByRole("link").filter({ hasText: label });
      await expect(card).toHaveAttribute("href", `/tasks?view=${view}`);
      const exactCount = (await card.innerText()).match(/\d+/)?.[0];
      expect(exactCount).toBeDefined();
      await card.click();
      await expect(page.getByRole("tab", { selected: true }).locator("span")).toHaveText(exactCount!);

      for (const [category, title] of Object.entries(titles)) {
        const shown = view === "open" ? category !== "completed" : category === view;
        await expect(page.getByRole("button", { name: title, exact: false }).filter({ hasText: title })).toHaveCount(shown ? 1 : 0);
      }
    }

    await page.getByRole("tab", { name: /unscheduled/i }).click();
    await expect(page).toHaveURL(/view=unscheduled/);
    await expect(page.getByText(titles.unscheduled, { exact: true })).toBeVisible();
    await expect(page.getByText(titles.upcoming, { exact: true })).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole("tab", { name: /all open/i })).toHaveAttribute("aria-selected", "true");
    await page.goForward();
    await expect(page.getByRole("tab", { name: /unscheduled/i })).toHaveAttribute("aria-selected", "true");
    await page.goto("/tasks?view=completed");
    await expect(page.getByRole("tab", { name: /completed/i })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(titles.completed, { exact: true })).toBeVisible();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(page.viewportSize()!.width);
  } finally {
    for (const id of taskIds) expect((await page.request.delete(`/api/tasks/${id}`, { headers })).status()).toBe(200);
  }
});

test("project detail totals refresh after task changes and project status edits", async ({ page }) => {
  await login(page);
  const headers = { "x-talorys-request": "1" };
  const names = ["e2e source project counts", "e2e destination project counts"];
  const ids: string[] = [];
  const title = "e2e project count task";
  const counts = async (open: number, done: number) => {
    await expect(page.getByText("Open tasks", { exact: true }).locator("..")).toHaveText(`${open}Open tasks`);
    await expect(page.getByText("Completed tasks", { exact: true }).locator("..")).toHaveText(`${done}Completed tasks`);
  };
  const viewProject = () => page.getByRole("link", { name: "View project", exact: true }).click();
  const viewAll = () => page.getByRole("link", { name: "View all project tasks" }).click();

  try {
    for (const name of names) {
      const res = await page.request.post("/api/projects", { headers, data: { name } });
      expect(res.status()).toBe(201);
      ids.push((await res.json()).project.id);
    }
    await page.goto("/projects");
    await page.getByRole("link").filter({ hasText: names[1] }).click();
    await counts(0, 0);
    await page.getByRole("link", { name: "All projects" }).click();
    await page.getByRole("link").filter({ hasText: names[0] }).click();
    await counts(0, 0);

    await viewAll();
    await page.getByLabel("New task title").fill(title);
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await viewProject();
    await counts(1, 0);

    // The project task has no due date and sits outside the default Today list.
    await page.getByRole("link").filter({ hasText: title }).click();
    const dialog = page.getByRole("dialog", { name: "Edit task" });
    await expect(dialog.getByLabel("Title")).toHaveValue(title);
    await dialog.getByRole("button", { name: "Close" }).click();
    await page.getByRole("tab", { name: /all open/i }).click();
    await page.getByRole("button", { name: `Complete “${title}”` }).click();
    await expect(page.getByText(title, { exact: true })).toHaveCount(0);
    await viewProject();
    await counts(0, 1);

    await viewAll();
    await page.getByRole("tab", { name: /completed/i }).click();
    await page.getByRole("button", { name: `Mark “${title}” as not done` }).click();
    await expect(page.getByText(title, { exact: true })).toHaveCount(0);
    await viewProject();
    await counts(1, 0);

    await page.getByRole("combobox", { name: "Project status" }).selectOption("paused");
    await expect(page.getByRole("combobox", { name: "Project status" })).toHaveValue("paused");
    await counts(1, 0);
    await page.getByRole("link").filter({ hasText: title }).click();
    await dialog.getByRole("combobox", { name: "Project Optional", exact: true }).selectOption(ids[1]!);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toHaveCount(0);
    await viewProject();
    await expect(page.getByRole("combobox", { name: "Project status" })).toHaveValue("paused");
    await counts(0, 0);

    await page.getByRole("link", { name: "All projects" }).click();
    await page.getByRole("link").filter({ hasText: names[1] }).click();
    await counts(1, 0);
    await page.getByRole("link").filter({ hasText: title }).click();
    await dialog.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await viewProject();
    await counts(0, 0);
  } finally {
    for (const id of ids) expect((await page.request.delete(`/api/projects/${id}`, { headers })).status()).toBe(200);
  }
});
