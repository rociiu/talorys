import { describe, expect, it } from "vitest";
import { checkPasswordStrength } from "../src/password-policy";
import { hashPassword, isPasswordHash, verifyPassword, hmacSha256Hex, timingSafeEqual } from "../src/crypto";
import { settingsSchema, backupSchema, taskCreateSchema } from "../src/schemas";

describe("password policy", () => {
  it("rejects weak passwords and accepts reasonable ones", () => {
    expect(checkPasswordStrength("short1!")).toMatch(/at least/);
    expect(checkPasswordStrength("aaaaaaaaaaaa")).toMatch(/repeating/);
    expect(checkPasswordStrength("🔐".repeat(12))).toMatch(/repeating/);
    expect(checkPasswordStrength("🇺🇸".repeat(5))).toMatch(/repeating/);
    expect(checkPasswordStrength("👨‍👩‍👧‍👦".repeat(3))).toMatch(/repeating/);
    expect(checkPasswordStrength("alllowercase")).toMatch(/Mix/);
    expect(checkPasswordStrength("password1234")).toMatch(/common/);
    expect(checkPasswordStrength("Sunny-Garden-42")).toBeNull();
    expect(checkPasswordStrength("a long passphrase of words")).toBeNull();
  });
});

describe("password hashing", () => {
  it("round-trips and resists tampering", async () => {
    const hash = await hashPassword("Sunny-Garden-42");
    expect(isPasswordHash(hash)).toBe(true);
    expect(hash).not.toContain("Sunny");
    expect(await verifyPassword("Sunny-Garden-42", hash)).toBe(true);
    expect(await verifyPassword("sunny-garden-42", hash)).toBe(false);
    // Tamper the first hash character: the last one partly holds base64 padding bits.
    const sep = hash.lastIndexOf("$") + 1;
    const tampered = hash.slice(0, sep) + (hash[sep] === "A" ? "B" : "A") + hash.slice(sep + 1);
    expect(await verifyPassword("Sunny-Garden-42", tampered)).toBe(false);
    expect(await verifyPassword("x", "plaintext")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2-sha256$1$abc$def")).toBe(false); // too few iterations
  });

  it("uses unique salts", async () => {
    expect(await hashPassword("same-Password-1")).not.toBe(await hashPassword("same-Password-1"));
  });

  it("HMAC and constant-time comparison behave", async () => {
    expect(await hmacSha256Hex("k", "v")).toMatch(/^[0-9a-f]{64}$/);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe("input schemas", () => {
  it("validates settings, tasks and backups", () => {
    expect(settingsSchema.shape.timezone.safeParse("Mars/Base").success).toBe(false);
    expect(settingsSchema.shape.model.safeParse("https://evil.example/model").success).toBe(false);
    expect(taskCreateSchema.safeParse({ title: "   " }).success).toBe(false);
    expect(backupSchema.safeParse({ format: "other", version: 1, exported_at: "", data: {} }).success).toBe(false);
  });
});
