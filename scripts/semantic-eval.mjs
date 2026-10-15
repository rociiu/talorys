// Scores the semantic surface examples against the real embedding model over the Workers AI REST API.
// Usage: CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... node scripts/semantic-eval.mjs
// Writes docs/semantic-eval.md; exits 0 when every gating case passes, 1 when one fails, 2 on a setup or API error.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const BATCH = 100;

/** An error that ends the run with exit code 2 and writes nothing. */
export class SetupError extends Error {}

/** The default model and its absolute floor, read from the agent's semantic config source. */
export function readModelAndFloor(configSource) {
  const model = configSource.match(/DEFAULT_SEMANTIC_CONFIG[^=]*=\s*\{[^}]*?model:\s*"([^"]+)"/)?.[1];
  const floor = configSource.match(/BGE_M3_FLOOR[^=]*=\s*\{[^}]*?absolute:\s*([\d.]+)/)?.[1];
  if (!model) throw new SetupError("Could not read the default model from config.ts");
  if (!floor) throw new SetupError("Could not read the bge-m3 absolute floor from config.ts");
  return { model, floor: Number(floor) };
}

/** The most items one prompt section lists, read from the agent's item recall source. */
export function readSectionCap(itemRecallSource) {
  const cap = itemRecallSource.match(/export const MAX_RECALLED_ITEMS\s*=\s*(\d+)\s*;/)?.[1];
  if (!cap) throw new SetupError("Could not read MAX_RECALLED_ITEMS from itemRecall.ts");
  return Number(cap);
}

/** Checks that every case and extra row names an item that exists; throws on the first that does not. */
export function validateCases(doc) {
  if (!Array.isArray(doc?.cases) || !Array.isArray(doc?.items)) throw new SetupError("Cases file needs cases and items arrays");
  const ids = new Set(doc.items.map((i) => i.id));
  for (const c of doc.cases) {
    if (c.kind === "positive" && !ids.has(c.target)) throw new SetupError(`${c.id}: target ${c.target} is not an item`);
    for (const id of c.exclude ?? []) if (!ids.has(id)) throw new SetupError(`${c.id}: excluded ${id} is not an item`);
  }
  for (const x of doc.extra ?? []) {
    if (!x.texts && !ids.has(x.target)) throw new SetupError(`${x.id}: target ${x.target} is not an item`);
  }
}

function normalize(v) {
  const n = Math.hypot(...v);
  return n ? v.map((x) => x / n) : v;
}

const cosine = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);

/**
 * Embeds every distinct query and part text once, then scores each case: an item's score is its
 * best part, a positive passes when its target clears the floor, a negative when no item does.
 * Each case also counts the items its prompt section would list: those in its pool at or above the
 * floor, best first, at most `cap`, with nothing under the floor falling back in. A negative fails
 * when that section would not be empty.
 */
export async function scoreCases(doc, embed, floor, cap = 3) {
  validateCases(doc);
  const extra = doc.extra ?? [];
  const texts = [
    ...new Set([
      ...doc.cases.map((c) => c.query),
      ...doc.items.flatMap((i) => i.texts),
      ...extra.flatMap((x) => [x.query, ...(x.texts ?? [])]),
    ]),
  ];
  const vectors = await embed(texts);
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new SetupError(`Expected ${texts.length} vectors, got ${Array.isArray(vectors) ? vectors.length : "none"}`);
  }
  const byText = new Map(texts.map((t, i) => [t, normalize(vectors[i])]));
  const score = (query, parts) => Math.max(...parts.map((t) => cosine(byText.get(query), byText.get(t))));

  const cases = doc.cases.map((c) => {
    const pool = doc.items.filter((i) => !(c.exclude ?? []).includes(i.id) && (!c.surfaces || c.surfaces.includes(i.type)));
    const ranked = pool.map((i) => ({ id: i.id, score: score(c.query, i.texts) })).sort((a, b) => b.score - a.score);
    const targetIndex = ranked.findIndex((r) => r.id === c.target);
    const distractor = ranked.find((r) => r.id !== c.target) ?? null;
    const sectionItems = Math.min(cap, ranked.filter((r) => r.score >= floor).length);
    const pass = c.kind === "positive" ? targetIndex >= 0 && ranked[targetIndex].score >= floor : sectionItems === 0;
    return {
      id: c.id,
      query: c.query,
      kind: c.kind,
      target: c.target,
      gating: c.gating !== false,
      targetScore: targetIndex >= 0 ? ranked[targetIndex].score : null,
      rank: targetIndex >= 0 ? targetIndex + 1 : null,
      distractor: distractor?.id ?? null,
      distractorScore: distractor?.score ?? null,
      sectionItems,
      pass,
    };
  });
  const extras = extra.map((x) => ({
    id: x.id,
    query: x.query,
    label: x.label ?? x.target,
    score: score(x.query, x.texts ?? doc.items.find((i) => i.id === x.target).texts),
  }));
  return { cases, extra: extras, pass: cases.every((c) => !c.gating || c.pass) };
}

