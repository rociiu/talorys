import { expect, type Page, test } from "@playwright/test";

const PASSWORD = process.env.TALORYS_DEV_PASSWORD || "talorys-dev-password";
const CSRF = { "x-talorys-request": "1" };

async function login(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("Owner password").fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("What would you like to do today?")).toBeVisible();
}

async function openSecurity(page: Page) {
  await page.goto("/settings?tab=Security");
  await expect(page.getByRole("heading", { name: "Remote access" })).toBeVisible();
}

/** Generates a token through the card and returns the plaintext from the once-only panel. */
async function generate(page: Page, name: string, scope: "read" | "write" = "read"): Promise<string> {
  await page.getByLabel("Token name").fill(name);
  await page.getByLabel("Scope").selectOption(scope);
  await page.getByRole("button", { name: "Generate token" }).click();
  const panel = page.getByRole("region", { name: "New access token" });
  await expect(panel.getByText("Copy this token now. It will not be shown again.")).toBeVisible();
  const token = (await panel.locator("code").first().textContent())!.trim();
  expect(token.startsWith("tal_")).toBe(true);
  return token;
}

const bearerGet = (page: Page, token: string) => page.request.get("/api/tasks", { headers: { authorization: `Bearer ${token}` } });

test.describe("Remote access", () => {
  // Each test leaves the feature off with no tokens, which is also the fresh-install state.
  test.afterEach(async ({ page }) => {
    await page.request.delete("/api/remote/tokens", { headers: CSRF });
    await page.request.patch("/api/remote/status", { headers: CSRF, data: { enabled: false } });
  });

  test("off by default with generate disabled and read scope preselected", async ({ page }) => {
    await login(page);
    await openSecurity(page);
    const toggle = page.getByRole("switch", { name: "Remote access" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText("Suspended", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Create personal access tokens so scripts and other apps can use your Talorys data over HTTPS."),
    ).toBeVisible();
    await expect(page.getByText("Tokens stay suspended until you turn this back on.")).toBeVisible();
    await expect(page.getByRole("link", { name: "How to use access tokens" })).toHaveAttribute("href", /\/blob\/main\/docs\/remote-access\.md$/);
    await expect(page.getByText("No access tokens yet.")).toBeVisible();

    await page.getByLabel("Token name").fill("CI runner");
    await expect(page.getByRole("button", { name: "Generate token" })).toBeDisabled();
    await expect(page.getByLabel("Scope")).toHaveValue("read");
    await expect(page.getByText("Write can create, update, and delete tasks, notes, reminders, and memories.")).toHaveCount(0);
    await page.getByLabel("Scope").selectOption("write");
    await expect(page.getByText("Write can create, update, and delete tasks, notes, reminders, and memories.")).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Suspended", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Generate token" })).toBeEnabled();
    await page.getByLabel("Token name").fill("");
    await expect(page.getByRole("button", { name: "Generate token" })).toBeDisabled();
  });

  test("show once: the plaintext works as Bearer and is gone after dismiss and reload", async ({ page }) => {
    await login(page);
    await openSecurity(page);
    await page.getByRole("switch", { name: "Remote access" }).click();
    const token = await generate(page, "Home server");
    expect((await bearerGet(page, token)).status()).toBe(200);
    const panel = page.getByRole("region", { name: "New access token" });
    await expect(panel.getByText("Use it as a Bearer token.")).toBeVisible();
    await expect(panel.getByRole("link", { name: "Docs" })).toHaveAttribute("href", /\/blob\/main\/docs\/remote-access\.md$/);
    const origin = new URL(page.url()).origin;
    await expect(panel.getByTestId("remote-token-example")).toHaveText(`curl -H "Authorization: Bearer ${token}" ${origin}/api/tasks`);

    const row = page.getByText(`tal_…${token.slice(-4)}`);
    await expect(row).toBeVisible();
    await expect(page.getByText(/last used/)).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText(token)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Remote access" })).toBeVisible();
    await expect(row).toBeVisible();
    await expect(page.getByText(token)).toHaveCount(0);
    await expect(page.getByText("Copy this token now. It will not be shown again.")).toHaveCount(0);
  });

  test("revoke and revoke all make tokens unusable and empty the list", async ({ page }) => {
    await login(page);
    await openSecurity(page);
    await page.getByRole("switch", { name: "Remote access" }).click();

    const first = await generate(page, "Laptop script");
    await page.getByRole("button", { name: "Done" }).click();
    expect((await bearerGet(page, first)).status()).toBe(200);
    await page.getByRole("button", { name: "Revoke Laptop script" }).click();
    await expect(page.getByText("No access tokens yet.")).toBeVisible();
    expect((await bearerGet(page, first)).status()).toBe(401);

    const a = await generate(page, "Sync A", "write");
    await page.getByRole("button", { name: "Done" }).click();
    const b = await generate(page, "Sync B");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText("2 of 20 tokens.")).toBeVisible();
    expect((await bearerGet(page, a)).status()).toBe(200);
    expect((await bearerGet(page, b)).status()).toBe(200);

    await page.getByRole("button", { name: "Revoke all" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Revoke all" }).click();
    await expect(page.getByText("No access tokens yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke all" })).toBeDisabled();
    expect((await bearerGet(page, a)).status()).toBe(401);
    expect((await bearerGet(page, b)).status()).toBe(401);
  });
});
