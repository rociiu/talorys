import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { FixtureEmbedder, SURFACE_FLOOR, fixtureConfig } from "./fixture-embedder";
import { invalidateSemanticCache } from "../src/semantic";
import { deleteSemanticConfig } from "../src/semantic/config";
import { dropSemanticData } from "../src/semantic/migrations";
import type { SemanticContext } from "../src/semantic/recall";
import { runItemPass } from "../src/semantic/itemIndex";
import { semanticTools } from "../src/semantic/tools";
import { ALL_TOOLS, type ToolContext, type ToolDefinition } from "../src/tools";
import type { ImmediateTool } from "../src/tools/registry";
import type { Services } from "../src/services/container";
import type { TalorysAgent } from "../src/agent/talorys-agent";
import type { ScheduleSpec } from "@talorys/shared";

type Entry = { id: string; title?: string; name?: string; excerpt?: string; match?: string };
type TaskList = { count: number; tasks: Entry[] };
type NoteResults = { results: Entry[] };
type SearchResult = { tasks: Entry[]; notes: Entry[]; memories: unknown[]; conversations: unknown[]; automations?: Entry[] };

/** Clears items and semantic state; the agent's own config stays off, so routes start no pass. */
function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
}

/** A fresh enabled context over the agent's database, searched with the fixture embedder. */
function setup(a: TalorysAgent) {
  const s = a.services;
  reset(s);
  const sem: SemanticContext = { db: s.db, services: s, embedder: new FixtureEmbedder(), config: fixtureConfig(), queryVectors: new Map() };
  const toolCtx: ToolContext = { services: s, timezone: "UTC", mode: "chat" };
  const tools = semanticTools(sem);
  // The whole seed is indexed first: a search embeds only a few pending parts itself.
  const run = async <T>(name: string, input: unknown, from: ToolDefinition[] = tools) => {
    await runItemPass(sem, { maxEmbed: 500 });
    return (from.find((t) => t.name === name) as ImmediateTool).execute(input, toolCtx) as Promise<T>;
  };
  return { s, run, seeds: seed(s) };
}

/** A paragraph of about 1,100 characters that only `phrase` gives a fixture key. */
const paragraph = (phrase: string) => `${phrase}. ${"lorem ipsum dolor sit amet ".repeat(45)}`.slice(0, 1100).trim();

/** Five paragraphs, well over 4,000 characters, so five chunks with the pet clause in chunk 3. */
const LEASE = [
  "Term of the tenancy is twelve months from the signing date",
  "Utilities for water and power are billed to the tenant monthly",
  "Pets are allowed with a 300 deposit, one animal per unit.",
  "Parking is one assigned space behind the building",
  "Move out requires sixty days of written notice to the landlord",
].map(paragraph).join("\n\n");

const reminder = (s: Services, name: string, schedule: ScheduleSpec = { type: "daily", time: "08:00" }) =>
  s.automationsRepo.create({ name, kind: "reminder", message: name, schedule, enabled: true });

