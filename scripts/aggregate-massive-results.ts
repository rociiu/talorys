import * as fs from "node:fs";
import * as path from "node:path";

interface SubReport {
  timestamp: string;
  domain: string;
  total: number;
  passed: number;
  failed: number;
  errored: number;
  durationMs: number;
  categoryBreakdown: Record<string, { total: number; passed: number; failed: number; errored: number }>;
  results: Array<{
    id: string;
    domain: string;
    category: string;
    description: string;
    status: "PASS" | "FAIL" | "ERROR";
    durationMs: number;
    error?: { message: string; stack?: string };
  }>;
  defects: Array<{
    id: string;
    category: string;
    description: string;
    errorMessage: string;
    stack?: string;
  }>;
}

const DOMAINS = [
  { file: "recurrence-results.json", domain: "recurrence-engine" },
  { file: "security-results.json", domain: "security-schemas" },
  { file: "vector-results.json", domain: "vector-math" },
  { file: "backup-results.json", domain: "backup-serialization" },
  { file: "time-results.json", domain: "time-scheduling" },
  { file: "approval-results.json", domain: "approval-tools" },
  { file: "computer-results.json", domain: "computer-state" },
  { file: "localization-results.json", domain: "localization-api" },
];

export function aggregateResults(baseDir = process.cwd()) {
  console.log(`=== Aggregating Massive Parallel Experiment & Verification Results (${baseDir}) ===`);
  let grandTotal = 0;
  let grandPassed = 0;
  let grandFailed = 0;
  let grandErrored = 0;
  let totalDurationMs = 0;
  const allIds = new Set<string>();
  const duplicateIds: string[] = [];
  const domainSummaries: Record<string, any> = {};
  const allDefects: any[] = [];

  for (const item of DOMAINS) {
    const filePath = path.resolve(baseDir, "test-results", item.file);
    if (!fs.existsSync(filePath)) {
      console.log(`[Pending] ${item.domain} - Result file not found: ${filePath}`);
      continue;
    }

    try {
      const data: SubReport = JSON.parse(fs.readFileSync(filePath, "utf8"));
      grandTotal += data.total;
      grandPassed += data.passed;
      grandFailed += data.failed;
      grandErrored += data.errored;
      totalDurationMs += data.durationMs;

      for (const res of data.results) {
        if (allIds.has(res.id)) {
          duplicateIds.push(res.id);
        }
        allIds.add(res.id);
      }

      for (const def of data.defects) {
        allDefects.push({ ...def, domain: item.domain });
      }

      domainSummaries[item.domain] = {
        total: data.total,
        passed: data.passed,
        failed: data.failed,
        errored: data.errored,
        durationMs: data.durationMs,
        categoryBreakdown: data.categoryBreakdown,
        defectCount: data.defects.length,
      };

      console.log(`[Loaded] ${item.domain.padEnd(22)}: Total=${data.total}, Pass=${data.passed}, Fail=${data.failed}, Err=${data.errored}, Defects=${data.defects.length}`);
    } catch (e: any) {
      console.error(`[Error] Failed to read ${filePath}:`, e.message);
    }
  }

  const passRate = grandTotal > 0 ? ((grandPassed / grandTotal) * 100).toFixed(2) + "%" : "0%";
  const errorRate = grandTotal > 0 ? (((grandFailed + grandErrored) / grandTotal) * 100).toFixed(2) + "%" : "0%";

  const summary = {
    timestamp: new Date().toISOString(),
    grandTotal,
    uniqueTestCount: allIds.size,
    duplicateIdCount: duplicateIds.length,
    grandPassed,
    grandFailed,
    grandErrored,
    passRate,
    errorRate,
    totalDurationMs: Math.round(totalDurationMs * 100) / 100,
    domainSummaries,
    totalDefects: allDefects.length,
    allDefects,
  };

  const outputPath = path.resolve(baseDir, "test-results/massive-experiment-summary.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), "utf8");

  console.log("--------------------------------------------------");
  console.log(`Grand Total Tests: ${grandTotal} (Unique: ${allIds.size}, Duplicates: ${duplicateIds.length})`);
  console.log(`Passed: ${grandPassed} | Failed: ${grandFailed} | Errored: ${grandErrored}`);
  console.log(`Pass Rate: ${passRate} | Error Rate: ${errorRate}`);
  console.log(`Total Execution Time: ${summary.totalDurationMs}ms`);
  console.log(`Summary written to: ${outputPath}`);

  return summary;
}

if (process.argv[1]?.endsWith("aggregate-massive-results.ts")) {
  aggregateResults();
}
