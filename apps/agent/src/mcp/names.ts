import { MCP_LIMITS } from "@talorys/shared";

export function slugFor(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 16) || "server";
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = String(i);
    const slug = base.slice(0, 16 - suffix.length) + suffix;
    if (!taken.has(slug)) return slug;
  }
}
export function providerToolName(slug: string, name: string): string | null {
  const tool = name.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = `mcp_${slug}_${tool}`;
  return tool && full.length <= 64 ? full : null;
}
export const clampDescription = (text: string) => text.slice(0, MCP_LIMITS.descriptionChars);
export async function schemaHash(schema: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(schema)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
