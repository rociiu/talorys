import { zodToJsonSchema } from "zod-to-json-schema";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest, Usage } from "./provider";
import { AppError } from "../api/errors";

export interface OpenAICompatibleConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id = "openai-compatible";

  constructor(private readonly config: OpenAICompatibleConfig) {}

  async generate(req: GenerateRequest): Promise<{ text: string; usage: Usage }> {
    const messages = [
      { role: "system", content: req.system },
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    const body = {
      model: this.config.model,
      messages,
      max_tokens: req.maxOutputTokens,
      temperature: req.temperature ?? 0.7,
      stream: false,
    };

    const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new AppError("AI_UNAVAILABLE", `Model error (${res.status}): ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as any;
    const choice = data.choices?.[0];
    const text = choice?.message?.content || "";
    const usage: Usage = {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };

    return { text, usage };
  }

  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({
      ...req,
      tools: [],
      maxIterations: 1,
      toolBudgetExhausted: () => true,
    });
  }

  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    const conversation: any[] = [
      { role: "system", content: req.system },
      ...req.messages.map((m) => ({ role: m.role, content: m.content })),
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    const formattedTools = req.tools.map((t) => {
      const schema = zodToJsonSchema(t.inputSchema as any, { target: "openAi" });
      return {
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: schema,
        },
      };
    });

    for (let iter = 0; iter < req.maxIterations; iter++) {
      const canCallTools = iter < req.maxIterations - 1 && !req.toolBudgetExhausted() && formattedTools.length > 0;

      const body: any = {
        model: this.config.model,
        messages: conversation,
        max_tokens: req.maxOutputTokens,
        temperature: req.temperature ?? 0.7,
        stream: false,
      };

      if (canCallTools) {
        body.tools = formattedTools;
        body.tool_choice = "auto";
      }

      let res: Response;
      try {
        res = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (err) {
        throw new AppError("AI_UNAVAILABLE", `Failed to connect to AI server: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new AppError("AI_UNAVAILABLE", `AI Model error (${res.status}): ${errText.slice(0, 300)}`);
      }

      const data = (await res.json()) as any;
      const choice = data.choices?.[0];
      const message = choice?.message;

      if (data.usage) {
        totalInputTokens += data.usage.prompt_tokens ?? 0;
        totalOutputTokens += data.usage.completion_tokens ?? 0;
      }

      if (!message) break;

      // Check tool calls
      const toolCalls = message.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        // Append assistant message with tool calls to conversation
        conversation.push(message);

        for (const tc of toolCalls) {
          const name = tc.function?.name;
          const id = tc.id || `call_${Math.random().toString(36).slice(2)}`;
          let input: unknown = {};
          try {
            input = JSON.parse(tc.function?.arguments || "{}");
          } catch {
            input = {};
          }

          yield { type: "tool-start", id, name, input };

          const tool = req.tools.find((t) => t.name === name);
          let output: unknown = null;
          let toolError: string | undefined;

          if (!tool) {
            toolError = `Tool ${name} not found`;
          } else {
            try {
              output = await tool.execute(input, id);
            } catch (err) {
              toolError = err instanceof Error ? err.message : String(err);
            }
          }

          yield { type: "tool-end", id, name, output, error: toolError };

          // Add tool result to conversation
          conversation.push({
            role: "tool",
            tool_call_id: id,
            content: toolError ? JSON.stringify({ error: toolError }) : JSON.stringify(output),
          });
        }

        // Loop again for model to reflect tool outputs
        continue;
      }

      // Final textual response
      const textContent = message.content || "";
      if (textContent) {
        // Stream text in chunks
        for (const chunk of textContent.match(/\S+\s*/g) ?? [textContent]) {
          if (req.signal?.aborted) return;
          yield { type: "text", delta: chunk };
          await new Promise((r) => setTimeout(r, 15));
        }
      }
      break;
    }

    yield {
      type: "usage",
      usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    };
  }
}