const fmt = (n) => (n === null ? "—" : n.toFixed(3));
const cell = (s) => String(s).replaceAll("|", "\\|");
const section = (n) => (n === 0 ? "none" : `${n} item${n === 1 ? "" : "s"}`);

/** The report: one row per case, then the informational rows. */
export function renderMarkdown(results, { model, date, floor }) {
  const lines = [
    "# Semantic surfaces eval",
    "",
    `Model: \`${model}\`  `,
    `Date: ${date}  `,
    `Floor: ${floor}`,
    "",
    `Result: ${results.pass ? "PASS" : "FAIL"} (${results.cases.filter((c) => c.pass).length}/${results.cases.length} cases pass)`,
    "",
    "| Case | Query | Kind | Target | Target cosine | Rank | Best distractor | Distractor cosine | Prompt section | Result |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.cases.map((c) =>
      [
        c.id,
        cell(c.query),
        c.kind,
        c.target ?? "—",
        fmt(c.targetScore),
        c.rank ?? "—",
        c.distractor ?? "—",
        fmt(c.distractorScore),
        section(c.sectionItems),
        c.pass ? "pass" : "FAIL",
      ].join(" | "),
    ).map((row) => `| ${row} |`),
  ];
  if (results.extra.length) {
    lines.push("", "## Informational rows", "", "| Row | Query | Against | Cosine |", "| --- | --- | --- | --- |");
    for (const x of results.extra) lines.push(`| ${x.id} | ${cell(x.query)} | ${cell(x.label)} | ${fmt(x.score)} |`);
  }
  return lines.join("\n") + "\n";
}

/** An embed function over the Workers AI REST API, in batches of at most BATCH texts. */
export function restEmbedder({ accountId, token, model, fetch: doFetch = fetch }) {
  return async (texts) => {
    const out = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      const res = await doFetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: batch }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        throw new SetupError(`Workers AI returned ${res.status}: ${JSON.stringify(body?.errors ?? body)}`);
      }
      const data = body.result?.data;
      if (!Array.isArray(data) || data.length !== batch.length) {
        throw new SetupError(`Workers AI returned ${Array.isArray(data) ? data.length : "no"} vectors for ${batch.length} texts`);
      }
      out.push(...data);
    }
    return out;
  };
}

/** Runs the eval and returns the exit code. Every option defaults to the real files and environment. */
export async function main({
  env = process.env,
  fetch: doFetch = fetch,
  configPath = fileURLToPath(new URL("apps/agent/src/semantic/config.ts", ROOT)),
  itemRecallPath = fileURLToPath(new URL("apps/agent/src/semantic/itemRecall.ts", ROOT)),
  casesPath = fileURLToPath(new URL("scripts/semantic-eval-cases.json", ROOT)),
  outPath = fileURLToPath(new URL("docs/semantic-eval.md", ROOT)),
  date = new Date().toISOString(),
  stderr = process.stderr,
  stdout = process.stdout,
} = {}) {
  try {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const token = env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !token) throw new SetupError("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to run the eval");
    const { model, floor } = readModelAndFloor(readFileSync(configPath, "utf8"));
    const cap = readSectionCap(readFileSync(itemRecallPath, "utf8"));
    const doc = JSON.parse(readFileSync(casesPath, "utf8"));
    const results = await scoreCases(doc, restEmbedder({ accountId, token, model, fetch: doFetch }), floor, cap);
    writeFileSync(outPath, renderMarkdown(results, { model, date, floor }));
    stdout.write(`${results.pass ? "PASS" : "FAIL"}: wrote ${outPath}\n`);
    return results.pass ? 0 : 1;
  } catch (error) {
    stderr.write(`semantic-eval: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