/** Every target of §10.6 plus the §10.2 distractors of its surface, so a positive must win against real competition. */
function seed(s: Services) {
  const task = (title: string) => s.tasks.create({ title });
  const note = (title: string, content: string) => s.notes.create({ title, content });
  const tasks = {
    patel: task("Call Dr. Patel's office to book a physical"),
    passport: task("Renew passport before the March trip"),
    brakes: task("Get the brakes looked at"),
  };
  for (const title of ["Water the plants", "Renew Tesla registration", "Call the dentist", "Buy milk and eggs", "Clean the gutters"]) task(title);
  const notes = {
    skillet: note("Father's Day: he's been eyeing a cast-iron skillet, 12 inch, Lodge", "Target has them in stock"),
    keypad: note("Side gate keypad: 4417, then press #", "Works after dark too"),
    apron: note("Mom: wants a new gardening apron, size M, likes navy", "Birthday is in May"),
    router: note("Router", "Router: Netgear, network HomeNet-5G, pw on sticker under base"),
    lease: note("Lease", LEASE),
    review: note("Restaurant review", "Osteria Nonna: great cacio e pepe, slow service, four stars"),
  };
  note("Lisbon itinerary", "Day 1: Alfama walk, Day 2: Belem and Sintra");
  note("Lake house", "Wifi network Loon5G, password maple-4417");
  note("Reading list", "Piranesi, The Overstory");
  // Reworded so they share no words with the dad-gift and door-code questions.
  note("Mom's birthday: gardening gloves, the cookbook she mentioned, spa gift card", "Before May");
  note("Garage opener remote lives in the hall drawer", "Spare battery in the same drawer");
  note("Weeknight recipes", "Chili, lentil soup, sheet-pan salmon");
  // The name keeps "Thursday": "garbage night?" shares no word with it, unlike "trash day?".
  const automations = {
    bins: reminder(s, "Every Thursday 7 PM: remind me to put the bins out", { type: "weekly", days: [4], time: "19:00" }),
    rent: reminder(s, "Pay rent", { type: "monthly", day: 1, time: "09:00" }),
    vitamin: reminder(s, "Take vitamin D"),
    plumber: reminder(s, "call the plumber Tuesday", { type: "once", at: "2026-10-20T09:00:00.000Z" }),
    umbrella: reminder(s, "remind me to bring an umbrella if rain"),
  };
  // The plumber reminder already fired: a one-shot is left completed and disabled.
  s.automationsRepo.update(automations.plumber.id, { status: "completed", enabled: false, next_run: null, schedule_id: null });
  for (const name of ["Take Lipitor", "Morning digest", "Time to stretch"]) reminder(s, name);
  return { tasks, notes, automations };
}

const meaningIds = (entries: Entry[] | undefined) => (entries ?? []).filter((e) => e.match === "meaning").map((e) => e.id);
const ids = (entries: Entry[] | undefined) => (entries ?? []).map((e) => e.id);

/** Fixture cosine between a question and an item's embedded text. */
function cosine(query: string, text: string) {
  const e = new FixtureEmbedder();
  const a = e.vector(query), b = e.vector(text);
  return a.reduce((sum, v, i) => sum + v * b[i]!, 0);
}

/** The target clears the absolute floor; rank against other items is not asserted. */
function expectClearsFloor(query: string, text: string) {
  expect(cosine(query, text)).toBeGreaterThanOrEqual(SURFACE_FLOOR.absolute);
}

/** No entry anywhere in a tool result carries a `match` field. */
function expectNoMeaning(result: unknown) {
  expect(JSON.stringify(result)).not.toContain('"match"');
}

