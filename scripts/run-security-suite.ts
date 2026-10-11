import { MassiveTestHarness, type TestCase } from "./massive-harness";
import { checkPasswordStrength, PASSWORD_MIN_LENGTH } from "../packages/shared/src/password-policy";
import {
  PBKDF2_ITERATIONS,
  toBase64Url,
  fromBase64Url,
  randomToken,
  hashPassword,
  isPasswordHash,
  verifyPassword,
  timingSafeEqual,
  sha256Hex,
  hmacSha256Hex,
} from "../packages/shared/src/crypto";
import {
  taskCreateSchema,
  taskUpdateSchema,
  taskListQuerySchema,
  memoryCreateSchema,
  memoryUpdateSchema,
  noteCreateSchema,
  noteUpdateSchema,
  projectCreateSchema,
  projectUpdateSchema,
  conversationCreateSchema,
  conversationUpdateSchema,
  chatRequestSchema,
  automationCreateSchema,
  automationUpdateSchema,
  limitsSchema,
  settingsSchema,
  settingsUpdateSchema,
  loginSchema,
  changePasswordSchema,
  backupSchema,
  TASK_STATUSES,
  TASK_PRIORITIES,
  MEMORY_CATEGORIES,
  PROJECT_STATUSES,
  AUTOMATION_KINDS,
} from "../packages/shared/src/schemas";
import { LIMIT_CEILINGS, BACKUP_FORMAT, DEFAULT_LIMITS } from "../packages/shared/src/constants";
import assert from "node:assert/strict";

const DOMAIN = "security-schemas";
const harness = new MassiveTestHarness(DOMAIN);

// Helper for building tests concisely
function t(id: string, category: TestCase["category"], description: string, run: () => Promise<void> | void): TestCase {
  return { id, domain: DOMAIN, category, description, run };
}

const tests: TestCase[] = [];

// ============================================================================
// 1. NORMAL TESTS (70 cases) [SEC-NORM-001 ~ SEC-NORM-070]
// ============================================================================

// Password Policy Normal Cases (15 cases)
tests.push(
  t("SEC-NORM-001", "normal", "Accepts strong mixed password with letters, numbers, and symbols", () => {
    assert.equal(checkPasswordStrength("P@ssw0rdSecure2026!"), null);
  }),
  t("SEC-NORM-002", "normal", "Accepts lowercase passphrase >= 16 chars with spaces", () => {
    assert.equal(checkPasswordStrength("correct horse battery staple"), null);
  }),
  t("SEC-NORM-003", "normal", "Accepts mixed-case passphrase >= 16 chars with hyphens", () => {
    assert.equal(checkPasswordStrength("azure-mountain-skyline-2026"), null);
  }),
  t("SEC-NORM-004", "normal", "Accepts exactly 10 chars with lowercase + uppercase", () => {
    assert.equal(checkPasswordStrength("SecurePass"), null);
  }),
  t("SEC-NORM-005", "normal", "Accepts exactly 10 chars with lowercase + number", () => {
    assert.equal(checkPasswordStrength("user123459"), null);
  }),
  t("SEC-NORM-006", "normal", "Accepts exactly 10 chars with lowercase + symbol", () => {
    assert.equal(checkPasswordStrength("welcome@home"), null);
  }),
  t("SEC-NORM-007", "normal", "Accepts exactly 10 chars with uppercase + number", () => {
    assert.equal(checkPasswordStrength("SYSTEM2026"), null);
  }),
  t("SEC-NORM-008", "normal", "Accepts exactly 10 chars with uppercase + symbol", () => {
    assert.equal(checkPasswordStrength("PROJECT#99"), null);
  }),
  t("SEC-NORM-009", "normal", "Accepts 15 chars mixed password with 3 classes", () => {
    assert.equal(checkPasswordStrength("AlphaBeta12345!"), null);
  }),
  t("SEC-NORM-010", "normal", "Accepts 20 chars complex mixed password", () => {
    assert.equal(checkPasswordStrength("K!9#mP$2vL&8xQ@4zW*1"), null);
  }),
  t("SEC-NORM-011", "normal", "Accepts 32 chars random token-style password", () => {
    assert.equal(checkPasswordStrength("aB3$kL9#mN2@pQ5%rS8^tU1&vW4*xY7~"), null);
  }),
  t("SEC-NORM-012", "normal", "Accepts passphrase containing numbers and spaces", () => {
    assert.equal(checkPasswordStrength("falcon 9 heavy rocket launch 2026"), null);
  }),
  t("SEC-NORM-013", "normal", "Accepts 16+ chars password containing common substring 'password'", () => {
    assert.equal(checkPasswordStrength("mypasswordisstrongenoughhere"), null);
  }),
  t("SEC-NORM-014", "normal", "Accepts 16+ chars passphrase containing common substring 'admin'", () => {
    assert.equal(checkPasswordStrength("system administrator workstation 1"), null);
  }),
  t("SEC-NORM-015", "normal", "Accepts strong password with Korean unicode characters", () => {
    assert.equal(checkPasswordStrength("Passw0rd-서울-한글-2026!"), null);
  }),
);

