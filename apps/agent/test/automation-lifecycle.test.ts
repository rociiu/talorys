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
