import { describe, expect, it } from "vitest";
import { cosine } from "../src/semantic/embeddings";
import { FixtureEmbedder, SEED_TEXTS, fixtureConfig, fixtureKey } from "./fixture-embedder";
import fixture from "./fixtures/surface-vectors.json";

const QUERY_KEYS = Object.entries(fixture.texts as Record<string, Record<string, number>>)
  .filter(([, cosines]) => Object.values(cosines).includes(1))
  .map(([key]) => key);

describe("FixtureEmbedder", () => {
  it("FX-exact: query and item vectors have the declared cosine", async () => {
    const e = new FixtureEmbedder();
    const [botany, plants, hello, milk] = await e.embed(["botany", "Task: Water the plants", "hello", "Task: Buy milk and eggs"]);
    expect(Math.abs(cosine(botany!, plants!) - 0.62)).toBeLessThan(1e-6);
    expect(Math.abs(cosine(hello!, milk!) - 0.51)).toBeLessThan(1e-6);
    // The question forms the tests use map to the same axis.
    const [question] = await e.embed(["any tasks about botany?"]);
    expect(Math.abs(cosine(question!, plants!) - 0.62)).toBeLessThan(1e-6);
    // Every vector is unit length, and the config matches the embedder.
    for (const v of [botany!, plants!, hello!, milk!]) expect(Math.abs(Math.hypot(...v) - 1)).toBeLessThan(1e-6);
    expect(fixtureConfig()).toMatchObject({ enabled: true, model: e.model, vectorFloor: { absolute: 0.55, relative: 0.1, backstop: 0.4 } });
  });

  it("FX-unknown: text with no key is orthogonal to every query", async () => {
    const e = new FixtureEmbedder();
    expect(fixtureKey("Task: Clean the gutters")).toBe("");
    const [unknown] = await e.embed(["Task: Clean the gutters"]);
    const queries = await e.embed(QUERY_KEYS);
    expect(queries.length).toBeGreaterThan(20);
    for (const q of queries) expect(Math.abs(cosine(unknown!, q))).toBeLessThan(1e-6);
  });

  it("FX-seeds: every seed text resolves to its named key", () => {
    const entries = Object.entries(SEED_TEXTS);
    expect(entries.length).toBeGreaterThan(50);
    for (const [text, key] of entries) expect({ text, key: fixtureKey(text) }).toEqual({ text, key });
    // Short query keys match whole words only.
    expect(fixtureKey("this thing")).toBe("");
    expect(fixtureKey("Call Dr. Patel's office to book a physical")).toBe("book a physical");
  });

  it("FX-calls: records each call and fails exactly the next one", async () => {
    const e = new FixtureEmbedder();
    expect(await e.embed([])).toEqual([]);
    await e.embed(["botany", "hello"]);
    e.failNext = 1;
    await expect(e.embed(["gm"])).rejects.toThrow("fixture embed failure");
    expect(e.failNext).toBe(0);
    expect(await e.embed(["thx"])).toHaveLength(1);
    expect(e.calls).toEqual([[], ["botany", "hello"], ["gm"], ["thx"]]);
  });
});
