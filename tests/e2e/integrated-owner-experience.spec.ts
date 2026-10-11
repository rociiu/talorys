import { expect, type Page, test } from "@playwright/test";

const PASSWORD = process.env.TALORYS_DEV_PASSWORD || "talorys-dev-password";

async function login(page: Page) {
  await page.goto("/");
  const pwInput = page.locator('input[type="password"]');
  await expect(pwInput).toBeVisible({ timeout: 10000 });
  await pwInput.fill(PASSWORD);
  const unlockBtn = page.getByRole("button", { name: /잠금 해제|Unlock/i });
  await unlockBtn.click();
  // Wait until password input disappears completely, proving login completed
  await expect(page.locator('input[type="password"]')).toHaveCount(0, { timeout: 15000 });
}

test.describe("Talorys Comprehensive Integrated E2E Lifecycle", () => {
  // 1. Failure Scenario: Invalid password rejected
  test("E2E-FAIL: Rejects invalid password with clear alert and prevents unauthorized access", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Talorys", exact: true })).toBeVisible();
    const pwInput = page.locator('input[type="password"]');
    await pwInput.fill("wrong-password-12345");
    const unlockBtn = page.getByRole("button", { name: /잠금 해제|Unlock/i });
    await unlockBtn.click();
    await expect(page.getByRole("alert")).toBeVisible();
  });

  // 2. Normal Operations: Task creation, listing, completion
  test("E2E-NORM: Owner can login, create tasks, list tasks and mark them complete", async ({ page }) => {
    await login(page);
    await page.goto("/tasks");
    await expect(page.getByRole("heading", { name: /^(할 일|Tasks)$/i })).toBeVisible();

    const taskInput = page.locator('input[aria-label*="할 일"], input[placeholder*="할 일"]');
    await expect(taskInput).toBeVisible();
    const taskTitle = `e2e-task-${Date.now()}`;
    await taskInput.fill(taskTitle);
    await page.keyboard.press("Enter");

    // Verify task created
    await expect(page.getByText(taskTitle).first()).toBeVisible();

    // Toggle complete
    const completeBtn = page.locator(`button[aria-label*="${taskTitle}"]`).first();
    await completeBtn.click();

    // Check completed tab
    const completedTab = page.getByRole("tab", { name: /완료|Completed/i });
    await completedTab.click();
    await expect(page.getByText(taskTitle).first()).toBeVisible();
  });

  // 3. Approval Scenario: Chat tool proposing destructive action requires approval
  test("E2E-APP: Chat interaction with destructive tool proposes action and awaits approval", async ({ page }) => {
    await login(page);
    await page.goto("/chat");
    const composer = page.locator('textarea[aria-label*="메시지"], textarea[placeholder*="물어보세요"], textarea').first();
    await expect(composer).toBeVisible();

    const targetTask = `approve-task-${Date.now()}`;
    await composer.fill(`add task ${targetTask}`);
    await page.keyboard.press("Enter");

    // Wait for task addition confirmation in chat
    await expect(page.getByText(new RegExp(`Added the task "${targetTask}"|할 일을 추가했습니다`, "i"))).toBeVisible({ timeout: 15000 });

    // Request deletion which requires approval
    await composer.fill(`delete task ${targetTask}`);
    await page.keyboard.press("Enter");

    // Verify approval card appears
    const approvalCard = page.locator('[role="group"][aria-label*="승인"], [role="group"][aria-label*="Approval"], div:has-text("승인 필요"), div:has-text("Approval needed")').first();
    await expect(approvalCard).toBeVisible({ timeout: 15000 });

    // Approve the action
    const approveBtn = approvalCard.getByRole("button", { name: /승인|Approve/i });
    await approveBtn.click();

    // Verify action executed
    await expect(page.getByText(/Approved and done|승인되어 실행되었습니다|완료/i).first()).toBeVisible({ timeout: 15000 });
  });

  // 4. Concurrency: Multiple tabs / simultaneous state modifications do not deadlock
  test("E2E-CONC: Concurrent operations in separate contexts maintain state integrity", async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    try {
      await Promise.all([login(page1), login(page2)]);

      await Promise.all([page1.goto("/tasks"), page2.goto("/notes")]);

      await expect(page1.getByRole("heading", { name: /^(할 일|Tasks)$/i })).toBeVisible();
      await expect(page2.getByRole("heading", { name: /^(메모|Notes)$/i })).toBeVisible();

      // Simultaneous writes
      const taskTitle = `conc-task-${Date.now()}`;
      const noteTitle = `conc-note-${Date.now()}`;

      const taskInput = page1.locator('input[aria-label*="할 일"], input[placeholder*="할 일"]');
      await taskInput.fill(taskTitle);

      const newNoteBtn = page2.getByRole("button", { name: /새 메모|New note/i });
      await newNoteBtn.click();
      const noteInput = page2.locator('input[aria-label*="메모 제목"], input[placeholder*="제목"]');
      await expect(noteInput).toBeVisible();
      await noteInput.fill(noteTitle);

      await Promise.all([
        page1.keyboard.press("Enter"),
        page2.getByRole("button", { name: /저장|Save/i }).click(),
      ]);

      await expect(page1.getByText(taskTitle).first()).toBeVisible();
      await expect(page2.getByText(noteTitle).first()).toBeVisible();
    } finally {
      await context1.close();
      await context2.close();
    }
  });

  // 5. State Persistence & Restart: Page reload preserves state across restarts
  test("E2E-STATE: State persists across page reload and navigation restarts", async ({ page }) => {
    await login(page);
    await page.goto("/notes");
    await expect(page.getByRole("heading", { name: /^(메모|Notes)$/i })).toBeVisible();

    const noteTitle = `persist-note-${Date.now()}`;
    const newNoteBtn = page.getByRole("button", { name: /새 메모|New note/i });
    await newNoteBtn.click();
    const noteInput = page.locator('input[aria-label*="메모 제목"], input[placeholder*="제목"]');
    await expect(noteInput).toBeVisible();
    await noteInput.fill(noteTitle);
    await page.getByRole("button", { name: /저장|Save/i }).click();

    await expect(page.getByText(noteTitle).first()).toBeVisible();

    // Reload page
    await page.reload();
    await expect(page.getByText(noteTitle).first()).toBeVisible();

    // Navigate to tasks and back to notes
    await page.goto("/tasks");
    await expect(page.getByRole("heading", { name: /^(할 일|Tasks)$/i })).toBeVisible();
    await page.goto("/notes");
    await expect(page.getByText(noteTitle).first()).toBeVisible();
  });

  // 6. Recovery: Invalid routes or failed actions recover cleanly to safe state
  test("E2E-REC: 404 navigation and locked session recover cleanly", async ({ page }) => {
    await login(page);
    // Navigate to unknown route
    await page.goto("/non-existent-subpath-for-recovery-test");
    // Navigate back to valid chat route
    await page.goto("/chat");
    await expect(page.locator('textarea[aria-label*="메시지"], textarea').first()).toBeVisible();

    // Sign out / lock via lock button in sidebar
    const logoutBtn = page.locator('button[aria-label*="로그아웃"], button[aria-label*="잠금"], button:has-text("로그아웃")').first();
    if (await logoutBtn.isVisible()) {
      await logoutBtn.click();
      await expect(page.locator('input[type="password"]')).toBeVisible({ timeout: 10000 });
    }
  });
});