describe("semantic surface examples: tasks", () => {
  it("EX-T1: doc appt soon? finds the Patel task on list_tasks and search", async () => {
    await inAgent(async (a) => {
      const { run, seeds } = setup(a);
      const patel = seeds.tasks.patel.id;

      expect(meaningIds((await run<TaskList>("list_tasks", { query: "doc appt soon?" })).tasks)).toContain(patel);
      expect(meaningIds((await run<SearchResult>("search", { query: "doc appt soon?" })).tasks)).toContain(patel);
      expect(ids((await run<TaskList>("list_tasks", { query: "doc appt soon?" }, ALL_TOOLS)).tasks)).not.toContain(patel);
      expect(ids((await run<SearchResult>("search", { query: "doc appt soon?" }, ALL_TOOLS)).tasks)).not.toContain(patel);
    });
  });

  it("EX-T2: travel prep? finds the passport task", async () => {
    await inAgent(async (a) => {
      const { run, seeds } = setup(a);
      const passport = seeds.tasks.passport.id;

      expect(meaningIds((await run<TaskList>("list_tasks", { query: "travel prep?" })).tasks)).toContain(passport);
      expect(ids((await run<TaskList>("list_tasks", { query: "travel prep?" }, ALL_TOOLS)).tasks)).not.toContain(passport);
    });
  });

  it("EX-T3: car stuff? finds the brakes task", async () => {
    await inAgent(async (a) => {
      const { run, seeds } = setup(a);
      const brakes = seeds.tasks.brakes.id;

      expect(meaningIds((await run<TaskList>("list_tasks", { query: "car stuff?" })).tasks)).toContain(brakes);
      expect(ids((await run<TaskList>("list_tasks", { query: "car stuff?" }, ALL_TOOLS)).tasks)).not.toContain(brakes);
    });
  });

  it("a done Patel task is no meaning addition for doc appt soon?", async () => {
    await inAgent(async (a) => {
      const { s, run, seeds } = setup(a);
      s.tasks.complete(seeds.tasks.patel.id);

      expectNoMeaning(await run("list_tasks", { query: "doc appt soon?" }));
      const search = await run<SearchResult>("search", { query: "doc appt soon?" });
      expect(meaningIds(search.tasks)).not.toContain(seeds.tasks.patel.id);
      expectNoMeaning(search);
    });
  });

  it("EX-T4: whats 2+2 adds nothing", async () => {
    await inAgent(async (a) => {
      const { run } = setup(a);
      expectNoMeaning(await run("list_tasks", { query: "whats 2+2" }));
      expectNoMeaning(await run("search", { query: "whats 2+2" }));
    });
  });

  it("EX-T5: gm adds nothing", async () => {
    await inAgent(async (a) => {
      const { run } = setup(a);
      expectNoMeaning(await run("list_tasks", { query: "gm" }));
      expectNoMeaning(await run("search", { query: "gm" }));
    });
  });

  it("EX-T6: capital of france adds nothing", async () => {
    await inAgent(async (a) => {
      const { run } = setup(a);
      expectNoMeaning(await run("list_tasks", { query: "capital of france" }));
      expectNoMeaning(await run("search", { query: "capital of france" }));
    });
  });
});

describe("semantic surface examples: notes", () => {
  it("EX-N1: gift ideas for dad? finds the Father's Day skillet note by meaning", async () => {
    await inAgent(async (a) => {
      const { run, seeds } = setup(a);
      const skillet = seeds.notes.skillet;
      expectClearsFloor("gift ideas for dad?", skillet.title);

      expect(meaningIds((await run<NoteResults>("search_notes", { query: "gift ideas for dad?" })).results)).toContain(skillet.id);
      expect(ids((await run<NoteResults>("search_notes", { query: "gift ideas for dad?" }, ALL_TOOLS)).results)).not.toContain(skillet.id);
    });
  });

  it("EX-N2: door code? finds the side gate keypad note by meaning", async () => {
    await inAgent(async (a) => {
      const { run, seeds } = setup(a);
      const keypad = seeds.notes.keypad;
      expectClearsFloor("door code?", keypad.title);

      expect(meaningIds((await run<NoteResults>("search_notes", { query: "door code?" })).results)).toContain(keypad.id);
      expect(ids((await run<NoteResults>("search_notes", { query: "door code?" }, ALL_TOOLS)).results)).not.toContain(keypad.id);
    });
  });

  it("EX-N3: dogs ok here? finds the lease once, excerpted at the pet clause", async () => {
    await inAgent(async (a) => {
      const { run, seeds } = setup(a);
      const lease = seeds.notes.lease;
      expect(lease.content.length).toBeGreaterThan(4000);
      expect(lease.content.toLowerCase()).not.toMatch(/\bdogs?\b/);
      expect(lease.content.split("\n\n")[2]).toContain("Pets are allowed");
      expectClearsFloor("dogs ok here?", "Pets are allowed");

      const result = await run<NoteResults>("search_notes", { query: "dogs ok here?" });
      const hits = result.results.filter((n) => n.id === lease.id);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.match).toBe("meaning");
      expect(hits[0]!.excerpt).toContain("Pets are allowed");
      expect(ids((await run<NoteResults>("search_notes", { query: "dogs ok here?" }, ALL_TOOLS)).results)).not.toContain(lease.id);
    });
  });

  it("grocery list? does not add the restaurant review", async () => {
    await inAgent(async (a) => {
      const { run, seeds } = setup(a);
      const result = await run<NoteResults>("search_notes", { query: "grocery list?" });
      expect(ids(result.results)).not.toContain(seeds.notes.review.id);
      expectNoMeaning(result);
    });
  });

  it("EX-N4: who wrote hamlet adds nothing", async () => {
    await inAgent(async (a) => {
      const { run } = setup(a);
      expectNoMeaning(await run("search_notes", { query: "who wrote hamlet" }));
      expectNoMeaning(await run("search", { query: "who wrote hamlet" }));
    });
  });

  it("EX-N5: who won last nite adds nothing", async () => {
    await inAgent(async (a) => {
      const { run } = setup(a);
      expectNoMeaning(await run("search_notes", { query: "who won last nite" }));
      expectNoMeaning(await run("search", { query: "who won last nite" }));
    });
  });

  it("EX-N6: thx adds nothing", async () => {
    await inAgent(async (a) => {
      const { run } = setup(a);
      expectNoMeaning(await run("search_notes", { query: "thx" }));
      expectNoMeaning(await run("search", { query: "thx" }));
    });
  });
});

