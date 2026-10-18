import { type Automation, type AutomationKind, type AutomationRun, type ScheduleSpec, computeNextRun, scheduleSpecSchema } from "@talorys/shared";
import type { AutomationRepository } from "../db/repositories/automations";
import type { SettingsService } from "../services/settings";
import type { ActivityLog } from "../services/usage";
import { ValidationError } from "../api/errors";

/**
 * Bridge to the Agents SDK scheduler (Durable Object alarms). Each enabled
 * automation has exactly one pending one-shot SDK schedule for its next run;
 * after it fires we compute the following occurrence in the owner's timezone.
 * This keeps wall-clock rules correct across DST and timezone changes.
 */
export interface Scheduler {
  schedule(at: Date, automationId: string): Promise<string>;
  cancel(scheduleId: string): Promise<void>;
  exists(scheduleId: string): Promise<boolean>;
}

export type AutomationExecutor = (automation: Automation) => Promise<{ status: "success" | "skipped"; result: string }>;

/** A run that was missed (e.g. during an outage) by more than this is executed once on recovery. */
const MAX_CATCH_UP_MS = 24 * 3600_000;

export class AutomationService {
  /** Automations executing in this instance; a run row left "running" without one was interrupted. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly repo: AutomationRepository,
    private readonly settings: SettingsService,
    private readonly activity: ActivityLog,
    private readonly scheduler: Scheduler,
  ) {}

  private tz(): string {
    return this.settings.get().timezone;
  }

  list(): Automation[] {
    return this.repo.list();
  }

  get(id: string): Automation | null {
    return this.repo.get(id);
  }

  async create(input: { name: string; kind: AutomationKind; message: string; schedule: ScheduleSpec; enabled: boolean }): Promise<Automation> {
    const schedule = scheduleSpecSchema.parse(input.schedule);
    if ((input.kind === "reminder" || input.kind === "agent_prompt") && !input.message.trim()) {
      throw new ValidationError(input.kind === "reminder" ? "A reminder needs a message." : "An AI automation needs a prompt.");
    }
    const first = computeNextRun(schedule, this.tz(), new Date());
    if (!first) throw new ValidationError("That time is in the past. Choose a future time.");
    const automation = this.repo.create({ ...input, schedule });
    this.activity.record("automation.created", `Created automation “${automation.name}”`);
    return automation.enabled ? this.arm(automation) : automation;
  }

  async update(
    id: string,
    patch: { name?: string; message?: string; schedule?: ScheduleSpec; enabled?: boolean },
  ): Promise<Automation> {
    const existing = this.repo.require(id);
    if (patch.message !== undefined && (existing.kind === "reminder" || existing.kind === "agent_prompt") && !patch.message.trim()) {
      throw new ValidationError(existing.kind === "reminder" ? "A reminder needs a message." : "An AI automation needs a prompt.");
    }
    const timingChanged = patch.schedule !== undefined || (patch.enabled !== undefined && patch.enabled !== existing.enabled);
    // Rescheduling an enabled automation, or turning a paused one back on, needs a run still ahead.
    const resuming = patch.enabled === true && !existing.enabled;
    if ((patch.schedule !== undefined && (patch.enabled ?? existing.enabled)) || resuming) {
      const schedule = scheduleSpecSchema.parse(patch.schedule ?? existing.schedule);
      if (!computeNextRun(schedule, this.tz(), new Date())) throw new ValidationError("That time is in the past. Choose a future time.");
    }
    let next = this.repo.update(id, {
      name: patch.name,
      message: patch.message,
      schedule: patch.schedule ? scheduleSpecSchema.parse(patch.schedule) : undefined,
      enabled: patch.enabled,
    });
    if (timingChanged) {
      await this.disarm(next);
      next = next.enabled ? await this.arm(next) : this.repo.update(id, { status: "paused", next_run: null, schedule_id: null });
    }
    return next;
  }

  async delete(id: string): Promise<void> {
    const existing = this.repo.require(id);
    await this.disarm(existing);
    this.repo.delete(id);
    this.activity.record("automation.deleted", `Deleted automation “${existing.name}”`);
  }

  /**
   * Re-arms every enabled automation, e.g. after a timezone change or an import.
   * Disabled automations that still hold a schedule (e.g. disabled by an import) are disarmed.
   */
  async rearmAll(): Promise<void> {
    for (const a of this.repo.list()) {
      await this.disarm(a);
      if (a.enabled) await this.arm(a);
      else if (a.schedule_id || a.status === "scheduled") {
        this.repo.update(a.id, { status: "paused", next_run: null, schedule_id: null });
      }
    }
  }

  private async arm(automation: Automation, after = new Date()): Promise<Automation> {
    const next = computeNextRun(automation.schedule, this.tz(), after);
    if (!next) {
      return this.repo.update(automation.id, { status: "completed", enabled: false, next_run: null, schedule_id: null });
    }
    const scheduleId = await this.scheduler.schedule(next, automation.id);
    return this.repo.update(automation.id, {
      status: "scheduled",
      next_run: next.toISOString(),
      schedule_id: scheduleId,
    });
  }

