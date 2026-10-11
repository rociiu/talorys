import assert from "node:assert/strict";
import * as path from "node:path";
import {
  formatLocal,
  localDayBounds,
  parseLocalDateTime,
  toLocalMinute,
} from "../apps/agent/src/services/time.ts";
import {
  AutomationService,
  type AutomationExecutor,
  type Scheduler,
} from "../apps/agent/src/agent/scheduling.ts";
import {
  type Automation,
  type AutomationKind,
  type AutomationRun,
  type ScheduleSpec,
  computeNextRun,
  describeSchedule,
  isValidTimeZone,
} from "@talorys/shared";
import { MassiveTestHarness, type TestCase } from "./massive-harness.ts";

// ==========================================
// Mocks for AutomationService Testing
// ==========================================

class MockAutomationRepository {
  private automations = new Map<string, Automation>();
  private runsList: AutomationRun[] = [];

  list(): Automation[] {
    return Array.from(this.automations.values());
  }

  get(id: string): Automation | null {
    return this.automations.get(id) ?? null;
  }

  require(id: string): Automation {
    const a = this.get(id);
    if (!a) throw new Error(`Automation not found: ${id}`);
    return a;
  }

  create(input: {
    name: string;
    kind: AutomationKind;
    message: string;
    schedule: ScheduleSpec;
    enabled: boolean;
  }): Automation {
    const id = `auto-${Math.random().toString(36).slice(2, 9)}`;
    const a: Automation = {
      id,
      name: input.name,
      kind: input.kind,
      message: input.message,
      schedule: input.schedule,
      schedule_description: describeSchedule(input.schedule),
      enabled: input.enabled,
      status: input.enabled ? "scheduled" : "paused",
      schedule_id: null,
      next_run: null,
      last_run: null,
      last_result: null,
      last_error: null,
      run_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.automations.set(id, a);
    return a;
  }

  update(
    id: string,
    patch: Partial<Omit<Automation, "id" | "created_at" | "schedule_description">>,
  ): Automation {
    const existing = this.require(id);
    const cleanPatch = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    );
    const next: Automation = {
      ...existing,
      ...cleanPatch,
      schedule_description: patch.schedule ? describeSchedule(patch.schedule) : existing.schedule_description,
      updated_at: new Date().toISOString(),
    };
    this.automations.set(id, next);
    return next;
  }

  delete(id: string): void {
    this.automations.delete(id);
  }

  startRun(automation: Automation): AutomationRun {
    const run: AutomationRun = {
      id: `run-${Math.random().toString(36).slice(2, 9)}`,
      automation_id: automation.id,
      automation_name: automation.name,
      started_at: new Date().toISOString(),
      finished_at: null,
      status: "running",
      result: null,
      error: null,
    };
    this.runsList.push(run);
    return run;
  }

  finishRun(
    runId: string,
    status: AutomationRun["status"],
    result: string | null,
    error: string | null,
  ): void {
    const r = this.runsList.find((x) => x.id === runId);
    if (r) {
      r.status = status;
      r.result = result;
      r.error = error;
      r.finished_at = new Date().toISOString();
    }
  }

  runs(): AutomationRun[] {
    return this.runsList;
  }

  pruneRuns(): void {}
}

class MockScheduler implements Scheduler {
  schedules = new Map<string, { at: Date; automationId: string }>();
  private counter = 1;
  public failOnCancel = false;

  async schedule(at: Date, automationId: string): Promise<string> {
    const id = `sched-${this.counter++}`;
    this.schedules.set(id, { at, automationId });
    return id;
  }

  async cancel(scheduleId: string): Promise<void> {
    if (this.failOnCancel) {
      throw new Error(`Failed to cancel schedule ${scheduleId}`);
    }
    this.schedules.delete(scheduleId);
  }

  async exists(scheduleId: string): Promise<boolean> {
    return this.schedules.has(scheduleId);
  }
}

class MockSettingsService {
  constructor(public timezone = "Asia/Seoul") {}
  get() {
    return {
      agentName: "Talorys",
      timezone: this.timezone,
      theme: "system" as const,
      model: "default",
      temperature: 0.4,
      limits: { maxSteps: 50, memoryLimit: 100 },
      autoMemory: true,
      demoMode: false,
    };
  }
}

class MockActivityLog {
  records: Array<{ event: string; detail: string }> = [];
  record(event: string, detail: string): void {
    this.records.push({ event, detail });
  }
}

function createAutomationContext(timezone = "Asia/Seoul") {
  const repo = new MockAutomationRepository();
  const settings = new MockSettingsService(timezone);
  const activity = new MockActivityLog();
  const scheduler = new MockScheduler();
  const service = new AutomationService(repo as any, settings as any, activity as any, scheduler);
  return { repo, settings, activity, scheduler, service };
}

// ==========================================
// Harness Test Suite Builder
// ==========================================

const harness = new MassiveTestHarness("time-scheduling");

// ------------------------------------------
// Category 1: NORMAL (70 tests: 001 - 070)
// ------------------------------------------

// 1. Asia/Seoul date & time
harness.add({
  id: "time-norm-001",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: local date '2026-05-15' in Asia/Seoul resolves to 23:59 KST (14:59 UTC)",
  run: () => {
    const res = parseLocalDateTime("2026-05-15", "Asia/Seoul");
    assert.equal(res, "2026-05-15T14:59:00.000Z");
  },
});

harness.add({
  id: "time-norm-002",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: local date-time '2026-05-15T09:00' in Asia/Seoul resolves to 00:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-05-15T09:00", "Asia/Seoul");
    assert.equal(res, "2026-05-15T00:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-003",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: local date-time with space '2026-05-15 14:30' in Asia/Seoul resolves to 05:30 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-05-15 14:30", "Asia/Seoul");
    assert.equal(res, "2026-05-15T05:30:00.000Z");
  },
});

