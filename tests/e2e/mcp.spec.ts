import { expect, test } from "@playwright/test";

test("owner connects MCP tools, calls echo, approves a write and removes the server", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("Owner password").fill(process.env.TALORYS_DEV_PASSWORD || "talorys-dev-password");
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByRole("link", { name: "Settings" }).first().click();
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  const form = page.getByRole("form", { name: "Add MCP server" });
  await form.getByLabel("Server name", { exact: true }).fill("e2e");
  await form.getByLabel("Server URL", { exact: true }).fill("http://127.0.0.1:8790/mcp");
  await form.getByRole("button", { name: "Add server" }).click();
  const server = page.getByRole("region", { name: "MCP server e2e" });
  await expect(server.getByLabel("Policy for echo")).toHaveValue("auto");
  await expect(server.getByLabel("Policy for append_log")).toHaveValue("approve");
  await page.getByRole("link", { name: "Chat", exact: true }).first().click();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill('call e2e tool echo with {"text":"hi"}');
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Actions taken")).toContainText("Using e2e: echo");
  await expect(page.getByText(/external_tool.*hi/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await composer.fill('call e2e tool append_log with {"line":"x"}');
  await page.keyboard.press("Enter");
  const card = page.getByRole("group", { name: "Approval needed" });
  await expect(card.getByRole("region", { name: "Proposed text" })).toHaveText('{\n  "line": "x"\n}');
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/Approved and done/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Action result" })).toContainText("Appended x");
  // Reload only once the turn has finished streaming, so the stored message is complete.
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Action result" })).toContainText("Appended x");
  await page.getByRole("link", { name: "Settings" }).first().click();
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await page.getByRole("button", { name: "Remove e2e", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(server).toHaveCount(0);
});
