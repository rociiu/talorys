import { estimateTokens, modelUsage, tokens, type Usage } from "../src/ai/provider";
import { DEFAULT_SEMANTIC_CONFIG, type SemanticConfig } from "../src/semantic/config";
import type { Embedder } from "../src/semantic/embeddings";
import fixture from "./fixtures/surface-vectors.json";

/** Axis dims come first; dims from RESIDUAL_START up hold each text's leftover length. */
const DIMS = 64;
const RESIDUAL_START = 48;

type Cosines = Record<string, number>;

/** The surface floors the acceptance tests run with (the bge-m3 defaults, spelled out). */
export const SURFACE_FLOOR: SemanticConfig["vectorFloor"] = { absolute: 0.55, relative: 0.1, backstop: 0.4 };

/** Semantic config for a database searched with `FixtureEmbedder`. */
export function fixtureConfig(): SemanticConfig {
  return {
    ...DEFAULT_SEMANTIC_CONFIG,
    enabled: true,
    model: "fixture-64",
    vectorFloor: { ...SURFACE_FLOOR },
    maxEmbeddingsPerDay: 10_000,
  };
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(s)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const axes: string[] = fixture.axes;
const texts = fixture.texts as Record<string, Cosines>;
/** Matchers in file order, so the first of two equally long keys wins. */
const matchers = Object.keys(texts).map((key) => ({ key, re: new RegExp(`\\b${escapeRegExp(key)}\\b`) }));

function validate(): void {
  if (axes.length > RESIDUAL_START) throw new Error(`surface-vectors.json has ${axes.length} axes, at most ${RESIDUAL_START}`);
  for (const [key, cosines] of Object.entries(texts)) {
    if (key !== key.toLowerCase()) throw new Error(`surface-vectors.json key "${key}" is not lowercase`);
    let sum = 0;
    for (const [axis, value] of Object.entries(cosines)) {
      if (!axes.includes(axis)) throw new Error(`surface-vectors.json key "${key}" names unknown axis "${axis}"`);
      sum += value * value;
    }
    if (sum > 1 + 1e-9) throw new Error(`surface-vectors.json key "${key}" has cosines with squares summing to ${sum}`);
  }
  for (const [text, key] of Object.entries(fixture.seedTexts)) {
    if (key !== "" && !(key in texts)) throw new Error(`surface-vectors.json seed "${text}" names unknown key "${key}"`);
  }
}
validate();

/** The fixture key a text resolves to: the longest key found in it as whole words, or "" for none. */
export function fixtureKey(text: string): string {
  const lower = text.toLowerCase();
  let best = "";
  for (const { key, re } of matchers) if (key.length > best.length && re.test(lower)) best = key;
  return best;
}

/** Every seeded item and query text the surface tests use, with the key it must resolve to. */
export const SEED_TEXTS: Record<string, string> = fixture.seedTexts;

/**
 * Embedder with exact, known cosines for surface acceptance tests. A query key's vector is a
 * pure axis, and an item key's vector has its declared cosine on each axis, so cosine(query,
 * item) is exactly the fixture value. Unmatched text lands on a residual dim alone, at cosine 0
 * with every query. `calls` records each call's texts; `failNext` makes that many calls throw.
 */
export class FixtureEmbedder implements Embedder {
  readonly model = "fixture-64";
  readonly dims = DIMS;
  readonly billable = false;
  readonly calls: string[][] = [];
  failNext = 0;

  async embed(texts: string[], onUsage?: (usage: Usage) => void): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("fixture embed failure");
    }
    if (texts.length === 0) return [];
    onUsage?.(modelUsage(this.model, this.billable, tokens(undefined, texts.reduce((n, t) => n + estimateTokens(t), 0))));
    return texts.map((t) => this.vector(t));
  }

  vector(text: string): Float32Array {
    const v = new Float32Array(DIMS);
    const key = fixtureKey(text);
    let sum = 0;
    for (const [axis, value] of Object.entries(key ? texts[key]! : {})) {
      v[axes.indexOf(axis)] = value;
      sum += value * value;
    }
    v[RESIDUAL_START + (fnv1a32(text) % (DIMS - RESIDUAL_START))] = Math.sqrt(Math.max(0, 1 - sum));
    const norm = Math.hypot(...v);
    for (let i = 0; i < v.length; i++) v[i]! /= norm;
    return v;
  }
}
