import { expect, type Page, test } from "@playwright/test";

const PASSWORD = process.env.TALORYS_DEV_PASSWORD || "talorys-dev-password";

async function login(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("Owner password").fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("What would you like to do today?")).toBeVisible();
}

async function proposePlan(page: Page, message: string) {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(message);
  await page.keyboard.press("Enter");
  const card = page.getByRole("group", { name: "Proposed plan" });
  await expect(card).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  return card;
}

test.describe("AI task planning", () => {
  test("a proposed plan is reviewed, edited and confirmed before any task exists @mobile", async ({ page }, testInfo) => {
    // Desktop and mobile runs share one database, and a plan leaves out tasks that already exist.
    const p = `e2e ${testInfo.project.name}`;
    await login(page);
    const card = await proposePlan(page, `plan ${p} Japan trip: ${p} renew passport!; ${p} book flights!; ${p} buy rail pass`);
    await expect(card.getByText("3 tasks")).toBeVisible();
    await expect(card.getByText("Nothing is created until you confirm.")).toBeVisible();

    // Nothing exists yet, and the card survives a reload.
    await page.reload();
    await expect(card.getByText(`${p} renew passport`)).toBeVisible();

    await card.getByRole("button", { name: "Edit" }).click();
    await card.getByLabel("Task 1 title").fill(`${p} renew passport this week`);
    await card.getByRole("button", { name: /Remove task 3/ }).click();
    await expect(card.getByText("1 removed")).toBeVisible();
    await card.getByRole("button", { name: "Save" }).click();
    await expect(card.getByText("2 tasks")).toBeVisible();
    // Saved edits are part of the draft on the server.
    await page.reload();
    await expect(card.getByText(`${p} renew passport this week`)).toBeVisible();

    await card.getByRole("button", { name: "Confirm plan" }).click();
    const done = page.getByRole("group", { name: "Confirmed plan" });
    await expect(done.getByText("Created 2 tasks")).toBeVisible();
    await page.reload();
    await expect(done.getByText("Created 2 tasks")).toBeVisible();

    await done.getByRole("link", { name: "View tasks" }).click();
    // Undated tasks are listed under Upcoming.
    await page.getByRole("tab", { name: /upcoming/i }).click();
    await expect(page.getByText(`${p} renew passport this week`)).toBeVisible();
    await expect(page.getByText(`${p} book flights`)).toBeVisible();
    await expect(page.getByText(`${p} buy rail pass`)).toHaveCount(0);
  });

  test("cancelling a plan creates nothing", async ({ page }) => {
    await login(page);
    const card = await proposePlan(page, "plan e2e cancelled plan: e2e never created one; e2e never created two");
    await card.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText(/Cancelled — nothing was created/)).toBeVisible();
    await page.getByRole("link", { name: "Tasks" }).first().click();
    await expect(page.getByText("e2e never created one")).toHaveCount(0);
  });
});