describe("semantic surface examples: automations", () => {
  for (const [id, query, target] of [
    ["EX-A1", "garbage night?", "bins"],
    ["EX-A2", "bill reminders?", "rent"],
    ["EX-A3", "vit D reminder?", "vitamin"],
  ] as const) {
    it(`${id}: ${query} finds the ${target} reminder`, async () => {
      await inAgent(async (a) => {
        const { run, seeds } = setup(a);
        const result = await run<SearchResult>("search", { query });
        expectClearsFloor(query, seeds.automations[target].name);
        // "vit D" also hits "vitamin D" as a keyword, so EX-A3 only asserts the reminder is found.
        const found = id === "EX-A3" ? ids : meaningIds;
        expect(found(result.automations)).toContain(seeds.automations[target].id);
        expect(await run("search", { query }, ALL_TOOLS)).not.toHaveProperty("automations");
      });
    });
  }

  it("EX-A4: brb adds nothing", async () => {
    await inAgent(async (a) => {
      const { run } = setup(a);
      expectNoMeaning(await run("search", { query: "brb" }));
    });
  });

  it("the fired plumber reminder is no meaning match for plumber?", async () => {
    await inAgent(async (a) => {
      const { run, seeds } = setup(a);
      const result = await run<SearchResult>("search", { query: "plumber?" });
      expect(meaningIds(result.automations)).not.toContain(seeds.automations.plumber.id);
      expectNoMeaning(result);
    });
  });

  it("EX-A5: weather tmrw does not return the umbrella reminder", async () => {
    await inAgent(async (a) => {
      const { run, seeds } = setup(a);
      const result = await run<SearchResult>("search", { query: "weather tmrw" });
      expect(ids(result.automations)).not.toContain(seeds.automations.umbrella.id);
      expectNoMeaning(result);
    });
  });

  it("EX-A6: hi adds nothing", async () => {
    await inAgent(async (a) => {
      const { run } = setup(a);
      expectNoMeaning(await run("search", { query: "hi" }));
    });
  });
});

describe("semantic surface negatives", () => {
  for (const [id, query, tools] of [
    ["NEG-greeting", "hello", ["search", "list_tasks", "search_notes"]],
    ["NEG-france", "what's the capital of France?", ["search", "list_tasks", "search_notes"]],
    ["NEG-weather", "what's the weather tomorrow?", ["list_tasks"]],
    ["NEG-game", "who won the game last night?", ["search_notes"]],
  ] as const) {
    it(`${id}: ${query} adds nothing on ${tools.join(", ")}`, async () => {
      await inAgent(async (a) => {
        const { run } = setup(a);
        for (const tool of tools) expectNoMeaning(await run(tool, { query }));
      });
    });
  }
});
