import { expect, test } from "@playwright/test";

test("chat usage popover supports keyboard, dismissal and settings @mobile", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("Owner password").fill(process.env.TALORYS_DEV_PASSWORD || "talorys-dev-password");
  await page.getByRole("button", { name: "Unlock" }).click();
  const trigger = page.getByRole("button", { name: "AI usage", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const popup = page.getByRole("dialog", { name: "AI usage today" });
  await expect(popup.getByRole("progressbar")).toBeVisible();
  await expect(popup).toContainText("Resets at 00:00 UTC");
  await expect(popup).toContainText("Tokens (estimated)");
  const bounds = await popup.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("textbox", { name: "Message", exact: true }).click();
  await expect(popup).toHaveCount(0);
  await trigger.click();
  await popup.getByRole("link", { name: "View usage & limits" }).click();
  await expect(page.getByRole("tab", { name: "AI", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
});
