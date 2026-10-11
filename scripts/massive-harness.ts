import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import * as path from "node:path";

export type TestCategory = "normal" | "boundary" | "failure" | "concurrency" | "recovery";

export interface TestCase {
  id: string;
  domain: string;
  category: TestCategory;
  description: string;
  run: () => Promise<void> | void;
}

export interface TestResult {
  id: string;
  domain: string;
  category: TestCategory;
  description: string;
  status: "PASS" | "FAIL" | "ERROR";
  durationMs: number;
  error?: {
    message: string;
    stack?: string;
  };
}

export interface HarnessReport {
  timestamp: string;
  domain: string;
  total: number;
  passed: number;
  failed: number;
  errored: number;
  durationMs: number;
  categoryBreakdown: Record<TestCategory, { total: number; passed: number; failed: number; errored: number }>;
  results: TestResult[];
  defects: Array<{
    id: string;
    category: TestCategory;
    description: string;
    errorMessage: string;
    stack?: string;
  }>;
}

export class MassiveTestHarness {
  private tests: TestCase[] = [];
  private seenIds = new Set<string>();
  private domain: string;

  constructor(domain: string) {
    this.domain = domain;
  }

  add(test: TestCase): void {
    if (this.seenIds.has(test.id)) {
      throw new Error(`Duplicate test ID detected: ${test.id}`);
    }
    this.seenIds.add(test.id);
    this.tests.push(test);
  }

  addAll(tests: TestCase[]): void {
    for (const t of tests) {
      this.add(t);
    }
  }

  get count(): number {
    return this.tests.length;
  }

  async run(options: { outputJsonPath?: string; verbose?: boolean } = {}): Promise<HarnessReport> {
    const startTime = performance.now();
    const results: TestResult[] = [];
    const defects: HarnessReport["defects"] = [];

    const categoryBreakdown: HarnessReport["categoryBreakdown"] = {
      normal: { total: 0, passed: 0, failed: 0, errored: 0 },
      boundary: { total: 0, passed: 0, failed: 0, errored: 0 },
      failure: { total: 0, passed: 0, failed: 0, errored: 0 },
      concurrency: { total: 0, passed: 0, failed: 0, errored: 0 },
      recovery: { total: 0, passed: 0, failed: 0, errored: 0 },
    };

    console.log(`[Harness] Starting execution of ${this.tests.length} tests for domain '${this.domain}'...`);

    for (const test of this.tests) {
      categoryBreakdown[test.category].total++;
      const t0 = performance.now();
      let status: "PASS" | "FAIL" | "ERROR" = "PASS";
      let errorObj: TestResult["error"] | undefined;

      try {
        await test.run();
        categoryBreakdown[test.category].passed++;
      } catch (err: any) {
        const isAssertionError =
          err.name === "AssertionError" ||
          err.constructor?.name === "AssertionError" ||
          err.message?.includes("expected") ||
          err.message?.includes("assert") ||
          err.message?.includes("Expected");

        status = isAssertionError ? "FAIL" : "ERROR";
        if (status === "FAIL") {
          categoryBreakdown[test.category].failed++;
        } else {
          categoryBreakdown[test.category].errored++;
        }

        errorObj = {
          message: err?.message || String(err),
          stack: err?.stack,
        };

        defects.push({
          id: test.id,
          category: test.category,
          description: test.description,
          errorMessage: errorObj.message,
          stack: errorObj.stack,
        });

        if (options.verbose) {
          console.error(`  [${status}] ${test.id} (${test.category}): ${test.description} -> ${errorObj.message}`);
        }
      }

      const durationMs = Math.round((performance.now() - t0) * 100) / 100;
      results.push({
        id: test.id,
        domain: test.domain,
        category: test.category,
        description: test.description,
        status,
        durationMs,
        error: errorObj,
      });
    }

    const totalDuration = Math.round((performance.now() - startTime) * 100) / 100;
    const passed = results.filter((r) => r.status === "PASS").length;
    const failed = results.filter((r) => r.status === "FAIL").length;
    const errored = results.filter((r) => r.status === "ERROR").length;

    const report: HarnessReport = {
      timestamp: new Date().toISOString(),
      domain: this.domain,
      total: this.tests.length,
      passed,
      failed,
      errored,
      durationMs: totalDuration,
      categoryBreakdown,
      results,
      defects,
    };

    console.log(`[Harness] Execution Complete in ${totalDuration}ms`);
    console.log(`[Harness] Results: Total=${report.total}, Passed=${passed}, Failed=${failed}, Errored=${errored}`);
    for (const [cat, stat] of Object.entries(categoryBreakdown)) {
      console.log(`  - ${cat.padEnd(12)}: Total=${stat.total}, Pass=${stat.passed}, Fail=${stat.failed}, Err=${stat.errored}`);
    }

    if (options.outputJsonPath) {
      const fullPath = path.resolve(options.outputJsonPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, JSON.stringify(report, null, 2), "utf8");
      console.log(`[Harness] Report written to: ${fullPath}`);
    }

    return report;
  }
}
