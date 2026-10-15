import type { Memory } from "@talorys/shared";
import type { ToolDefinition } from "../tools";

/**
 * The seam between the upstream `AgentRunner` and the semantic module. When the
 * runner is constructed without extensions it runs the upstream expressions unchanged.
 */
export interface RunnerExtensions {
  /** Replaces upstream `selectRelevantMemories` for chat and scheduled runs. */
  selectMemories(query: string): Promise<Memory[]>;
  /**
   * The finished items section for a chat turn's prompt (heading and lines), or undefined for
   * none. Chat turns only: scheduled runs never call it. Without this hook the prompt has no
   * items section.
   */
  selectItems?(query: string): Promise<string | undefined>;
  /** Replaces upstream `ALL_TOOLS`. */
  tools: ToolDefinition[];
}
