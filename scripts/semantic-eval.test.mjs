import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { SetupError, main, readModelAndFloor, readSectionCap, renderMarkdown, scoreCases } from "./semantic-eval.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const CONFIG = readFileSync(here("../apps/agent/src/semantic/config.ts"), "utf8");
const ITEM_RECALL = readFileSync(here("../apps/agent/src/semantic/itemRecall.ts"), "utf8");
const CASES = JSON.parse(readFileSync(here("./semantic-eval-cases.json"), "utf8"));
const FLOOR = 0.55;

/** A unit vector whose cosine with the query axis [1, 0] is `c`. */
const at = (c) => [c, Math.sqrt(1 - c * c)];

/** An embed function that looks each text up in `table`; unknown texts get an orthogonal vector. */
function fakeEmbed(table, calls = []) {
  return async (texts) => {
    calls.push(texts);
    return texts.map((t) => table[t] ?? [0, 1]);
  };
}

/** One query, a target and a distractor at the given cosines, plus a negative over the same items. */
function smallDoc(targetCos, distractorCos, negativeCos) {
  return {
    doc: {
      cases: [
        { id: "EX-P", query: "q", kind: "positive", target: "t", gating: true },
        { id: "EX-N", query: "n", kind: "negative", target: null, gating: true, exclude: ["t"] },
      ],
      items: [
        { id: "t", type: "task", texts: ["Task: target", "shared"] },
        { id: "d", type: "note", texts: ["Note: distractor"] },
      ],
      extra: [{ id: "XT-weather-umbrella", query: "weather tmrw", label: "umbrella reminder", target: "d" }],
    },
    table: {
      q: [1, 0],
      n: [1, 0],
      "weather tmrw": [1, 0],
      "Task: target": at(targetCos),
      shared: at(0.1),
      "Note: distractor": at(Math.max(distractorCos, negativeCos)),
    },
  };
}

describe("readModelAndFloor", () => {
  it("reads the default model and bge-m3 floor from the real config", () => {
    assert.deepEqual(readModelAndFloor(CONFIG), { model: "@cf/baai/bge-m3", floor: 0.55 });
  });

  it("names the missing value", () => {
    assert.throws(() => readModelAndFloor(CONFIG.replace("BGE_M3_FLOOR", "OTHER")), /absolute floor/);
    assert.throws(() => readModelAndFloor(CONFIG.replace('model: "@cf/baai/bge-m3"', "")), /default model/);
  });
});

describe("scoreCases", () => {
  it("passes when the positive clears the floor and the negative does not", async () => {
    const { doc, table } = smallDoc(0.7, 0.3, 0.3);
    const r = await scoreCases(doc, fakeEmbed(table), FLOOR);
    assert.equal(r.pass, true);
    const [p, n] = r.cases;
    assert.equal(p.pass, true);
    assert.equal(p.rank, 1);
    assert.equal(p.distractor, "d");
    assert.ok(Math.abs(p.targetScore - 0.7) < 1e-9);
    assert.ok(Math.abs(p.distractorScore - 0.3) < 1e-9);
    assert.equal(n.pass, true);
    assert.equal(n.target, null);
  });

  it("fails a positive under the floor, ranked below its distractor", async () => {
    const { doc, table } = smallDoc(0.5, 0.6, 0);
    const r = await scoreCases(doc, fakeEmbed(table), FLOOR);
    assert.equal(r.pass, false);
    assert.equal(r.cases[0].pass, false);
    assert.equal(r.cases[0].rank, 2);
  });

  it("fails a negative when any item clears the floor", async () => {
    const { doc, table } = smallDoc(0.9, 0.2, 0.6);
    const r = await scoreCases(doc, fakeEmbed(table), FLOOR);
    assert.equal(r.cases[0].pass, true);
    assert.equal(r.cases[1].pass, false);
    assert.equal(r.pass, false);
  });

  it("leaves non-gating cases and extra rows out of the verdict", async () => {
    const { doc, table } = smallDoc(0.9, 0.2, 0.6);
    doc.cases[1].gating = false;
    const r = await scoreCases(doc, fakeEmbed(table), FLOOR);
    assert.equal(r.pass, true);
    assert.equal(r.extra[0].id, "XT-weather-umbrella");
    assert.ok(Math.abs(r.extra[0].score - 0.6) < 1e-9);
  });

  it("honours a case's surfaces and excluded items", async () => {
    const { doc, table } = smallDoc(0.9, 0.2, 0.6);
    doc.cases[1].surfaces = ["task"];
    doc.cases[1].exclude = ["t"];
    const r = await scoreCases(doc, fakeEmbed(table), FLOOR);
    assert.equal(r.cases[1].pass, true);
    assert.equal(r.cases[1].distractor, null);
  });

  it("embeds each distinct text once", async () => {
    const { doc, table } = smallDoc(0.7, 0.3, 0.3);
    doc.items.push({ id: "dup", type: "task", texts: ["Task: target"] });
    const calls = [];
    await scoreCases(doc, fakeEmbed(table, calls), FLOOR);
    assert.equal(calls.length, 1);
    assert.equal(new Set(calls[0]).size, calls[0].length);
  });

  it("rejects a vector count that does not match the texts", async () => {
    const { doc } = smallDoc(0.7, 0.3, 0.3);
    await assert.rejects(scoreCases(doc, async () => [[1, 0]], FLOOR), SetupError);
  });

  it("rejects a target missing from the items", async () => {
    const { doc, table } = smallDoc(0.7, 0.3, 0.3);
    doc.cases[0].target = "missing";
    await assert.rejects(scoreCases(doc, fakeEmbed(table), FLOOR), /target missing/);
  });
});

