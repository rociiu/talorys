import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("automation completion respects concurrent owner changes", () => {
  it.each(["pause", "reschedule", "delete", "unchanged"] as const)("handles %s during an active run", async (change) => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const automation = await s.automations.create({
        name: `Concurrent ${change}`, kind: "agent_prompt", message: "Summarize tasks",
        schedule: { type: "interval", minutes: 15 }, enabled: true,
      });
      const entered = deferred<void>();
      const finish = deferred<void>();
      const running = s.automations.fire(automation.id, automation.schedule_id!, async () => {
        entered.resolve();
        await finish.promise;
        return { status: "success", result: "Owned automation output" };
      });
      await entered.promise;
      let expectedSchedule: string | null = null;
      if (change === "pause") await s.automations.update(automation.id, { enabled: false });
      else if (change === "reschedule") {
        expectedSchedule = (await s.automations.update(automation.id, { schedule: { type: "daily", time: "09:00" } })).schedule_id;
      } else if (change === "delete") await s.automations.delete(automation.id);
      finish.resolve();
      await expect(running).resolves.toBeUndefined();
      const current = s.automations.get(automation.id);
      const schedules = (await agent.listSchedules()).filter((schedule) =>
        (schedule.payload as { automationId?: string })?.automationId === automation.id);
      if (change === "pause") {
        expect(current).toMatchObject({ enabled: false, status: "paused", schedule_id: null, next_run: null });
        expect(schedules).toHaveLength(0);
      } else if (change === "delete") {
        expect(current).toBeNull();
        expect(schedules).toHaveLength(0);
      } else if (change === "reschedule") {
        expect(current?.schedule_id).toBe(expectedSchedule);
        expect(schedules).toHaveLength(1);
      } else {
        expect(current).toMatchObject({ enabled: true, status: "scheduled", run_count: 1 });
        expect(current?.schedule_id).not.toBe(automation.schedule_id);
        await s.automations.delete(automation.id);
      }
      if (change === "pause" || change === "reschedule") await s.automations.delete(automation.id);
    });
  });

  it("does not execute the same callback twice while its first run is active", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const a = await s.automations.create({ name: "Duplicate", kind: "agent_prompt", message: "Summarize",
        schedule: { type: "interval", minutes: 15 }, enabled: true });
      const entered = deferred<void>();
      const finish = deferred<void>();
      let calls = 0;
      const running = s.automations.fire(a.id, a.schedule_id!, async () => {
        calls++; entered.resolve(); await finish.promise;
        return { status: "success", result: "Owned output" };
      });
      await entered.promise;
      await s.automations.fire(a.id, a.schedule_id!, async () => {
        calls++; return { status: "success", result: "Duplicate output" };
      });
      finish.resolve();
      await running;
      expect(calls).toBe(1);
      await s.automations.delete(a.id);
    });
  });
});

describe("run now and run history", () => {
  it("runs immediately without moving the next scheduled run, and pages history per automation", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const a = await s.automations.create({ name: "Manual", kind: "reminder", message: "Stretch",
        schedule: { type: "daily", time: "09:00" }, enabled: true });
      const other = await s.automations.create({ name: "Other", kind: "reminder", message: "Water",
        schedule: { type: "daily", time: "10:00" }, enabled: true });
      const first = await agent.runAutomationNow(a.id);
      expect(first).toMatchObject({ automation_id: a.id, status: "success", result: "Reminder delivered" });
      await expect(s.automations.runNow(a.id, async () => { throw new Error("boom"); })).resolves.toMatchObject({ status: "error", error: "boom" });
      await agent.runAutomationNow(other.id);

      const current = s.automations.get(a.id)!;
      expect(current).toMatchObject({ run_count: 2, last_error: "boom", schedule_id: a.schedule_id, next_run: a.next_run });

      const mine = s.automationsRepo.runs({ automationId: a.id });
      expect(mine.map((r) => r.status)).toEqual(["error", "success"]);
      expect(s.automationsRepo.runs({ automationId: a.id, status: "error" })).toHaveLength(1);
      expect(s.automationsRepo.runs({ automationId: a.id, before: mine[0]!.started_at }).map((r) => r.id)).not.toContain(mine[0]!.id);

      await s.automations.delete(a.id);
      await s.automations.delete(other.id);
    });
  });
});