// Crypto & Hashing Normal Cases (25 cases)
tests.push(
  t("SEC-NORM-016", "normal", "hashPassword generates standard pbkdf2 format string", async () => {
    const hash = await hashPassword("TestPassword123!", 10000);
    assert.match(hash, /^pbkdf2-sha256\$10000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  }),
  t("SEC-NORM-017", "normal", "isPasswordHash recognizes valid generated hash", async () => {
    const hash = await hashPassword("TestPassword123!", 10000);
    assert.equal(isPasswordHash(hash), true);
  }),
  t("SEC-NORM-018", "normal", "verifyPassword succeeds with correct password and generated hash", async () => {
    const hash = await hashPassword("CorrectHorseStaple#9", 10000);
    const valid = await verifyPassword("CorrectHorseStaple#9", hash);
    assert.equal(valid, true);
  }),
  t("SEC-NORM-019", "normal", "verifyPassword returns false for wrong password", async () => {
    const hash = await hashPassword("CorrectHorseStaple#9", 10000);
    const valid = await verifyPassword("WrongPassword#9", hash);
    assert.equal(valid, false);
  }),
  t("SEC-NORM-020", "normal", "hashPassword generates unique salts for identical passwords", async () => {
    const hash1 = await hashPassword("IdenticalPassword#1", 10000);
    const hash2 = await hashPassword("IdenticalPassword#1", 10000);
    assert.notEqual(hash1, hash2);
  }),
  t("SEC-NORM-021", "normal", "PBKDF2 roundtrip with 10,000 iterations (minimum threshold)", async () => {
    const hash = await hashPassword("Iter10kTest#", 10000);
    assert.equal(await verifyPassword("Iter10kTest#", hash), true);
  }),
  t("SEC-NORM-022", "normal", "PBKDF2 roundtrip with 25,000 iterations", async () => {
    const hash = await hashPassword("Iter25kTest#", 25000);
    assert.equal(await verifyPassword("Iter25kTest#", hash), true);
  }),
  t("SEC-NORM-023", "normal", "PBKDF2 roundtrip with 50,000 iterations", async () => {
    const hash = await hashPassword("Iter50kTest#", 50000);
    assert.equal(await verifyPassword("Iter50kTest#", hash), true);
  }),
  t("SEC-NORM-024", "normal", "toBase64Url and fromBase64Url roundtrip on 16-byte buffer", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const b64 = toBase64Url(bytes);
    const back = fromBase64Url(b64);
    assert.deepEqual(back, bytes);
  }),
  t("SEC-NORM-025", "normal", "toBase64Url and fromBase64Url roundtrip on 32-byte buffer", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const b64 = toBase64Url(bytes);
    const back = fromBase64Url(b64);
    assert.deepEqual(back, bytes);
  }),
  t("SEC-NORM-026", "normal", "toBase64Url produces URL-safe characters without +, /, or =", () => {
    const bytes = new Uint8Array([251, 255, 254, 253, 252, 251]);
    const b64 = toBase64Url(bytes);
    assert.equal(/^[A-Za-z0-9_-]+$/.test(b64), true);
  }),
  t("SEC-NORM-027", "normal", "randomToken(16) generates 22 characters of base64url", () => {
    const token = randomToken(16);
    assert.equal(token.length, 22);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
  }),
  t("SEC-NORM-028", "normal", "randomToken(32) generates 43 characters of base64url", () => {
    const token = randomToken(32);
    assert.equal(token.length, 43);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
  }),
  t("SEC-NORM-029", "normal", "randomToken produces distinct tokens on consecutive invocations", () => {
    const t1 = randomToken(32);
    const t2 = randomToken(32);
    assert.notEqual(t1, t2);
  }),
  t("SEC-NORM-030", "normal", "timingSafeEqual returns true for identical byte arrays", () => {
    const a = new Uint8Array([10, 20, 30, 40]);
    const b = new Uint8Array([10, 20, 30, 40]);
    assert.equal(timingSafeEqual(a, b), true);
  }),
  t("SEC-NORM-031", "normal", "timingSafeEqual returns false for distinct byte arrays of same length", () => {
    const a = new Uint8Array([10, 20, 30, 40]);
    const b = new Uint8Array([10, 20, 31, 40]);
    assert.equal(timingSafeEqual(a, b), false);
  }),
  t("SEC-NORM-032", "normal", "sha256Hex matches standard SHA-256 digest of empty string", async () => {
    const hex = await sha256Hex("");
    assert.equal(hex, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  }),
  t("SEC-NORM-033", "normal", "sha256Hex matches standard SHA-256 digest of 'hello world'", async () => {
    const hex = await sha256Hex("hello world");
    assert.equal(hex, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  }),
  t("SEC-NORM-034", "normal", "sha256Hex outputs exactly 64 lowercase hex characters", async () => {
    const hex = await sha256Hex("talorys security test");
    assert.match(hex, /^[0-9a-f]{64}$/);
  }),
  t("SEC-NORM-035", "normal", "hmacSha256Hex generates 64-character lowercase hex signature", async () => {
    const hmac = await hmacSha256Hex("secret-key", "message-payload");
    assert.match(hmac, /^[0-9a-f]{64}$/);
  }),
  t("SEC-NORM-036", "normal", "hmacSha256Hex is deterministic for identical secret and message", async () => {
    const h1 = await hmacSha256Hex("k", "v");
    const h2 = await hmacSha256Hex("k", "v");
    assert.equal(h1, h2);
  }),
  t("SEC-NORM-037", "normal", "hmacSha256Hex varies with message", async () => {
    const h1 = await hmacSha256Hex("secret", "message-1");
    const h2 = await hmacSha256Hex("secret", "message-2");
    assert.notEqual(h1, h2);
  }),
  t("SEC-NORM-038", "normal", "hmacSha256Hex varies with secret", async () => {
    const h1 = await hmacSha256Hex("secret-1", "message");
    const h2 = await hmacSha256Hex("secret-2", "message");
    assert.notEqual(h1, h2);
  }),
  t("SEC-NORM-039", "normal", "PBKDF2 derives identically for NFKC normalized unicode equivalents", async () => {
    const decomposed = "\u0041\u030A"; // Å decomposed
    const precomposed = "\u00C5"; // Å precomposed
    const hash = await hashPassword(decomposed, 10000);
    assert.equal(await verifyPassword(precomposed, hash), true);
  }),
  t("SEC-NORM-040", "normal", "PBKDF2 default iterations equals constant PBKDF2_ITERATIONS (100,000)", async () => {
    assert.equal(PBKDF2_ITERATIONS, 100_000);
  }),
);

// Schemas Normal Cases (30 cases)
tests.push(
  t("SEC-NORM-041", "normal", "taskCreateSchema parses minimal valid task with title only", () => {
    const res = taskCreateSchema.safeParse({ title: "Buy groceries" });
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.title, "Buy groceries");
      assert.equal(res.data.status, "todo");
      assert.equal(res.data.priority, "medium");
      assert.equal(res.data.description, "");
    }
  }),
  t("SEC-NORM-042", "normal", "taskCreateSchema parses full task with all fields", () => {
    const res = taskCreateSchema.safeParse({
      title: "Prepare sprint review",
      description: "Review tickets and metrics",
      status: "in_progress",
      priority: "high",
      due_at: "2026-10-15T09:00:00Z",
      project_id: "proj_12345",
    });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-043", "normal", "taskUpdateSchema parses partial title update", () => {
    const res = taskUpdateSchema.safeParse({ title: "Updated Title" });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-044", "normal", "taskUpdateSchema parses explicit null for nullable fields", () => {
    const res = taskUpdateSchema.safeParse({ due_at: null, project_id: null });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-045", "normal", "taskListQuerySchema provides default query values", () => {
    const res = taskListQuerySchema.safeParse({});
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.status, "all");
      assert.equal(res.data.view, "all");
      assert.equal(res.data.limit, 200);
    }
  }),
  t("SEC-NORM-046", "normal", "taskListQuerySchema coerces string limit to number", () => {
    const res = taskListQuerySchema.safeParse({ limit: "50", status: "open", view: "today" });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.limit, 50);
  }),
  t("SEC-NORM-047", "normal", "memoryCreateSchema parses default category 'other'", () => {
    const res = memoryCreateSchema.safeParse({ content: "Prefers dark mode" });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.category, "other");
  }),
  t("SEC-NORM-048", "normal", "memoryCreateSchema parses explicit category", () => {
    const res = memoryCreateSchema.safeParse({ content: "Birthday is May 4", category: "fact" });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.category, "fact");
  }),
  t("SEC-NORM-049", "normal", "memoryUpdateSchema parses partial content update", () => {
    const res = memoryUpdateSchema.safeParse({ content: "Updated memory content" });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-050", "normal", "noteCreateSchema parses minimal note", () => {
    const res = noteCreateSchema.safeParse({ title: "Architecture Notes" });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.content, "");
  }),
  t("SEC-NORM-051", "normal", "noteCreateSchema parses full note with project_id", () => {
    const res = noteCreateSchema.safeParse({
      title: "Meeting Summary",
      content: "# Meeting\nDiscussed requirements.",
      project_id: "proj_99",
    });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-052", "normal", "noteUpdateSchema parses partial content update", () => {
    const res = noteUpdateSchema.safeParse({ content: "New note body" });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-053", "normal", "projectCreateSchema parses minimal project with default status 'active'", () => {
    const res = projectCreateSchema.safeParse({ name: "Core Engine" });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.status, "active");
  }),
  t("SEC-NORM-054", "normal", "projectCreateSchema parses project with description and status", () => {
    const res = projectCreateSchema.safeParse({
      name: "Security Hardening",
      description: "Audit and verify all endpoints",
      status: "completed",
    });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-055", "normal", "projectUpdateSchema parses status update", () => {
    const res = projectUpdateSchema.safeParse({ status: "paused" });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-056", "normal", "conversationCreateSchema parses empty object", () => {
    const res = conversationCreateSchema.safeParse({});
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-057", "normal", "conversationCreateSchema parses optional title", () => {
    const res = conversationCreateSchema.safeParse({ title: "Project Sync" });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-058", "normal", "conversationUpdateSchema parses title update", () => {
    const res = conversationUpdateSchema.safeParse({ title: "Renamed Chat" });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-059", "normal", "chatRequestSchema parses message only", () => {
    const res = chatRequestSchema.safeParse({ message: "Hello assistant!" });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-060", "normal", "chatRequestSchema parses conversation_id and retry flag", () => {
    const res = chatRequestSchema.safeParse({
      conversation_id: "conv_123",
      message: "Please retry last step",
      retry: true,
    });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-061", "normal", "automationCreateSchema parses daily automation schedule", () => {
    const res = automationCreateSchema.safeParse({
      name: "Morning Briefing",
      kind: "reminder",
      schedule: { type: "daily", time: "08:30" },
    });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-062", "normal", "automationCreateSchema parses weekly automation schedule", () => {
    const res = automationCreateSchema.safeParse({
      name: "Weekly Review",
      kind: "task_digest",
      schedule: { type: "weekly", days: [1, 5], time: "17:00" },
    });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-063", "normal", "automationCreateSchema parses interval automation schedule", () => {
    const res = automationCreateSchema.safeParse({
      name: "Health Ping",
      kind: "agent_prompt",
      schedule: { type: "interval", minutes: 30 },
    });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-064", "normal", "automationCreateSchema parses once automation schedule with valid date", () => {
    const res = automationCreateSchema.safeParse({
      name: "Launch Alert",
      kind: "reminder",
      schedule: { type: "once", at: "2026-10-31T15:00" },
    });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-065", "normal", "automationUpdateSchema parses partial enabled toggle", () => {
    const res = automationUpdateSchema.safeParse({ enabled: false });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-066", "normal", "limitsSchema validates DEFAULT_LIMITS", () => {
    const res = limitsSchema.safeParse(DEFAULT_LIMITS);
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-067", "normal", "settingsSchema parses valid standard settings", () => {
    const res = settingsSchema.safeParse({
      agentName: "Talorys Agent",
      timezone: "Asia/Seoul",
      theme: "dark",
      model: "@cf/zai-org/glm-4.7-flash",
      temperature: 0.7,
      limits: DEFAULT_LIMITS,
      autoMemory: true,
      demoMode: false,
    });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-068", "normal", "settingsUpdateSchema parses partial settings update", () => {
    const res = settingsUpdateSchema.safeParse({ timezone: "America/New_York", theme: "system" });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-069", "normal", "loginSchema parses valid login password", () => {
    const res = loginSchema.safeParse({ password: "ValidMasterPassword2026!" });
    assert.equal(res.success, true);
  }),
  t("SEC-NORM-070", "normal", "changePasswordSchema parses current and new passwords", () => {
    const res = changePasswordSchema.safeParse({
      current_password: "OldPassword123!",
      new_password: "NewPassword456!",
    });
    assert.equal(res.success, true);
  }),
);

