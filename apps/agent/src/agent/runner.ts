import type { ChatMessage, ChatStreamEvent, PendingAction, TaskPlanDraft, ToolActivity } from "@talorys/shared";
import type { Services } from "../services/container";
import { type AIProvider, classifyAiError, estimateTokens, type ProviderTool, usageOfFailure } from "../ai/provider";
import { AppError, NotFoundError } from "../api/errors";
import { ALL_TOOLS, ToolExecutor, type ToolDefinition } from "../tools";
import { clip } from "../services/text";
import { buildSystemPrompt } from "./prompt";
import { SUMMARIZE_THRESHOLD, buildContextWindow, memoryTokenBudget, selectRelevantMemories, summarizationPrompt } from "./memory";
import type { RunnerExtensions } from "../semantic/hooks";

export interface TurnInput {
  conversationId?: string;
  message: string;
  retry?: boolean;
  signal: AbortSignal;
}

export function titleFromMessage(message: string): string {
  const clean = message.replace(/\s+/g, " ").trim();
  if (clean.length <= 60) return clean;
  const cut = clip(clean, 60);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 30 ? cut.slice(0, lastSpace) : cut}…`;
}

function toolLabel(tool: ToolDefinition | undefined, name: string, input: unknown): string {
  if (!tool) return name;
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) return name.replace(/_/g, " ");
  try {
    return tool.label(parsed.data);
  } catch {
    return name;
  }
}

function toProviderTools(executor: ToolExecutor): ProviderTool[] {
  return executor.available().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input,
    execute: (input, callId) => executor.execute(tool.name, input, callId),
  }));
}

const APPROVAL_OUTCOME: Record<PendingAction["status"], string> = {
  pending: "waiting for the owner's approval",
  approved: "approved by the owner and done",
  cancelled: "declined by the owner",
  expired: "expired without approval",
  failed: "approved but failed",
};

function planOutcome(plan: TaskPlanDraft): string {
  const name = `Task plan “${plan.plan.title}”`;
  switch (plan.status) {
    case "pending":
      return `[${name}: waiting for the owner to review and confirm; no tasks exist yet]`;
    case "confirmed":
      return `[${name}: confirmed by the owner; ${plan.result?.task_ids.length ?? 0} task(s) were created]`;
    case "cancelled":
      return `[${name}: cancelled; nothing was created]`;
    case "expired":
      return `[${name}: expired without confirmation; nothing was created]`;
  }
}

/** Lets the model see what happened to actions and plans it proposed in earlier turns. */
function withApprovalOutcomes(m: ChatMessage): ChatMessage {
  const notes = m.tools.flatMap((t) => [
    ...(t.approval ? [`[${t.approval.summary}: ${APPROVAL_OUTCOME[t.approval.status]}]`] : []),
    ...(t.plan ? [planOutcome(t.plan)] : []),
  ]);
  return notes.length ? { ...m, content: `${m.content}\n\n${notes.join("\n")}`.trim() } : m;
}

/** Runs agent turns: context assembly, provider streaming, tool execution, persistence. */
export class AgentRunner {
  constructor(
    private readonly services: Services,
    private readonly provider: AIProvider | null,
    private readonly ext?: RunnerExtensions,
  ) {}

  async *chat(input: TurnInput): AsyncGenerator<ChatStreamEvent> {
    const s = this.services;
    const settings = s.settings.get();
    const { limits } = settings;

    // 1. Conversation and the owner's message.
    let conversation = input.conversationId ? s.conversations.get(input.conversationId) : null;
    if (input.conversationId && !conversation) throw new NotFoundError("Conversation not found");
    let userMessage: ChatMessage;
    if (input.retry && conversation) {
      // Drop the failed assistant reply and answer the last owner message again.
      const last = s.conversations.lastMessage(conversation.id);
      if (last?.role === "assistant" && last.status !== "complete") s.conversations.deleteMessage(last.id);
      const prev = s.conversations.lastMessage(conversation.id);
      if (prev?.role !== "user") throw new AppError("CONFLICT", "Nothing to retry.");
      // Restored backup content is data, never live owner input.
      if (prev.source === "import") throw new AppError("CONFLICT", "Messages restored from a backup can't be retried. Send a new message instead.");
      userMessage = prev;
    } else {
      if (!conversation) {
        conversation = s.conversations.create(titleFromMessage(input.message));
        yield { type: "title", conversation_id: conversation.id, title: conversation.title };
      }
      userMessage = s.conversations.addMessage({ conversation_id: conversation.id, role: "user", content: input.message });
    }
    const assistantId = crypto.randomUUID();
    yield { type: "start", conversation_id: conversation.id, user_message_id: userMessage.id, assistant_message_id: assistantId };

    let text = "";
    const tools: ToolActivity[] = [];
    let executor: ToolExecutor | null = null;
    const finish = (status: ChatMessage["status"], error: string | null): ChatMessage => {
      // A plan proposed in a turn the owner stopped is withdrawn, so a half-finished reply can't leave one to confirm.
      if (status === "cancelled" && executor) {
        for (const id of executor.proposedPlans()) s.taskPlans.discard(id);
        for (const t of tools) if (t.plan) t.plan = s.taskPlans.get(t.plan.id) ?? t.plan;
      }
      return s.conversations.addMessage({
        id: assistantId,
        conversation_id: conversation!.id,
        role: "assistant",
        content: text,
        tools,
        status,
        error,
      });
    };

    try {
      if (!this.provider) {
        throw new AppError("AI_UNAVAILABLE", "Workers AI is not configured for this deployment. Everything else keeps working.");
      }
      if (!s.usage.canUseAi(limits)) throw aiLimitReached(limits.maxAiRequestsPerDay);

      // 2. Context: relevant memories, summary, recent history within the token budget.
      const selected = this.ext ? await this.ext.selectMemories(userMessage.content) : selectRelevantMemories(s.memories, userMessage.content);
      const memories = s.memoryHistory.promptMemories(selected, memoryTokenBudget(limits));
      const items = this.ext?.selectItems ? await this.ext.selectItems(userMessage.content) : undefined;
      const history = s.taskPlans
        .withCurrentState(s.pendingActions.withCurrentStatus(s.conversations.messages(conversation.id, { limit: 200 })))
        .filter((m) => m.role === "user" || m.status === "complete")
        .map(withApprovalOutcomes);
      let summary = conversation.summary;
      let summaryUpto = conversation.summary_upto;
      const baseSystem = buildSystemPrompt({
        agentName: settings.agentName,
        timezone: settings.timezone,
        now: new Date(),
        autoMemory: settings.autoMemory,
        memories,
        conversationSummary: summary,
        ...(items ? { items } : {}),
      });
      const historyBudget = Math.max(500, limits.maxContextTokens - estimateTokens(baseSystem) - 600);
      let window = buildContextWindow(history, historyBudget, summaryUpto);

      // Summarizing is an extra model call: only when the budget leaves room for the reply too.
      if (window.overflow.length >= SUMMARIZE_THRESHOLD && s.usage.remainingAi(limits) >= 2) {
        try {
          s.usage.increment({ ai_requests: 1 });
          const result = await this.provider.generate({
            system: "You write compact, factual conversation summaries.",
            messages: summarizationPrompt(summary, window.overflow),
            maxOutputTokens: 300,
            temperature: 0.2,
            signal: input.signal,
          });
          s.usage.record(result.usage);
          summary = result.text.trim().slice(0, 2000);
          summaryUpto = window.overflow.at(-1)!.created_at;
          s.conversations.setSummary(conversation.id, summary, summaryUpto);
          window = buildContextWindow(history, historyBudget, summaryUpto);
        } catch (error) {
          const usage = usageOfFailure(error);
          if (usage) s.usage.record(usage);
          console.warn("Summarization skipped", error);
        }
      }

      const system = summary === conversation.summary
        ? baseSystem
        : buildSystemPrompt({
            agentName: settings.agentName,
            timezone: settings.timezone,
            now: new Date(),
            autoMemory: settings.autoMemory,
            memories,
            conversationSummary: summary,
            ...(items ? { items } : {}),
          });

      // 3. Tools with per-turn limits.
      executor = new ToolExecutor(
        this.ext?.tools ?? ALL_TOOLS,
        { services: s, timezone: settings.timezone, mode: "chat", conversationId: conversation.id },
        { maxToolCalls: limits.maxToolCalls },
      );
      const providerTools = toProviderTools(executor);
      const turnTools = executor;

      // Memory selection and summarizing may have spent budget since the first check.
      if (!s.usage.reserveAi(limits)) throw aiLimitReached(limits.maxAiRequestsPerDay);
      for await (const event of this.provider.generateWithTools({
        system,
        messages: window.messages,
        tools: providerTools,
        maxIterations: limits.maxAgentIterations,
        maxOutputTokens: limits.maxOutputTokens,
        temperature: settings.temperature,
        toolBudgetExhausted: () => turnTools.budgetExhausted(),
        reserveNextStep: () => s.usage.reserveAi(limits),
        signal: input.signal,
      })) {
        if (event.type === "text") {
          text += event.delta;
          yield { type: "text", delta: event.delta };
        } else if (event.type === "tool-start") {
          const activity: ToolActivity = {
            id: event.id,
            name: event.name,
            label: toolLabel(turnTools.find(event.name), event.name, event.input),
            status: "running",
          };
          tools.push(activity);
          yield { type: "tool", tool: { ...activity } };
        } else if (event.type === "tool-end") {
          const activity = tools.find((t) => t.id === event.id);
          if (activity) {
            activity.status = event.error ? "error" : "success";
            if (event.error) activity.error = event.error.slice(0, 300);
            const approval = turnTools.approvalFor(event.id);
            if (approval) activity.approval = approval;
            const planId = turnTools.planFor(event.id);
            const plan = planId ? s.taskPlans.get(planId) : null;
            if (plan) activity.plan = plan;
            yield { type: "tool", tool: { ...activity } };
          }
        } else if (event.type === "usage") {
          s.usage.record(event.usage);
        }
      }
      s.usage.increment({ tool_calls: turnTools.callCount });

      // Providers (like the AI SDK's streamText) may end the stream quietly on abort instead of throwing.
      if (input.signal.aborted) {
        yield { type: "done", message: finish("cancelled", null) };
        return;
      }
      if (!text.trim()) {
        text = tools.some((t) => t.plan)
          ? "I've proposed a plan for you to review. Nothing is created until you confirm it."
          : tools.some((t) => t.status === "success") ? "Done." : "I wasn't able to produce a response. Please try rephrasing.";
      }
      yield { type: "done", message: finish("complete", null) };
    } catch (error) {
      if (input.signal.aborted) {
        yield { type: "done", message: finish("cancelled", null) };
        return;
      }
      const appError = error instanceof AppError ? error : classifyAiError(error);
      if (appError.code.startsWith("AI_")) s.usage.increment({ ai_errors: 1 });
      yield { type: "error", code: appError.code, message: appError.message };
      yield { type: "done", message: finish("error", appError.message) };
    }
  }

  /** Runs an AI automation prompt with read-only tools. Returns the reply text. */
  async runScheduledPrompt(prompt: string, signal?: AbortSignal): Promise<string> {
    const s = this.services;
    const settings = s.settings.get();
    if (!this.provider) throw new AppError("AI_UNAVAILABLE", "Workers AI is not configured.");
    const executor = new ToolExecutor(
      this.ext?.tools ?? ALL_TOOLS,
      { services: s, timezone: settings.timezone, mode: "scheduled" },
      { maxToolCalls: Math.min(settings.limits.maxToolCalls, 4) },
    );
    const system = buildSystemPrompt({
      agentName: settings.agentName,
      timezone: settings.timezone,
      now: new Date(),
      autoMemory: false,
      memories: s.memoryHistory.promptMemories(
        this.ext ? await this.ext.selectMemories(prompt) : selectRelevantMemories(s.memories, prompt),
        memoryTokenBudget(settings.limits),
      ),
      scheduled: true,
    });
    const providerTools = toProviderTools(executor);
    let text = "";
    // Reserved after the awaits above, so a run started just before the budget ran out cannot overrun it.
    if (!s.usage.reserveScheduledAi(settings.limits)) throw aiLimitReached(settings.limits.maxAiRequestsPerDay);
    try {
      for await (const event of this.provider.generateWithTools({
        system,
        messages: [{ role: "user", content: prompt }],
        tools: providerTools,
        maxIterations: Math.min(settings.limits.maxAgentIterations, 3),
        maxOutputTokens: Math.min(settings.limits.maxOutputTokens, 600),
        temperature: settings.temperature,
        toolBudgetExhausted: () => executor.budgetExhausted(),
        reserveNextStep: () => s.usage.reserveAi(settings.limits),
        signal,
      })) {
        if (event.type === "text") text += event.delta;
        if (event.type === "usage") {
          s.usage.record(event.usage);
        }
      }
    } catch (error) {
      s.usage.increment({ ai_errors: 1 });
      throw classifyAiError(error);
    }
    s.usage.increment({ tool_calls: executor.callCount });
    return text.trim() || "(No output)";
  }
}

function aiLimitReached(max: number): AppError {
  return new AppError("AI_LIMIT_REACHED", `Talorys reached its daily limit of ${max} AI requests (adjustable in Settings → AI).`);
}