describe("the cases file", () => {
  it("lists the 18 gating examples and the informational rows", () => {
    const ids = CASES.cases.map((c) => c.id);
    assert.equal(ids.length, 18);
    for (const prefix of ["EX-T", "EX-N", "EX-A"]) {
      for (let i = 1; i <= 6; i++) assert.ok(ids.includes(`${prefix}${i}`), `${prefix}${i}`);
    }
    assert.ok(CASES.cases.every((c) => c.gating === true));
    const queries = CASES.extra.map((x) => x.query);
    for (const q of ["weather tmrw", "trash", "do i have a reminder about trash", "garbage night?"]) assert.ok(queries.includes(q), q);
  });

  it("renders every case and the weather row with any embedder", async () => {
    let n = 0;
    const r = await scoreCases(CASES, async (texts) => texts.map(() => [1, ++n % 7, n % 3]), FLOOR);
    const md = renderMarkdown(r, { model: "@cf/baai/bge-m3", date: "2026-10-14T00:00:00.000Z", floor: FLOOR });
    for (const c of CASES.cases) assert.match(md, new RegExp(`^\\| ${c.id} \\|`, "m"));
    assert.match(md, /^\| XT-weather-umbrella \| weather tmrw \| umbrella reminder \| -?\d\.\d{3} \|$/m);
    assert.match(md, /Model: `@cf\/baai\/bge-m3`/);
    assert.match(md, /Floor: 0\.55/);
  });
});

describe("prompt section", () => {
  it("CI-o: a negative with an item at 0.6 fails because it would add a section", async () => {
    const { doc, table } = smallDoc(0.7, 0.3, 0.6);
    const r = await scoreCases(doc, fakeEmbed(table), FLOOR, 3);
    const n = r.cases.find((c) => c.id === "EX-N");
    assert.ok(n.sectionItems > 0);
    assert.equal(n.pass, false);
    assert.equal(r.pass, false);
  });

  it("CI-o: a negative with every item under 0.55 passes with no section", async () => {
    const { doc, table } = smallDoc(0.7, 0.3, 0.54);
    const r = await scoreCases(doc, fakeEmbed(table), FLOOR, 3);
    const n = r.cases.find((c) => c.id === "EX-N");
    assert.equal(n.sectionItems, 0);
    assert.equal(n.pass, true);
  });

  it("CI-o: a score exactly at the floor counts, and the section stops at the cap", async () => {
    const doc = {
      cases: [{ id: "EX-N", query: "n", kind: "negative", target: null, gating: true }],
      items: ["a", "b", "c"].map((id) => ({ id, type: "note", texts: [`Note: ${id}`] })),
    };
    // 0.6 is exact for a 3-4-5 vector, so it can stand in for the floor without rounding.
    const table = { n: [1, 0], "Note: a": at(0.9), "Note: b": at(0.8), "Note: c": [0.6, 0.8] };
    assert.equal((await scoreCases(doc, fakeEmbed(table), 0.6, 2)).cases[0].sectionItems, 2);
    assert.equal((await scoreCases(doc, fakeEmbed(table), 0.6, 3)).cases[0].sectionItems, 3);
  });

  it("CI-o: an empty pool gives no section", async () => {
    const doc = {
      cases: [{ id: "EX-N", query: "n", kind: "negative", target: null, gating: true, surfaces: ["automation"] }],
      items: [{ id: "a", type: "note", texts: ["Note: a"] }],
    };
    const r = await scoreCases(doc, fakeEmbed({ n: [1, 0], "Note: a": at(0.9) }), FLOOR, 3);
    assert.equal(r.cases[0].sectionItems, 0);
    assert.equal(r.cases[0].pass, true);
  });

  it("CI-o: the report has a Prompt section column before Result", async () => {
    const { doc, table } = smallDoc(0.7, 0.3, 0.6);
    const md = renderMarkdown(await scoreCases(doc, fakeEmbed(table), FLOOR, 3), { model: "m", date: "d", floor: FLOOR });
    assert.match(md, /\| Distractor cosine \| Prompt section \| Result \|/);
    assert.match(md, /^\| EX-N \|.*\| 1 item \| FAIL \|$/m);
    const { doc: quiet, table: quietTable } = smallDoc(0.7, 0.3, 0.3);
    const quietMd = renderMarkdown(await scoreCases(quiet, fakeEmbed(quietTable), FLOOR, 3), { model: "m", date: "d", floor: FLOOR });
    assert.match(quietMd, /^\| EX-N \|.*\| none \| pass \|$/m);
  });

  it("CI-o: the cap reader reads MAX_RECALLED_ITEMS from the real source", () => {
    assert.equal(readSectionCap(ITEM_RECALL), 3);
    assert.throws(() => readSectionCap(ITEM_RECALL.replace("MAX_RECALLED_ITEMS", "OTHER")), SetupError);
  });
});

