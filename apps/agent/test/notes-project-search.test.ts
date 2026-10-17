import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";

describe("project-filtered note search", () => {
  it.each(["FTS", "LIKE fallback"])("combines the project and query filters for %s", async (kind) => {
    const c = await loggedIn();
    const term = `tomato${crypto.randomUUID().replaceAll("-", "")}`;
    const { project: garden } = await c.json("/api/projects", { method: "POST", body: { name: `Garden ${term}` } });
    const { project: work } = await c.json("/api/projects", { method: "POST", body: { name: `Work ${term}` } });
    const ids: string[] = [];
    for (const project_id of [garden.id, work.id, null]) {
      const { note } = await c.json("/api/notes", {
        method: "POST",
        body: { title: `${term} 100%`, content: "The same search term in every project", project_id },
      });
      ids.push(note.id);
    }
    const q = kind === "FTS" ? term : "%";
    const filtered = (await c.json(`/api/notes?${new URLSearchParams({ q, project_id: garden.id })}`)).notes;
    const actual = filtered.map((note: { id: string }) => note.id);
    expect(actual, JSON.stringify({ query: q, project: garden.id, expected: [ids[0]], actual })).toEqual([ids[0]]);
    expect((await c.json(`/api/notes?${new URLSearchParams({ q })}`)).notes.map((note: { id: string }) => note.id))
      .toEqual(expect.arrayContaining(ids));
    expect((await c.json(`/api/notes?${new URLSearchParams({ q, project_id: crypto.randomUUID() })}`)).notes).toEqual([]);
    // A caller requesting one result still receives the matching project note.
    expect(await inAgent((agent) => agent.services.notes.list({ q, project_id: garden.id, limit: 1 }).map((note) => note.id)))
      .toEqual([ids[0]]);
  });
});
