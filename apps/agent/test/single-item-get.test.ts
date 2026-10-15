import { describe, expect, it } from "vitest";
import { client, loggedIn } from "./helpers";

const UNKNOWN = "00000000-0000-4000-8000-000000000000";

describe("single-item GET routes", () => {
  it("memory by id", async () => {
    const c = await loggedIn();
    const { memory } = await c.json("/api/memories", { method: "POST", body: { content: `Single item memory ${crypto.randomUUID()}`, category: "fact" } });
    const res = await c.call(`/api/memories/${memory.id}`);
    expect(res.status).toBe(200);
    const fetched = (await res.json()) as { memory: Record<string, unknown> };
    const listed = (await c.json("/api/memories")).memories.find((m: { id: string }) => m.id === memory.id);
    expect(fetched.memory).toEqual(listed);
    expect(fetched.memory).not.toHaveProperty("embedding");

    const missing = await c.call(`/api/memories/${UNKNOWN}`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.code).toBe("NOT_FOUND");
    expect((await client().call(`/api/memories/${memory.id}`)).status).toBe(401);
  });

  it("automation by id", async () => {
    const c = await loggedIn();
    const { automation } = await c.json("/api/automations", {
      method: "POST",
      body: { name: "Single item", kind: "reminder", message: "Drink water", schedule: { type: "daily", time: "09:00" } },
    });
    const res = await c.call(`/api/automations/${automation.id}`);
    expect(res.status).toBe(200);
    const fetched = (await res.json()) as { automation: Record<string, unknown> };
    const listed = (await c.json("/api/automations")).automations.find((a: { id: string }) => a.id === automation.id);
    expect(fetched.automation).toEqual(listed);

    const missing = await c.call(`/api/automations/${UNKNOWN}`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.code).toBe("NOT_FOUND");
    await c.call(`/api/automations/${automation.id}`, { method: "DELETE" });
  });

  it("reviews route still answers before the id route", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/memories/reviews");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reviews: unknown[]; memory?: unknown };
    expect(Array.isArray(body.reviews)).toBe(true);
    expect(body).not.toHaveProperty("memory");
  });
});
