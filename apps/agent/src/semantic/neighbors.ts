import type { Memory } from "@talorys/shared";
import { estimateTokens } from "../ai/provider";
import { now } from "../db/database";
import type { Env } from "../env";
import type { Services } from "../services/container";
import { UsageService } from "../services/usage";
import { contentHash, embeddingText, reserveEmbedding } from "./embeddings";
import { cachedSemanticConfig } from "./index";
import { ensureSemanticSchema } from "./migrations";
import { createSemanticContext } from "./recall";
import { cachedVectors, dot, upsertVectors, vectorMetaFor } from "./vectorStore";

export interface NeighborOptions {
  /** Lowest cosine returned; the walk stops at the first neighbor below it. */
  minCosine: number;
  /** Most neighbors returned. */
  limit: number;
  /** Ids never returned. */
  exclude: ReadonlySet<string>;
}

/**
 * Current, older memories by cosine to `memory`, best first, for the memory-history AI check:
 * at most `opts.limit`, each at or above `opts.minCosine`. Only memories whose stored vector
 * matches their current text are scored; the rest wait for the background index. The saved
 * memory's own vector is reused when current, otherwise it alone is embedded, under the daily
 * cap. Empty when semantic recall is off, there is no embedder, or the embed is capped or fails.
 */
export async function semanticNeighbors(
  services: Services,
  env: Env,
  memory: Memory,
  opts: NeighborOptions,
): Promise<{ id: string; cosine: number }[]> {
  const config = cachedSemanticConfig(services);
  if (!config?.enabled) return [];
  const db = services.db;
  ensureSemanticSchema(db);
  const { embedder } = createSemanticContext(services, env, config);
  if (!embedder) return [];

  const text = embeddingText(memory);
  const hash = await contentHash(text);
  const meta = vectorMetaFor(db, memory.id);
  let own =
    meta && meta.model === embedder.model && meta.content_hash === hash && (embedder.dims === 0 || meta.dims === embedder.dims)
      ? cachedVectors(db, embedder.model, embedder.dims).get(memory.id)
      : undefined;
  if (!own) {
    const day = UsageService.day();
    // Check and count in one synchronous step before the call, so concurrent saves cannot all
    // pass the cap. A failed call still counts, because it was reserved first.
    if (!reserveEmbedding(db, day, config.maxEmbeddingsPerDay, estimateTokens(text))) return [];
    try {
      const vectors = await embedder.embed([text]);
      if (vectors.length !== 1 || vectors[0]!.length !== embedder.dims) throw new Error(`Embedder returned ${vectors.length} vectors for 1 text`);
      upsertVectors(db, [{ memoryId: memory.id, model: embedder.model, dims: embedder.dims, contentHash: hash, vector: vectors[0]!, updatedAt: now() }]);
    } catch (error) {
      console.warn("memory.neighbors_embed_failed", (error as Error).name);
      return [];
    }
    own = cachedVectors(db, embedder.model, embedder.dims).get(memory.id);
    if (!own) return [];
  }

  const vectors = cachedVectors(db, embedder.model, embedder.dims);
  const scored: { id: string; cosine: number }[] = [];
  for (const [id, vector] of vectors) if (id !== memory.id && !opts.exclude.has(id)) scored.push({ id, cosine: dot(own, vector) });
  scored.sort((a, b) => b.cosine - a.cosine);

  const out: { id: string; cosine: number }[] = [];
  for (const n of scored) {
    if (out.length >= opts.limit || n.cosine < opts.minCosine) break;
    const candidate = services.memories.get(n.id);
    if (!candidate || candidate.status === "historical" || candidate.created_at > memory.updated_at) continue;
    if (vectorMetaFor(db, n.id)?.content_hash !== (await contentHash(embeddingText(candidate)))) continue;
    out.push(n);
  }
  return out;
}
