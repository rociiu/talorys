import type { ProjectDetail, Task } from "@talorys/shared";
import { expect, it } from "vitest";
import { client, inAgent, loggedIn } from "./helpers";

it("serves exact authenticated project totals beyond task list limits and across mutations", async () => {
  const c = await loggedIn();
  const { project, other } = await inAgent((agent) => ({
    project: agent.services.projects.create({ name: "Large project" }),
    other: agent.services.projects.create({ name: "Other project" }),
  }));
  const path = `/api/projects/${project.id}`;
  const otherPath = `/api/projects/${other.id}`;
  const counts = async (url = path) => (await c.json<ProjectDetail>(url)).task_counts;
  try {
    expect((await client().call(path)).status).toBe(401);
    expect((await c.call("/api/projects/missing")).status).toBe(404);
    expect(await c.json<ProjectDetail>(path)).toEqual({ project, task_counts: { open: 0, completed: 0 } });

    await inAgent((agent) => {
      const { db, tasks } = agent.services;
      db.transaction(() => {
        for (let i = 0; i < 201; i++) tasks.create({ title: `Completed ${i}`, status: "done", project_id: project.id });
      });
    });
    expect(await counts()).toEqual({ open: 0, completed: 201 });
    await inAgent((agent) => {
      const { db, tasks } = agent.services;
      db.transaction(() => {
        for (let i = 0; i < 501; i++) tasks.create({ title: `Open ${i}`, project_id: project.id, status: i % 2 === 0 ? "todo" : "in_progress" });
      });
    });
    expect(await counts()).toEqual({ open: 501, completed: 201 });

    const res = await c.call("/api/tasks", { method: "POST", body: { title: "Moving task", project_id: project.id } });
    expect(res.status).toBe(201);
    const { task } = await res.json<{ task: Task }>();
    const taskPath = `/api/tasks/${task.id}`;
    const patch = async (body: object) => expect((await c.call(taskPath, { method: "PATCH", body })).status).toBe(200);
    expect(await counts()).toEqual({ open: 502, completed: 201 });
    await patch({ status: "done" });
    expect(await counts()).toEqual({ open: 501, completed: 202 });
    await patch({ status: "todo" });
    expect(await counts()).toEqual({ open: 502, completed: 201 });
    await patch({ project_id: other.id });
    expect(await counts()).toEqual({ open: 501, completed: 201 });
    expect(await counts(otherPath)).toEqual({ open: 1, completed: 0 });
    expect((await c.call(taskPath, { method: "DELETE" })).status).toBe(200);
    expect(await counts(otherPath)).toEqual({ open: 0, completed: 0 });
    expect((await c.call(path, { method: "PATCH", body: { status: "paused" } })).status).toBe(200);
    expect(await c.json<ProjectDetail>(path)).toMatchObject({ project: { status: "paused" }, task_counts: { open: 501, completed: 201 } });
  } finally {
    await inAgent((agent) => {
      const { db, projects } = agent.services;
      db.run("DELETE FROM tal_tasks WHERE project_id IN (?, ?)", project.id, other.id);
      projects.delete(project.id);
      projects.delete(other.id);
    });
  }
});
