import type { Memory } from "@talorys/shared";
import type { Env } from "../env";
import type { Services } from "../services/container";
import { cachedSemanticConfig } from "./index";
import { runIndexer } from "./indexer";
import { ensureSemanticSchema } from "./migrations";
import { createSemanticContext } from "./recall";
import { cachedVectors, dot } from "./vectorStore";

/**
 * Other memories by cosine to `memory`, best first, for the memory-history AI check. Brings the
 * vector store up to date first, so the new memory is embedded once, by the indexer, under the
 * daily cap. Empty when semantic recall is off, there is no embedder, or the memory has no vector.
 */
export async function semanticNeighbors(services: Services, env: Env, memory: Memory): Promise<{ id: string; cosine: number }[]> {
  const config = cachedSemanticConfig(services);
  if (!config?.enabled) return [];
  ensureSemanticSchema(services.db);
  const ctx = createSemanticContext(services, env, config);
  if (!ctx.embedder) return [];
  await runIndexer(ctx);
  const vectors = cachedVectors(services.db, ctx.embedder.model, ctx.embedder.dims);
  const own = vectors.get(memory.id);
  if (!own) return [];
  const out: { id: string; cosine: number }[] = [];
  for (const [id, vector] of vectors) if (id !== memory.id) out.push({ id, cosine: dot(own, vector) });
  return out.sort((a, b) => b.cosine - a.cosine);
}
