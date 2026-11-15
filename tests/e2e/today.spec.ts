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