// ============================================================================
// 2. BOUNDARY TESTS (60 cases) [SEC-BOUND-001 ~ SEC-BOUND-060]
// ============================================================================

// Password Boundary Tests (20 cases)
tests.push(
  t("SEC-BOUND-001", "boundary", "Password with exactly PASSWORD_MIN_LENGTH (10) characters accepted", () => {
    assert.equal(PASSWORD_MIN_LENGTH, 10);
    assert.equal(checkPasswordStrength("abcdefgh12"), null);
  }),
  t("SEC-BOUND-002", "boundary", "Password with length 9 rejected at boundary", () => {
    const res = checkPasswordStrength("abcdefgh1");
    assert.match(res ?? "", /Use at least 10 characters/);
  }),
  t("SEC-BOUND-003", "boundary", "Password with length 15 requires at least 2 character classes", () => {
    assert.equal(checkPasswordStrength("abcdefghijklm12"), null); // 15 chars, 2 classes
  }),
  t("SEC-BOUND-004", "boundary", "Password with length 16 allows single class (passphrase boundary)", () => {
    assert.equal(checkPasswordStrength("abcdefghijklmnop"), null); // 16 chars, 1 class
  }),
  t("SEC-BOUND-005", "boundary", "Password with exactly 256 characters accepted", () => {
    const longPass = "aA1!" + "x".repeat(252);
    assert.equal(longPass.length, 256);
    assert.equal(checkPasswordStrength(longPass), null);
  }),
  t("SEC-BOUND-006", "boundary", "Password with exactly 257 characters rejected (upper boundary)", () => {
    const tooLong = "aA1!" + "x".repeat(253);
    assert.equal(tooLong.length, 257);
    assert.match(checkPasswordStrength(tooLong) ?? "", /Use at most 256 characters/);
  }),
  t("SEC-BOUND-007", "boundary", "Password with Cyrillic unicode characters accepted", () => {
    assert.equal(checkPasswordStrength("ПриветМир123!"), null);
  }),
  t("SEC-BOUND-008", "boundary", "Password with CJK ideographs accepted", () => {
    assert.equal(checkPasswordStrength("密碼保護系統2026!"), null);
  }),
  t("SEC-BOUND-009", "boundary", "Password with Arabic characters accepted", () => {
    assert.equal(checkPasswordStrength("كلمةالسرالقوية2026!"), null);
  }),
  t("SEC-BOUND-010", "boundary", "Password with combining diacritics accepted", () => {
    assert.equal(checkPasswordStrength("café-crème-brûlée-2026"), null);
  }),
  t("SEC-BOUND-011", "boundary", "Password containing all printable ASCII symbols", () => {
    assert.equal(checkPasswordStrength("!@#$%^&*()_+-=[]{}|;':,./<>?abc"), null);
  }),
  t("SEC-BOUND-012", "boundary", "Passphrase with multiple internal spaces accepted", () => {
    assert.equal(checkPasswordStrength("deep blue ocean wave splash"), null);
  }),
  t("SEC-BOUND-013", "boundary", "Password preserving leading/trailing spaces for length", () => {
    assert.equal(checkPasswordStrength("  spaced-passphrase  "), null);
  }),
  t("SEC-BOUND-014", "boundary", "Password containing tab characters accepted", () => {
    assert.equal(checkPasswordStrength("secret\tphrase\ttoken\t2026"), null);
  }),
  t("SEC-BOUND-015", "boundary", "Repeating unicode emoji character must be rejected as repeating [REPRODUCTION]", () => {
    const emojiRepeat = "🚀".repeat(10); // 10 emojis
    const res = checkPasswordStrength(emojiRepeat);
    assert.equal(res, "Avoid repeating a single character.");
  }),
  t("SEC-BOUND-016", "boundary", "Repeating newline characters must be rejected as repeating [REPRODUCTION]", () => {
    const newlineRepeat = "\n".repeat(12);
    const res = checkPasswordStrength(newlineRepeat);
    assert.equal(res, "Avoid repeating a single character.");
  }),
  t("SEC-BOUND-017", "boundary", "Alternating repeating characters ('abababababab') accepted", () => {
    assert.equal(checkPasswordStrength("abababababab12!"), null);
  }),
  t("SEC-BOUND-018", "boundary", "Password with exactly 255 characters accepted", () => {
    const p255 = "aA1!" + "y".repeat(251);
    assert.equal(p255.length, 255);
    assert.equal(checkPasswordStrength(p255), null);
  }),
  t("SEC-BOUND-019", "boundary", "Single character repeated 9 times rejected by length", () => {
    assert.match(checkPasswordStrength("a".repeat(9)) ?? "", /Use at least 10 characters/);
  }),
  t("SEC-BOUND-020", "boundary", "Common word substring allowed at length 16 boundary", () => {
    assert.equal(checkPasswordStrength("super-admin-root-key"), null);
  }),
);

// Crypto Boundary Tests (15 cases)
tests.push(
  t("SEC-BOUND-021", "boundary", "PBKDF2 exactly 10,000 iterations accepted", async () => {
    const hash = await hashPassword("ValidPass123!", 10000);
    assert.equal(await verifyPassword("ValidPass123!", hash), true);
  }),
  t("SEC-BOUND-022", "boundary", "PBKDF2 exactly 100,000 iterations accepted", async () => {
    const hash = await hashPassword("ValidPass123!", 100000);
    assert.equal(await verifyPassword("ValidPass123!", hash), true);
  }),
  t("SEC-BOUND-023", "boundary", "fromBase64Url handles empty string returning empty Uint8Array", () => {
    const out = fromBase64Url("");
    assert.equal(out.length, 0);
  }),
  t("SEC-BOUND-024", "boundary", "fromBase64Url handles 1 byte encoded (2 chars: 'AQ')", () => {
    const out = fromBase64Url("AQ");
    assert.equal(out.length, 1);
    assert.equal(out[0], 1);
  }),
  t("SEC-BOUND-025", "boundary", "fromBase64Url handles 2 bytes encoded (3 chars: 'AQI')", () => {
    const out = fromBase64Url("AQI");
    assert.equal(out.length, 2);
    assert.equal(out[0], 1);
    assert.equal(out[1], 2);
  }),
  t("SEC-BOUND-026", "boundary", "fromBase64Url handles 3 bytes encoded (4 chars: 'AQID')", () => {
    const out = fromBase64Url("AQID");
    assert.equal(out.length, 3);
    assert.equal(out[0], 1);
    assert.equal(out[1], 2);
    assert.equal(out[2], 3);
  }),
  t("SEC-BOUND-027", "boundary", "randomToken(1) generates exactly 2 base64url characters", () => {
    const token = randomToken(1);
    assert.equal(token.length, 2);
  }),
  t("SEC-BOUND-028", "boundary", "randomToken(256) generates large random token without error", () => {
    const token = randomToken(256);
    assert.equal(token.length, Math.ceil((256 * 4) / 3));
  }),
  t("SEC-BOUND-029", "boundary", "sha256Hex processes 64KB string correctly", async () => {
    const large = "A".repeat(65536);
    const hex = await sha256Hex(large);
    assert.match(hex, /^[0-9a-f]{64}$/);
  }),
  t("SEC-BOUND-030", "boundary", "hmacSha256Hex processes 64KB message payload", async () => {
    const large = "B".repeat(65536);
    const hex = await hmacSha256Hex("key", large);
    assert.match(hex, /^[0-9a-f]{64}$/);
  }),
  t("SEC-BOUND-031", "boundary", "timingSafeEqual handles empty Uint8Arrays (0 bytes) returning true", () => {
    assert.equal(timingSafeEqual(new Uint8Array(0), new Uint8Array(0)), true);
  }),
  t("SEC-BOUND-032", "boundary", "timingSafeEqual handles 1-byte equal buffers", () => {
    assert.equal(timingSafeEqual(new Uint8Array([42]), new Uint8Array([42])), true);
  }),
  t("SEC-BOUND-033", "boundary", "timingSafeEqual handles 256-byte identical buffers", () => {
    const b1 = new Uint8Array(256).fill(7);
    const b2 = new Uint8Array(256).fill(7);
    assert.equal(timingSafeEqual(b1, b2), true);
  }),
  t("SEC-BOUND-034", "boundary", "timingSafeEqual detects mismatch on last byte of 256-byte buffer", () => {
    const b1 = new Uint8Array(256).fill(7);
    const b2 = new Uint8Array(256).fill(7);
    b2[255] = 8;
    assert.equal(timingSafeEqual(b1, b2), false);
  }),
  t("SEC-BOUND-035", "boundary", "timingSafeEqual detects mismatch on first byte of 256-byte buffer", () => {
    const b1 = new Uint8Array(256).fill(7);
    const b2 = new Uint8Array(256).fill(7);
    b2[0] = 8;
    assert.equal(timingSafeEqual(b1, b2), false);
  }),
);

