import { Agent } from "agents";
import type { Automation } from "@talorys/shared";
import type { Env } from "../env";
import { migrate } from "../db/migrations";
import { createServices, type Services } from "../services/container";
import type { Scheduler } from "./scheduling";
import { AgentRunner } from "./runner";
import { createApi } from "../api/app";
import { CloudflareWorkersAIProvider } from "../ai/workers-ai";
import { MockAIProvider } from "../ai/mock";
import type { AIProvider } from "../ai/provider";
import { localDayBounds, formatLocal } from "../services/time";
import { semanticExtensions } from "../semantic";
import { AppError } from "../api/errors";
import { semanticNeighbors } from "../semantic/neighbors";
import { CLEF_MODEL, type ClefRun } from "../memory/conflict";

interface AgentState {
  /** Unread notifications, kept in agent state for cheap polling. */
  unread: number;
}

interface AutomationPayload {
  automationId: string;
}

const api = createApi();

/**
 * The owner's personal agent. Exactly one instance exists per deployment
 * ("personal-agent"); it owns all data in its SQLite-backed Durable Object.
 */
export class TalorysAgent extends Agent<Env, AgentState> {
  override initialState: AgentState = { unread: 0 };

  private _services: Services | null = null;
  /** In-flight chat turns by conversation, for cancellation. */
  readonly activeRuns = new Map<string, AbortController>();

  get services(): Services {
    if (!this._services) {
      const scheduler: Scheduler = {
        schedule: async (at, automationId) => {
          const s = await this.schedule<AutomationPayload>(at, "runAutomation", { automationId });
          return s.id;
        },
        cancel: async (id) => {
          await this.cancelSchedule(id);
        },
        exists: async (id) => (await this.getScheduleById(id)) !== undefined,
      };
      this._services = createServices(this.ctx.storage, this.env, scheduler, {
        clef: () => this.clefRun(),
        neighbors: (memory, opts) => semanticNeighbors(this.services, this.env, memory, opts),
        ...(this.env.TALORYS_ENV === "development" ? { onAiCheck: (check) => console.info("memory.ai_check", JSON.stringify(check)) } : {}),
      });
      migrate(this._services.db);
    }
    return this._services;
  }

  override async onStart(): Promise<void> {
    const services = this.services;
    try {
      const { repaired } = await services.automations.reconcile();
      if (repaired > 0) services.activity.record("automation.reconciled", `Recovered ${repaired} schedule(s) after restart`);
    } catch (error) {
      console.error("Schedule reconciliation failed", error);
    }
  }

  override async onRequest(request: Request): Promise<Response> {
    return api.fetch(request, { agent: this, env: this.env });
  }

  /**
   * Talorys has no sub-agents. Without this, the SDK forwards any `/sub/{class}/{name}/...`
   * request to a fresh facet with its own empty database, bypassing login rate limits.
   */
  override async onBeforeSubAgent(): Promise<Response> {
    return Response.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  }

  /** Chooses the AI provider. The mock is only used in local development or explicit demo mode. */
  aiProvider(): AIProvider | null {
    const settings = this.services.settings.get();
    if (settings.demoMode) return new MockAIProvider();
    if (this.env.TALORYS_ENV === "development" && this.env.TALORYS_MOCK_AI === "1") return new MockAIProvider();
    if (!this.env.AI) return null;
    return new CloudflareWorkersAIProvider(this.env.AI, settings.model);
  }

  /** Clef for the memory-history AI check: only with real Workers AI (not mock AI or demo mode). */
  clefRun(): ClefRun | null {
    if (!this.env.AI || !(this.aiProvider() instanceof CloudflareWorkersAIProvider)) return null;
    const ai = this.env.AI;
    return (request, signal) => ai.run(CLEF_MODEL, { ...request }, { signal });
  }

  runner(): AgentRunner {
    return new AgentRunner(this.services, this.aiProvider(), semanticExtensions(this.services, this.env));
  }

  refreshUnread(): void {
    const unread = this.services.notifications.unreadCount();
    if (unread !== this.state.unread) this.setState({ unread });
  }

  /** Scheduled callback invoked by the Agents SDK (Durable Object alarm). */
  async runAutomation(payload: AutomationPayload, schedule: { id: string }): Promise<void> {
    await this.services.automations.fire(payload.automationId, schedule.id, (a) => this.executeAutomation(a));
    this.refreshUnread();
  }

  private async executeAutomation(a: Automation): Promise<{ status: "success" | "skipped"; result: string }> {
    const s = this.services;
    const settings = s.settings.get();
    switch (a.kind) {
      case "reminder": {
        // Simple reminders never use AI.
        s.notifications.create({ title: "Reminder", body: a.message || a.name, automation_id: a.id });
        return { status: "success", result: "Reminder delivered" };
      }
      case "task_digest": {
        const bounds = localDayBounds(settings.timezone);
        const overdue = s.tasks.list({ view: "overdue", limit: 20 });
        const today = s.tasks.list({ view: "today", dayStart: bounds.start, dayEnd: bounds.end, limit: 20 }).filter(
          (t) => !overdue.some((o) => o.id === t.id),
        );
        const open = s.tasks.list({ status: "open", limit: 200 }).length;
        const line = (t: { title: string; due_at: string | null; priority: string }) =>
          `- ${t.title}${t.due_at ? ` (due ${formatLocal(t.due_at, settings.timezone)})` : ""}${t.priority === "high" || t.priority === "urgent" ? ` · ${t.priority}` : ""}`;
        const parts = [
          overdue.length ? `**Overdue (${overdue.length})**\n${overdue.map(line).join("\n")}` : "",
          today.length ? `**Due today (${today.length})**\n${today.map(line).join("\n")}` : "",
          `${open} open task(s) in total.`,
        ].filter(Boolean);
        if (a.message) parts.unshift(a.message);
        s.notifications.create({ title: a.name, body: parts.join("\n\n"), automation_id: a.id });
        return { status: "success", result: `${overdue.length} overdue, ${today.length} due today` };
      }
      case "agent_prompt": {
        if (!s.usage.canRunScheduledAi(settings.limits)) return skipForBudget(s, a);
        let text: string;
        try {
          text = await this.runner().runScheduledPrompt(a.message);
        } catch (error) {
          // The budget ran out while this run waited (another run or chat took the last request).
          if (error instanceof AppError && error.code === "AI_LIMIT_REACHED") return skipForBudget(s, a);
          throw error;
        }
        s.notifications.create({ title: a.name, body: text, automation_id: a.id });
        return { status: "success", result: text.slice(0, 300) };
      }
    }
  }
}

function skipForBudget(s: Services, a: Automation): { status: "skipped"; result: string } {
  s.notifications.create({
    title: a.name,
    body: "Skipped: the daily budget for scheduled AI runs was reached. Adjust it in Settings → AI.",
    automation_id: a.id,
  });
  return { status: "skipped", result: "Scheduled AI budget reached" };
}
