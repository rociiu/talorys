import { generateText, streamText, type ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "./provider";
import { classifyAiError } from "./provider";

/**
 * Cloudflare Workers AI through the AI SDK's official Workers AI provider.
 * Reasoning ("thinking") is disabled by default to keep Neuron usage low.
 */
export class CloudflareWorkersAIProvider implements AIProvider {
  readonly id = "workers-ai";
  private readonly workersai: ReturnType<typeof createWorkersAI>;

  constructor(
    binding: Ai,
    private readonly modelId: string,
  ) {
    this.workersai = createWorkersAI({ binding });
  }

  private model() {
    return this.workersai(this.modelId as Parameters<typeof this.workersai>[0], {
      chat_template_kwargs: { enable_thinking: false },
    });
  }

  async generate(req: GenerateRequest) {
    try {
      const result = await generateText({
        model: this.model(),
        instructions: req.system,
        messages: req.messages,
        maxOutputTokens: req.maxOutputTokens,
        temperature: req.temperature,
        abortSignal: req.signal,
        // Retries would be model calls the daily budget cannot see; the UI offers Retry instead.
        maxRetries: 0,
      });
      return {
        text: result.text,
        usage: { inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 },
      };
    } catch (error) {
      throw classifyAiError(error);
    }
  }

  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }

  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    const tools: ToolSet = {};
    for (const t of req.tools) {
      tools[t.name] = {
        description: t.description,
        inputSchema: t.inputSchema,
        execute: async (input: unknown, options: { toolCallId: string }) => t.execute(input, options.toolCallId),
      } as ToolSet[string];
    }
    const hasTools = req.tools.length > 0;
    let streamError: unknown = null;
    const result = streamText({
      model: this.model(),
      instructions: req.system,
      messages: req.messages,
      maxOutputTokens: req.maxOutputTokens,
      temperature: req.temperature,
      abortSignal: req.signal,
      // Retries would be model calls the daily budget cannot see; the UI offers Retry instead.
      maxRetries: 0,
      ...(hasTools
        ? {
            tools,
            // Every further step is another model call: stop at the step cap or when the daily budget is spent.
            stopWhen: ({ steps }: { steps: unknown[] }) =>
              steps.length >= req.maxIterations || (req.reserveNextStep ? !req.reserveNextStep() : false),
            // On the last allowed step, or once the tool budget is spent, force a plain-text answer.
            prepareStep: ({ stepNumber }: { stepNumber: number }) =>
              stepNumber >= req.maxIterations - 1 || req.toolBudgetExhausted() ? { toolChoice: "none" as const } : {},
          }
        : {}),
      onError: ({ error }: { error: unknown }) => {
        streamError = error;
      },
    });

    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            if (part.text) yield { type: "text", delta: part.text };
            break;
          case "tool-call":
            yield { type: "tool-start", id: part.toolCallId, name: part.toolName, input: part.input };
            break;
          case "tool-result":
            yield { type: "tool-end", id: part.toolCallId, name: part.toolName, output: part.output };
            break;
          case "tool-error":
            yield {
              type: "tool-end",
              id: part.toolCallId,
              name: part.toolName,
              output: null,
              error: part.error instanceof Error ? part.error.message : String(part.error),
            };
            break;
          case "finish":
            yield {
              type: "usage",
              usage: { inputTokens: part.totalUsage.inputTokens ?? 0, outputTokens: part.totalUsage.outputTokens ?? 0 },
            };
            break;
          case "error":
            throw part.error;
          default:
            break;
        }
      }
    } catch (error) {
      throw classifyAiError(error);
    }
    if (streamError) throw classifyAiError(streamError);
  }
}
