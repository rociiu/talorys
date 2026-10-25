import { describe, expect, it } from "vitest";
import { chatGreeting } from "../src/pages/ChatPage";

describe("empty chat greeting", () => {
  it("follows the hour in the owner's timezone", () => {
    // 00:30 in Tokyo (morning) and 16:30 in London (afternoon) at the same instant.
    const now = new Date("2026-06-15T15:30:00.000Z");
    expect(chatGreeting(now, "Asia/Tokyo")).toBe("Good morning");
    expect(chatGreeting(now, "Europe/London")).toBe("Good afternoon");
  });

  it("changes at noon and at 6pm", () => {
    expect(chatGreeting(new Date("2026-01-15T11:59:00.000Z"), "UTC")).toBe("Good morning");
    expect(chatGreeting(new Date("2026-01-15T12:00:00.000Z"), "UTC")).toBe("Good afternoon");
    expect(chatGreeting(new Date("2026-01-15T17:59:00.000Z"), "UTC")).toBe("Good afternoon");
    expect(chatGreeting(new Date("2026-01-15T18:00:00.000Z"), "UTC")).toBe("Good evening");
  });
});