describe("editing an automation keeps its message required", () => {
  it.each([
    ["reminder", "A reminder needs a message."],
    ["agent_prompt", "An AI automation needs a prompt."],
  ] as const)("rejects a blank %s message and leaves the automation unchanged", async (kind, error) => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const a = await s.automations.create({ name: "Edit me", kind, message: "Original", schedule: { type: "daily", time: "09:00" }, enabled: true });
      await expect(s.automations.update(a.id, { message: "   " })).rejects.toThrow(error);
      expect(s.automations.get(a.id)?.message).toBe("Original");
      await s.automations.delete(a.id);
    });
  });

  it("still allows a task digest to have no message", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const a = await s.automations.create({ name: "Digest", kind: "task_digest", message: "note", schedule: { type: "daily", time: "09:00" }, enabled: true });
      expect((await s.automations.update(a.id, { message: "" })).message).toBe("");
      await s.automations.delete(a.id);
    });
  });
});

describe("rescheduling an automation to a time that has passed", () => {
  it("is rejected like creating one, and leaves the automation armed", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const a = await s.automations.create({ name: "Keep me", kind: "reminder", message: "Hi", schedule: { type: "daily", time: "09:00" }, enabled: true });
      await expect(s.automations.update(a.id, { schedule: { type: "once", at: "2000-01-01T09:00" } })).rejects.toThrow("in the past");
      const after = s.automations.get(a.id);
      expect(after).toMatchObject({ enabled: true, status: "scheduled", schedule: { type: "daily", time: "09:00" } });
      expect(after?.schedule_id).toBe(a.schedule_id);
      await s.automations.delete(a.id);
    });
  });

  it("is allowed while the automation is being disabled", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const a = await s.automations.create({ name: "Park me", kind: "reminder", message: "Hi", schedule: { type: "daily", time: "09:00" }, enabled: true });
      const parked = await s.automations.update(a.id, { enabled: false, schedule: { type: "once", at: "2000-01-01T09:00" } });
      expect(parked).toMatchObject({ enabled: false, status: "paused", schedule_id: null });
      await s.automations.delete(a.id);
    });
  });
});

describe("resuming a paused one-off automation", () => {
  it("is rejected when its time has passed, and the automation stays paused", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const a = await s.automations.create({ name: "Old", kind: "reminder", message: "Hi", schedule: { type: "daily", time: "09:00" }, enabled: true });
      await s.automations.update(a.id, { enabled: false, schedule: { type: "once", at: "2000-01-01T09:00" } });
      await expect(s.automations.update(a.id, { enabled: true })).rejects.toThrow("in the past");
      expect(s.automations.get(a.id)).toMatchObject({ enabled: false, status: "paused", schedule_id: null });
      await s.automations.delete(a.id);
    });
  });

  it("re-arms a paused recurring automation as before", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const a = await s.automations.create({ name: "Daily", kind: "reminder", message: "Hi", schedule: { type: "daily", time: "09:00" }, enabled: false });
      expect(await s.automations.update(a.id, { enabled: true })).toMatchObject({ enabled: true, status: "scheduled" });
      await s.automations.delete(a.id);
    });
  });
});

describe("run now concurrency and recovery", () => {
  it("skips a scheduled occurrence while a manual run is in progress and keeps the schedule", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const a = await s.automations.create({ name: "Overlap", kind: "agent_prompt", message: "Summarize",
        schedule: { type: "interval", minutes: 15 }, enabled: true });
      const entered = deferred<void>();
      const finish = deferred<void>();
      let calls = 0;
      const manual = s.automations.runNow(a.id, async () => {
        calls++; entered.resolve(); await finish.promise;
        return { status: "success", result: "Manual output" };
      });
      await entered.promise;
      await s.automations.fire(a.id, a.schedule_id!, async () => {
        calls++; return { status: "success", result: "Scheduled output" };
      });
      finish.resolve();
      const run = await manual;
      expect(calls).toBe(1);
      expect(run).toMatchObject({ status: "success", result: "Manual output" });
      const current = s.automations.get(a.id)!;
      expect(current.enabled).toBe(true);
      expect(current.schedule_id).toBeTruthy();
      expect(current.schedule_id).not.toBe(a.schedule_id);
      expect(s.automationsRepo.runs({ automationId: a.id }).map((r) => r.status).sort()).toEqual(["skipped", "success"]);
      await s.automations.delete(a.id);
    });
  });

  it("closes runs interrupted by a restart so run now works again", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      const a = await s.automations.create({ name: "Interrupted", kind: "reminder", message: "Stretch",
        schedule: { type: "daily", time: "09:00" }, enabled: true });
      const orphan = s.automationsRepo.startRun(a);
      await s.automations.reconcile();
      expect(s.automationsRepo.getRun(orphan.id)).toMatchObject({ status: "error", error: "Interrupted before it finished." });
      await expect(agent.runAutomationNow(a.id)).resolves.toMatchObject({ status: "success" });
      await s.automations.delete(a.id);
    });
  });
});
