import type { z } from "zod";
import { AppError } from "../api/errors";

export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  system: string;
  messages: ModelMessage[];
  maxOutputTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** A tool as seen by a provider. Execution limits are enforced by the caller-supplied `execute`. */
export interface ProviderTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute: (input: unknown, callId: string) => Promise<unknown>;
}

export interface ToolRequest extends GenerateRequest {
  tools: ProviderTool[];
  /** Maximum model round-trips (each may contain several tool calls). */
  maxIterations: number;
  /** Returns true when no further tool calls are allowed; the model must then answer in text. */
  toolBudgetExhausted: () => boolean;
  /**
   * Called before every model call after the first; it records the call against the
   * daily budget and returns false when the budget is spent, which ends the turn.
   */
  reserveNextStep?: () => boolean;
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool-start"; id: string; name: string; input: unknown }
  | { type: "tool-end"; id: string; name: string; output: unknown; error?: string }
  | { type: "usage"; usage: Usage };

/**
 * Provider abstraction. Workers AI is the only production provider in the MVP;
 * others (OpenRouter, Gemini, ...) can implement this interface later.
 */
export interface AIProvider {
  readonly id: string;
  generate(req: GenerateRequest): Promise<{ text: string; usage: Usage }>;
  stream(req: GenerateRequest): AsyncIterable<AgentEvent>;
  generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent>;
}

/** Rough token estimate (≈4 chars/token) used for budgeting and local usage estimates. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Maps Workers AI failures onto stable application errors.
 * 4006: daily free allocation exhausted. 3040 / 429: capacity or rate limits.
 */
export function classifyAiError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  if (lower.includes("4006") || lower.includes("free allocation") || lower.includes("neurons")) {
    return new AppError(
      "AI_QUOTA_EXHAUSTED",
      "Your Cloudflare account has used its Workers AI allocation for today. Tasks, notes, memories and reminders keep working; chat will resume when the quota resets.",
    );
  }
  if (lower.includes("3040") || lower.includes("capacity") || lower.includes("429") || lower.includes("rate limit") || lower.includes("too many")) {
    return new AppError("AI_UNAVAILABLE", "Workers AI is busy right now. Please try again in a moment.");
  }
  if (lower.includes("5007") || lower.includes("no such model") || lower.includes("model not found")) {
    return new AppError("AI_UNAVAILABLE", "The configured AI model is not available. Choose another model in Settings.");
  }
  if (lower.includes("abort")) {
    return new AppError("AI_UNAVAILABLE", "The response was cancelled.");
  }
  console.error("Workers AI error", message);
  return new AppError("AI_UNAVAILABLE", "The AI model could not respond. Please try again.");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return `${error.name}: ${error.message}${cause ? ` (${errorMessage(cause)})` : ""}`;
  }
  return String(error);
}