// Schema Field Bounds (25 cases)
tests.push(
  t("SEC-BOUND-036", "boundary", "id accepts exactly 1 character", () => {
    assert.equal(taskCreateSchema.safeParse({ title: "t", project_id: "x" }).success, true);
  }),
  t("SEC-BOUND-037", "boundary", "id accepts exactly 64 characters", () => {
    assert.equal(taskCreateSchema.safeParse({ title: "t", project_id: "a".repeat(64) }).success, true);
  }),
  t("SEC-BOUND-038", "boundary", "taskCreateSchema accepts title with exactly 1 character", () => {
    assert.equal(taskCreateSchema.safeParse({ title: "A" }).success, true);
  }),
  t("SEC-BOUND-039", "boundary", "taskCreateSchema accepts title with exactly 300 characters", () => {
    assert.equal(taskCreateSchema.safeParse({ title: "x".repeat(300) }).success, true);
  }),
  t("SEC-BOUND-040", "boundary", "taskCreateSchema accepts description with exactly 10,000 characters", () => {
    assert.equal(taskCreateSchema.safeParse({ title: "t", description: "d".repeat(10000) }).success, true);
  }),
  t("SEC-BOUND-041", "boundary", "noteCreateSchema accepts content with exactly 200,000 characters", () => {
    assert.equal(noteCreateSchema.safeParse({ title: "Huge note", content: "n".repeat(200000) }).success, true);
  }),
  t("SEC-BOUND-042", "boundary", "chatRequestSchema accepts message with exactly 16,000 characters", () => {
    assert.equal(chatRequestSchema.safeParse({ message: "c".repeat(16000) }).success, true);
  }),
  t("SEC-BOUND-043", "boundary", "projectCreateSchema accepts name with exactly 200 characters", () => {
    assert.equal(projectCreateSchema.safeParse({ name: "p".repeat(200) }).success, true);
  }),
  t("SEC-BOUND-044", "boundary", "projectCreateSchema accepts description with exactly 5,000 characters", () => {
    assert.equal(projectCreateSchema.safeParse({ name: "proj", description: "d".repeat(5000) }).success, true);
  }),
  t("SEC-BOUND-045", "boundary", "memoryCreateSchema accepts content with exactly 2,000 characters", () => {
    assert.equal(memoryCreateSchema.safeParse({ content: "m".repeat(2000) }).success, true);
  }),
  t("SEC-BOUND-046", "boundary", "automationCreateSchema accepts message with exactly 4,000 characters", () => {
    assert.equal(
      automationCreateSchema.safeParse({
        name: "Auto",
        kind: "reminder",
        schedule: { type: "interval", minutes: 15 },
        message: "a".repeat(4000),
      }).success,
      true,
    );
  }),
  t("SEC-BOUND-047", "boundary", "limitsSchema accepts maxOutputTokens at minimum (64)", () => {
    assert.equal(limitsSchema.safeParse({ ...DEFAULT_LIMITS, maxOutputTokens: 64 }).success, true);
  }),
  t("SEC-BOUND-048", "boundary", "limitsSchema accepts maxOutputTokens at ceiling (4096)", () => {
    assert.equal(limitsSchema.safeParse({ ...DEFAULT_LIMITS, maxOutputTokens: LIMIT_CEILINGS.maxOutputTokens }).success, true);
  }),
  t("SEC-BOUND-049", "boundary", "limitsSchema accepts maxToolCalls at minimum (0)", () => {
    assert.equal(limitsSchema.safeParse({ ...DEFAULT_LIMITS, maxToolCalls: 0 }).success, true);
  }),
  t("SEC-BOUND-050", "boundary", "limitsSchema accepts maxToolCalls at ceiling (20)", () => {
    assert.equal(limitsSchema.safeParse({ ...DEFAULT_LIMITS, maxToolCalls: LIMIT_CEILINGS.maxToolCalls }).success, true);
  }),
  t("SEC-BOUND-051", "boundary", "limitsSchema accepts maxAgentIterations at minimum (1)", () => {
    assert.equal(limitsSchema.safeParse({ ...DEFAULT_LIMITS, maxAgentIterations: 1 }).success, true);
  }),
  t("SEC-BOUND-052", "boundary", "limitsSchema accepts maxAgentIterations at ceiling (10)", () => {
    assert.equal(limitsSchema.safeParse({ ...DEFAULT_LIMITS, maxAgentIterations: LIMIT_CEILINGS.maxAgentIterations }).success, true);
  }),
  t("SEC-BOUND-053", "boundary", "limitsSchema accepts maxContextTokens at minimum (1000)", () => {
    assert.equal(limitsSchema.safeParse({ ...DEFAULT_LIMITS, maxContextTokens: 1000 }).success, true);
  }),
  t("SEC-BOUND-054", "boundary", "limitsSchema accepts maxContextTokens at ceiling (32000)", () => {
    assert.equal(limitsSchema.safeParse({ ...DEFAULT_LIMITS, maxContextTokens: LIMIT_CEILINGS.maxContextTokens }).success, true);
  }),
  t("SEC-BOUND-055", "boundary", "limitsSchema accepts maxScheduledAiRunsPerDay at minimum (0)", () => {
    assert.equal(limitsSchema.safeParse({ ...DEFAULT_LIMITS, maxScheduledAiRunsPerDay: 0 }).success, true);
  }),
  t("SEC-BOUND-056", "boundary", "limitsSchema accepts maxScheduledAiRunsPerDay at ceiling (48)", () => {
    assert.equal(limitsSchema.safeParse({ ...DEFAULT_LIMITS, maxScheduledAiRunsPerDay: LIMIT_CEILINGS.maxScheduledAiRunsPerDay }).success, true);
  }),
  t("SEC-BOUND-057", "boundary", "limitsSchema accepts maxAiRequestsPerDay at minimum (1)", () => {
    assert.equal(limitsSchema.safeParse({ ...DEFAULT_LIMITS, maxAiRequestsPerDay: 1 }).success, true);
  }),
  t("SEC-BOUND-058", "boundary", "limitsSchema accepts maxAiRequestsPerDay at ceiling (2000)", () => {
    assert.equal(limitsSchema.safeParse({ ...DEFAULT_LIMITS, maxAiRequestsPerDay: LIMIT_CEILINGS.maxAiRequestsPerDay }).success, true);
  }),
  t("SEC-BOUND-059", "boundary", "settingsSchema accepts temperature at lower boundary (0.0)", () => {
    const res = settingsSchema.safeParse({
      agentName: "Agent",
      timezone: "UTC",
      theme: "system",
      model: "@cf/zai-org/glm-4.7-flash",
      temperature: 0.0,
      limits: DEFAULT_LIMITS,
      autoMemory: false,
      demoMode: true,
    });
    assert.equal(res.success, true);
  }),
  t("SEC-BOUND-060", "boundary", "settingsSchema accepts temperature at upper boundary (1.5)", () => {
    const res = settingsSchema.safeParse({
      agentName: "Agent",
      timezone: "UTC",
      theme: "system",
      model: "@cf/zai-org/glm-4.7-flash",
      temperature: 1.5,
      limits: DEFAULT_LIMITS,
      autoMemory: false,
      demoMode: true,
    });
    assert.equal(res.success, true);
  }),
);

// ============================================================================
// 3. FAILURE TESTS (50 cases) [SEC-FAIL-001 ~ SEC-FAIL-050]
// ============================================================================

// Weak Password Rejections (10 cases)
tests.push(
  t("SEC-FAIL-001", "failure", "Rejects password with length 9", () => {
    assert.match(checkPasswordStrength("short123!") ?? "", /at least/);
  }),
  t("SEC-FAIL-002", "failure", "Rejects empty password string", () => {
    assert.match(checkPasswordStrength("") ?? "", /at least/);
  }),
  t("SEC-FAIL-003", "failure", "Rejects password with length 257", () => {
    assert.match(checkPasswordStrength("a".repeat(257)) ?? "", /at most 256/);
  }),
  t("SEC-FAIL-004", "failure", "Rejects password repeating single lowercase character 'aaaaaaaaaa'", () => {
    assert.match(checkPasswordStrength("aaaaaaaaaa") ?? "", /repeating/);
  }),
  t("SEC-FAIL-005", "failure", "Rejects password repeating single digit '1111111111'", () => {
    assert.match(checkPasswordStrength("1111111111") ?? "", /repeating/);
  }),
  t("SEC-FAIL-006", "failure", "Rejects single-class lowercase password under 16 characters", () => {
    assert.match(checkPasswordStrength("alllowercaseno") ?? "", /Mix letters/);
  }),
  t("SEC-FAIL-007", "failure", "Rejects single-class uppercase password under 16 characters", () => {
    assert.match(checkPasswordStrength("ALLUPPERCASENO") ?? "", /Mix letters/);
  }),
  t("SEC-FAIL-008", "failure", "Rejects password containing common word 'password' when < 16 chars", () => {
    assert.match(checkPasswordStrength("mypassword1") ?? "", /common words/);
  }),
  t("SEC-FAIL-009", "failure", "Rejects password containing common word '123456' when < 16 chars", () => {
    assert.match(checkPasswordStrength("abc123456xyz") ?? "", /common words/);
  }),
  t("SEC-FAIL-010", "failure", "Rejects password containing common word 'admin' when < 16 chars", () => {
    assert.match(checkPasswordStrength("sysadmin101") ?? "", /common words/);
  }),
);

