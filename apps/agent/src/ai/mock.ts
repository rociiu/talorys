import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "./provider";
import { estimatedUsage } from "./provider";

/**
 * Deterministic provider for local development, automated tests and the
 * documented demo mode. It never calls a model: it recognises a few simple
 * intents, routes them through the real tool pipeline (so limits and
 * validation apply), and streams a templated reply.
 */
export class MockAIProvider implements AIProvider {
  readonly id = "mock";
  readonly model = "mock";
  readonly billable = false;

  constructor(private readonly chunkDelayMs = 25) {}

  async generate(req: GenerateRequest) {
    const last = req.messages.at(-1)?.content ?? "";
    const text = `Summary: ${last.slice(0, 200)}`;
    return { text, usage: estimatedUsage(this, req.system.length + JSON.stringify(req.messages).length, text.length) };
  }

  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }

  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    const input = req.messages.at(-1)?.content.trim() ?? "";
    const plan = planTools(input);
    let reply = "";
    let calls = 0;
    for (const step of plan) {
      const tool = req.tools.find((t) => t.name === step.name);
      if (!tool) continue;
      if (calls >= req.maxIterations * 4 || req.toolBudgetExhausted()) break;
      calls++;
      const id = `mock_${calls}`;
      yield { type: "tool-start", id, name: tool.name, input: step.input };
      try {
        const output = await tool.execute(step.input, id);
        yield { type: "tool-end", id, name: tool.name, output };
        reply += step.describe(output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        yield { type: "tool-end", id, name: tool.name, output: null, error: message };
        reply += `I couldn't complete that: ${message}`;
      }
    }
    if (!reply) {
      reply = `(Demo mode) You said: "${input.slice(0, 500)}". Connect Workers AI for real answers — tasks, notes, memories and reminders work either way.`;
    }
    let outputChars = 0;
    for (const chunk of reply.match(/\S+\s*/g) ?? [reply]) {
      if (req.signal?.aborted) break;
      outputChars += chunk.length;
      yield { type: "text", delta: chunk };
      // Paces output like a real model so streaming paths are exercised.
      await new Promise((r) => setTimeout(r, this.chunkDelayMs));
    }
    yield {
      type: "usage",
      usage: estimatedUsage(this, req.system.length + JSON.stringify(req.messages).length, outputChars),
    };
  }
}

interface PlannedCall {
  name: string;
  input: unknown;
  describe: (output: unknown) => string;
}

function planTools(text: string): PlannedCall[] {
  let m: RegExpMatchArray | null;
  if ((m = text.match(/^remember(?: that)?\s+(.+)$/i))) {
    return [{ name: "remember", input: { content: m[1], category: "preference" }, describe: () => `Got it — I'll remember that ${m![1]}.` }];
  }
  if ((m = text.match(/^(?:add|create) (?:a )?task(?: to)?\s*:?\s+(.+)$/i))) {
    return [{ name: "create_task", input: { title: m[1] }, describe: () => `Added the task "${m![1]}".` }];
  }
  if ((m = text.match(/^plan (.+?):\s*(.+)$/i))) {
    // "plan Trip to Japan: book flights; renew passport!; pack" — "!" marks high priority.
    const tasks = m[2]!.split(";").map((t) => t.trim()).filter(Boolean).map((t) => ({
      title: t.replace(/!$/, "").trim(),
      priority: t.endsWith("!") ? "high" : "medium",
    }));
    return [
      {
        name: "propose_task_plan",
        input: { title: m[1], tasks },
        describe: () => `I've proposed a plan with ${tasks.length} tasks. Review it and confirm to create them.`,
      },
    ];
  }
  if ((m = text.match(/^(?:add|create|write) (?:a )?note\s*:?\s+(.+)$/i))) {
    return [{ name: "create_note", input: { title: m[1]!.slice(0, 80), content: m[1] }, describe: () => `Saved a note.` }];
  }
  if ((m = text.match(/^(?:complete|finish|mark) (?:the )?task\s+(.+?)(?: as (?:done|completed))?$/i))) {
    return [{ name: "complete_task", input: { task: m[1] }, describe: () => `Marked "${m![1]}" as done.` }];
  }
  if ((m = text.match(/^(?:delete|remove) (?:the )?task\s+(.+)$/i))) {
    return [{ name: "delete_task", input: { task: m[1] }, describe: () => `I've asked to delete "${m![1]}". Approve it above if you want it gone.` }];
  }
  if ((m = text.match(/^rewrite note (\S+) as:\s*(.+)$/i))) {
    return [{ name: "replace_note_content", input: { id: m[1], content: m[2] }, describe: () => "I've proposed new text for that note. Approve it above to save it." }];
  }
  if (/^(?:list|show)(?: my)? tasks|what should i work on/i.test(text)) {
    return [
      {
        name: "list_tasks",
        input: { view: "open" },
        describe: (out) => {
          const tasks = ((out as { tasks?: { title: string }[] })?.tasks ?? []).map((t) => `- ${t.title}`);
          return tasks.length ? `Here are your open tasks:\n\n${tasks.join("\n")}` : "You have no open tasks.";
        },
      },
    ];
  }
  if ((m = text.match(/^remind me in (\d+) minutes? to (.+)$/i))) {
    return [
      {
        name: "create_reminder",
        input: { message: m[2], in_minutes: Number(m[1]) },
        describe: () => `I'll remind you in ${m![1]} minutes to ${m![2]}.`,
      },
    ];
  }
  if ((m = text.match(/^(?:search|find)\s+(.+)$/i))) {
    return [{ name: "search", input: { query: m[1] }, describe: (out) => `Search results:\n\n\`\`\`json\n${JSON.stringify(out, null, 2).slice(0, 1500)}\n\`\`\`` }];
  }
  return [];
}
