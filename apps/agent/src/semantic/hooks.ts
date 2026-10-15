import type { Memory } from "@talorys/shared";
import type { PromptMemory } from "../memory/service";
import type { ToolDefinition } from "../tools";

/**
 * The seam between the upstream `AgentRunner` and the semantic module. When the
 * runner is constructed without extensions it runs the upstream expressions unchanged.
 */
export interface RunnerExtensions {
  /** Replaces upstream `selectRelevantMemories` for chat and scheduled runs. */
  selectMemories(query: string): Promise<Memory[]>;
  /**
   * Item lines for the prompt, given the memories it already lists and the memory token
   * budget they share. Without this hook the prompt has no items section.
   */
  selectItems?(query: string, memories: PromptMemory[], budget: number): Promise<string[]>;
  /** Replaces upstream `ALL_TOOLS`. */
  tools: ToolDefinition[];
}
