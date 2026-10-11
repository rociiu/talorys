import os

output_path = "/home/wasuphj/talorys-wt8-localization/scripts/run-localization-suite.ts"

header = '''import assert from "node:assert/strict";
import * as path from "node:path";
import { z } from "zod";
import {
  BASE_SYSTEM_PROMPT,
  SAFETY_RULES,
  AUTO_MEMORY_RULE,
  EXPLICIT_MEMORY_RULE,
  SCHEDULED_RUN_PROMPT,
  buildSystemPrompt,
  type PromptContext,
} from "../apps/agent/src/agent/prompt.ts";
import {
  savedAt,
  applyM1,
  newerWinsNote,
  rrf,
  newerDuplicateCosine,
  NEWER_WINS_NOTE,
  RRF_K,
} from "../apps/agent/src/semantic/recall.ts";
import {
  AppError,
  NotFoundError,
  ValidationError,
  errorResponse,
} from "../apps/agent/src/api/errors.ts";
import {
  securityHeaders,
  csrfProtection,
  readSessionToken,
  sessionCookie,
  sessionCookieName,
} from "../apps/agent/src/api/middleware.ts";
import {
  toLocalMinute,
  localDayBounds,
  formatLocal,
  parseLocalDateTime,
} from "../apps/agent/src/services/time.ts";
import { MassiveTestHarness, type TestCase } from "./massive-harness.ts";
import type { ChatStreamEvent, Memory, ApiErrorCode } from "@talorys/shared";

// ==========================================
// SSE Stream Parser Helper (Frontend Spec)
// ==========================================

export async function parseSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent?: (event: ChatStreamEvent) => void
): Promise<ChatStreamEvent[]> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const events: ChatStreamEvent[] = [];

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary: number;
    while ((boundary = buffer.indexOf("\\n\\n")) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = raw
        .split("\\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\\n");
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as ChatStreamEvent;
        events.push(parsed);
        if (onEvent) onEvent(parsed);
      } catch {
        // ignore malformed frame
      }
    }
  }
  return events;
}

export function createMockStreamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
      } else {
        controller.close();
      }
    },
  });
}

// ==========================================
// Mock Hono Context for Middleware Testing
// ==========================================

function createMockContext(opts: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  env?: Record<string, any>;
}) {
  const reqHeaders = new Headers(opts.headers || {});
  const resHeaders = new Headers();
  const store = new Map<string, any>();

  const req = {
    url: opts.url,
    method: opts.method || "GET",
    header: (name: string) => reqHeaders.get(name.toLowerCase()) || undefined,
    raw: new Request(opts.url, { method: opts.method || "GET", headers: reqHeaders }),
  };

  const res = {
    headers: resHeaders,
    status: 200,
  };

  const c: any = {
    req,
    res,
    env: {
      env: opts.env || { TALORYS_ENV: "production" },
      agent: {
        services: {
          auth: {
            validate: async (t: string) => (t === "valid-session-123" ? "user-session-1" : null),
          },
        },
      },
    },
    set: (key: string, value: any) => store.set(key, value),
    get: (key: string) => store.get(key),
  };
  return c;
}

// ==========================================
// Initialize Test Harness
// ==========================================

const harness = new MassiveTestHarness("localization-and-api-invariants");

function addTest(test: TestCase) {
  harness.add(test);
}
'''

footer = '''
// ==========================================
// Main Execution Entrypoint
// ==========================================

async function main() {
  const outputPath = path.resolve("test-results/localization-results.json");
  console.log(`[LocalizationSuite] Harness registered ${harness.count} tests.`);
  const report = await harness.run({ outputJsonPath: outputPath, verbose: false });

  console.log(`\\n[LocalizationSuite] Execution Summary:`);
  console.log(`  Total:   ${report.total}`);
  console.log(`  Passed:  ${report.passed}`);
  console.log(`  Failed:  ${report.failed}`);
  console.log(`  Errored: ${report.errored}`);

  if (report.failed > 0 || report.errored > 0) {
    console.error(`\\n[LocalizationSuite] FAILURES DETECTED: ${report.failed + report.errored} tests failed/errored.`);
    for (const defect of report.defects) {
      console.error(`  - [${defect.category}] ${defect.id}: ${defect.description} -> ${defect.errorMessage}`);
    }
    process.exit(1);
  } else {
    console.log(`\\n[LocalizationSuite] ALL ${report.total} TESTS PASSED SUCCESSFULLY!`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("[LocalizationSuite] Fatal error during test execution:", err);
  process.exit(1);
});
'''

print("Python generator template ready.")