  private async disarm(automation: Automation): Promise<void> {
    if (automation.schedule_id) await this.scheduler.cancel(automation.schedule_id);
  }

  /**
   * Called when an SDK schedule fires. Stale schedules (automation deleted,
   * paused or re-armed since) are ignored, so double execution cannot happen.
   */
  async fire(automationId: string, scheduleId: string, execute: AutomationExecutor): Promise<void> {
    const automation = this.repo.get(automationId);
    if (!automation?.enabled || automation.schedule_id !== scheduleId || automation.status === "running") return;
    if (this.inFlight.has(automation.id)) {
      // A manual run is in progress: skip this occurrence rather than running twice.
      const run = this.repo.startRun(automation);
      this.repo.finishRun(run.id, "skipped", "Skipped because a manual run was in progress.", null);
      const slot = automation.next_run ? new Date(automation.next_run) : new Date();
      const rearmed = await this.arm(this.repo.update(automation.id, { schedule_id: null }), new Date(Math.max(Date.now(), slot.getTime())));
      if (automation.status === "failed" && rearmed.enabled) this.repo.update(automation.id, { status: "failed" });
      return;
    }
    const run = this.repo.startRun(automation);
    this.repo.update(automation.id, { status: "running" });
    const { lastResult, lastError } = await this.execute(automation, run.id, execute);
    const current = this.repo.get(automation.id);
    this.repo.pruneRuns();
    // The owner can pause, delete or reschedule while the executor awaits AI.
    // Keep the completed run receipt without claiming a replacement schedule.
    if (!current) return;
    const ownsSchedule = current.enabled && current.schedule_id === scheduleId;
    const updated = this.repo.update(automation.id, {
      last_run: new Date().toISOString(),
      last_result: lastResult,
      last_error: lastError,
      run_count: current.run_count + 1,
      ...(ownsSchedule ? { schedule_id: null, status: lastError ? "failed" as const : "scheduled" as const } : {}),
    });
    if (!ownsSchedule) return;
    // Schedule the next occurrence after both "now" and the slot that just fired.
    const slot = automation.next_run ? new Date(automation.next_run) : new Date();
    const after = new Date(Math.max(Date.now(), slot.getTime()));
    const rearmed = await this.arm(updated, after);
    if (lastError && rearmed.enabled) this.repo.update(automation.id, { status: "failed" });
  }

  /**
   * Runs an automation immediately, outside its schedule. The next scheduled
   * run is left untouched.
   */
  async runNow(id: string, execute: AutomationExecutor): Promise<AutomationRun> {
    const automation = this.repo.require(id);
    if (automation.status === "running" || this.inFlight.has(id)) {
      throw new ValidationError("This automation is already running.");
    }
    const run = this.repo.startRun(automation);
    const { lastResult, lastError } = await this.execute(automation, run.id, execute);
    this.repo.pruneRuns();
    const current = this.repo.get(id);
    if (current) {
      this.repo.update(id, {
        last_run: new Date().toISOString(),
        last_result: lastResult,
        last_error: lastError,
        run_count: current.run_count + 1,
        // A successful manual run clears a previous failure badge.
        ...(!lastError && current.status === "failed" && current.enabled ? { status: "scheduled" as const } : {}),
      });
    }
    return this.repo.getRun(run.id) ?? run;
  }

  /** Executes once and records the outcome on the run row. */
  private async execute(
    automation: Automation,
    runId: string,
    execute: AutomationExecutor,
  ): Promise<{ lastResult: string | null; lastError: string | null }> {
    this.inFlight.add(automation.id);
    try {
      const outcome = await execute(automation);
      const lastResult = outcome.result.slice(0, 2000);
      this.repo.finishRun(runId, outcome.status, lastResult, null);
      return { lastResult, lastError: null };
    } catch (error) {
      const lastError = error instanceof Error ? error.message : String(error);
      this.repo.finishRun(runId, "error", null, lastError);
      this.activity.record("automation.failed", `Automation “${automation.name}” failed: ${lastError}`);
      return { lastResult: null, lastError };
    } finally {
      this.inFlight.delete(automation.id);
    }
  }

  /**
   * Makes sure every enabled automation has a live SDK schedule. Recovers from
   * interrupted runs and lost schedules; a recently missed run executes once.
   */
  async reconcile(): Promise<{ repaired: number }> {
    let repaired = 0;
    this.repo.closeInterruptedRuns([...this.inFlight]);
    for (const a of this.repo.list()) {
      if (!a.enabled) continue;
      const alive = a.schedule_id ? await this.scheduler.exists(a.schedule_id) : false;
      if (alive && a.status !== "running") continue;
      repaired++;
      if (a.schedule_id) await this.scheduler.cancel(a.schedule_id);
      const missedAt = a.next_run ? Date.parse(a.next_run) : NaN;
      if (!Number.isNaN(missedAt) && missedAt <= Date.now() && Date.now() - missedAt < MAX_CATCH_UP_MS) {
        const scheduleId = await this.scheduler.schedule(new Date(Date.now() + 1000), a.id);
        this.repo.update(a.id, { schedule_id: scheduleId, status: "scheduled" });
      } else {
        await this.arm(a);
      }
    }
    return { repaired };
  }
}