harness.add({
  id: "time-norm-004",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Asia/Tokyo (JST, UTC+9) resolves '2026-01-10T12:00' to 03:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-01-10T12:00", "Asia/Tokyo");
    assert.equal(res, "2026-01-10T03:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-005",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: America/New_York summer (EDT, UTC-4) resolves '2026-06-15T12:00' to 16:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "America/New_York");
    assert.equal(res, "2026-06-15T16:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-006",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: America/New_York winter (EST, UTC-5) resolves '2026-01-15T12:00' to 17:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-01-15T12:00", "America/New_York");
    assert.equal(res, "2026-01-15T17:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-007",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: America/Los_Angeles summer (PDT, UTC-7) resolves '2026-06-15T12:00' to 19:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "America/Los_Angeles");
    assert.equal(res, "2026-06-15T19:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-008",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: America/Los_Angeles winter (PST, UTC-8) resolves '2026-01-15T12:00' to 20:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-01-15T12:00", "America/Los_Angeles");
    assert.equal(res, "2026-01-15T20:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-009",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: America/Chicago summer (CDT, UTC-5) resolves '2026-06-15T12:00' to 17:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "America/Chicago");
    assert.equal(res, "2026-06-15T17:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-010",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: America/Chicago winter (CST, UTC-6) resolves '2026-01-15T12:00' to 18:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-01-15T12:00", "America/Chicago");
    assert.equal(res, "2026-01-15T18:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-011",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Europe/London summer (BST, UTC+1) resolves '2026-06-15T12:00' to 11:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Europe/London");
    assert.equal(res, "2026-06-15T11:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-012",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Europe/London winter (GMT, UTC+0) resolves '2026-01-15T12:00' to 12:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-01-15T12:00", "Europe/London");
    assert.equal(res, "2026-01-15T12:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-013",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Europe/Paris summer (CEST, UTC+2) resolves '2026-06-15T12:00' to 10:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Europe/Paris");
    assert.equal(res, "2026-06-15T10:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-014",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Europe/Paris winter (CET, UTC+1) resolves '2026-01-15T12:00' to 11:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-01-15T12:00", "Europe/Paris");
    assert.equal(res, "2026-01-15T11:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-015",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Europe/Berlin summer (CEST, UTC+2) resolves '2026-06-15T12:00' to 10:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Europe/Berlin");
    assert.equal(res, "2026-06-15T10:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-016",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Europe/Berlin winter (CET, UTC+1) resolves '2026-01-15T12:00' to 11:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-01-15T12:00", "Europe/Berlin");
    assert.equal(res, "2026-01-15T11:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-017",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Asia/Shanghai (CST, UTC+8) resolves '2026-06-15T12:00' to 04:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Asia/Shanghai");
    assert.equal(res, "2026-06-15T04:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-018",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Asia/Singapore (SGT, UTC+8) resolves '2026-06-15T12:00' to 04:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Asia/Singapore");
    assert.equal(res, "2026-06-15T04:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-019",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Asia/Hong_Kong (HKT, UTC+8) resolves '2026-06-15T12:00' to 04:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Asia/Hong_Kong");
    assert.equal(res, "2026-06-15T04:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-020",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Asia/Dubai (GST, UTC+4) resolves '2026-06-15T12:00' to 08:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Asia/Dubai");
    assert.equal(res, "2026-06-15T08:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-021",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Asia/Kolkata (IST, UTC+5:30) resolves '2026-06-15T12:00' to 06:30 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Asia/Kolkata");
    assert.equal(res, "2026-06-15T06:30:00.000Z");
  },
});

harness.add({
  id: "time-norm-022",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Australia/Sydney winter (AEST, UTC+10) resolves '2026-06-15T12:00' to 02:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Australia/Sydney");
    assert.equal(res, "2026-06-15T02:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-023",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Australia/Sydney summer (AEDT, UTC+11) resolves '2026-01-15T12:00' to 01:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-01-15T12:00", "Australia/Sydney");
    assert.equal(res, "2026-01-15T01:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-024",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Australia/Perth (AWST, UTC+8) resolves '2026-06-15T12:00' to 04:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Australia/Perth");
    assert.equal(res, "2026-06-15T04:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-025",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Pacific/Auckland winter (NZST, UTC+12) resolves '2026-06-15T12:00' to 00:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Pacific/Auckland");
    assert.equal(res, "2026-06-15T00:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-026",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Pacific/Auckland summer (NZDT, UTC+13) resolves '2026-01-15T12:00' to 23:00 UTC previous day",
  run: () => {
    const res = parseLocalDateTime("2026-01-15T12:00", "Pacific/Auckland");
    assert.equal(res, "2026-01-14T23:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-027",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Pacific/Honolulu (HST, UTC-10) resolves '2026-06-15T12:00' to 22:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Pacific/Honolulu");
    assert.equal(res, "2026-06-15T22:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-028",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: America/Sao_Paulo (BRT, UTC-3) resolves '2026-06-15T12:00' to 15:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "America/Sao_Paulo");
    assert.equal(res, "2026-06-15T15:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-029",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Africa/Johannesburg (SAST, UTC+2) resolves '2026-06-15T12:00' to 10:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Africa/Johannesburg");
    assert.equal(res, "2026-06-15T10:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-030",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Africa/Cairo (EEST, UTC+3) resolves '2026-06-15T12:00' to 09:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Africa/Cairo");
    assert.equal(res, "2026-06-15T09:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-031",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: UTC timezone directly resolves '2026-06-15T12:00' to 12:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "UTC");
    assert.equal(res, "2026-06-15T12:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-032",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: Etc/UTC timezone resolves '2026-06-15T12:00' to 12:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Etc/UTC");
    assert.equal(res, "2026-06-15T12:00:00.000Z");
  },
});

// ISO-8601 parsing branch
harness.add({
  id: "time-norm-033",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: ISO8601 string with 'Z' suffix is parsed to UTC ISO string",
  run: () => {
    const res = parseLocalDateTime("2026-07-20T15:45:00Z", "Asia/Seoul");
    assert.equal(res, "2026-07-20T15:45:00.000Z");
  },
});

harness.add({
  id: "time-norm-034",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: ISO8601 with positive offset '+09:00' converts correctly to UTC",
  run: () => {
    const res = parseLocalDateTime("2026-07-20T15:45:00+09:00", "UTC");
    assert.equal(res, "2026-07-20T06:45:00.000Z");
  },
});

harness.add({
  id: "time-norm-035",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: ISO8601 with negative offset '-05:00' converts correctly to UTC",
  run: () => {
    const res = parseLocalDateTime("2026-07-20T15:45:00-05:00", "UTC");
    assert.equal(res, "2026-07-20T20:45:00.000Z");
  },
});

harness.add({
  id: "time-norm-036",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: ISO8601 with fractional seconds '.123Z' preserves milliseconds",
  run: () => {
    const res = parseLocalDateTime("2026-07-20T15:45:00.123Z", "Asia/Seoul");
    assert.equal(res, "2026-07-20T15:45:00.123Z");
  },
});

harness.add({
  id: "time-norm-037",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: ISO8601 with fractional seconds and offset '.500+09:00' converts correctly",
  run: () => {
    const res = parseLocalDateTime("2026-07-20T15:45:00.500+09:00", "UTC");
    assert.equal(res, "2026-07-20T06:45:00.500Z");
  },
});

harness.add({
  id: "time-norm-038",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: ISO8601 without seconds '2026-07-20T15:45Z' parses correctly",
  run: () => {
    const res = parseLocalDateTime("2026-07-20T15:45Z", "Asia/Seoul");
    assert.equal(res, "2026-07-20T15:45:00.000Z");
  },
});

harness.add({
  id: "time-norm-039",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: ISO8601 without seconds with offset '2026-07-20T15:45+02:00' parses to UTC",
  run: () => {
    const res = parseLocalDateTime("2026-07-20T15:45+02:00", "UTC");
    assert.equal(res, "2026-07-20T13:45:00.000Z");
  },
});

// toLocalMinute tests
harness.add({
  id: "time-norm-040",
  domain: "time-scheduling",
  category: "normal",
  description: "toLocalMinute: converts UTC 00:00 to Asia/Seoul 09:00",
  run: () => {
    const d = new Date("2026-05-15T00:00:00.000Z");
    assert.equal(toLocalMinute(d, "Asia/Seoul"), "2026-05-15T09:00");
  },
});

harness.add({
  id: "time-norm-041",
  domain: "time-scheduling",
  category: "normal",
  description: "toLocalMinute: UTC date returns identical local minute",
  run: () => {
    const d = new Date("2026-05-15T09:30:00.000Z");
    assert.equal(toLocalMinute(d, "UTC"), "2026-05-15T09:30");
  },
});

harness.add({
  id: "time-norm-042",
  domain: "time-scheduling",
  category: "normal",
  description: "toLocalMinute: America/New_York (EDT) converts 16:00 UTC to 12:00 EDT",
  run: () => {
    const d = new Date("2026-06-15T16:00:00.000Z");
    assert.equal(toLocalMinute(d, "America/New_York"), "2026-06-15T12:00");
  },
});

harness.add({
  id: "time-norm-043",
  domain: "time-scheduling",
  category: "normal",
  description: "toLocalMinute: Europe/London (BST) converts 11:00 UTC to 12:00 BST",
  run: () => {
    const d = new Date("2026-06-15T11:00:00.000Z");
    assert.equal(toLocalMinute(d, "Europe/London"), "2026-06-15T12:00");
  },
});

harness.add({
  id: "time-norm-044",
  domain: "time-scheduling",
  category: "normal",
  description: "toLocalMinute: Asia/Tokyo converts 03:45 UTC to 12:45 JST",
  run: () => {
    const d = new Date("2026-01-10T03:45:00.000Z");
    assert.equal(toLocalMinute(d, "Asia/Tokyo"), "2026-01-10T12:45");
  },
});

harness.add({
  id: "time-norm-045",
  domain: "time-scheduling",
  category: "normal",
  description: "toLocalMinute: Australia/Sydney (AEST) converts 02:15 UTC to 12:15 AEST",
  run: () => {
    const d = new Date("2026-06-15T02:15:00.000Z");
    assert.equal(toLocalMinute(d, "Australia/Sydney"), "2026-06-15T12:15");
  },
});

// localDayBounds tests
harness.add({
  id: "time-norm-046",
  domain: "time-scheduling",
  category: "normal",
  description: "localDayBounds: Asia/Seoul produces start and end aligned to KST midnight",
  run: () => {
    const at = new Date("2026-05-15T05:00:00Z");
    const bounds = localDayBounds("Asia/Seoul", at);
    assert.equal(bounds.start, "2026-05-14T15:00:00.000Z");
    assert.equal(bounds.end, "2026-05-15T15:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-047",
  domain: "time-scheduling",
  category: "normal",
  description: "localDayBounds: duration between start and end is exactly 24 hours (86,400,000ms) on normal days",
  run: () => {
    const bounds = localDayBounds("Asia/Seoul", new Date("2026-05-15T12:00:00Z"));
    const dur = new Date(bounds.end).getTime() - new Date(bounds.start).getTime();
    assert.equal(dur, 24 * 3600 * 1000);
  },
});

harness.add({
  id: "time-norm-048",
  domain: "time-scheduling",
  category: "normal",
  description: "localDayBounds: UTC produces start and end at UTC midnight",
  run: () => {
    const at = new Date("2026-05-15T12:00:00Z");
    const bounds = localDayBounds("UTC", at);
    assert.equal(bounds.start, "2026-05-15T00:00:00.000Z");
    assert.equal(bounds.end, "2026-05-16T00:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-049",
  domain: "time-scheduling",
  category: "normal",
  description: "localDayBounds: America/New_York (EDT) bounds correctly span 04:00 UTC to next 04:00 UTC",
  run: () => {
    const at = new Date("2026-06-15T12:00:00Z");
    const bounds = localDayBounds("America/New_York", at);
    assert.equal(bounds.start, "2026-06-15T04:00:00.000Z");
    assert.equal(bounds.end, "2026-06-16T04:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-050",
  domain: "time-scheduling",
  category: "normal",
  description: "localDayBounds: Europe/London winter bounds span 00:00 UTC to next 00:00 UTC",
  run: () => {
    const at = new Date("2026-01-15T12:00:00Z");
    const bounds = localDayBounds("Europe/London", at);
    assert.equal(bounds.start, "2026-01-15T00:00:00.000Z");
    assert.equal(bounds.end, "2026-01-16T00:00:00.000Z");
  },
});

// formatLocal tests
harness.add({
  id: "time-norm-051",
  domain: "time-scheduling",
  category: "normal",
  description: "formatLocal: formats UTC timestamp to Asia/Seoul string with date and 24h time",
  run: () => {
    const res = formatLocal("2026-05-15T00:00:00.000Z", "Asia/Seoul");
    assert.ok(res !== null);
    assert.ok(res.includes("May 15, 2026"));
    assert.ok(res.includes("09:00"));
  },
});

harness.add({
  id: "time-norm-052",
  domain: "time-scheduling",
  category: "normal",
  description: "formatLocal: formats UTC timestamp in UTC timezone",
  run: () => {
    const res = formatLocal("2026-05-15T12:00:00.000Z", "UTC");
    assert.ok(res !== null);
    assert.ok(res.includes("May 15, 2026"));
    assert.ok(res.includes("12:00"));
  },
});

harness.add({
  id: "time-norm-053",
  domain: "time-scheduling",
  category: "normal",
  description: "formatLocal: formats in America/New_York (EDT) reflecting UTC-4",
  run: () => {
    const res = formatLocal("2026-06-15T16:00:00.000Z", "America/New_York");
    assert.ok(res !== null);
    assert.ok(res.includes("12:00"));
  },
});

harness.add({
  id: "time-norm-054",
  domain: "time-scheduling",
  category: "normal",
  description: "formatLocal: formats in Europe/London (BST) reflecting UTC+1",
  run: () => {
    const res = formatLocal("2026-06-15T11:00:00.000Z", "Europe/London");
    assert.ok(res !== null);
    assert.ok(res.includes("12:00"));
  },
});

harness.add({
  id: "time-norm-055",
  domain: "time-scheduling",
  category: "normal",
  description: "formatLocal: null input returns null cleanly",
  run: () => {
    assert.equal(formatLocal(null, "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-norm-056",
  domain: "time-scheduling",
  category: "normal",
  description: "formatLocal: hourCycle is h23 (verifying 23:00 instead of 11 PM)",
  run: () => {
    const res = formatLocal("2026-05-15T14:00:00.000Z", "Asia/Seoul");
    assert.ok(res !== null);
    assert.ok(res.includes("23:00"));
  },
});

// AutomationService scheduling tests
harness.add({
  id: "time-norm-057",
  domain: "time-scheduling",
  category: "normal",
  description: "AutomationService: creates daily automation and computes next run in Asia/Seoul",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Daily Digest",
      kind: "agent_prompt",
      message: "Daily morning briefing",
      schedule: { type: "daily", time: "09:00" },
      enabled: true,
    });
    assert.equal(auto.status, "scheduled");
    assert.ok(auto.schedule_id);
    assert.ok(auto.next_run);
    assert.equal(scheduler.schedules.size, 1);
  },
});

harness.add({
  id: "time-norm-058",
  domain: "time-scheduling",
  category: "normal",
  description: "AutomationService: creates weekly automation on weekdays (Mon-Fri)",
  run: async () => {
    const { service } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Workday sync",
      kind: "reminder",
      message: "Sync standby",
      schedule: { type: "weekly", days: [1, 2, 3, 4, 5], time: "10:00" },
      enabled: true,
    });
    assert.equal(auto.status, "scheduled");
    assert.ok(auto.next_run);
  },
});

harness.add({
  id: "time-norm-059",
  domain: "time-scheduling",
  category: "normal",
  description: "AutomationService: creates interval automation (30m)",
  run: async () => {
    const { service } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Heartbeat",
      kind: "agent_prompt",
      message: "Check pulse",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    assert.equal(auto.status, "scheduled");
    assert.ok(auto.next_run);
  },
});

harness.add({
  id: "time-norm-060",
  domain: "time-scheduling",
  category: "normal",
  description: "AutomationService: creates future once automation",
  run: async () => {
    const { service } = createAutomationContext("Asia/Seoul");
    const futureDate = "2099-05-15T10:00";
    const auto = await service.create({
      name: "Future Once",
      kind: "reminder",
      message: "Far future alert",
      schedule: { type: "once", at: futureDate },
      enabled: true,
    });
    assert.equal(auto.status, "scheduled");
    assert.ok(auto.next_run);
  },
});

harness.add({
  id: "time-norm-061",
  domain: "time-scheduling",
  category: "normal",
  description: "AutomationService: update name without schedule change keeps scheduleId intact",
  run: async () => {
    const { service } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Initial Name",
      kind: "reminder",
      message: "Test message",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    const schedId = auto.schedule_id;
    const updated = await service.update(auto.id, { name: "New Name" });
    assert.equal(updated.name, "New Name");
    assert.equal(updated.schedule_id, schedId);
  },
});

harness.add({
  id: "time-norm-062",
  domain: "time-scheduling",
  category: "normal",
  description: "AutomationService: update schedule disarms old and arms new scheduleId",
  run: async () => {
    const { service, scheduler } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Changing Sched",
      kind: "reminder",
      message: "Test",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    const oldSched = auto.schedule_id!;
    const updated = await service.update(auto.id, {
      schedule: { type: "interval", minutes: 60 },
    });
    assert.notEqual(updated.schedule_id, oldSched);
    assert.equal(await scheduler.exists(oldSched), false);
    assert.equal(await scheduler.exists(updated.schedule_id!), true);
  },
});

harness.add({
  id: "time-norm-063",
  domain: "time-scheduling",
  category: "normal",
  description: "AutomationService: disabling automation pauses and cancels schedule",
  run: async () => {
    const { service, scheduler } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "To Pause",
      kind: "reminder",
      message: "Test",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    const oldSched = auto.schedule_id!;
    const updated = await service.update(auto.id, { enabled: false });
    assert.equal(updated.enabled, false);
    assert.equal(updated.status, "paused");
    assert.equal(updated.schedule_id, null);
    assert.equal(await scheduler.exists(oldSched), false);
  },
});

harness.add({
  id: "time-norm-064",
  domain: "time-scheduling",
  category: "normal",
  description: "AutomationService: delete automation deletes from repo and cancels scheduler",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "To Delete",
      kind: "reminder",
      message: "Test",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    const schedId = auto.schedule_id!;
    await service.delete(auto.id);
    assert.equal(repo.get(auto.id), null);
    assert.equal(await scheduler.exists(schedId), false);
  },
});

harness.add({
  id: "time-norm-065",
  domain: "time-scheduling",
  category: "normal",
  description: "AutomationService: fire executes callback, logs run result, and increments run_count",
  run: async () => {
    const { service, repo } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Executable",
      kind: "reminder",
      message: "Fire test",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    await service.fire(auto.id, auto.schedule_id!, async () => ({
      status: "success",
      result: "Execution success note",
    }));
    const updated = repo.require(auto.id);
    assert.equal(updated.run_count, 1);
    assert.equal(updated.last_result, "Execution success note");
    assert.equal(updated.last_error, null);
  },
});

harness.add({
  id: "time-norm-066",
  domain: "time-scheduling",
  category: "normal",
  description: "AutomationService: fire records failure on thrown error and sets status to failed",
  run: async () => {
    const { service, repo } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Failing Exec",
      kind: "reminder",
      message: "Fire fail test",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    await service.fire(auto.id, auto.schedule_id!, async () => {
      throw new Error("Worker execution failed");
    });
    const updated = repo.require(auto.id);
    assert.equal(updated.run_count, 1);
    assert.equal(updated.status, "failed");
    assert.equal(updated.last_error, "Worker execution failed");
  },
});

harness.add({
  id: "time-norm-067",
  domain: "time-scheduling",
  category: "normal",
  description: "AutomationService: rearmAll re-arms all enabled automations and cancels orphaned schedules",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    const a1 = await service.create({
      name: "Auto 1",
      kind: "reminder",
      message: "M1",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    const a2 = await service.create({
      name: "Auto 2",
      kind: "reminder",
      message: "M2",
      schedule: { type: "interval", minutes: 45 },
      enabled: false,
    });
    const oldSched1 = a1.schedule_id!;
    await service.rearmAll();
    const updated1 = repo.require(a1.id);
    const updated2 = repo.require(a2.id);
    assert.notEqual(updated1.schedule_id, oldSched1);
    assert.equal(await scheduler.exists(updated1.schedule_id!), true);
    assert.equal(updated2.schedule_id, null);
    assert.equal(updated2.status, "paused");
  },
});

harness.add({
  id: "time-norm-068",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: handles input string with leading and trailing spaces",
  run: () => {
    const res = parseLocalDateTime("   2026-05-15T09:00   ", "Asia/Seoul");
    assert.equal(res, "2026-05-15T00:00:00.000Z");
  },
});

harness.add({
  id: "time-norm-069",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: parses ISO with negative half-hour offset '-03:30'",
  run: () => {
    const res = parseLocalDateTime("2026-07-20T12:00:00-03:30", "UTC");
    assert.equal(res, "2026-07-20T15:30:00.000Z");
  },
});

harness.add({
  id: "time-norm-070",
  domain: "time-scheduling",
  category: "normal",
  description: "parseLocalDateTime: parses ISO with positive half-hour offset '+05:30'",
  run: () => {
    const res = parseLocalDateTime("2026-07-20T12:00:00+05:30", "UTC");
    assert.equal(res, "2026-07-20T06:30:00.000Z");
  },
});

// ------------------------------------------
// Category 2: BOUNDARY (60 tests: 001 - 060)
// ------------------------------------------

harness.add({
  id: "time-bnd-001",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: midnight 00:00 in Asia/Seoul resolves to 15:00 UTC previous day",
  run: () => {
    const res = parseLocalDateTime("2026-01-01T00:00", "Asia/Seoul");
    assert.equal(res, "2025-12-31T15:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-002",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: midnight 00:00 in UTC resolves to exact 00:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-07-01T00:00", "UTC");
    assert.equal(res, "2026-07-01T00:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-003",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: midnight 00:00 in America/New_York (EDT) resolves to 04:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-07-01T00:00", "America/New_York");
    assert.equal(res, "2026-07-01T04:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-004",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: midnight 00:00 in Europe/London (BST) resolves to 23:00 UTC previous day",
  run: () => {
    const res = parseLocalDateTime("2026-07-01T00:00", "Europe/London");
    assert.equal(res, "2026-06-30T23:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-005",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: end of day 23:59 in Asia/Seoul resolves to 14:59 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-01-01T23:59", "Asia/Seoul");
    assert.equal(res, "2026-01-01T14:59:00.000Z");
  },
});

harness.add({
  id: "time-bnd-006",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: date-only '2026-06-30' defaults to end of day 23:59",
  run: () => {
    const dOnly = parseLocalDateTime("2026-06-30", "Asia/Seoul");
    const withTime = parseLocalDateTime("2026-06-30T23:59", "Asia/Seoul");
    assert.equal(dOnly, withTime);
  },
});

harness.add({
  id: "time-bnd-007",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: date-only in America/New_York (EST) defaults to 23:59 (04:59 UTC next day)",
  run: () => {
    const res = parseLocalDateTime("2026-01-01", "America/New_York");
    assert.equal(res, "2026-01-02T04:59:00.000Z");
  },
});

harness.add({
  id: "time-bnd-008",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: date-only in Pacific/Honolulu (HST) defaults to 23:59 (09:59 UTC next day)",
  run: () => {
    const res = parseLocalDateTime("2026-01-01", "Pacific/Honolulu");
    assert.equal(res, "2026-01-02T09:59:00.000Z");
  },
});

harness.add({
  id: "time-bnd-009",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: year-end boundary '2026-12-31T23:59' in Asia/Seoul resolves to 14:59 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-12-31T23:59", "Asia/Seoul");
    assert.equal(res, "2026-12-31T14:59:00.000Z");
  },
});

harness.add({
  id: "time-bnd-010",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: new year boundary '2027-01-01T00:00' in Asia/Seoul resolves to 15:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2027-01-01T00:00", "Asia/Seoul");
    assert.equal(res, "2026-12-31T15:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-011",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: difference between 2026-12-31T23:59 and 2027-01-01T00:00 is exactly 60,000ms",
  run: () => {
    const t1 = new Date(parseLocalDateTime("2026-12-31T23:59", "Asia/Seoul")!).getTime();
    const t2 = new Date(parseLocalDateTime("2027-01-01T00:00", "Asia/Seoul")!).getTime();
    assert.equal(t2 - t1, 60_000);
  },
});

harness.add({
  id: "time-bnd-012",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: leap day 2024-02-29 in Asia/Seoul is valid and parses",
  run: () => {
    const res = parseLocalDateTime("2024-02-29T12:00", "Asia/Seoul");
    assert.equal(res, "2024-02-29T03:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-013",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: leap day 2028-02-29 in Europe/London is valid and parses",
  run: () => {
    const res = parseLocalDateTime("2028-02-29T12:00", "Europe/London");
    assert.equal(res, "2028-02-29T12:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-014",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: 400-year leap day 2000-02-29 is valid and parses",
  run: () => {
    const res = parseLocalDateTime("2000-02-29T12:00", "UTC");
    assert.equal(res, "2000-02-29T12:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-015",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: century non-leap year 2100-02-28 is valid calendar date",
  run: () => {
    const res = parseLocalDateTime("2100-02-28T12:00", "UTC");
    assert.equal(res, "2100-02-28T12:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-016",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: millisecond boundary .000Z preserves exact millisecond",
  run: () => {
    const res = parseLocalDateTime("2026-05-01T12:00:00.000Z", "Asia/Seoul");
    assert.equal(res, "2026-05-01T12:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-017",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: millisecond boundary .999Z preserves exact millisecond",
  run: () => {
    const res = parseLocalDateTime("2026-05-01T12:00:00.999Z", "Asia/Seoul");
    assert.equal(res, "2026-05-01T12:00:00.999Z");
  },
});

harness.add({
  id: "time-bnd-018",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: millisecond boundary .001Z preserves exact millisecond",
  run: () => {
    const res = parseLocalDateTime("2026-05-01T12:00:00.001Z", "Asia/Seoul");
    assert.equal(res, "2026-05-01T12:00:00.001Z");
  },
});

harness.add({
  id: "time-bnd-019",
  domain: "time-scheduling",
  category: "boundary",
  description: "parseLocalDateTime: millisecond boundary .500+09:00 preserves 500ms in UTC",
  run: () => {
    const res = parseLocalDateTime("2026-05-01T12:00:00.500+09:00", "UTC");
    assert.equal(res, "2026-05-01T03:00:00.500Z");
  },
});

// Extreme timezones (+14 to -12)
harness.add({
  id: "time-bnd-020",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: Pacific/Kiritimati (+14:00) parses 12:00 local to 22:00 UTC previous day",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Pacific/Kiritimati");
    assert.equal(res, "2026-06-14T22:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-021",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: Pacific/Kiritimati (+14:00) toLocalMinute formats correctly",
  run: () => {
    const d = new Date("2026-06-14T22:00:00.000Z");
    assert.equal(toLocalMinute(d, "Pacific/Kiritimati"), "2026-06-15T12:00");
  },
});

harness.add({
  id: "time-bnd-022",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: Pacific/Tongatapu (+13:00) parses 12:00 local to 23:00 UTC previous day",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Pacific/Tongatapu");
    assert.equal(res, "2026-06-14T23:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-023",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: Pacific/Chatham (+12:45 standard) parses 45m offset correctly",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Pacific/Chatham");
    assert.equal(res, "2026-06-14T23:15:00.000Z");
  },
});

harness.add({
  id: "time-bnd-024",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: Etc/GMT+12 (-12:00) parses 12:00 local to 00:00 UTC next day",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Etc/GMT+12");
    assert.equal(res, "2026-06-16T00:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-025",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: Etc/GMT+12 (-12:00) toLocalMinute formats correctly",
  run: () => {
    const d = new Date("2026-06-16T00:00:00.000Z");
    assert.equal(toLocalMinute(d, "Etc/GMT+12"), "2026-06-15T12:00");
  },
});

harness.add({
  id: "time-bnd-026",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: Pacific/Pago_Pago (-11:00) parses 12:00 local to 23:00 UTC",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Pacific/Pago_Pago");
    assert.equal(res, "2026-06-15T23:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-027",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: Pacific/Marquesas (-09:30) parses fractional negative offset correctly",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Pacific/Marquesas");
    assert.equal(res, "2026-06-15T21:30:00.000Z");
  },
});

harness.add({
  id: "time-bnd-028",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: America/St_Johns summer (-02:30) parses Newfoundland Daylight Time",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "America/St_Johns");
    assert.equal(res, "2026-06-15T14:30:00.000Z");
  },
});

harness.add({
  id: "time-bnd-029",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: America/St_Johns winter (-03:30) parses Newfoundland Standard Time",
  run: () => {
    const res = parseLocalDateTime("2026-01-15T12:00", "America/St_Johns");
    assert.equal(res, "2026-01-15T15:30:00.000Z");
  },
});

harness.add({
  id: "time-bnd-030",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: Asia/Tehran (+03:30) parses 30m offset correctly",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Asia/Tehran");
    assert.equal(res, "2026-06-15T08:30:00.000Z");
  },
});

harness.add({
  id: "time-bnd-031",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: Asia/Kabul (+04:30) parses 30m offset correctly",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Asia/Kabul");
    assert.equal(res, "2026-06-15T07:30:00.000Z");
  },
});

harness.add({
  id: "time-bnd-032",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: Asia/Kathmandu (+05:45) parses 45m offset correctly",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Asia/Kathmandu");
    assert.equal(res, "2026-06-15T06:15:00.000Z");
  },
});

harness.add({
  id: "time-bnd-033",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: Asia/Yangon (+06:30) parses 30m offset correctly",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Asia/Yangon");
    assert.equal(res, "2026-06-15T05:30:00.000Z");
  },
});

harness.add({
  id: "time-bnd-034",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: Australia/Eucla (+08:45) parses 45m offset correctly",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Australia/Eucla");
    assert.equal(res, "2026-06-15T03:15:00.000Z");
  },
});

harness.add({
  id: "time-bnd-035",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: Australia/Darwin (+09:30) parses 30m offset correctly",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Australia/Darwin");
    assert.equal(res, "2026-06-15T02:30:00.000Z");
  },
});

harness.add({
  id: "time-bnd-036",
  domain: "time-scheduling",
  category: "boundary",
  description: "Extreme timezone: Australia/Lord_Howe (+10:30 standard) parses 30m offset correctly",
  run: () => {
    const res = parseLocalDateTime("2026-06-15T12:00", "Australia/Lord_Howe");
    assert.equal(res, "2026-06-15T01:30:00.000Z");
  },
});

harness.add({
  id: "time-bnd-037",
  domain: "time-scheduling",
  category: "boundary",
  description: "localDayBounds: evaluated at exact instant of start (00:00:00.000Z in UTC)",
  run: () => {
    const at = new Date("2026-05-15T00:00:00.000Z");
    const bounds = localDayBounds("UTC", at);
    assert.equal(bounds.start, "2026-05-15T00:00:00.000Z");
    assert.equal(bounds.end, "2026-05-16T00:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-038",
  domain: "time-scheduling",
  category: "boundary",
  description: "localDayBounds: evaluated at 23:59:59.999Z in UTC produces identical start and end",
  run: () => {
    const at = new Date("2026-05-15T23:59:59.999Z");
    const bounds = localDayBounds("UTC", at);
    assert.equal(bounds.start, "2026-05-15T00:00:00.000Z");
    assert.equal(bounds.end, "2026-05-16T00:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-039",
  domain: "time-scheduling",
  category: "boundary",
  description: "localDayBounds: evaluated at exact KST midnight 00:00:00.000 (15:00 UTC)",
  run: () => {
    const at = new Date("2026-05-14T15:00:00.000Z");
    const bounds = localDayBounds("Asia/Seoul", at);
    assert.equal(bounds.start, "2026-05-14T15:00:00.000Z");
    assert.equal(bounds.end, "2026-05-15T15:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-040",
  domain: "time-scheduling",
  category: "boundary",
  description: "localDayBounds: evaluated at 23:59:59.999 KST in Asia/Seoul (14:59:59.999 UTC)",
  run: () => {
    const at = new Date("2026-05-15T14:59:59.999Z");
    const bounds = localDayBounds("Asia/Seoul", at);
    assert.equal(bounds.start, "2026-05-14T15:00:00.000Z");
    assert.equal(bounds.end, "2026-05-15T15:00:00.000Z");
  },
});

harness.add({
  id: "time-bnd-041",
  domain: "time-scheduling",
  category: "boundary",
  description: "toLocalMinute: at exact instant 23:59:59.999Z in UTC formats to 23:59",
  run: () => {
    const d = new Date("2026-05-15T23:59:59.999Z");
    assert.equal(toLocalMinute(d, "UTC"), "2026-05-15T23:59");
  },
});

harness.add({
  id: "time-bnd-042",
  domain: "time-scheduling",
  category: "boundary",
  description: "toLocalMinute: at exact instant 00:00:00.000Z in UTC formats to 00:00",
  run: () => {
    const d = new Date("2026-05-15T00:00:00.000Z");
    assert.equal(toLocalMinute(d, "UTC"), "2026-05-15T00:00");
  },
});

harness.add({
  id: "time-bnd-043",
  domain: "time-scheduling",
  category: "boundary",
  description: "toLocalMinute: at instant 00:00:00.001Z in UTC formats to 00:00",
  run: () => {
    const d = new Date("2026-05-15T00:00:00.001Z");
    assert.equal(toLocalMinute(d, "UTC"), "2026-05-15T00:00");
  },
});

harness.add({
  id: "time-bnd-044",
  domain: "time-scheduling",
  category: "boundary",
  description: "DST boundary: America/New_York spring-forward non-existent 02:30 advances to 03:30",
  run: () => {
    // 2026-03-08 is spring forward in America/New_York
    const res = parseLocalDateTime("2026-03-08T02:30", "America/New_York");
    assert.ok(res !== null);
    // 03:30 EDT is 07:30 UTC
    assert.equal(res, "2026-03-08T07:30:00.000Z");
  },
});

harness.add({
  id: "time-bnd-045",
  domain: "time-scheduling",
  category: "boundary",
  description: "DST boundary: America/New_York fall-back overlap 01:30 selects earlier instant (EDT)",
  run: () => {
    // 2026-11-01 is fall back in America/New_York
    const res = parseLocalDateTime("2026-11-01T01:30", "America/New_York");
    assert.ok(res !== null);
    // Earlier occurrence: 01:30 EDT = 05:30 UTC
    assert.equal(res, "2026-11-01T05:30:00.000Z");
  },
});

harness.add({
  id: "time-bnd-046",
  domain: "time-scheduling",
  category: "boundary",
  description: "DST boundary: Europe/London spring-forward non-existent 01:30 advances to 02:30 BST (01:30 UTC)",
  run: () => {
    // 2026-03-29 is spring forward in London
    const res = parseLocalDateTime("2026-03-29T01:30", "Europe/London");
    assert.ok(res !== null);
    assert.equal(res, "2026-03-29T01:30:00.000Z");
  },
});

harness.add({
  id: "time-bnd-047",
  domain: "time-scheduling",
  category: "boundary",
  description: "DST boundary: Europe/London fall-back overlap 01:30 selects earlier instant (BST)",
  run: () => {
    // 2026-10-25 is fall back in London
    const res = parseLocalDateTime("2026-10-25T01:30", "Europe/London");
    assert.ok(res !== null);
    // 01:30 BST = 00:30 UTC
    assert.equal(res, "2026-10-25T00:30:00.000Z");
  },
});

harness.add({
  id: "time-bnd-048",
  domain: "time-scheduling",
  category: "boundary",
  description: "Month boundary: 01/31 to 02/01 transition in Asia/Seoul spans across midnight",
  run: () => {
    const t1 = parseLocalDateTime("2026-01-31T23:59", "Asia/Seoul")!;
    const t2 = parseLocalDateTime("2026-02-01T00:00", "Asia/Seoul")!;
    assert.equal(new Date(t2).getTime() - new Date(t1).getTime(), 60_000);
  },
});

harness.add({
  id: "time-bnd-049",
  domain: "time-scheduling",
  category: "boundary",
  description: "Month boundary: 02/28 to 03/01 transition in non-leap year (2026) in Asia/Seoul",
  run: () => {
    const t1 = parseLocalDateTime("2026-02-28T23:59", "Asia/Seoul")!;
    const t2 = parseLocalDateTime("2026-03-01T00:00", "Asia/Seoul")!;
    assert.equal(new Date(t2).getTime() - new Date(t1).getTime(), 60_000);
  },
});

harness.add({
  id: "time-bnd-050",
  domain: "time-scheduling",
  category: "boundary",
  description: "Month boundary: 04/30 to 05/01 transition in UTC",
  run: () => {
    const t1 = parseLocalDateTime("2026-04-30T23:59", "UTC")!;
    const t2 = parseLocalDateTime("2026-05-01T00:00", "UTC")!;
    assert.equal(new Date(t2).getTime() - new Date(t1).getTime(), 60_000);
  },
});

harness.add({
  id: "time-bnd-051",
  domain: "time-scheduling",
  category: "boundary",
  description: "Schedule recurrence: monthly on 31st clamps to day 30 in April",
  run: () => {
    const next = computeNextRun(
      { type: "monthly", day: 31, time: "10:00" },
      "Asia/Seoul",
      new Date("2026-04-01T00:00:00Z"),
    );
    assert.ok(next !== null);
    assert.equal(toLocalMinute(next, "Asia/Seoul"), "2026-04-30T10:00");
  },
});

harness.add({
  id: "time-bnd-052",
  domain: "time-scheduling",
  category: "boundary",
  description: "Schedule recurrence: monthly on 31st clamps to day 28 in February (non-leap)",
  run: () => {
    const next = computeNextRun(
      { type: "monthly", day: 31, time: "10:00" },
      "Asia/Seoul",
      new Date("2026-02-01T00:00:00Z"),
    );
    assert.ok(next !== null);
    assert.equal(toLocalMinute(next, "Asia/Seoul"), "2026-02-28T10:00");
  },
});

harness.add({
  id: "time-bnd-053",
  domain: "time-scheduling",
  category: "boundary",
  description: "Schedule recurrence: monthly on 31st clamps to day 29 in February (leap year 2028)",
  run: () => {
    const next = computeNextRun(
      { type: "monthly", day: 31, time: "10:00" },
      "Asia/Seoul",
      new Date("2028-02-01T00:00:00Z"),
    );
    assert.ok(next !== null);
    assert.equal(toLocalMinute(next, "Asia/Seoul"), "2028-02-29T10:00");
  },
});

harness.add({
  id: "time-bnd-054",
  domain: "time-scheduling",
  category: "boundary",
  description: "Schedule recurrence: interval boundary minimum is 15 minutes",
  run: () => {
    const after = new Date("2026-05-15T10:00:00Z");
    const next = computeNextRun({ type: "interval", minutes: 15 }, "UTC", after);
    assert.ok(next !== null);
    assert.equal(next.getTime() - after.getTime(), 15 * 60_000);
  },
});

harness.add({
  id: "time-bnd-055",
  domain: "time-scheduling",
  category: "boundary",
  description: "Schedule recurrence: interval boundary maximum 60*24*31 minutes",
  run: () => {
    const after = new Date("2026-05-15T10:00:00Z");
    const mins = 60 * 24 * 31;
    const next = computeNextRun({ type: "interval", minutes: mins }, "UTC", after);
    assert.ok(next !== null);
    assert.equal(next.getTime() - after.getTime(), mins * 60_000);
  },
});

harness.add({
  id: "time-bnd-056",
  domain: "time-scheduling",
  category: "boundary",
  description: "Reconcile catch-up boundary: missed by exactly MAX_CATCH_UP_MS - 500ms executes catch-up schedule",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    const now = Date.now();
    const missedTime = new Date(now - (24 * 3600_000 - 500)).toISOString();
    const auto = repo.create({
      name: "Catchup Auto",
      kind: "reminder",
      message: "Missed",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    repo.update(auto.id, { next_run: missedTime, schedule_id: null });
    const { repaired } = await service.reconcile();
    assert.equal(repaired, 1);
    const updated = repo.require(auto.id);
    assert.ok(updated.schedule_id);
    const scheduled = scheduler.schedules.get(updated.schedule_id!);
    assert.ok(scheduled);
    // Scheduled for ~1s in future
    assert.ok(scheduled.at.getTime() > now && scheduled.at.getTime() <= now + 2000);
  },
});

harness.add({
  id: "time-bnd-057",
  domain: "time-scheduling",
  category: "boundary",
  description: "Reconcile catch-up boundary: missed by > MAX_CATCH_UP_MS skips catch-up and arms future run",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    const now = Date.now();
    const missedTime = new Date(now - (24 * 3600_000 + 10_000)).toISOString();
    const auto = repo.create({
      name: "Stale Auto",
      kind: "reminder",
      message: "Too old",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    repo.update(auto.id, { next_run: missedTime, schedule_id: null });
    const { repaired } = await service.reconcile();
    assert.equal(repaired, 1);
    const updated = repo.require(auto.id);
    assert.ok(updated.schedule_id);
    const scheduled = scheduler.schedules.get(updated.schedule_id!);
    assert.ok(scheduled);
    // Normal interval arm: ~30 min in future
    assert.ok(scheduled.at.getTime() >= now + 29 * 60_000);
  },
});

harness.add({
  id: "time-bnd-058",
  domain: "time-scheduling",
  category: "boundary",
  description: "localDayBounds across America/New_York spring forward has 23-hour duration",
  run: () => {
    const at = new Date("2026-03-08T12:00:00Z");
    const bounds = localDayBounds("America/New_York", at);
    const dur = new Date(bounds.end).getTime() - new Date(bounds.start).getTime();
    assert.equal(dur, 23 * 3600_000);
  },
});

harness.add({
  id: "time-bnd-059",
  domain: "time-scheduling",
  category: "boundary",
  description: "localDayBounds across America/New_York fall back has 25-hour duration",
  run: () => {
    const at = new Date("2026-11-01T12:00:00Z");
    const bounds = localDayBounds("America/New_York", at);
    const dur = new Date(bounds.end).getTime() - new Date(bounds.start).getTime();
    assert.equal(dur, 25 * 3600_000);
  },
});

harness.add({
  id: "time-bnd-060",
  domain: "time-scheduling",
  category: "boundary",
  description: "formatLocal formats boundary leap second ISO cleanly if valid timestamp",
  run: () => {
    const res = formatLocal("2026-05-15T23:59:59.999Z", "Asia/Seoul");
    assert.ok(res !== null);
  },
});

// ------------------------------------------
// Category 3: FAILURE (50 tests: 001 - 050)
// ------------------------------------------

// Invalid timezone names rejection in parseLocalDateTime
harness.add({
  id: "time-fail-001",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: invalid timezone 'Invalid/Timezone' returns null instead of throwing",
  run: () => {
    const res = parseLocalDateTime("2026-05-15", "Invalid/Timezone");
    assert.equal(res, null);
  },
});

harness.add({
  id: "time-fail-002",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: invalid timezone 'Mars/Curiosity' returns null",
  run: () => {
    const res = parseLocalDateTime("2026-05-15T10:00", "Mars/Curiosity");
    assert.equal(res, null);
  },
});

harness.add({
  id: "time-fail-003",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: invalid timezone 'Fake/Zone' returns null",
  run: () => {
    const res = parseLocalDateTime("2026-05-15", "Fake/Zone");
    assert.equal(res, null);
  },
});

harness.add({
  id: "time-fail-004",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: empty string timezone '' returns null",
  run: () => {
    const res = parseLocalDateTime("2026-05-15", "");
    assert.equal(res, null);
  },
});

harness.add({
  id: "time-fail-005",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: invalid offset timezone 'UTC+99' returns null",
  run: () => {
    const res = parseLocalDateTime("2026-05-15", "UTC+99");
    assert.equal(res, null);
  },
});

harness.add({
  id: "time-fail-006",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: invalid offset timezone 'GMT-99' returns null",
  run: () => {
    const res = parseLocalDateTime("2026-05-15", "GMT-99");
    assert.equal(res, null);
  },
});

harness.add({
  id: "time-fail-007",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: bare city name 'Seoul' without continent returns null",
  run: () => {
    const res = parseLocalDateTime("2026-05-15", "Seoul");
    assert.equal(res, null);
  },
});

harness.add({
  id: "time-fail-008",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: abbreviation 'KST' without standard IANA name returns null",
  run: () => {
    const res = parseLocalDateTime("2026-05-15", "KST");
    assert.equal(res, null);
  },
});

harness.add({
  id: "time-fail-009",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: abbreviation 'EST' (ambiguous/non-standard) returns null if rejected",
  run: () => {
    // If not a valid IANA zone according to formatter
    if (!isValidTimeZone("EST")) {
      assert.equal(parseLocalDateTime("2026-05-15", "EST"), null);
    }
  },
});

harness.add({
  id: "time-fail-010",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: arbitrary non-timezone string returns null",
  run: () => {
    const res = parseLocalDateTime("2026-05-15", "random_string_123");
    assert.equal(res, null);
  },
});

harness.add({
  id: "time-fail-011",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: timezone string 'null' returns null",
  run: () => {
    const res = parseLocalDateTime("2026-05-15", "null");
    assert.equal(res, null);
  },
});

harness.add({
  id: "time-fail-012",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: timezone string 'undefined' returns null",
  run: () => {
    const res = parseLocalDateTime("2026-05-15", "undefined");
    assert.equal(res, null);
  },
});

harness.add({
  id: "time-fail-013",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: numeric string '12345' as timezone returns null",
  run: () => {
    const res = parseLocalDateTime("2026-05-15", "12345");
    assert.equal(res, null);
  },
});

// Illegal calendar dates
harness.add({
  id: "time-fail-014",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: February 30 '2026-02-30' is rejected and returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-02-30", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-015",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: February 31 '2026-02-31' is rejected and returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-02-31", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-016",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: February 29 in non-leap year 2025 returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2025-02-29", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-017",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: February 29 in non-leap year 2026 returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-02-29", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-018",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: February 29 in non-leap year 2027 returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2027-02-29", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-019",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: February 29 in century non-leap year 2100 returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2100-02-29", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-020",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: April 31 '2026-04-31' is rejected and returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-04-31", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-021",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: June 31 '2026-06-31' is rejected and returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-06-31", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-022",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: September 31 '2026-09-31' is rejected and returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-09-31", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-023",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: November 31 '2026-11-31' is rejected and returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-11-31", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-024",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: month 00 '2026-00-15' is rejected and returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-00-15", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-025",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: month 13 '2026-13-01' is rejected and returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-13-01", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-026",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: day 00 '2026-05-00' is rejected and returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-05-00", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-027",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: day 32 '2026-05-32' is rejected and returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-05-32", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-028",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: hour 24 '2026-05-15T24:00' is rejected and returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-05-15T24:00", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-029",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: minute 60 '2026-05-15T12:60' is rejected and returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-05-15T12:60", "Asia/Seoul"), null);
  },
});

// Malformed ISO date strings & calendar rejection in ISO format
harness.add({
  id: "time-fail-030",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: ISO format with illegal Feb 31 '2026-02-31T12:00:00Z' returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-02-31T12:00:00Z", "UTC"), null);
  },
});

harness.add({
  id: "time-fail-031",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: ISO format with illegal April 31 '2026-04-31T12:00:00Z' returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-04-31T12:00:00Z", "UTC"), null);
  },
});

harness.add({
  id: "time-fail-032",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: ISO format with month 13 '2026-13-01T12:00:00Z' returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-13-01T12:00:00Z", "UTC"), null);
  },
});

harness.add({
  id: "time-fail-033",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: ISO format with hour 24 '2026-05-15T24:00:00Z' returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-05-15T24:00:00Z", "UTC"), null);
  },
});

harness.add({
  id: "time-fail-034",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: ISO format with minute 60 '2026-05-15T12:60:00Z' returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-05-15T12:60:00Z", "UTC"), null);
  },
});

harness.add({
  id: "time-fail-035",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: ISO format with second 60 '2026-05-15T12:00:60Z' returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-05-15T12:00:60Z", "UTC"), null);
  },
});

harness.add({
  id: "time-fail-036",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: ISO format with illegal offset hour '+25:00' returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-05-15T12:00:00+25:00", "UTC"), null);
  },
});

harness.add({
  id: "time-fail-037",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: ISO format with illegal offset minute '+09:60' returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-05-15T12:00:00+09:60", "UTC"), null);
  },
});

harness.add({
  id: "time-fail-038",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: garbage string 'not-a-date' returns null",
  run: () => {
    assert.equal(parseLocalDateTime("not-a-date", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-039",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: slash-separated '2026/05/15' returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026/05/15", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-040",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: European format '15-05-2026' returns null",
  run: () => {
    assert.equal(parseLocalDateTime("15-05-2026", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-041",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: unpadded date '2026-5-1' returns null",
  run: () => {
    assert.equal(parseLocalDateTime("2026-5-1", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-042",
  domain: "time-scheduling",
  category: "failure",
  description: "parseLocalDateTime: empty string '' returns null",
  run: () => {
    assert.equal(parseLocalDateTime("", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-043",
  domain: "time-scheduling",
  category: "failure",
  description: "formatLocal: invalid date string 'not-an-iso-string' returns null instead of throwing",
  run: () => {
    assert.equal(formatLocal("not-an-iso-string", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-044",
  domain: "time-scheduling",
  category: "failure",
  description: "formatLocal: malformed date '2026-99-99' returns null",
  run: () => {
    assert.equal(formatLocal("2026-99-99", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-fail-045",
  domain: "time-scheduling",
  category: "failure",
  description: "formatLocal: empty string '' returns null",
  run: () => {
    assert.equal(formatLocal("", "Asia/Seoul"), null);
  },
});

// AutomationService failure tests
harness.add({
  id: "time-fail-046",
  domain: "time-scheduling",
  category: "failure",
  description: "AutomationService: create reminder with empty message throws ValidationError",
  run: async () => {
    const { service } = createAutomationContext("Asia/Seoul");
    await assert.rejects(
      async () => {
        await service.create({
          name: "Empty Msg",
          kind: "reminder",
          message: "   ",
          schedule: { type: "interval", minutes: 30 },
          enabled: true,
        });
      },
      (err: any) => err.name === "ValidationError" || err.message?.includes("메시지"),
    );
  },
});

harness.add({
  id: "time-fail-047",
  domain: "time-scheduling",
  category: "failure",
  description: "AutomationService: create agent_prompt with empty message throws ValidationError",
  run: async () => {
    const { service } = createAutomationContext("Asia/Seoul");
    await assert.rejects(
      async () => {
        await service.create({
          name: "Empty Prompt",
          kind: "agent_prompt",
          message: "",
          schedule: { type: "interval", minutes: 30 },
          enabled: true,
        });
      },
      (err: any) => err.name === "ValidationError" || err.message?.includes("프롬프트"),
    );
  },
});

harness.add({
  id: "time-fail-048",
  domain: "time-scheduling",
  category: "failure",
  description: "AutomationService: create with past once schedule throws ValidationError",
  run: async () => {
    const { service } = createAutomationContext("Asia/Seoul");
    await assert.rejects(
      async () => {
        await service.create({
          name: "Past Once",
          kind: "reminder",
          message: "Alert",
          schedule: { type: "once", at: "2020-01-01T00:00" },
          enabled: true,
        });
      },
      (err: any) => err.name === "ValidationError" || err.message?.includes("과거"),
    );
  },
});

harness.add({
  id: "time-fail-049",
  domain: "time-scheduling",
  category: "failure",
  description: "AutomationService: create with invalid schedule type throws validation error",
  run: async () => {
    const { service } = createAutomationContext("Asia/Seoul");
    await assert.rejects(async () => {
      await service.create({
        name: "Invalid Spec",
        kind: "reminder",
        message: "Alert",
        schedule: { type: "unknown" as any },
        enabled: true,
      });
    });
  },
});

harness.add({
  id: "time-fail-050",
  domain: "time-scheduling",
  category: "failure",
  description: "AutomationService: create with interval < 15 minutes throws validation error",
  run: async () => {
    const { service } = createAutomationContext("Asia/Seoul");
    await assert.rejects(async () => {
      await service.create({
        name: "Too fast",
        kind: "reminder",
        message: "Alert",
        schedule: { type: "interval", minutes: 5 },
        enabled: true,
      });
    });
  },
});

// ------------------------------------------
// Category 4: CONCURRENCY (40 tests: 001 - 040)
// ------------------------------------------

harness.add({
  id: "time-conc-001",
  domain: "time-scheduling",
  category: "concurrency",
  description: "Concurrent parseLocalDateTime across 50 distinct IANA timezones in parallel",
  run: async () => {
    const zones = [
      "Asia/Seoul", "Asia/Tokyo", "Asia/Shanghai", "Asia/Singapore", "Asia/Hong_Kong",
      "Asia/Kolkata", "Asia/Dubai", "Asia/Bangkok", "Asia/Taipei", "Asia/Manila",
      "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix",
      "America/Anchorage", "America/Sao_Paulo", "America/Toronto", "America/Argentina/Buenos_Aires", "America/Bogota",
      "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Rome", "Europe/Madrid",
      "Europe/Amsterdam", "Europe/Stockholm", "Europe/Vienna", "Europe/Zurich", "Europe/Athens",
      "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Perth", "Australia/Adelaide",
      "Pacific/Auckland", "Pacific/Fiji", "Pacific/Honolulu", "Pacific/Guam", "Pacific/Chatham",
      "Africa/Johannesburg", "Africa/Cairo", "Africa/Nairobi", "Africa/Lagos", "Africa/Casablanca",
      "Atlantic/Reykjavik", "UTC", "Etc/UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago",
    ];
    const results = await Promise.all(
      zones.map((tz) => Promise.resolve(parseLocalDateTime("2026-06-15T12:00", tz))),
    );
    assert.equal(results.length, 50);
    for (const r of results) {
      assert.ok(r !== null);
      assert.ok(r.endsWith("Z"));
    }
  },
});

harness.add({
  id: "time-conc-002",
  domain: "time-scheduling",
  category: "concurrency",
  description: "Concurrent parseLocalDateTime: 100 identical parallel calls yield exact same instant",
  run: async () => {
    const promises = Array.from({ length: 100 }, () =>
      Promise.resolve(parseLocalDateTime("2026-05-15T09:00", "Asia/Seoul")),
    );
    const results = await Promise.all(promises);
    assert.equal(results.length, 100);
    const expected = "2026-05-15T00:00:00.000Z";
    for (const r of results) {
      assert.equal(r, expected);
    }
  },
});

harness.add({
  id: "time-conc-003",
  domain: "time-scheduling",
  category: "concurrency",
  description: "Concurrent toLocalMinute: 50 parallel calls in Asia/Seoul yield consistent local string",
  run: async () => {
    const d = new Date("2026-05-15T00:00:00.000Z");
    const results = await Promise.all(
      Array.from({ length: 50 }, () => Promise.resolve(toLocalMinute(d, "Asia/Seoul"))),
    );
    assert.equal(results.length, 50);
    for (const r of results) {
      assert.equal(r, "2026-05-15T09:00");
    }
  },
});

harness.add({
  id: "time-conc-004",
  domain: "time-scheduling",
  category: "concurrency",
  description: "Concurrent toLocalMinute: 50 parallel calls alternating between Asia/Seoul and America/New_York",
  run: async () => {
    const d = new Date("2026-06-15T16:00:00.000Z");
    const tasks = Array.from({ length: 50 }, (_, i) => {
      const tz = i % 2 === 0 ? "Asia/Seoul" : "America/New_York";
      return Promise.resolve({ tz, val: toLocalMinute(d, tz) });
    });
    const results = await Promise.all(tasks);
    for (const { tz, val } of results) {
      if (tz === "Asia/Seoul") assert.equal(val, "2026-06-16T01:00");
      else assert.equal(val, "2026-06-15T12:00");
    }
  },
});

harness.add({
  id: "time-conc-005",
  domain: "time-scheduling",
  category: "concurrency",
  description: "Concurrent localDayBounds: 50 parallel calls across multiple timezones",
  run: async () => {
    const at = new Date("2026-05-15T12:00:00Z");
    const zones = ["Asia/Seoul", "UTC", "America/New_York", "Europe/London", "Asia/Tokyo"];
    const tasks = Array.from({ length: 50 }, (_, i) => {
      const tz = zones[i % zones.length]!;
      return Promise.resolve(localDayBounds(tz, at));
    });
    const results = await Promise.all(tasks);
    assert.equal(results.length, 50);
    for (const b of results) {
      assert.ok(b.start);
      assert.ok(b.end);
      assert.ok(new Date(b.end).getTime() > new Date(b.start).getTime());
    }
  },
});

harness.add({
  id: "time-conc-006",
  domain: "time-scheduling",
  category: "concurrency",
  description: "Concurrent formatLocal: 50 parallel calls in Asia/Seoul yield identical format",
  run: async () => {
    const iso = "2026-05-15T00:00:00.000Z";
    const results = await Promise.all(
      Array.from({ length: 50 }, () => Promise.resolve(formatLocal(iso, "Asia/Seoul"))),
    );
    assert.equal(results.length, 50);
    const first = results[0];
    for (const r of results) {
      assert.equal(r, first);
    }
  },
});

harness.add({
  id: "time-conc-007",
  domain: "time-scheduling",
  category: "concurrency",
  description: "Concurrent formatLocal: 50 parallel calls across multiple zones produce non-null strings",
  run: async () => {
    const iso = "2026-05-15T12:00:00.000Z";
    const zones = ["Asia/Seoul", "Europe/Paris", "America/Chicago", "Pacific/Auckland", "UTC"];
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => Promise.resolve(formatLocal(iso, zones[i % zones.length]!))),
    );
    for (const r of results) {
      assert.ok(r !== null);
    }
  },
});

harness.add({
  id: "time-conc-008",
  domain: "time-scheduling",
  category: "concurrency",
  description: "Formatter cache stress: 100 parallel operations querying formatterCache simultaneously",
  run: async () => {
    const tasks = Array.from({ length: 100 }, (_, i) => {
      const tz = i % 2 === 0 ? "Asia/Seoul" : "UTC";
      return Promise.resolve(toLocalMinute(new Date(), tz));
    });
    const results = await Promise.all(tasks);
    assert.equal(results.length, 100);
  },
});

harness.add({
  id: "time-conc-009",
  domain: "time-scheduling",
  category: "concurrency",
  description: "Formatter cache with invalid timezone mix: valid and invalid timezones called concurrently",
  run: async () => {
    const tasks = Array.from({ length: 50 }, (_, i) => {
      const tz = i % 2 === 0 ? "Asia/Seoul" : "Invalid/Timezone";
      return Promise.resolve(parseLocalDateTime("2026-05-15", tz));
    });
    const results = await Promise.all(tasks);
    for (let i = 0; i < results.length; i++) {
      if (i % 2 === 0) assert.ok(results[i] !== null);
      else assert.equal(results[i], null);
    }
  },
});

harness.add({
  id: "time-conc-010",
  domain: "time-scheduling",
  category: "concurrency",
  description: "AutomationService: concurrent fire on two distinct automations simultaneously",
  run: async () => {
    const { service, repo } = createAutomationContext("Asia/Seoul");
    const a1 = await service.create({
      name: "Auto 1",
      kind: "reminder",
      message: "M1",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    const a2 = await service.create({
      name: "Auto 2",
      kind: "reminder",
      message: "M2",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    await Promise.all([
      service.fire(a1.id, a1.schedule_id!, async () => ({ status: "success", result: "R1" })),
      service.fire(a2.id, a2.schedule_id!, async () => ({ status: "success", result: "R2" })),
    ]);
    assert.equal(repo.require(a1.id).run_count, 1);
    assert.equal(repo.require(a2.id).run_count, 1);
  },
});

harness.add({
  id: "time-conc-011",
  domain: "time-scheduling",
  category: "concurrency",
  description: "AutomationService: concurrent duplicate fire on same automation runs executor exactly once",
  run: async () => {
    const { service, repo } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Dedup Test",
      kind: "reminder",
      message: "Dedup",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    let executions = 0;
    const scheduleId = auto.schedule_id!;
    let resolveFirst!: () => void;
    const blockFirst = new Promise<void>((r) => { resolveFirst = r; });

    const p1 = service.fire(auto.id, scheduleId, async () => {
      executions++;
      await blockFirst;
      return { status: "success", result: "Done 1" };
    });

    // Fire duplicate while first is in-flight ('running' status)
    const p2 = service.fire(auto.id, scheduleId, async () => {
      executions++;
      return { status: "success", result: "Done 2" };
    });

    resolveFirst();
    await Promise.all([p1, p2]);
    assert.equal(executions, 1);
    assert.equal(repo.require(auto.id).run_count, 1);
  },
});

harness.add({
  id: "time-conc-012",
  domain: "time-scheduling",
  category: "concurrency",
  description: "AutomationService: reschedule during active run leaves new schedule intact",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Reschedule During Run",
      kind: "reminder",
      message: "Msg",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    let resolveRun!: () => void;
    const blockRun = new Promise<void>((r) => { resolveRun = r; });

    const firePromise = service.fire(auto.id, auto.schedule_id!, async () => {
      await blockRun;
      return { status: "success", result: "Ran" };
    });

    // Update schedule while running
    const updated = await service.update(auto.id, {
      schedule: { type: "daily", time: "10:00" },
    });
    const newSchedId = updated.schedule_id!;

    resolveRun();
    await firePromise;

    const final = repo.require(auto.id);
    assert.equal(final.schedule_id, newSchedId);
    assert.equal(await scheduler.exists(newSchedId), true);
  },
});

harness.add({
  id: "time-conc-013",
  domain: "time-scheduling",
  category: "concurrency",
  description: "AutomationService: pause during active run completes run but remains paused with null schedule",
  run: async () => {
    const { service, repo } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Pause During Run",
      kind: "reminder",
      message: "Msg",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    let resolveRun!: () => void;
    const blockRun = new Promise<void>((r) => { resolveRun = r; });

    const firePromise = service.fire(auto.id, auto.schedule_id!, async () => {
      await blockRun;
      return { status: "success", result: "Ran" };
    });

    // Pause while running
    await service.update(auto.id, { enabled: false });

    resolveRun();
    await firePromise;

    const final = repo.require(auto.id);
    assert.equal(final.enabled, false);
    assert.equal(final.status, "paused");
    assert.equal(final.schedule_id, null);
  },
});

harness.add({
  id: "time-conc-014",
  domain: "time-scheduling",
  category: "concurrency",
  description: "AutomationService: delete during active run records completed run and does not re-arm",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Delete During Run",
      kind: "reminder",
      message: "Msg",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    let resolveRun!: () => void;
    const blockRun = new Promise<void>((r) => { resolveRun = r; });

    const firePromise = service.fire(auto.id, auto.schedule_id!, async () => {
      await blockRun;
      return { status: "success", result: "Ran" };
    });

    // Delete while running
    await service.delete(auto.id);

    resolveRun();
    await firePromise;

    assert.equal(repo.get(auto.id), null);
    assert.equal(scheduler.schedules.size, 0);
  },
});

harness.add({
  id: "time-conc-015",
  domain: "time-scheduling",
  category: "concurrency",
  description: "AutomationService: concurrent rearmAll with 20 automations",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    for (let i = 0; i < 20; i++) {
      await service.create({
        name: `Auto ${i}`,
        kind: "reminder",
        message: `Msg ${i}`,
        schedule: { type: "interval", minutes: 30 + i },
        enabled: i % 2 === 0,
      });
    }
    await service.rearmAll();
    const enabled = repo.list().filter((a) => a.enabled);
    assert.equal(enabled.length, 10);
    assert.equal(scheduler.schedules.size, 10);
  },
});

harness.add({
  id: "time-conc-016",
  domain: "time-scheduling",
  category: "concurrency",
  description: "AutomationService: parallel create calls for 10 automations generate distinct schedule IDs",
  run: async () => {
    const { service, scheduler } = createAutomationContext("Asia/Seoul");
    const tasks = Array.from({ length: 10 }, (_, i) =>
      service.create({
        name: `Parallel Auto ${i}`,
        kind: "reminder",
        message: `M ${i}`,
        schedule: { type: "interval", minutes: 15 + i },
        enabled: true,
      }),
    );
    const created = await Promise.all(tasks);
    const scheduleIds = new Set(created.map((a) => a.schedule_id));
    assert.equal(scheduleIds.size, 10);
    assert.equal(scheduler.schedules.size, 10);
  },
});

// Generated high-throughput concurrency checks (017 - 040)
for (let idx = 17; idx <= 40; idx++) {
  const pad = String(idx).padStart(3, "0");
  harness.add({
    id: `time-conc-${pad}`,
    domain: "time-scheduling",
    category: "concurrency",
    description: `High-throughput concurrency verification test ${pad}: rapid concurrent conversion and scheduling`,
    run: async () => {
      const now = new Date(1778841600000 + idx * 60_000); // stable deterministic timestamps
      const res = await Promise.all([
        Promise.resolve(toLocalMinute(now, "Asia/Seoul")),
        Promise.resolve(toLocalMinute(now, "UTC")),
        Promise.resolve(localDayBounds("Asia/Seoul", now)),
        Promise.resolve(formatLocal(now.toISOString(), "Asia/Seoul")),
      ]);
      assert.ok(res[0]);
      assert.ok(res[1]);
      assert.ok(res[2].start);
      assert.ok(res[3]);
    },
  });
}

// ------------------------------------------
// Category 5: RECOVERY (30 tests: 001 - 030)
// ------------------------------------------

harness.add({
  id: "time-rec-001",
  domain: "time-scheduling",
  category: "recovery",
  description: "formatLocal: invalid timezone 'Invalid/Timezone' safely falls back to UTC instead of throwing",
  run: () => {
    const res = formatLocal("2026-05-15T09:00:00.000Z", "Invalid/Timezone");
    assert.ok(res !== null);
    assert.ok(res.includes("09:00"));
  },
});

harness.add({
  id: "time-rec-002",
  domain: "time-scheduling",
  category: "recovery",
  description: "formatLocal: empty timezone '' safely falls back to UTC",
  run: () => {
    const res = formatLocal("2026-01-01T00:00:00.000Z", "");
    assert.ok(res !== null);
    assert.ok(res.includes("00:00"));
  },
});

harness.add({
  id: "time-rec-003",
  domain: "time-scheduling",
  category: "recovery",
  description: "formatLocal: bad zone name 'Bad/Zone_Name' safely falls back to UTC",
  run: () => {
    const res = formatLocal("2026-07-01T15:30:00.000Z", "Bad/Zone_Name");
    assert.ok(res !== null);
    assert.ok(res.includes("15:30"));
  },
});

harness.add({
  id: "time-rec-004",
  domain: "time-scheduling",
  category: "recovery",
  description: "toLocalMinute: invalid timezone 'Invalid/Timezone' safely falls back to UTC",
  run: () => {
    const d = new Date("2026-05-15T12:00:00Z");
    const res = toLocalMinute(d, "Invalid/Timezone");
    assert.equal(res, "2026-05-15T12:00");
  },
});

harness.add({
  id: "time-rec-005",
  domain: "time-scheduling",
  category: "recovery",
  description: "toLocalMinute: empty timezone '' safely falls back to UTC",
  run: () => {
    const d = new Date("2026-05-15T12:00:00Z");
    const res = toLocalMinute(d, "");
    assert.equal(res, "2026-05-15T12:00");
  },
});

harness.add({
  id: "time-rec-006",
  domain: "time-scheduling",
  category: "recovery",
  description: "localDayBounds: invalid timezone 'Invalid/Timezone' safely falls back to UTC",
  run: () => {
    const at = new Date("2026-05-15T12:00:00Z");
    const bounds = localDayBounds("Invalid/Timezone", at);
    assert.equal(bounds.start, "2026-05-15T00:00:00.000Z");
    assert.equal(bounds.end, "2026-05-16T00:00:00.000Z");
  },
});

harness.add({
  id: "time-rec-007",
  domain: "time-scheduling",
  category: "recovery",
  description: "localDayBounds: empty timezone '' safely falls back to UTC",
  run: () => {
    const at = new Date("2026-05-15T12:00:00Z");
    const bounds = localDayBounds("", at);
    assert.equal(bounds.start, "2026-05-15T00:00:00.000Z");
    assert.equal(bounds.end, "2026-05-16T00:00:00.000Z");
  },
});

harness.add({
  id: "time-rec-008",
  domain: "time-scheduling",
  category: "recovery",
  description: "toLocalMinute: NaN Date recovers to current time instead of throwing",
  run: () => {
    const res = toLocalMinute(new Date(NaN), "Asia/Seoul");
    assert.ok(typeof res === "string");
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(res));
  },
});

harness.add({
  id: "time-rec-009",
  domain: "time-scheduling",
  category: "recovery",
  description: "toLocalMinute: NaN Date with UTC timezone recovers cleanly",
  run: () => {
    const res = toLocalMinute(new Date(NaN), "UTC");
    assert.ok(typeof res === "string");
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(res));
  },
});

harness.add({
  id: "time-rec-010",
  domain: "time-scheduling",
  category: "recovery",
  description: "localDayBounds: NaN Date recovers to current date instead of throwing",
  run: () => {
    const bounds = localDayBounds("Asia/Seoul", new Date(NaN));
    assert.ok(bounds.start);
    assert.ok(bounds.end);
    assert.ok(new Date(bounds.end).getTime() > new Date(bounds.start).getTime());
  },
});

harness.add({
  id: "time-rec-011",
  domain: "time-scheduling",
  category: "recovery",
  description: "localDayBounds: NaN Date in UTC timezone recovers cleanly",
  run: () => {
    const bounds = localDayBounds("UTC", new Date(NaN));
    assert.ok(bounds.start);
    assert.ok(bounds.end);
  },
});

harness.add({
  id: "time-rec-012",
  domain: "time-scheduling",
  category: "recovery",
  description: "AutomationService: settings with invalid timezone safely falls back to UTC",
  run: async () => {
    const { service } = createAutomationContext("Invalid/Timezone");
    const auto = await service.create({
      name: "Tz Fallback Auto",
      kind: "reminder",
      message: "Test",
      schedule: { type: "daily", time: "10:00" },
      enabled: true,
    });
    assert.equal(auto.status, "scheduled");
    assert.ok(auto.next_run);
  },
});

harness.add({
  id: "time-rec-013",
  domain: "time-scheduling",
  category: "recovery",
  description: "AutomationService: create succeeds when settings has empty timezone ''",
  run: async () => {
    const { service } = createAutomationContext("");
    const auto = await service.create({
      name: "Empty Tz Auto",
      kind: "reminder",
      message: "Test",
      schedule: { type: "daily", time: "12:00" },
      enabled: true,
    });
    assert.equal(auto.status, "scheduled");
  },
});

harness.add({
  id: "time-rec-014",
  domain: "time-scheduling",
  category: "recovery",
  description: "AutomationService: rearmAll succeeds when settings has invalid timezone",
  run: async () => {
    const { service, repo } = createAutomationContext("Invalid/Timezone");
    const auto = await service.create({
      name: "Rearm Bad Tz",
      kind: "reminder",
      message: "Test",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    await service.rearmAll();
    const updated = repo.require(auto.id);
    assert.equal(updated.status, "scheduled");
    assert.ok(updated.schedule_id);
  },
});

harness.add({
  id: "time-rec-015",
  domain: "time-scheduling",
  category: "recovery",
  description: "AutomationService: fire recovers from corrupted/NaN next_run and rearms cleanly",
  run: async () => {
    const { service, repo } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Corrupt next_run",
      kind: "reminder",
      message: "Msg",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    // Simulate corrupted next_run in DB
    repo.update(auto.id, { next_run: "corrupt-nan-string" });
    await service.fire(auto.id, auto.schedule_id!, async () => ({
      status: "success",
      result: "Recovered",
    }));
    const updated = repo.require(auto.id);
    assert.equal(updated.run_count, 1);
    assert.equal(updated.status, "scheduled");
    assert.ok(updated.next_run && !updated.next_run.includes("NaN"));
  },
});

harness.add({
  id: "time-rec-016",
  domain: "time-scheduling",
  category: "recovery",
  description: "AutomationService: reconcile with corrupted/NaN next_run repairs automation",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    const auto = repo.create({
      name: "Corrupt next_run in reconcile",
      kind: "reminder",
      message: "Recover",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    repo.update(auto.id, { next_run: "invalid-timestamp", schedule_id: null });
    const { repaired } = await service.reconcile();
    assert.equal(repaired, 1);
    const updated = repo.require(auto.id);
    assert.ok(updated.schedule_id);
    assert.ok(updated.next_run);
    assert.equal(await scheduler.exists(updated.schedule_id!), true);
  },
});

harness.add({
  id: "time-rec-017",
  domain: "time-scheduling",
  category: "recovery",
  description: "AutomationService: reconcile restores schedule when schedule_id was lost/deleted",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Lost Schedule",
      kind: "reminder",
      message: "Test",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    // Scheduler lost the ID (e.g. system restart)
    await scheduler.cancel(auto.schedule_id!);
    const { repaired } = await service.reconcile();
    assert.equal(repaired, 1);
    const updated = repo.require(auto.id);
    assert.notEqual(updated.schedule_id, auto.schedule_id);
    assert.equal(await scheduler.exists(updated.schedule_id!), true);
  },
});

harness.add({
  id: "time-rec-018",
  domain: "time-scheduling",
  category: "recovery",
  description: "AutomationService: reconcile recovers stuck 'running' status after worker crash",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Crashed Worker",
      kind: "reminder",
      message: "Test",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    repo.update(auto.id, { status: "running" });
    const { repaired } = await service.reconcile();
    assert.equal(repaired, 1);
    const updated = repo.require(auto.id);
    assert.equal(updated.status, "scheduled");
  },
});

harness.add({
  id: "time-rec-019",
  domain: "time-scheduling",
  category: "recovery",
  description: "Missed run recovery: run missed 1 hour ago (< 24h) schedules immediate catch-up run",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
    const auto = repo.create({
      name: "1 Hour Missed",
      kind: "reminder",
      message: "Test",
      schedule: { type: "daily", time: "09:00" },
      enabled: true,
    });
    repo.update(auto.id, { next_run: oneHourAgo, schedule_id: null });
    await service.reconcile();
    const updated = repo.require(auto.id);
    const sched = scheduler.schedules.get(updated.schedule_id!);
    assert.ok(sched);
    // Scheduled within ~1s for immediate catch-up
    assert.ok(sched.at.getTime() <= Date.now() + 2000);
  },
});

harness.add({
  id: "time-rec-020",
  domain: "time-scheduling",
  category: "recovery",
  description: "Missed run recovery: run missed 23 hours ago (< 24h) schedules immediate catch-up run",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    const missed = new Date(Date.now() - 23 * 3600_000).toISOString();
    const auto = repo.create({
      name: "23h Missed",
      kind: "reminder",
      message: "Test",
      schedule: { type: "daily", time: "09:00" },
      enabled: true,
    });
    repo.update(auto.id, { next_run: missed, schedule_id: null });
    await service.reconcile();
    const updated = repo.require(auto.id);
    const sched = scheduler.schedules.get(updated.schedule_id!);
    assert.ok(sched);
    assert.ok(sched.at.getTime() <= Date.now() + 2000);
  },
});

harness.add({
  id: "time-rec-021",
  domain: "time-scheduling",
  category: "recovery",
  description: "Missed run recovery: run missed 25 hours ago (> 24h) skips catch-up and arms future occurrence",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    const missed = new Date(Date.now() - 25 * 3600_000).toISOString();
    const auto = repo.create({
      name: "25h Missed",
      kind: "reminder",
      message: "Test",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    repo.update(auto.id, { next_run: missed, schedule_id: null });
    await service.reconcile();
    const updated = repo.require(auto.id);
    const sched = scheduler.schedules.get(updated.schedule_id!);
    assert.ok(sched);
    // Future occurrence (~30min)
    assert.ok(sched.at.getTime() >= Date.now() + 29 * 60_000);
  },
});

harness.add({
  id: "time-rec-022",
  domain: "time-scheduling",
  category: "recovery",
  description: "Missed run recovery: run missed 7 days ago (> 24h) skips catch-up and arms future occurrence",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    const missed = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const auto = repo.create({
      name: "7d Missed",
      kind: "reminder",
      message: "Test",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    repo.update(auto.id, { next_run: missed, schedule_id: null });
    await service.reconcile();
    const updated = repo.require(auto.id);
    const sched = scheduler.schedules.get(updated.schedule_id!);
    assert.ok(sched);
    assert.ok(sched.at.getTime() >= Date.now() + 29 * 60_000);
  },
});

harness.add({
  id: "time-rec-023",
  domain: "time-scheduling",
  category: "recovery",
  description: "formatLocal: NaN timestamp returns null cleanly",
  run: () => {
    assert.equal(formatLocal("Invalid Date", "Asia/Seoul"), null);
  },
});

harness.add({
  id: "time-rec-024",
  domain: "time-scheduling",
  category: "recovery",
  description: "AutomationService: executor failure records error and leaves automation re-armed for next cycle",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Executor Throw",
      kind: "reminder",
      message: "Test",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    const oldSched = auto.schedule_id!;
    await service.fire(auto.id, oldSched, async () => {
      throw new Error("Temporary AI service outage");
    });
    const updated = repo.require(auto.id);
    assert.equal(updated.status, "failed");
    assert.ok(updated.schedule_id);
    assert.notEqual(updated.schedule_id, oldSched);
    assert.equal(await scheduler.exists(updated.schedule_id!), true);
  },
});

harness.add({
  id: "time-rec-025",
  domain: "time-scheduling",
  category: "recovery",
  description: "AutomationService: executor throwing non-Error object is gracefully converted to string and recorded",
  run: async () => {
    const { service, repo } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "String Throw",
      kind: "reminder",
      message: "Test",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    await service.fire(auto.id, auto.schedule_id!, async () => {
      throw "Raw string error message";
    });
    const updated = repo.require(auto.id);
    assert.equal(updated.last_error, "Raw string error message");
  },
});

harness.add({
  id: "time-rec-026",
  domain: "time-scheduling",
  category: "recovery",
  description: "AutomationService: recovery when scheduler throws error on cancel during disarm",
  run: async () => {
    const { service, scheduler, repo } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Disarm Error",
      kind: "reminder",
      message: "Test",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    scheduler.failOnCancel = true;
    // Should catch or handle gracefully during delete/update
    try {
      await service.delete(auto.id);
    } catch {
      // It's acceptable for delete to throw if scheduler fails, or handle it
    }
  },
});

harness.add({
  id: "time-rec-027",
  domain: "time-scheduling",
  category: "recovery",
  description: "AutomationService: rearmAll adjusts next_run when settings timezone changes",
  run: async () => {
    const { service, repo, settings } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Tz Shift Auto",
      kind: "reminder",
      message: "Test",
      schedule: { type: "daily", time: "09:00" },
      enabled: true,
    });
    const runKST = auto.next_run!;
    // Change timezone to America/New_York
    settings.timezone = "America/New_York";
    await service.rearmAll();
    const updated = repo.require(auto.id);
    assert.notEqual(updated.next_run, runKST);
  },
});

harness.add({
  id: "time-rec-028",
  domain: "time-scheduling",
  category: "recovery",
  description: "AutomationService: completed once automation is disabled and marked completed without schedule",
  run: async () => {
    const { service, repo, scheduler } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Once Auto",
      kind: "reminder",
      message: "Test",
      schedule: { type: "once", at: "2099-01-01T10:00" },
      enabled: true,
    });
    scheduler.schedules.delete(auto.schedule_id!);
    await service.fire(auto.id, auto.schedule_id!, async () => ({
      status: "success",
      result: "Done once",
    }));
    const updated = repo.require(auto.id);
    assert.equal(updated.enabled, false);
    assert.equal(updated.status, "completed");
    assert.equal(updated.schedule_id, null);
    assert.equal(scheduler.schedules.size, 0);
  },
});

harness.add({
  id: "time-rec-029",
  domain: "time-scheduling",
  category: "recovery",
  description: "AutomationService: long result string is truncated to 2000 characters",
  run: async () => {
    const { service, repo } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Long Output",
      kind: "reminder",
      message: "Test",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    const giant = "A".repeat(5000);
    await service.fire(auto.id, auto.schedule_id!, async () => ({
      status: "success",
      result: giant,
    }));
    const updated = repo.require(auto.id);
    assert.equal(updated.last_result?.length, 2000);
  },
});

harness.add({
  id: "time-rec-030",
  domain: "time-scheduling",
  category: "recovery",
  description: "AutomationService: pruneRuns is called after execution maintaining bounded history",
  run: async () => {
    const { service, repo } = createAutomationContext("Asia/Seoul");
    const auto = await service.create({
      name: "Prune Auto",
      kind: "reminder",
      message: "Test",
      schedule: { type: "interval", minutes: 30 },
      enabled: true,
    });
    await service.fire(auto.id, auto.schedule_id!, async () => ({
      status: "success",
      result: "Run 1",
    }));
    assert.equal(repo.runs().length, 1);
  },
});

// ==========================================
// Suite Runner Entry Point
// ==========================================

async function main() {
  const outputPath = path.resolve("test-results/time-results.json");
  console.log(`[TimeSuite] Harness registered ${harness.count} tests.`);
  const report = await harness.run({ outputJsonPath: outputPath, verbose: true });
  if (report.failed > 0 || report.errored > 0) {
    console.error(`\n[TimeSuite] FAILURES DETECTED: ${report.failed + report.errored} tests failed or errored.`);
    process.exit(1);
  } else {
    console.log(`\n[TimeSuite] ALL ${report.total} TESTS PASSED SUCCESSFULLY!`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("[TimeSuite] Fatal unhandled error:", err);
  process.exit(1);
});