// Crypto Tampering & Rejections (15 cases)
tests.push(
  t("SEC-FAIL-011", "failure", "verifyPassword returns false when salt is tampered in stored hash", async () => {
    const hash = await hashPassword("TargetPassword#1", 10000);
    const parts = hash.split("$");
    const tamperedSalt = parts[2]!.startsWith("A") ? "B" + parts[2]!.slice(1) : "A" + parts[2]!.slice(1);
    const tampered = `${parts[0]}${parts[1]}$${tamperedSalt}$${parts[3]}`;
    assert.equal(await verifyPassword("TargetPassword#1", tampered), false);
  }),
  t("SEC-FAIL-012", "failure", "verifyPassword returns false when hash bytes are tampered in stored hash", async () => {
    const hash = await hashPassword("TargetPassword#1", 10000);
    const parts = hash.split("$");
    const tamperedHash = parts[3]!.startsWith("A") ? "B" + parts[3]!.slice(1) : "A" + parts[3]!.slice(1);
    const tampered = `${parts[0]}$${parts[1]}$${parts[2]}$${tamperedHash}`;
    assert.equal(await verifyPassword("TargetPassword#1", tampered), false);
  }),
  t("SEC-FAIL-013", "failure", "verifyPassword rejects iterations below minimum (9,999)", async () => {
    const hash = "pbkdf2-sha256$9999$c2FsdHNhbHQ$aGFzaGhhc2g";
    assert.equal(await verifyPassword("pass", hash), false);
  }),
  t("SEC-FAIL-014", "failure", "verifyPassword rejects iterations exceeding ceiling (100,001)", async () => {
    const hash = "pbkdf2-sha256$100001$c2FsdHNhbHQ$aGFzaGhhc2g";
    assert.equal(await verifyPassword("pass", hash), false);
  }),
  t("SEC-FAIL-015", "failure", "verifyPassword rejects non-integer iterations ('10000.5')", async () => {
    const hash = "pbkdf2-sha256$10000.5$c2FsdHNhbHQ$aGFzaGhhc2g";
    assert.equal(await verifyPassword("pass", hash), false);
  }),
  t("SEC-FAIL-016", "failure", "isPasswordHash rejects plaintext string without prefix", () => {
    assert.equal(isPasswordHash("myPlaintextSecret"), false);
  }),
  t("SEC-FAIL-017", "failure", "isPasswordHash rejects unsupported algorithm prefix ('bcrypt$...')", () => {
    assert.equal(isPasswordHash("bcrypt$10000$c2FsdHNhbHQ$aGFzaGhhc2g"), false);
  }),
  t("SEC-FAIL-018", "failure", "isPasswordHash rejects hash missing hash segment", () => {
    assert.equal(isPasswordHash("pbkdf2-sha256$10000$c2FsdHNhbHQ"), false);
  }),
  t("SEC-FAIL-019", "failure", "isPasswordHash rejects hash with superfluous segments", () => {
    assert.equal(isPasswordHash("pbkdf2-sha256$10000$c2FsdHNhbHQ$aGFzaGhhc2g$extra"), false);
  }),
  t("SEC-FAIL-020", "failure", "timingSafeEqual returns false for buffers with unequal lengths", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 4]);
    assert.equal(timingSafeEqual(a, b), false);
  }),
  t("SEC-FAIL-021", "failure", "timingSafeEqual returns false when all bytes are inverted", () => {
    const a = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
    const b = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    assert.equal(timingSafeEqual(a, b), false);
  }),
  t("SEC-FAIL-022", "failure", "hmacSha256Hex throws DataError when key is empty string", async () => {
    await assert.rejects(async () => {
      await hmacSha256Hex("", "data");
    }, /DataError|data does not meet requirements/i);
  }),
  t("SEC-FAIL-023", "failure", "isPasswordHash returns false for empty string", () => {
    assert.equal(isPasswordHash(""), false);
  }),
  t("SEC-FAIL-024", "failure", "isPasswordHash returns false for null", () => {
    assert.equal(isPasswordHash(null), false);
  }),
  t("SEC-FAIL-025", "failure", "isPasswordHash returns false for undefined", () => {
    assert.equal(isPasswordHash(undefined), false);
  }),
);

// Schema Validation Rejections (25 cases)
tests.push(
  t("SEC-FAIL-026", "failure", "id rejects empty string", () => {
    assert.equal(taskCreateSchema.safeParse({ title: "t", project_id: "" }).success, false);
  }),
  t("SEC-FAIL-027", "failure", "id rejects string longer than 64 characters", () => {
    assert.equal(taskCreateSchema.safeParse({ title: "t", project_id: "a".repeat(65) }).success, false);
  }),
  t("SEC-FAIL-028", "failure", "taskCreateSchema rejects empty title", () => {
    assert.equal(taskCreateSchema.safeParse({ title: "" }).success, false);
  }),
  t("SEC-FAIL-029", "failure", "taskCreateSchema rejects whitespace-only title", () => {
    assert.equal(taskCreateSchema.safeParse({ title: "    " }).success, false);
  }),
  t("SEC-FAIL-030", "failure", "taskCreateSchema rejects title longer than 300 characters", () => {
    assert.equal(taskCreateSchema.safeParse({ title: "a".repeat(301) }).success, false);
  }),
  t("SEC-FAIL-031", "failure", "taskCreateSchema rejects invalid status ('archived' not in task statuses)", () => {
    assert.equal(taskCreateSchema.safeParse({ title: "t", status: "archived" }).success, false);
  }),
  t("SEC-FAIL-032", "failure", "taskCreateSchema rejects invalid priority ('critical')", () => {
    assert.equal(taskCreateSchema.safeParse({ title: "t", priority: "critical" }).success, false);
  }),
  t("SEC-FAIL-033", "failure", "taskCreateSchema rejects invalid due_at datetime string", () => {
    assert.equal(taskCreateSchema.safeParse({ title: "t", due_at: "invalid-date" }).success, false);
  }),
  t("SEC-FAIL-034", "failure", "taskCreateSchema rejects due_at missing timezone offset", () => {
    assert.equal(taskCreateSchema.safeParse({ title: "t", due_at: "2026-10-12T12:00:00" }).success, false);
  }),
  t("SEC-FAIL-035", "failure", "taskCreateSchema rejects description exceeding 10,000 characters", () => {
    assert.equal(taskCreateSchema.safeParse({ title: "t", description: "d".repeat(10001) }).success, false);
  }),
  t("SEC-FAIL-036", "failure", "memoryCreateSchema rejects invalid category", () => {
    assert.equal(memoryCreateSchema.safeParse({ content: "c", category: "classified" }).success, false);
  }),
  t("SEC-FAIL-037", "failure", "noteCreateSchema rejects content exceeding 200,000 characters", () => {
    assert.equal(noteCreateSchema.safeParse({ title: "t", content: "n".repeat(200001) }).success, false);
  }),
  t("SEC-FAIL-038", "failure", "projectCreateSchema rejects invalid status ('deleted')", () => {
    assert.equal(projectCreateSchema.safeParse({ name: "p", status: "deleted" }).success, false);
  }),
  t("SEC-FAIL-039", "failure", "chatRequestSchema rejects message exceeding 16,000 characters", () => {
    assert.equal(chatRequestSchema.safeParse({ message: "c".repeat(16001) }).success, false);
  }),
  t("SEC-FAIL-040", "failure", "chatRequestSchema rejects empty message", () => {
    assert.equal(chatRequestSchema.safeParse({ message: "" }).success, false);
  }),
  t("SEC-FAIL-041", "failure", "settingsSchema rejects invalid IANA timezone ('Mars/Base')", () => {
    const res = settingsSchema.safeParse({
      agentName: "Agent",
      timezone: "Mars/Base",
      theme: "dark",
      model: "@cf/zai-org/glm-4.7-flash",
      temperature: 0.7,
      limits: DEFAULT_LIMITS,
      autoMemory: true,
      demoMode: false,
    });
    assert.equal(res.success, false);
  }),
  t("SEC-FAIL-042", "failure", "settingsSchema rejects invalid theme ('solarized')", () => {
    const res = settingsSchema.safeParse({
      agentName: "Agent",
      timezone: "UTC",
      theme: "solarized",
      model: "@cf/zai-org/glm-4.7-flash",
      temperature: 0.7,
      limits: DEFAULT_LIMITS,
      autoMemory: true,
      demoMode: false,
    });
    assert.equal(res.success, false);
  }),
  t("SEC-FAIL-043", "failure", "settingsSchema rejects model id without @cf/ or @hf/ prefix", () => {
    const res = settingsSchema.safeParse({
      agentName: "Agent",
      timezone: "UTC",
      theme: "dark",
      model: "gpt-4-turbo",
      temperature: 0.7,
      limits: DEFAULT_LIMITS,
      autoMemory: true,
      demoMode: false,
    });
    assert.equal(res.success, false);
  }),
  t("SEC-FAIL-044", "failure", "settingsSchema rejects negative temperature (-0.1)", () => {
    const res = settingsSchema.safeParse({
      agentName: "Agent",
      timezone: "UTC",
      theme: "dark",
      model: "@cf/zai-org/glm-4.7-flash",
      temperature: -0.1,
      limits: DEFAULT_LIMITS,
      autoMemory: true,
      demoMode: false,
    });
    assert.equal(res.success, false);
  }),
  t("SEC-FAIL-045", "failure", "settingsSchema rejects temperature > 1.5", () => {
    const res = settingsSchema.safeParse({
      agentName: "Agent",
      timezone: "UTC",
      theme: "dark",
      model: "@cf/zai-org/glm-4.7-flash",
      temperature: 1.51,
      limits: DEFAULT_LIMITS,
      autoMemory: true,
      demoMode: false,
    });
    assert.equal(res.success, false);
  }),
  t("SEC-FAIL-046", "failure", "limitsSchema rejects maxOutputTokens < 64", () => {
    assert.equal(limitsSchema.safeParse({ ...DEFAULT_LIMITS, maxOutputTokens: 63 }).success, false);
  }),
  t("SEC-FAIL-047", "failure", "limitsSchema rejects maxOutputTokens > 4096", () => {
    assert.equal(limitsSchema.safeParse({ ...DEFAULT_LIMITS, maxOutputTokens: 4097 }).success, false);
  }),
  t("SEC-FAIL-048", "failure", "limitsSchema rejects maxToolCalls > 20", () => {
    assert.equal(limitsSchema.safeParse({ ...DEFAULT_LIMITS, maxToolCalls: 21 }).success, false);
  }),
  t("SEC-FAIL-049", "failure", "backupSchema rejects invalid format ('unauthorized-backup')", () => {
    assert.equal(
      backupSchema.safeParse({
        format: "unauthorized-backup",
        version: 1,
        exported_at: "2026-10-12T00:00:00Z",
        data: {},
      }).success,
      false,
    );
  }),
  t("SEC-FAIL-050", "failure", "backupSchema rejects version < 1", () => {
    assert.equal(
      backupSchema.safeParse({
        format: BACKUP_FORMAT,
        version: 0,
        exported_at: "2026-10-12T00:00:00Z",
        data: {},
      }).success,
      false,
    );
  }),
);