/** A fetch that answers Workers AI embedding calls from `table` and records each batch size. */
function fakeFetch(table, batches = [], override) {
  return async (url, init) => {
    assert.match(url, /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/acct\/ai\/run\/@cf\/baai\/bge-m3$/);
    const { text } = JSON.parse(init.body);
    batches.push(text.length);
    const body = override ?? { success: true, result: { shape: [text.length, 2], data: text.map((t) => table[t] ?? [0, 1]) } };
    return { ok: true, status: 200, json: async () => body };
  };
}

describe("main", () => {
  const env = { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "token" };
  const sink = () => {
    const out = { text: "", write: (s) => (out.text += s) };
    return out;
  };
  const setup = (targetCos, negativeCos) => {
    const dir = mkdtempSync(join(tmpdir(), "semantic-eval-"));
    const { doc, table } = smallDoc(targetCos, 0.2, negativeCos);
    const casesPath = join(dir, "cases.json");
    writeFileSync(casesPath, JSON.stringify(doc));
    return { table, casesPath, outPath: join(dir, "semantic-eval.md") };
  };

  it("exits 0 and writes the report when every gating case passes", async () => {
    const { table, casesPath, outPath } = setup(0.7, 0.3);
    const code = await main({ env, fetch: fakeFetch(table), casesPath, outPath, stdout: sink(), stderr: sink() });
    assert.equal(code, 0);
    assert.match(readFileSync(outPath, "utf8"), /Result: PASS/);
  });

  it("exits 1 and still writes the report when a gating case fails", async () => {
    const { table, casesPath, outPath } = setup(0.7, 0.6);
    const code = await main({ env, fetch: fakeFetch(table), casesPath, outPath, stdout: sink(), stderr: sink() });
    assert.equal(code, 1);
    assert.match(readFileSync(outPath, "utf8"), /Result: FAIL/);
  });

  it("sends at most 100 texts per request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "semantic-eval-"));
    const batches = [];
    const code = await main({ env, fetch: fakeFetch({}, batches), outPath: join(dir, "out.md"), stdout: sink(), stderr: sink() });
    assert.notEqual(code, 2);
    assert.ok(batches.length > 0 && batches.every((n) => n <= 100));
  });

  it("exits 2 without credentials and writes nothing", async () => {
    const { table, casesPath, outPath } = setup(0.7, 0.3);
    const stderr = sink();
    const code = await main({ env: {}, fetch: fakeFetch(table), casesPath, outPath, stdout: sink(), stderr });
    assert.equal(code, 2);
    assert.match(stderr.text, /CLOUDFLARE_ACCOUNT_ID/);
    assert.equal(existsSync(outPath), false);
  });

  it("exits 2 on an API error or a short data array and writes nothing", async () => {
    for (const override of [{ success: false, errors: [{ message: "bad token" }] }, { success: true, result: { data: [[1, 0]] } }]) {
      const { table, casesPath, outPath } = setup(0.7, 0.3);
      const code = await main({ env, fetch: fakeFetch(table, [], override), casesPath, outPath, stdout: sink(), stderr: sink() });
      assert.equal(code, 2);
      assert.equal(existsSync(outPath), false);
    }
  });

  it("exits 2 as a command without credentials", () => {
    const childEnv = { ...process.env };
    delete childEnv.CLOUDFLARE_ACCOUNT_ID;
    delete childEnv.CLOUDFLARE_API_TOKEN;
    const r = spawnSync(process.execPath, [here("./semantic-eval.mjs")], { env: childEnv, encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /CLOUDFLARE_API_TOKEN/);
  });
});
