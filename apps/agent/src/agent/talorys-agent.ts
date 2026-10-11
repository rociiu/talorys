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
import { OpenAICompatibleProvider } from "../ai/openai-compatible";
import type { AIProvider } from "../ai/provider";
import { localDayBounds, formatLocal } from "../services/time";
import { semanticExtensions } from "../semantic";

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
      this._services = createServices(this.ctx.storage, this.env, scheduler);
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
    if (this.env.TALORYS_AI_PROVIDER === "openai-compatible" || this.env.OPENAI_BASE_URL) {
      return new OpenAICompatibleProvider({
        baseUrl: this.env.OPENAI_BASE_URL || "http://127.0.0.1:8088/v1",
        model: this.env.OPENAI_MODEL || "qwen3.8-27b",
        apiKey: this.env.OPENAI_API_KEY,
      });
    }
    if (this.env.TALORYS_ENV === "development" && this.env.TALORYS_MOCK_AI === "1") return new MockAIProvider();
    if (!this.env.AI) return null;
    return new CloudflareWorkersAIProvider(this.env.AI, settings.model);
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
        s.notifications.create({ title: "미리 알림", body: a.message || a.name, automation_id: a.id });
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
          `- ${t.title}${t.due_at ? ` (기한: ${formatLocal(t.due_at, settings.timezone)})` : ""}${t.priority === "high" || t.priority === "urgent" ? ` · ${t.priority}` : ""}`;
        const parts = [
          overdue.length ? `**기한 초과 (${overdue.length})**\n${overdue.map(line).join("\n")}` : "",
          today.length ? `**오늘 마감 (${today.length})**\n${today.map(line).join("\n")}` : "",
          `총 ${open}개의 미완료 할 일이 있습니다.`,
        ].filter(Boolean);
        if (a.message) parts.unshift(a.message);
        s.notifications.create({ title: a.name, body: parts.join("\n\n"), automation_id: a.id });
        return { status: "success", result: `${overdue.length} overdue, ${today.length} due today` };
      }
      case "agent_prompt": {
        if (!s.usage.canRunScheduledAi(settings.limits)) {
          s.notifications.create({
            title: a.name,
            body: "실행 건너뜀: 예약된 AI 작업의 일일 한도에 도달했습니다. 설정 → AI 탭에서 한도를 조정할 수 있습니다.",
            automation_id: a.id,
          });
          return { status: "skipped", result: "Scheduled AI budget reached" };
        }
        const text = await this.runner().runScheduledPrompt(a.message);
        s.notifications.create({ title: a.name, body: text, automation_id: a.id });
        return { status: "success", result: text.slice(0, 300) };
      }
    }
  }
}
