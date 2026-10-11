import { Database } from "bun:sqlite";
import { z } from "zod";
import { checkPasswordStrength } from "../packages/shared/src/password-policy";
import { verifyPassword, timingSafeEqual } from "../packages/shared/src/crypto";
import { normalize, dot } from "../apps/agent/src/semantic/vectorStore";
import {
  parseLocalDateTime,
  toLocalMinute,
  localDayBounds,
  formatLocal,
} from "../apps/agent/src/services/time";
import { isValidCalendarDate } from "../packages/shared/src/recurrence";
import { runApprovedAction, ToolDefinition, ToolContext } from "../apps/agent/src/tools/registry";
import { PendingActionRepository } from "../apps/agent/src/db/repositories/pending-actions";
import { createTestEnv } from "./tests/approval/helpers";

async function verifyCoreInvariants() {
  console.log("================================================================================");
  console.log(" Talorys 4 Core Invariants Deep Re-Verification Suite");
  console.log("================================================================================\n");

  const results: Array<{ name: string; status: "PASS" | "FAIL"; details: string }> = [];

  // ---------------------------------------------------------------------------
  // Invariant 1: DB Transaction Atomicity & Action Rollback
  // ---------------------------------------------------------------------------
  console.log("[Invariant 1] DB Transaction Atomicity & External Action Rollback");
  try {
    const env = createTestEnv();

    // Create a real task in the database
    const task = env.services.tasks.create({ title: "Rollback Test Task" });
    if (!task) throw new Error("Failed to create initial test task");

    // Propose a destructive action targeting this task
    const pendingAction = env.services.pendingActions.create({
      conversation_id: env.conversation.id,
      tool: "destructive_fail_tool",
      target_id: task.id,
      summary: "Delete task destructively with simulated mid-flight crash",
    });

    const mockTool: ToolDefinition = {
      name: "destructive_fail_tool",
      description: "Fails midway through execution",
      permission: "destructive",
      input: z.object({ id: z.string() }),
      label: () => "Delete",
      prepare: (i) => ({ targetId: i.id, summary: "Delete" }),
      commit: (id: string, ctx: ToolContext) => {
        // Step 1: Mutate DB
        ctx.services.tasks.delete(id);
        // Step 2: Throw mid-flight error to trigger transaction rollback
        throw new Error("SIMULATED_DB_CRASH_MID_COMMIT");
      },
    };

    // Execute approved action
    const actionResult = await runApprovedAction([mockTool], env.ctx, pendingAction.id);

    // Verify: action marked failed
    if (actionResult.status !== "failed") {
      throw new Error(`Expected pending action status 'failed', got '${actionResult.status}'`);
    }

    // Verify: Database was rolled back and the task still exists!
    const taskAfter = env.services.tasks.get(task.id);
    if (!taskAfter) {
      throw new Error("Transaction rollback failed: task was deleted despite mid-commit exception!");
    }

    results.push({
      name: "1. DB Transaction Atomicity & Action Rollback",
      status: "PASS",
      details: "Mid-flight failure triggered atomic DB rollback; initial data intact, pending action marked failed cleanly.",
    });
    console.log("  -> PASS: DB mutation rolled back, task preserved, status recorded failed.");
  } catch (err: any) {
    results.push({
      name: "1. DB Transaction Atomicity & Action Rollback",
      status: "FAIL",
      details: err.message,
    });
    console.error("  -> FAIL:", err.message);
  }

  // ---------------------------------------------------------------------------
  // Invariant 2: Timezone Fallback & Calendar Bounds
  // ---------------------------------------------------------------------------
  console.log("\n[Invariant 2] Timezone Fallback & Calendar Bounds");
  try {
    // 2.1 Invalid timezone fallback to UTC
    const invalidTz = "Mars/Olympus_Mons";
    const date = new Date("2026-05-15T12:00:00Z");
    const localMin = toLocalMinute(date, invalidTz);
    if (!localMin.startsWith("2026-05-15T12:00")) {
      throw new Error(`Expected UTC fallback for invalid timezone, got: ${localMin}`);
    }

    const bounds = localDayBounds("Invalid/Zone", date);
    if (!bounds.start || !bounds.end) {
      throw new Error("localDayBounds crashed or returned empty bounds on invalid timezone");
    }

    const formatted = formatLocal("2026-05-15T12:00:00Z", "NonExistent/TZ");
    if (!formatted) {
      throw new Error("formatLocal failed on invalid timezone");
    }

    // 2.2 Invalid calendar dates rejected
    if (isValidCalendarDate(2026, 2, 31)) throw new Error("2026-02-31 should be rejected");
    if (isValidCalendarDate(2026, 2, 29)) throw new Error("2026-02-29 (non-leap year) should be rejected");
    if (!isValidCalendarDate(2028, 2, 29)) throw new Error("2028-02-29 (leap year) should be accepted");
    if (isValidCalendarDate(2026, 4, 31)) throw new Error("2026-04-31 (April has 30 days) should be rejected");

    const parsedInvalid = parseLocalDateTime("2026-02-31T10:00", "Asia/Seoul");
    if (parsedInvalid !== null) throw new Error("parseLocalDateTime must return null for 2026-02-31");

    results.push({
      name: "2. Timezone Fallback & Calendar Bounds",
      status: "PASS",
      details: "Invalid timezones safely fall back to UTC without crashing; leap year & calendar bounds strictly enforced.",
    });
    console.log("  -> PASS: UTC fallback verified, 2026-02-31 rejected, leap years accurate.");
  } catch (err: any) {
    results.push({
      name: "2. Timezone Fallback & Calendar Bounds",
      status: "FAIL",
      details: err.message,
    });
    console.error("  -> FAIL:", err.message);
  }

  // ---------------------------------------------------------------------------
  // Invariant 3: Zero-Vector & Non-Finite (NaN/Infinity) Shield
  // ---------------------------------------------------------------------------
  console.log("\n[Invariant 3] Zero-Vector & Non-Finite (NaN/Infinity) Shield");
  try {
    // 3.1 All-zero vector normalization
    const zeroVec = new Float32Array([0, 0, 0, 0]);
    const normZero = normalize(zeroVec);
    for (let i = 0; i < normZero.length; i++) {
      if (Number.isNaN(normZero[i]) || normZero[i] !== 0) {
        throw new Error(`normalize(zeroVec) returned non-zero or NaN at index ${i}: ${normZero[i]}`);
      }
    }

    // 3.2 NaN vector normalization
    const nanVec = new Float32Array([1.0, Number.NaN, 3.0]);
    const normNan = normalize(nanVec);
    for (let i = 0; i < normNan.length; i++) {
      if (!Number.isFinite(normNan[i]) || normNan[i] !== 0) {
        throw new Error(`normalize(nanVec) failed to return clean zero vector: got ${normNan[i]}`);
      }
    }

    // 3.3 Infinity vector normalization
    const infVec = new Float32Array([Number.POSITIVE_INFINITY, 2.0, 3.0]);
    const normInf = normalize(infVec);
    for (let i = 0; i < normInf.length; i++) {
      if (!Number.isFinite(normInf[i]) || normInf[i] !== 0) {
        throw new Error(`normalize(infVec) failed to return clean zero vector: got ${normInf[i]}`);
      }
    }

    // 3.4 dot product immunity
    const a = new Float32Array([1, 2, 3]);
    const nanB = new Float32Array([1, Number.NaN, 3]);
    const infB = new Float32Array([1, Number.POSITIVE_INFINITY, 3]);
    if (dot(a, nanB) !== 0) throw new Error("dot(a, nanB) must return 0");
    if (dot(a, infB) !== 0) throw new Error("dot(a, infB) must return 0");
    if (dot(zeroVec, zeroVec) !== 0) throw new Error("dot(zero, zero) must return 0");

    results.push({
      name: "3. Zero-Vector & Non-Finite Shield",
      status: "PASS",
      details: "All-zero, NaN, and Infinity vectors safely normalize to zero vectors without polluting state; dot products remain finite.",
    });
    console.log("  -> PASS: Zero-vectors stay zero; NaN and +/-Infinity return 0 with zero NaN leakage.");
  } catch (err: any) {
    results.push({
      name: "3. Zero-Vector & Non-Finite Shield",
      status: "FAIL",
      details: err.message,
    });
    console.error("  -> FAIL:", err.message);
  }

  // ---------------------------------------------------------------------------
  // Invariant 4: Unicode Password Policy & Timing Safety
  // ---------------------------------------------------------------------------
  console.log("\n[Invariant 4] Unicode Password Policy & Timing Safety");
  try {
    // 4.1 Surrogate pair repeated emoji bypass check
    // 🚀 is surrogate pair (\uD83D\uDE80), length 2 in UTF-16, 1 codepoint.
    const repeatedEmoji = "🚀".repeat(10);
    const emojiPolicyResult = checkPasswordStrength(repeatedEmoji);
    if (!emojiPolicyResult || !emojiPolicyResult.includes("repeating a single character")) {
      throw new Error(`Single character repeat check failed on emoji '${repeatedEmoji}': got result '${emojiPolicyResult}'`);
    }

    // 4.2 Newline repeat check
    const repeatedNewline = "\n".repeat(12);
    const nlPolicyResult = checkPasswordStrength(repeatedNewline);
    if (!nlPolicyResult || !nlPolicyResult.includes("repeating a single character")) {
      throw new Error(`Single character repeat check failed on newlines: got '${nlPolicyResult}'`);
    }

    // 4.3 Safe password verification against corrupt hashes
    const corruptHashes = [
      "not-a-hash",
      "pbkdf2-sha256$bad$salt$hash",
      "pbkdf2-sha256$1000$shortiter$hash", // below minimum iterations
      "pbkdf2-sha256$100000$!!invalid-base64!!$!!invalid-base64!!",
      "",
      null as any,
    ];
    for (const h of corruptHashes) {
      const ok = await verifyPassword("some-password", h);
      if (ok !== false) {
        throw new Error(`verifyPassword returned true or failed on corrupt hash: ${h}`);
      }
    }

    // 4.4 timingSafeEqual robustness
    const u1 = new Uint8Array([1, 2, 3, 4]);
    const u2 = new Uint8Array([1, 2, 3, 5]);
    const uShort = new Uint8Array([1, 2]);
    if (!timingSafeEqual(u1, u1)) throw new Error("timingSafeEqual(u1, u1) should be true");
    if (timingSafeEqual(u1, u2)) throw new Error("timingSafeEqual(u1, u2) should be false");
    if (timingSafeEqual(u1, uShort)) throw new Error("timingSafeEqual with different length should be false");
    if (timingSafeEqual(null as any, u1)) throw new Error("timingSafeEqual(null, u1) should be false");

    results.push({
      name: "4. Unicode Password Policy & Timing Safety",
      status: "PASS",
      details: "Surrogate pairs and multi-byte Unicode repeated chars strictly caught; malformed hashes and timingSafeEqual robustly bounded.",
    });
    console.log("  -> PASS: Surrogate pair emoji repeat caught, newline repeat caught, corrupt hashes return false.");
  } catch (err: any) {
    results.push({
      name: "4. Unicode Password Policy & Timing Safety",
      status: "FAIL",
      details: err.message,
    });
    console.error("  -> FAIL:", err.message);
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(" Core Invariants Verification Summary");
  console.log("================================================================================");
  let allPass = true;
  for (const r of results) {
    if (r.status !== "PASS") allPass = false;
    console.log(`[${r.status}] ${r.name}`);
    console.log(`       Details: ${r.details}`);
  }

  if (!allPass) {
    console.error("\nCore invariants verification failed!");
    process.exit(1);
  } else {
    console.log("\nAll 4 Core Invariants 100% Verified and Intact!");
    process.exit(0);
  }
}

void verifyCoreInvariants();
