import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

interface MutationScenario {
  domain: string;
  targetFile: string;
  description: string;
  testCommand: string;
  mutate: (content: string) => string;
}

const SCENARIOS: MutationScenario[] = [
  {
    domain: "recurrence-engine",
    targetFile: "packages/shared/src/recurrence.ts",
    description: "Re-introduce defect: Remove integer check in isValidCalendarDate allowing float dates",
    testCommand: "bun run scripts/run-recurrence-suite.ts",
    mutate: (code) => {
      return code.replace(
        "if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {",
        "if (false && (!Number.isInteger(year))) { /* mutated */"
      );
    },
  },
  {
    domain: "security-schemas",
    targetFile: "packages/shared/src/password-policy.ts",
    description: "Re-introduce defect: Remove Unicode/dotAll flag in repeated char regex (bypass single char repeat with emoji)",
    testCommand: "bun run scripts/run-security-suite.ts",
    mutate: (code) => {
      return code.replace(
        "/^(.)\\1+$/su.test(password)",
        "/^(.)\\1+$/.test(password) /* mutated */"
      );
    },
  },
  {
    domain: "vector-math",
    targetFile: "apps/agent/src/semantic/vectorStore.ts",
    description: "Re-introduce defect: Remove non-finite guards in dot() causing NaN/Infinity return",
    testCommand: "bun run scripts/run-vector-suite.ts",
    mutate: (code) => {
      return code.replace(
        "if (!Number.isFinite(ai) || !Number.isFinite(bi)) return 0;",
        "// mutated: removed non-finite check"
      ).replace(
        "return Number.isFinite(sum) ? sum : 0;",
        "return sum; /* mutated */"
      );
    },
  },
  {
    domain: "backup-serialization",
    targetFile: "apps/agent/src/services/backup.ts",
    description: "Re-introduce defect: Disable prototype pollution check on importData",
    testCommand: "bun run scripts/run-backup-suite.ts",
    mutate: (code) => {
      return code.replace(
        "if (hasPrototypePollution(raw)) {",
        "if (false && hasPrototypePollution(raw)) { /* mutated */"
      );
    },
  },
  {
    domain: "time-scheduling",
    targetFile: "apps/agent/src/services/time.ts",
    description: "Re-introduce defect: Remove calendar date validation allowing invalid dates like 2026-02-31",
    testCommand: "bun run scripts/run-time-suite.ts",
    mutate: (code) => {
      return code.replace(
        "if (!isValidCalendarDate(Number(y), Number(mo), Number(d))) return null;",
        "// mutated calendar date check removed"
      );
    },
  },
  {
    domain: "approval-tools",
    targetFile: "apps/agent/src/tools/registry.ts",
    description: "Re-introduce defect: Remove transaction wrapper around commit execution causing dirty rollback failure",
    testCommand: "bun run scripts/run-approval-suite.ts",
    mutate: (code) => {
      return code.replace(
        "ctx.services.db.transaction(() => {",
        "(() => { /* mutated no transaction */"
      );
    },
  },
  {
    domain: "computer-state",
    targetFile: "services/computer-manager/state.ts",
    description: "Re-introduce defect: Remove session running status check in beginAction()",
    testCommand: "bun run scripts/run-computer-suite.ts",
    mutate: (code) => {
      return code.replace(
        'if (this.status !== "running") {\n      throw new Error("Computer session is not running.");\n    }',
        '// mutated: running status check removed'
      );
    },
  },
  {
    domain: "localization-api",
    targetFile: "apps/agent/src/agent/prompt.ts",
    description: "Re-introduce defect: Remove try/catch timezone fallback in buildSystemPrompt()",
    testCommand: "bun run scripts/run-localization-suite.ts",
    mutate: (code) => {
      return code.replace(
        "let format: Intl.DateTimeFormat;\n  let tz = ctx.timezone;\n  try {",
        "let format: Intl.DateTimeFormat = null as any;\n  let tz = ctx.timezone;\n  if (false) { /* mutated */"
      );
    },
  },
];

async function runMutationTesting() {
  console.log("================================================================================");
  console.log(" Talorys 8-Domain Mutation Testing Pipeline");
  console.log(" Purpose: Prove that test suites actively DETECT re-introduced defects (FAIL expected)");
  console.log("================================================================================\n");

  const results: Array<{
    domain: string;
    description: string;
    targetFile: string;
    mutated: boolean;
    failDetected: boolean;
    revertedClean: boolean;
  }> = [];

  for (const s of SCENARIOS) {
    const filePath = path.resolve(s.targetFile);
    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`[Domain] ${s.domain}`);
    console.log(`[Target] ${s.targetFile}`);
    console.log(`[Mutation] ${s.description}`);

    const originalContent = fs.readFileSync(filePath, "utf8");
    const mutatedContent = s.mutate(originalContent);

    if (mutatedContent === originalContent) {
      console.error(`[MUTATION ERROR] Failed to mutate ${s.targetFile} (pattern match failed)`);
      results.push({
        domain: s.domain,
        description: s.description,
        targetFile: s.targetFile,
        mutated: false,
        failDetected: false,
        revertedClean: true,
      });
      continue;
    }

    // 1. Inject defect
    fs.writeFileSync(filePath, mutatedContent, "utf8");
    console.log(`-> Defect successfully injected.`);

    // 2. Run test command (expect exit code != 0 or FAIL detected)
    let failDetected = false;
    try {
      const output = execSync(s.testCommand, { stdio: "pipe", encoding: "utf8" });
      console.log(`[UNEXPECTED PASS] Command succeeded when failure was expected.`);
      failDetected = false;
    } catch (err: any) {
      const output = (err.stdout || "") + "\n" + (err.stderr || "");
      console.log(`[EXPECTED FAIL DETECTED] Test runner caught the injected defect! Exit code: ${err.status}`);
      failDetected = true;
    }

    // 3. Restore original code
    fs.writeFileSync(filePath, originalContent, "utf8");
    execSync(`git checkout -- "${s.targetFile}"`, { stdio: "ignore" });

    // 4. Verify clean restoration
    let revertedClean = false;
    try {
      execSync(s.testCommand, { stdio: "pipe", encoding: "utf8" });
      revertedClean = true;
      console.log(`[RESTORED] Clean state re-verified (PASS).`);
    } catch (err) {
      console.error(`[RESTORE ERROR] Clean run failed after revert!`);
      revertedClean = false;
    }

    results.push({
      domain: s.domain,
      description: s.description,
      targetFile: s.targetFile,
      mutated: true,
      failDetected,
      revertedClean,
    });
  }

  console.log("\n================================================================================");
  console.log(" Mutation Testing Final Report");
  console.log("================================================================================");
  let allPassed = true;
  for (const r of results) {
    const status = r.mutated && r.failDetected && r.revertedClean ? "PASS (DEFECT CAUGHT)" : "FAIL";
    if (status !== "PASS (DEFECT CAUGHT)") allPassed = false;
    console.log(`[${status}] ${r.domain.padEnd(24)}: ${r.description}`);
  }

  const outReportPath = path.resolve("test-results/mutation-test-report.json");
  fs.writeFileSync(outReportPath, JSON.stringify({ timestamp: new Date().toISOString(), allPassed, results }, null, 2));
  console.log(`\nReport saved to: ${outReportPath}`);

  if (!allPassed) {
    console.error("Mutation test validation failed!");
    process.exit(1);
  } else {
    console.log("\nAll 8 domains successfully proved test sensitivity to defect injection!");
    process.exit(0);
  }
}

void runMutationTesting();
