import { MassiveTestHarness } from "./massive-harness";
import { normalTests } from "./tests/approval/normal";
import { boundaryTests } from "./tests/approval/boundary";
import { failureTests } from "./tests/approval/failure";
import { concurrencyTests } from "./tests/approval/concurrency";
import { recoveryTests } from "./tests/approval/recovery";
import * as path from "node:path";

async function main() {
  console.log("==================================================================");
  console.log("  Human-in-the-loop & Approval Tools Verification Suite");
  console.log("==================================================================");

  const harness = new MassiveTestHarness("approval-tools");

  console.log(`[Suite] Loading test suites:`);
  console.log(`  - Normal      : ${normalTests.length} tests`);
  console.log(`  - Boundary    : ${boundaryTests.length} tests`);
  console.log(`  - Failure     : ${failureTests.length} tests`);
  console.log(`  - Concurrency : ${concurrencyTests.length} tests`);
  console.log(`  - Recovery    : ${recoveryTests.length} tests`);

  harness.addAll(normalTests);
  harness.addAll(boundaryTests);
  harness.addAll(failureTests);
  harness.addAll(concurrencyTests);
  harness.addAll(recoveryTests);

  const totalLoaded = harness.count;
  console.log(`[Suite] Total loaded tests: ${totalLoaded} (Target: >=250)`);

  if (totalLoaded < 250) {
    console.error(`[Error] Test count ${totalLoaded} is below the 250 test requirement.`);
    process.exit(1);
  }

  const outputJsonPath = path.resolve(process.cwd(), "test-results/approval-results.json");
  const verbose = process.argv.includes("--verbose");

  const report = await harness.run({
    outputJsonPath,
    verbose,
  });

  console.log("\n==================================================================");
  console.log("  Approval Suite Final Execution Summary");
  console.log("==================================================================");
  console.log(`  Timestamp   : ${report.timestamp}`);
  console.log(`  Domain      : ${report.domain}`);
  console.log(`  Total Tests : ${report.total}`);
  console.log(`  Passed      : ${report.passed}`);
  console.log(`  Failed      : ${report.failed}`);
  console.log(`  Errored     : ${report.errored}`);
  console.log(`  Duration    : ${report.durationMs}ms`);
  console.log(`  Result File : ${outputJsonPath}`);
  console.log("------------------------------------------------------------------");
  for (const [cat, s] of Object.entries(report.categoryBreakdown)) {
    console.log(`  - ${cat.padEnd(12)}: Total=${s.total.toString().padStart(3)}, Pass=${s.passed.toString().padStart(3)}, Fail=${s.failed.toString().padStart(2)}, Err=${s.errored.toString().padStart(2)}`);
  }
  console.log("==================================================================");

  if (report.failed > 0 || report.errored > 0) {
    console.error(`[Suite] Execution failed with ${report.failed} failures and ${report.errored} errors.`);
    process.exit(1);
  }

  console.log("[Suite] All 250+ verification tests passed successfully!");
}

main().catch((err) => {
  console.error("[Fatal] Error executing approval suite:", err);
  process.exit(1);
});
