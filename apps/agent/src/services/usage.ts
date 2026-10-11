import type { Limits, UsageCounters } from "@talorys/shared";
import type { Database } from "../db/database";

type Counter = "ai_requests" | "input_tokens" | "output_tokens" | "tool_calls" | "scheduled_ai_runs" | "ai_errors";

/**
 * Local, application-measured usage. These are estimates made by Talorys, not
 * Cloudflare's billing figures; exact Neuron usage lives in the Cloudflare dashboard.
 */
export class UsageService {
  constructor(private readonly db: Database) {}

  static day(date = new Date()): string {
    return date.toISOString().slice(0, 10);
  }

  increment(counters: Partial<Record<Counter, number>>, date = new Date()): void {
    const day = UsageService.day(date);
    this.db.run(`INSERT INTO tal_usage_daily (day) VALUES (?) ON CONFLICT(day) DO NOTHING`, day);
    for (const [key, amount] of Object.entries(counters) as [Counter, number][]) {
      if (!amount) continue;
      // Column names come from the closed Counter union above, never from input.
      this.db.run(`UPDATE tal_usage_daily SET ${key} = ${key} + ? WHERE day = ?`, Math.round(amount), day);
    }
  }

  today(): UsageCounters {
    return this.sum(UsageService.day(), UsageService.day());
  }

  lastDays(days: number): UsageCounters {
    const start = new Date(Date.now() - (days - 1) * 86400_000);
    return this.sum(UsageService.day(start), UsageService.day());
  }

  private sum(from: string, to: string): UsageCounters {
    const row = this.db.one<Record<string, number | null>>(
      `SELECT sum(ai_requests) AS ai_requests, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
              sum(tool_calls) AS tool_calls, sum(scheduled_ai_runs) AS scheduled_ai_runs, sum(ai_errors) AS ai_errors
       FROM tal_usage_daily WHERE day >= ? AND day <= ?`,
      from, to,
    );
    return {
      ai_requests: row?.ai_requests ?? 0,
      input_tokens_estimate: row?.input_tokens ?? 0,
      output_tokens_estimate: row?.output_tokens ?? 0,
      tool_calls: row?.tool_calls ?? 0,
      scheduled_ai_runs: row?.scheduled_ai_runs ?? 0,
      ai_errors: row?.ai_errors ?? 0,
    };
  }

  canUseAi(limits: Limits): boolean {
    return this.today().ai_requests < limits.maxAiRequestsPerDay;
  }

  remainingAi(limits: Limits): number {
    return Math.max(0, limits.maxAiRequestsPerDay - this.today().ai_requests);
  }

  /** Counts one more model call if the daily budget allows it; false means stop. */
  reserveAi(limits: Limits): boolean {
    if (!this.canUseAi(limits)) return false;
    this.increment({ ai_requests: 1 });
    return true;
  }

  canRunScheduledAi(limits: Limits): boolean {
    return this.today().scheduled_ai_runs < limits.maxScheduledAiRunsPerDay && this.canUseAi(limits);
  }
}

export class ActivityLog {
  constructor(private readonly db: Database) {}

  record(type: string, summary: string): void {
    this.db.run(
      `INSERT INTO tal_activity (id, type, summary, created_at) VALUES (?, ?, ?, ?)`,
      crypto.randomUUID(), type, summary.slice(0, 500), new Date().toISOString(),
    );
    this.db.run(`DELETE FROM tal_activity WHERE id NOT IN (SELECT id FROM tal_activity ORDER BY created_at DESC LIMIT 1000)`);
  }

  list(limit = 50): { id: string; type: string; summary: string; created_at: string }[] {
    return this.db.all(`SELECT * FROM tal_activity ORDER BY created_at DESC LIMIT ?`, limit);
  }
}
