import { MassiveTestHarness } from "./massive-harness";
import { createNormalTests } from "./tests/computer/normal";
import { createBoundaryTests } from "./tests/computer/boundary";
import { createFailureTests } from "./tests/computer/failure";
import { createConcurrencyTests } from "./tests/computer/concurrency";
import { createRecoveryTests } from "./tests/computer/recovery";
import { setContainerDriver } from "../services/computer-manager/container";
import { FastMockContainerDriver } from "./tests/computer/mock-helper";

async function main() {
  console.log("================================================================================");
  console.log(" Talorys Computer Manager State & Security Massive Verification Suite (250 Tests)");
  console.log(" Target: state.ts, automation.ts, server.ts");
  console.log("================================================================================");

  // Set FastMockContainerDriver to enable deterministic, high-speed, isolated execution without docker socket conflicts
  setContainerDriver(new FastMockContainerDriver());

  const harness = new MassiveTestHarness("computer");

  const normalTests = createNormalTests();
  const boundaryTests = createBoundaryTests();
  const failureTests = createFailureTests();
  const concurrencyTests = createConcurrencyTests();
  const recoveryTests = createRecoveryTests();

  console.log(`[Suite Setup] Normal:      ${normalTests.length} tests`);
  console.log(`[Suite Setup] Boundary:    ${boundaryTests.length} tests`);
  console.log(`[Suite Setup] Failure:     ${failureTests.length} tests`);
  console.log(`[Suite Setup] Concurrency: ${concurrencyTests.length} tests`);
  console.log(`[Suite Setup] Recovery:    ${recoveryTests.length} tests`);
  console.log(`[Suite Setup] Total:       ${normalTests.length + boundaryTests.length + failureTests.length + concurrencyTests.length + recoveryTests.length} tests`);

  harness.addAll(normalTests);
  harness.addAll(boundaryTests);
  harness.addAll(failureTests);
  harness.addAll(concurrencyTests);
  harness.addAll(recoveryTests);

  const report = await harness.run({
    outputJsonPath: "test-results/computer-results.json",
    verbose: true,
  });

  console.log("\n================================================================================");
  console.log(` Final Execution Summary: Total ${report.total} | Passed ${report.passed} | Failed ${report.failed} | Errored ${report.errored}`);
  console.log("================================================================================");

  if (report.failed > 0 || report.errored > 0) {
    console.error(`\n[FAIL] Found ${report.failed + report.errored} issues. Defect review required.`);
    process.exit(1);
  } else {
    console.log("\n[PASS] All 250 tests passed successfully with zero defects!");
    process.exit(0);
  }
}

void main();
