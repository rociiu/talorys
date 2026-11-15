import { describe, expect, it } from "vitest";
import { greetingKey } from "../src/pages/TodayPage";

describe("Today greeting", () => {
  it("uses the hour from the owner's timezone", () => {
    expect(greetingKey(0)).toBe("today.goodMorning");
    expect(greetingKey(11)).toBe("today.goodMorning");
    expect(greetingKey(12)).toBe("today.goodAfternoon");
    expect(greetingKey(17)).toBe("today.goodAfternoon");
    expect(greetingKey(18)).toBe("today.goodEvening");
    expect(greetingKey(23)).toBe("today.goodEvening");
  });
});