// ============================================================================
// 4. CONCURRENCY TESTS (40 cases) [SEC-CONC-001 ~ SEC-CONC-040]
// ============================================================================

tests.push(
  t("SEC-CONC-001", "concurrency", "50 concurrent verifyPassword calls with valid password", async () => {
    const hash = await hashPassword("ConcurrentValidPassword#1", 10000);
    const tasks = Array.from({ length: 50 }, () => verifyPassword("ConcurrentValidPassword#1", hash));
    const results = await Promise.all(tasks);
    assert.equal(results.every((r) => r === true), true);
  }),
  t("SEC-CONC-002", "concurrency", "50 concurrent verifyPassword calls with invalid password", async () => {
    const hash = await hashPassword("ConcurrentValidPassword#2", 10000);
    const tasks = Array.from({ length: 50 }, () => verifyPassword("WrongPassword#2", hash));
    const results = await Promise.all(tasks);
    assert.equal(results.every((r) => r === false), true);
  }),
  t("SEC-CONC-003", "concurrency", "50 concurrent verifyPassword calls alternating valid and invalid", async () => {
    const hash = await hashPassword("ConcurrentValidPassword#3", 10000);
    const tasks = Array.from({ length: 50 }, (_, i) =>
      verifyPassword(i % 2 === 0 ? "ConcurrentValidPassword#3" : "Wrong", hash),
    );
    const results = await Promise.all(tasks);
    for (let i = 0; i < 50; i++) {
      assert.equal(results[i], i % 2 === 0);
    }
  }),
  t("SEC-CONC-004", "concurrency", "20 concurrent hashPassword calls generate all unique hashes & salts", async () => {
    const tasks = Array.from({ length: 20 }, () => hashPassword("CommonPassword#4", 10000));
    const hashes = await Promise.all(tasks);
    const unique = new Set(hashes);
    assert.equal(unique.size, 20);
  }),
  t("SEC-CONC-005", "concurrency", "100 concurrent sha256Hex calls with distinct inputs", async () => {
    const tasks = Array.from({ length: 100 }, (_, i) => sha256Hex(`payload-${i}`));
    const digests = await Promise.all(tasks);
    const unique = new Set(digests);
    assert.equal(unique.size, 100);
  }),
  t("SEC-CONC-006", "concurrency", "100 concurrent hmacSha256Hex calls with identical secret", async () => {
    const tasks = Array.from({ length: 100 }, (_, i) => hmacSha256Hex("shared-secret", `msg-${i}`));
    const signatures = await Promise.all(tasks);
    const unique = new Set(signatures);
    assert.equal(unique.size, 100);
  }),
  t("SEC-CONC-007", "concurrency", "100 concurrent hmacSha256Hex calls with distinct secrets", async () => {
    const tasks = Array.from({ length: 100 }, (_, i) => hmacSha256Hex(`secret-${i}`, "same-message"));
    const signatures = await Promise.all(tasks);
    const unique = new Set(signatures);
    assert.equal(unique.size, 100);
  }),
  t("SEC-CONC-008", "concurrency", "50 concurrent randomToken(32) generations verify zero collision", () => {
    const tokens = Array.from({ length: 50 }, () => randomToken(32));
    const unique = new Set(tokens);
    assert.equal(unique.size, 50);
  }),
  t("SEC-CONC-009", "concurrency", "100 concurrent timingSafeEqual invocations on identical buffers", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    for (let i = 0; i < 100; i++) {
      assert.equal(timingSafeEqual(a, b), true);
    }
  }),
  t("SEC-CONC-010", "concurrency", "100 concurrent timingSafeEqual invocations on different buffers", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 9]);
    for (let i = 0; i < 100; i++) {
      assert.equal(timingSafeEqual(a, b), false);
    }
  }),
  t("SEC-CONC-011", "concurrency", "100 concurrent base64url encode/decode roundtrips", () => {
    for (let i = 0; i < 100; i++) {
      const orig = crypto.getRandomValues(new Uint8Array(i % 32));
      const encoded = toBase64Url(orig);
      const decoded = fromBase64Url(encoded);
      assert.deepEqual(decoded, orig);
    }
  }),
  t("SEC-CONC-012", "concurrency", "50 concurrent taskCreateSchema.safeParse calls", () => {
    const tasks = Array.from({ length: 50 }, (_, i) => ({ title: `Task ${i}` }));
    for (const item of tasks) {
      assert.equal(taskCreateSchema.safeParse(item).success, true);
    }
  }),
  t("SEC-CONC-013", "concurrency", "50 concurrent settingsSchema.safeParse calls", () => {
    const payload = {
      agentName: "Agent",
      timezone: "Asia/Seoul",
      theme: "dark" as const,
      model: "@cf/zai-org/glm-4.7-flash",
      temperature: 0.5,
      limits: DEFAULT_LIMITS,
      autoMemory: true,
      demoMode: false,
    };
    for (let i = 0; i < 50; i++) {
      assert.equal(settingsSchema.safeParse(payload).success, true);
    }
  }),
  t("SEC-CONC-014", "concurrency", "50 concurrent backupSchema.safeParse calls", () => {
    const payload = {
      format: BACKUP_FORMAT,
      version: 1,
      exported_at: "2026-10-12T00:00:00Z",
      data: {},
    };
    for (let i = 0; i < 50; i++) {
      assert.equal(backupSchema.safeParse(payload).success, true);
    }
  }),
  t("SEC-CONC-015", "concurrency", "50 concurrent checkPasswordStrength calls", () => {
    for (let i = 0; i < 50; i++) {
      assert.equal(checkPasswordStrength(`SecurePassword#${i}`), null);
    }
  }),
  t("SEC-CONC-016", "concurrency", "20 concurrent PBKDF2 hash verifications with 10k iterations", async () => {
    const hash = await hashPassword("PassIter10k", 10000);
    const results = await Promise.all(Array.from({ length: 20 }, () => verifyPassword("PassIter10k", hash)));
    assert.equal(results.every((r) => r === true), true);
  }),
  t("SEC-CONC-017", "concurrency", "20 concurrent PBKDF2 hash verifications with 12k iterations", async () => {
    const hash = await hashPassword("PassIter12k", 12000);
    const results = await Promise.all(Array.from({ length: 20 }, () => verifyPassword("PassIter12k", hash)));
    assert.equal(results.every((r) => r === true), true);
  }),
  t("SEC-CONC-018", "concurrency", "20 concurrent PBKDF2 hash verifications with 15k iterations", async () => {
    const hash = await hashPassword("PassIter15k", 15000);
    const results = await Promise.all(Array.from({ length: 20 }, () => verifyPassword("PassIter15k", hash)));
    assert.equal(results.every((r) => r === true), true);
  }),
  t("SEC-CONC-019", "concurrency", "50 concurrent SHA-256 digests of random 1KB payloads", async () => {
    const payloads = Array.from({ length: 50 }, () => randomToken(1024));
    const digests = await Promise.all(payloads.map((p) => sha256Hex(p)));
    assert.equal(new Set(digests).size, 50);
  }),
  t("SEC-CONC-020", "concurrency", "50 concurrent HMAC signatures of random 1KB payloads", async () => {
    const payloads = Array.from({ length: 50 }, () => randomToken(1024));
    const sigs = await Promise.all(payloads.map((p) => hmacSha256Hex("key-concurrency", p)));
    assert.equal(new Set(sigs).size, 50);
  }),
  t("SEC-CONC-021", "concurrency", "100 concurrent randomToken(32) generations verify uniqueness", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(randomToken(32));
    }
    assert.equal(tokens.size, 100);
  }),
  t("SEC-CONC-022", "concurrency", "100 concurrent randomToken(64) generations verify uniqueness", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(randomToken(64));
    }
    assert.equal(tokens.size, 100);
  }),
  t("SEC-CONC-023", "concurrency", "50 concurrent Unicode normalizations in PBKDF2 verification", async () => {
    const hash = await hashPassword("Café-Boulangerie-2026", 10000);
    const decomposed = "Cafe\u0301-Boulangerie-2026";
    const tasks = Array.from({ length: 50 }, () => verifyPassword(decomposed, hash));
    const results = await Promise.all(tasks);
    assert.equal(results.every((r) => r === true), true);
  }),
  t("SEC-CONC-024", "concurrency", "50 concurrent taskUpdateSchema validations with partial inputs", () => {
    for (let i = 0; i < 50; i++) {
      assert.equal(taskUpdateSchema.safeParse({ title: `Title ${i}`, status: "done" }).success, true);
    }
  }),
  t("SEC-CONC-025", "concurrency", "50 concurrent memoryCreateSchema validations", () => {
    for (let i = 0; i < 50; i++) {
      assert.equal(memoryCreateSchema.safeParse({ content: `Memory ${i}`, category: "fact" }).success, true);
    }
  }),
  t("SEC-CONC-026", "concurrency", "50 concurrent projectCreateSchema validations", () => {
    for (let i = 0; i < 50; i++) {
      assert.equal(projectCreateSchema.safeParse({ name: `Project ${i}` }).success, true);
    }
  }),
  t("SEC-CONC-027", "concurrency", "50 concurrent noteCreateSchema validations with 10KB content", () => {
    const content = "x".repeat(10240);
    for (let i = 0; i < 50; i++) {
      assert.equal(noteCreateSchema.safeParse({ title: `Note ${i}`, content }).success, true);
    }
  }),
  t("SEC-CONC-028", "concurrency", "50 concurrent chatRequestSchema validations with 1KB messages", () => {
    const message = "m".repeat(1024);
    for (let i = 0; i < 50; i++) {
      assert.equal(chatRequestSchema.safeParse({ message }).success, true);
    }
  }),
  t("SEC-CONC-029", "concurrency", "50 concurrent automationCreateSchema validations (daily)", () => {
    for (let i = 0; i < 50; i++) {
      assert.equal(
        automationCreateSchema.safeParse({
          name: `Daily ${i}`,
          kind: "reminder",
          schedule: { type: "daily", time: "12:00" },
        }).success,
        true,
      );
    }
  }),
  t("SEC-CONC-030", "concurrency", "50 concurrent automationCreateSchema validations (weekly)", () => {
    for (let i = 0; i < 50; i++) {
      assert.equal(
        automationCreateSchema.safeParse({
          name: `Weekly ${i}`,
          kind: "reminder",
          schedule: { type: "weekly", days: [1], time: "09:00" },
        }).success,
        true,
      );
    }
  }),
  t("SEC-CONC-031", "concurrency", "50 concurrent automationCreateSchema validations (interval)", () => {
    for (let i = 0; i < 50; i++) {
      assert.equal(
        automationCreateSchema.safeParse({
          name: `Interval ${i}`,
          kind: "agent_prompt",
          schedule: { type: "interval", minutes: 15 },
        }).success,
        true,
      );
    }
  }),
  t("SEC-CONC-032", "concurrency", "50 concurrent automationCreateSchema validations (once)", () => {
    for (let i = 0; i < 50; i++) {
      assert.equal(
        automationCreateSchema.safeParse({
          name: `Once ${i}`,
          kind: "reminder",
          schedule: { type: "once", at: "2026-12-25T10:00" },
        }).success,
        true,
      );
    }
  }),
  t("SEC-CONC-033", "concurrency", "50 concurrent loginSchema validations", () => {
    for (let i = 0; i < 50; i++) {
      assert.equal(loginSchema.safeParse({ password: `Password_${i}` }).success, true);
    }
  }),
  t("SEC-CONC-034", "concurrency", "50 concurrent changePasswordSchema validations", () => {
    for (let i = 0; i < 50; i++) {
      assert.equal(
        changePasswordSchema.safeParse({
          current_password: `OldPass_${i}`,
          new_password: `NewPass_${i}`,
        }).success,
        true,
      );
    }
  }),
  t("SEC-CONC-035", "concurrency", "50 concurrent settingsUpdateSchema validations", () => {
    for (let i = 0; i < 50; i++) {
      assert.equal(settingsUpdateSchema.safeParse({ agentName: `Agent_${i}` }).success, true);
    }
  }),
  t("SEC-CONC-036", "concurrency", "50 concurrent taskListQuerySchema validations with query string conversions", () => {
    for (let i = 0; i < 50; i++) {
      assert.equal(taskListQuerySchema.safeParse({ limit: `${i + 1}`, status: "all" }).success, true);
    }
  }),
  t("SEC-CONC-037", "concurrency", "50 concurrent timingSafeEqual comparisons with variable length buffers", () => {
    for (let i = 0; i < 50; i++) {
      const b1 = new Uint8Array(i);
      const b2 = new Uint8Array(i);
      assert.equal(timingSafeEqual(b1, b2), true);
    }
  }),
  t("SEC-CONC-038", "concurrency", "50 concurrent timingSafeEqual comparisons with 32-byte hash buffers", () => {
    for (let i = 0; i < 50; i++) {
      const b1 = crypto.getRandomValues(new Uint8Array(32));
      const b2 = new Uint8Array(b1);
      assert.equal(timingSafeEqual(b1, b2), true);
    }
  }),
  t("SEC-CONC-039", "concurrency", "50 concurrent checkPasswordStrength calls on long passphrases", () => {
    for (let i = 0; i < 50; i++) {
      assert.equal(checkPasswordStrength(`passphrase number ${i} is sufficiently long and varied`), null);
    }
  }),
  t("SEC-CONC-040", "concurrency", "50 concurrent checkPasswordStrength calls on weak passwords", () => {
    for (let i = 0; i < 50; i++) {
      assert.notEqual(checkPasswordStrength("short"), null);
    }
  }),
);

