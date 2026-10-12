import type { Env } from "../env";
import type { Database } from "../db/database";
import type { SettingsService } from "../services/settings";

/** Dimensions of the mock embedder's vectors. */
export const EMBEDDING_DIMS = 384;

/** Output dimensions of the Workers AI embedding models whose size is known up front. */
export const MODEL_DIMS: Record<string, number> = {
  "@cf/baai/bge-small-en-v1.5": 384,
  "@cf/baai/bge-base-en-v1.5": 768,
  "@cf/baai/bge-large-en-v1.5": 1024,
  "@cf/baai/bge-m3": 1024,
};

export interface Embedder {
  readonly model: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Workers AI text embeddings in one call. Throws on any failure or malformed output.
 * A model missing from MODEL_DIMS starts at 0 dims and takes its size from the first
 * successful response; every later response must match it.
 */
export class WorkersAiEmbedder implements Embedder {
  private size: number;

  constructor(
    private readonly ai: Ai,
    readonly model: string,
  ) {
    this.size = MODEL_DIMS[model] ?? 0;
  }

  get dims(): number {
    return this.size;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const result = (await this.ai.run(this.model as "@cf/baai/bge-small-en-v1.5", { text: texts })) as { data?: unknown };
    const data = result?.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error(`Embedding response had ${Array.isArray(data) ? data.length : "no"} vectors for ${texts.length} texts`);
    }
    const first: unknown = data[0];
    const dims = this.size || (Array.isArray(first) ? first.length : 0);
    const vectors = data.map((row) => {
      if (dims <= 0 || !Array.isArray(row) || row.length !== dims || !row.every((v) => typeof v === "number" && Number.isFinite(v))) {
        throw new Error(`Embedding vector does not have ${this.size || "a consistent positive number of"} numeric dimensions`);
      }
      return Float32Array.from(row as number[]);
    });
    this.size = dims;
    return vectors;
  }
}

/** Word groups the mock treats as one concept, so paraphrases ("car" ~ "Tesla") land close together. */
const MOCK_CONCEPTS: string[][] = [
  ["car", "drive", "tesla", "bug", "vw", "oil", "vehicle"],
  ["vegetarian", "dinner", "meat", "meal", "food"],
  ["peanut", "peanuts", "reese's", "reeses", "allergic", "allergy"],
  ["city", "live", "portland", "denver"],
  ["heights", "mountains", "mountain", "hiking", "knee"],
];

const encoder = new TextEncoder();

/** 32-bit FNV-1a over the UTF-8 bytes of `s`. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const byte of encoder.encode(s)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic hashed bag-of-words embedder for development, demo mode and tests. */
export class MockEmbedder implements Embedder {
  readonly model = "mock-bge-384";
  readonly dims = EMBEDDING_DIMS;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.vector(t));
  }

  private vector(text: string): Float32Array {
    const v = new Float32Array(this.dims);
    const tokens = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
    const present = new Set(tokens.flatMap((t) => [t, t.replace(/'/g, "")]));
    for (const token of tokens) v[fnv1a32(token) % this.dims]! += 1;
    MOCK_CONCEPTS.forEach((members, i) => {
      if (members.some((m) => present.has(m))) v[fnv1a32(`concept:${i}`) % this.dims]! += 3;
    });
    const norm = Math.hypot(...v);
    if (norm > 0) for (let i = 0; i < v.length; i++) v[i]! /= norm;
    return v;
  }
}

/**
 * Chooses the embedder the way `TalorysAgent.aiProvider()` chooses the chat provider:
 * the mock in demo mode or explicit local development, Workers AI when bound, else null.
 */
export function createEmbedder(env: Env, settings: SettingsService, model: string): Embedder | null {
  if (settings.get().demoMode) return new MockEmbedder();
  if (env.TALORYS_ENV === "development" && env.TALORYS_MOCK_AI === "1") return new MockEmbedder();
  if (!env.AI) return null;
  return new WorkersAiEmbedder(env.AI, model);
}

/**
 * Base64 of the vector's little-endian Float32 bytes: the slim v1 TEXT vector format, kept to
 * decode legacy rows (see `convertLegacyVectors`) and for tests.
 */
export function encodeVector(v: Float32Array): string {
  const view = new DataView(new ArrayBuffer(v.length * 4));
  for (let i = 0; i < v.length; i++) view.setFloat32(i * 4, v[i]!, true);
  let binary = "";
  const bytes = new Uint8Array(view.buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function decodeVector(encoded: string): Float32Array {
  const binary = atob(encoded);
  const view = new DataView(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) view.setUint8(i, binary.charCodeAt(i));
  const out = new Float32Array(binary.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Cosine similarity; 0 when either vector is zero or the lengths differ. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** The text embedded for a memory. */
export function embeddingText(memory: { content: string; category: string }): string {
  return `${memory.content}\n${memory.category}`;
}

/** SHA-256 hex of the UTF-8 text. */
export async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Embedding requests recorded in `tal_semantic_usage` for a UTC day (YYYY-MM-DD).
 * One Workers AI call is one request; kept apart from `maxAiRequestsPerDay`.
 */
export function embeddingsToday(db: Database, day: string): number {
  return db.one<{ n: number }>(`SELECT embedding_requests AS n FROM tal_semantic_usage WHERE day = ?`, day)?.n ?? 0;
}

/**
 * Counts one embedding request before it is made, if the day's cap allows it. Check and
 * record happen in one synchronous step, so concurrent callers cannot all pass the cap.
 */
export function reserveEmbedding(db: Database, day: string, cap: number, tokens: number): boolean {
  if (embeddingsToday(db, day) >= cap) return false;
  recordEmbeddings(db, day, 1, tokens);
  return true;
}

export function recordEmbeddings(db: Database, day: string, requests: number, tokens: number): void {
  db.run(
    `INSERT INTO tal_semantic_usage (day, embedding_requests, embedded_tokens_estimate) VALUES (?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET embedding_requests = embedding_requests + excluded.embedding_requests,
       embedded_tokens_estimate = embedded_tokens_estimate + excluded.embedded_tokens_estimate`,
    day,
    Math.round(requests),
    Math.round(tokens),
  );
}
