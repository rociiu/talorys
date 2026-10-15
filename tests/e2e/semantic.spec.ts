import { expect, type Page, test } from "@playwright/test";

const PASSWORD = process.env.TALORYS_DEV_PASSWORD || "talorys-dev-password";
const CSRF = { "x-talorys-request": "1" };

async function login(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("Owner password").fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("What would you like to do today?")).toBeVisible();
}

async function openAiSettings(page: Page) {
  await page.getByRole("link", { name: "Settings" }).first().click();
  await page.getByRole("tab", { name: "AI" }).click();
}

test.describe("Semantic recall", () => {
  test("settings card toggles, indexes Memory-page saves and deletes its data", async ({ page }) => {
    const content = `Semantic e2e prefers green tea ${Date.now()}`;
    await login(page);
    // Start from the never-enabled state; memories are not touched.
    expect((await page.request.delete("/api/semantic/data", { headers: CSRF, data: { confirm: "DELETE" } })).status()).toBe(200);

    await openAiSettings(page);
    const toggle = page.getByRole("switch", { name: "Semantic memory recall" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText("Finds memories, tasks, notes and reminders by meaning using Workers AI embeddings. Memories use up to 500 embeddings per day; tasks, notes and reminders have their own 50 per day. Off by default.")).toBeVisible();
    await expect(page.getByLabel("Semantic recall status")).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const status = page.getByLabel("Semantic recall status");
    await expect(status).toContainText("Embedder");
    await expect(status).toContainText("Embeddings today");
    await expect(page.locator('[data-stat="Pending"]')).toHaveText("0", { timeout: 20_000 });

    const modelInput = page.getByLabel("Embedding model id");
    const saveModel = page.locator("form").filter({ has: modelInput }).getByRole("button", { name: "Save" });
    await expect(modelInput).toHaveValue("@cf/baai/bge-m3");
    await modelInput.fill("bge-small");
    await saveModel.click();
    await expect(page.getByText("Must be a Workers AI model id").first()).toBeVisible();
    await page.reload();
    await page.getByRole("tab", { name: "AI" }).click();
    await expect(modelInput).toHaveValue("@cf/baai/bge-m3");
    for (const model of ["@cf/baai/bge-small-en-v1.5", "@cf/baai/bge-m3"]) {
      await modelInput.fill(model);
      await saveModel.click();
      await expect(saveModel).toBeDisabled();
      await page.reload();
    await page.getByRole("tab", { name: "AI" }).click();
      await expect(modelInput).toHaveValue(model);
    }
    await expect(page.locator('[data-stat="Pending"]')).toHaveText("0", { timeout: 20_000 });

    await page.getByRole("link", { name: "Memory" }).first().click();
    await page.getByRole("button", { name: "Add memory" }).click();
    await page.getByLabel("What should Talorys remember?").fill(content);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(content).first()).toBeVisible();

    await openAiSettings(page);
    await expect(page.locator('[data-stat="Pending"]')).toHaveText("0", { timeout: 20_000 });
    await expect(page.locator('[data-stat="Vectors"]')).not.toHaveText("0");

    await page.getByRole("button", { name: "Delete semantic data" }).click();
    await expect(page.getByText("Removes the search index and turns the feature off. Your memories are kept.").last()).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.getByLabel("Semantic recall status")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete semantic data" })).toHaveCount(0);

    const memories = await (await page.request.get(`/api/memories?q=${encodeURIComponent(content)}`)).json();
    expect(memories.memories.map((m: { content: string }) => m.content)).toContain(content);
  });

  test("search finds a Tasks-page task by meaning once items are indexed", async ({ page }) => {
    const title = `Water the plants ${Date.now()}`;
    await login(page);
    expect((await page.request.delete("/api/semantic/data", { headers: CSRF, data: { confirm: "DELETE" } })).status()).toBe(200);

    await openAiSettings(page);
    const toggle = page.getByRole("switch", { name: "Semantic memory recall" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await page.getByRole("link", { name: "Tasks" }).first().click();
    await page.getByLabel("New task title").fill(title);
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByText(title)).toBeVisible();

    await openAiSettings(page);
    await expect(page.locator('[data-stat="Items pending"]')).toHaveText("0", { timeout: 20_000 });

    // The mock chat AI routes "search ..." to the search tool and prints its JSON output.
    await page.goto("/chat");
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("search botany");
    await page.keyboard.press("Enter");
    await expect(page.getByText(title)).toBeVisible();

    expect((await page.request.delete("/api/semantic/data", { headers: CSRF, data: { confirm: "DELETE" } })).status()).toBe(200);
    const tasks = await (await page.request.get(`/api/tasks?q=${encodeURIComponent(title)}`)).json();
    for (const task of tasks.tasks) {
      expect((await page.request.delete(`/api/tasks/${task.id}`, { headers: CSRF })).ok()).toBe(true);
    }
  });
});
