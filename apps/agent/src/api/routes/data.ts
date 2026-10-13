import {
  memoryCorrectSchema,
  memoryCreateSchema,
  memoryListQuerySchema,
  memoryReviewResolveSchema,
  memoryStatusSchema,
  memoryUpdateSchema,
  type MemoryReview,
  noteCreateSchema,
  noteUpdateSchema,
  projectCreateSchema,
  projectUpdateSchema,
  taskCreateSchema,
  taskListQuerySchema,
  taskUpdateSchema,
} from "@talorys/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import { body, query } from "../middleware";
import { ValidationError } from "../errors";
import { localDayBounds } from "../../services/time";

/** Tasks, memories, notes and projects. None of these routes need AI. */
export const dataRoutes = new Hono<AppEnv>();

function assertProject(c: { env: AppEnv["Bindings"] }, projectId: string | null | undefined) {
  if (projectId && !c.env.agent.services.projects.get(projectId)) throw new ValidationError("Project does not exist.");
}

// ---------- Tasks ----------

dataRoutes.get("/tasks", (c) => {
  const q = query(c, taskListQuerySchema);
  const s = c.env.agent.services;
  const bounds = localDayBounds(s.settings.get().timezone);
  return c.json({ tasks: s.tasks.list({ ...q, dayStart: bounds.start, dayEnd: bounds.end }), today: bounds });
});

dataRoutes.post("/tasks", async (c) => {
  const input = await body(c, taskCreateSchema);
  assertProject(c, input.project_id);
  return c.json({ task: c.env.agent.services.tasks.create(input) }, 201);
});

dataRoutes.get("/tasks/:id", (c) => c.json({ task: c.env.agent.services.tasks.require(c.req.param("id")) }));

dataRoutes.patch("/tasks/:id", async (c) => {
  const patch = await body(c, taskUpdateSchema);
  assertProject(c, patch.project_id);
  return c.json({ task: c.env.agent.services.tasks.update(c.req.param("id"), patch) });
});

dataRoutes.delete("/tasks/:id", (c) => {
  c.env.agent.services.tasks.delete(c.req.param("id"));
  return c.json({ deleted: true });
});

// ---------- Memories ----------
// Responses never include embeddings; vectors stay server-side.

dataRoutes.get("/memories", (c) => {
  const q = query(c, memoryListQuerySchema);
  const s = c.env.agent.services;
  return c.json({
    memories: s.memories.list({ q: q.q, category: q.category, status: q.status }),
    total: s.memories.count(),
    counts: { active: s.memories.count("active"), historical: s.memories.count("historical"), review: s.memories.count("review") },
  });
});

dataRoutes.post("/memories", async (c) => {
  const input = await body(c, memoryCreateSchema);
  const result = await c.env.agent.services.memoryHistory.create({ ...input, source: "manual" }, { signal: c.req.raw.signal });
  return c.json({ memory: result.memory, superseded: result.superseded, reviews: result.reviews.length }, 201);
});

dataRoutes.patch("/memories/:id", async (c) => {
  const patch = await body(c, memoryUpdateSchema);
  const result = await c.env.agent.services.memoryHistory.update(c.req.param("id"), patch, { signal: c.req.raw.signal });
  return c.json({ memory: result.memory, superseded: result.superseded, reviews: result.reviews.length });
});

dataRoutes.delete("/memories/:id", (c) => {
  c.env.agent.services.memoryHistory.delete(c.req.param("id"));
  return c.json({ deleted: true });
});

dataRoutes.delete("/memories", async (c) => {
  await body(c, z.object({ confirm: z.literal("DELETE") }));
  const s = c.env.agent.services;
  const deleted = s.memoryHistory.clear();
  s.activity.record("privacy.memories_cleared", `Cleared ${deleted} memories`);
  return c.json({ deleted });
});

dataRoutes.get("/memories/reviews", (c) => {
  const s = c.env.agent.services;
  const reviews: MemoryReview[] = s.memories.listReviews().flatMap((r) => {
    const memory = s.memories.get(r.memory_id);
    const other = s.memories.get(r.other_id);
    return memory && other ? [{ id: r.id, memory, other, relationship: r.relationship, reason: r.reason, created_at: r.created_at }] : [];
  });
  return c.json({ reviews });
});

dataRoutes.post("/memories/reviews/:id", async (c) => {
  const { action } = await body(c, memoryReviewResolveSchema);
  return c.json(c.env.agent.services.memoryHistory.resolveReview(c.req.param("id"), action));
});

dataRoutes.get("/memories/:id/history", (c) => c.json(c.env.agent.services.memoryHistory.lifecycle.history(c.req.param("id"))));

dataRoutes.post("/memories/:id/status", async (c) => {
  const { status } = await body(c, memoryStatusSchema);
  return c.json({ memory: c.env.agent.services.memoryHistory.lifecycle.setStatus(c.req.param("id"), status) });
});

/** Saves a newer version of a fact; the old one is kept as history. */
dataRoutes.post("/memories/:id/correct", async (c) => {
  const input = await body(c, memoryCorrectSchema);
  const result = await c.env.agent.services.memoryHistory.correct(c.req.param("id"), input.content, input.category, { signal: c.req.raw.signal });
  return c.json({ memory: result.memory, superseded: result.superseded, reviews: result.reviews.length }, 201);
});

// ---------- Notes ----------

dataRoutes.get("/notes", (c) => {
  const q = query(c, z.object({ q: z.string().max(200).optional(), project_id: z.string().max(64).optional() }));
  return c.json({ notes: c.env.agent.services.notes.list(q) });
});

dataRoutes.post("/notes", async (c) => {
  const input = await body(c, noteCreateSchema, 512 * 1024);
  assertProject(c, input.project_id);
  return c.json({ note: c.env.agent.services.notes.create(input) }, 201);
});

dataRoutes.get("/notes/:id", (c) => c.json({ note: c.env.agent.services.notes.require(c.req.param("id")) }));

dataRoutes.patch("/notes/:id", async (c) => {
  const patch = await body(c, noteUpdateSchema, 512 * 1024);
  assertProject(c, patch.project_id);
  return c.json({ note: c.env.agent.services.notes.update(c.req.param("id"), patch) });
});

dataRoutes.delete("/notes/:id", (c) => {
  c.env.agent.services.notes.delete(c.req.param("id"));
  return c.json({ deleted: true });
});

// ---------- Projects ----------

dataRoutes.get("/projects", (c) => c.json({ projects: c.env.agent.services.projects.list() }));

dataRoutes.post("/projects", async (c) => {
  const input = await body(c, projectCreateSchema);
  return c.json({ project: c.env.agent.services.projects.create(input) }, 201);
});

dataRoutes.patch("/projects/:id", async (c) => {
  const patch = await body(c, projectUpdateSchema);
  return c.json({ project: c.env.agent.services.projects.update(c.req.param("id"), patch) });
});

dataRoutes.delete("/projects/:id", (c) => {
  c.env.agent.services.projects.delete(c.req.param("id"));
  return c.json({ deleted: true });
});