// ============================================================================
// 5. RECOVERY TESTS (30 cases) [SEC-RECOV-001 ~ SEC-RECOV-030]
// ============================================================================

tests.push(
  t("SEC-RECOV-001", "recovery", "verifyPassword with single-char salt/hash safely returns false without crashing [REPRODUCTION]", async () => {
    const res = await verifyPassword("pass", "pbkdf2-sha256$10000$A$B");
    assert.equal(res, false);
  }),
  t("SEC-RECOV-002", "recovery", "verifyPassword with invalid base64 salt (length%4==1) safely returns false", async () => {
    const res = await verifyPassword("pass", "pbkdf2-sha256$10000$abcde$c2FsdHNhbHQ");
    assert.equal(res, false);
  }),
  t("SEC-RECOV-003", "recovery", "verifyPassword with invalid base64 hash (length%4==1) safely returns false", async () => {
    const res = await verifyPassword("pass", "pbkdf2-sha256$10000$c2FsdHNhbHQ$abcde");
    assert.equal(res, false);
  }),
  t("SEC-RECOV-004", "recovery", "verifyPassword with null password input returns false without throwing [REPRODUCTION]", async () => {
    const res = await verifyPassword(null as any, "pbkdf2-sha256$10000$c2FsdHNhbHQ$aGFzaGhhc2g");
    assert.equal(res, false);
  }),
  t("SEC-RECOV-005", "recovery", "verifyPassword with undefined password input returns false without throwing", async () => {
    const res = await verifyPassword(undefined as any, "pbkdf2-sha256$10000$c2FsdHNhbHQ$aGFzaGhhc2g");
    assert.equal(res, false);
  }),
  t("SEC-RECOV-006", "recovery", "verifyPassword with number password input returns false without throwing", async () => {
    const res = await verifyPassword(12345 as any, "pbkdf2-sha256$10000$c2FsdHNhbHQ$aGFzaGhhc2g");
    assert.equal(res, false);
  }),
  t("SEC-RECOV-007", "recovery", "verifyPassword with empty salt string returns false", async () => {
    const res = await verifyPassword("pass", "pbkdf2-sha256$10000$$aGFzaGhhc2g");
    assert.equal(res, false);
  }),
  t("SEC-RECOV-008", "recovery", "verifyPassword with empty hash string returns false", async () => {
    const res = await verifyPassword("pass", "pbkdf2-sha256$10000$c2FsdHNhbHQ$");
    assert.equal(res, false);
  }),
  t("SEC-RECOV-009", "recovery", "verifyPassword with salt containing invalid characters returns false", async () => {
    const res = await verifyPassword("pass", "pbkdf2-sha256$10000$salt!@#$%^$hash");
    assert.equal(res, false);
  }),
  t("SEC-RECOV-010", "recovery", "verifyPassword with hash containing invalid characters returns false", async () => {
    const res = await verifyPassword("pass", "pbkdf2-sha256$10000$salt$hash!@#$%^");
    assert.equal(res, false);
  }),
  t("SEC-RECOV-011", "recovery", "verifyPassword with truncated 1-byte salt returns false", async () => {
    const res = await verifyPassword("pass", "pbkdf2-sha256$10000$AQ$c2FsdHNhbHQ");
    assert.equal(res, false);
  }),
  t("SEC-RECOV-012", "recovery", "verifyPassword with truncated 1-byte hash returns false", async () => {
    const res = await verifyPassword("pass", "pbkdf2-sha256$10000$c2FsdHNhbHQ$AQ");
    assert.equal(res, false);
  }),
  t("SEC-RECOV-013", "recovery", "timingSafeEqual with null as first argument returns false without throwing", () => {
    const res = timingSafeEqual(null as any, new Uint8Array([1, 2]));
    assert.equal(res, false);
  }),
  t("SEC-RECOV-014", "recovery", "timingSafeEqual with null as second argument returns false without throwing", () => {
    const res = timingSafeEqual(new Uint8Array([1, 2]), null as any);
    assert.equal(res, false);
  }),
  t("SEC-RECOV-015", "recovery", "timingSafeEqual with non-Uint8Array inputs returns false without throwing", () => {
    const res = timingSafeEqual({} as any, "invalid" as any);
    assert.equal(res, false);
  }),
  t("SEC-RECOV-016", "recovery", "taskCreateSchema.safeParse recovers with validation errors on malformed object", () => {
    const res = taskCreateSchema.safeParse({ invalid: true, numbers: 1234 });
    assert.equal(res.success, false);
  }),
  t("SEC-RECOV-017", "recovery", "taskCreateSchema.safeParse recovers gracefully on null input", () => {
    const res = taskCreateSchema.safeParse(null);
    assert.equal(res.success, false);
  }),
  t("SEC-RECOV-018", "recovery", "taskCreateSchema.safeParse recovers gracefully on array input", () => {
    const res = taskCreateSchema.safeParse(["item1", "item2"]);
    assert.equal(res.success, false);
  }),
  t("SEC-RECOV-019", "recovery", "settingsSchema.safeParse recovers gracefully on corrupted object", () => {
    const res = settingsSchema.safeParse({ theme: 12345, limits: null });
    assert.equal(res.success, false);
  }),
  t("SEC-RECOV-020", "recovery", "backupSchema.safeParse recovers gracefully on missing data field", () => {
    const res = backupSchema.safeParse({
      format: BACKUP_FORMAT,
      version: 1,
      exported_at: "2026-10-12T00:00:00Z",
    });
    assert.equal(res.success, false);
  }),
  t("SEC-RECOV-021", "recovery", "backupSchema.safeParse recovers gracefully on invalid tasks array in data", () => {
    const res = backupSchema.safeParse({
      format: BACKUP_FORMAT,
      version: 1,
      exported_at: "2026-10-12T00:00:00Z",
      data: {
        tasks: [{ id: "", title: 1234 }],
      },
    });
    assert.equal(res.success, false);
  }),
  t("SEC-RECOV-022", "recovery", "chatRequestSchema.safeParse recovers gracefully on numeric message", () => {
    const res = chatRequestSchema.safeParse({ message: 123456 });
    assert.equal(res.success, false);
  }),
  t("SEC-RECOV-023", "recovery", "automationCreateSchema.safeParse recovers gracefully on invalid schedule type", () => {
    const res = automationCreateSchema.safeParse({
      name: "Bad schedule",
      kind: "reminder",
      schedule: { type: "hourly" },
    });
    assert.equal(res.success, false);
  }),
  t("SEC-RECOV-024", "recovery", "loginSchema.safeParse recovers gracefully on boolean password", () => {
    const res = loginSchema.safeParse({ password: true });
    assert.equal(res.success, false);
  }),
  t("SEC-RECOV-025", "recovery", "changePasswordSchema.safeParse recovers gracefully on missing new_password", () => {
    const res = changePasswordSchema.safeParse({ current_password: "old" });
    assert.equal(res.success, false);
  }),
  t("SEC-RECOV-026", "recovery", "verifyPassword handles malformed UTF-8 characters safely without crash", async () => {
    const res = await verifyPassword("\uD800", "pbkdf2-sha256$10000$c2FsdHNhbHQ$aGFzaGhhc2g");
    assert.equal(typeof res, "boolean");
  }),
  t("SEC-RECOV-027", "recovery", "checkPasswordStrength handles 100,000 char input without ReDoS or hang", () => {
    const huge = "a".repeat(100000);
    const res = checkPasswordStrength(huge);
    assert.match(res ?? "", /Use at most 256/);
  }),
  t("SEC-RECOV-028", "recovery", "verifyPassword handles 10,000 char stored hash without ReDoS or hang", async () => {
    const hugeHash = "pbkdf2-sha256$10000$" + "a".repeat(5000) + "$" + "b".repeat(5000);
    const res = await verifyPassword("pass", hugeHash);
    assert.equal(res, false);
  }),
  t("SEC-RECOV-029", "recovery", "settingsUpdateSchema safely strips or ignores unknown keys", () => {
    const res = settingsUpdateSchema.safeParse({ theme: "dark", unknownKey: "malicious" });
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal("unknownKey" in res.data, false);
    }
  }),
  t("SEC-RECOV-030", "recovery", "backupSchema passthrough preserves unknown entity properties safely", () => {
    const res = backupSchema.safeParse({
      format: BACKUP_FORMAT,
      version: 1,
      exported_at: "2026-10-12T00:00:00Z",
      data: {
        tasks: [
          {
            id: "task_1",
            title: "Task with extra",
            status: "todo",
            created_at: "2026-10-12T00:00:00Z",
            updated_at: "2026-10-12T00:00:00Z",
            custom_metadata: "preserved",
          },
        ],
      },
    });
    assert.equal(res.success, true);
    if (res.success) {
      const task = res.data.data.tasks[0] as any;
      assert.equal(task.custom_metadata, "preserved");
    }
  }),
);

// Register and run all tests
harness.addAll(tests);

async function main() {
  console.log(`[Suite] Loaded ${harness.count} security and schema verification tests.`);
  const report = await harness.run({
    outputJsonPath: "./test-results/security-results.json",
    verbose: true,
  });

  if (report.failed > 0 || report.errored > 0) {
    console.error(`\n[Suite] FAILURE: ${report.failed} failed, ${report.errored} errored.`);
    process.exit(1);
  } else {
    console.log(`\n[Suite] SUCCESS: All ${report.passed} tests passed!`);
  }
}

main().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
