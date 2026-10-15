import type { RemoteScope } from "@talorys/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { isRemoteAllowed } from "../src/remote/allowlist";
import { bearer, client, inAgent, loggedIn } from "./helpers";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

async function mint(scope: RemoteScope, name: string = scope): Promise<string> {
  return inAgent(async (agent) => {
    agent.services.remote.setEnabled(true);
    return (await agent.services.remote.create({ name, scope })).token;
  });
}

beforeEach(async () => {
  await inAgent((agent) => {
    agent.services.remote.revokeAll();
    agent.services.remote.setEnabled(false);
  });
});

describe("remote bearer access", () => {
  it("write token crud: tasks and notes without cookie or CSRF header", async () => {
    const b = bearer(await mint("write"));

    const created = await b.call("/api/tasks", { method: "POST", body: { title: "From a script" } });
    expect(created.status).toBe(201);
    const { task } = (await created.json()) as any;
    expect((await b.json("/api/tasks")).tasks.map((t: { id: string }) => t.id)).toContain(task.id);
    expect((await b.json(`/api/tasks/${task.id}`)).task.title).toBe("From a script");
    expect((await b.json(`/api/tasks/${task.id}`, { method: "PATCH", body: { status: "done" } })).task.status).toBe("done");
    expect(await b.json(`/api/tasks/${task.id}`, { method: "DELETE" })).toEqual({ deleted: true });
    expect((await b.call(`/api/tasks/${task.id}`)).status).toBe(404);

    const res = await b.call("/api/notes", { method: "POST", body: { title: "Remote note", content: "hi" } });
    expect(res.status).toBe(201);
    const { note } = (await res.json()) as any;
    expect((await b.json("/api/notes")).notes.map((n: { id: string }) => n.id)).toContain(note.id);
    expect((await b.json(`/api/notes/${note.id}`, { method: "PATCH", body: { content: "edited" } })).note.content).toBe(
      "edited",
    );
    expect(await b.json(`/api/notes/${note.id}`, { method: "DELETE" })).toEqual({ deleted: true });

    expect((await b.call(`/api/notes/${ID}`)).status).toBe(404);
    expect((await b.call("/api/health")).status).toBe(200);
    expect((await b.call("/api/tasks", { method: "HEAD" })).status).toBe(200);
  });

  it("read scope: GET allowed, writes rejected", async () => {
    const b = bearer(await mint("read"));
    expect((await b.call("/api/tasks")).status).toBe(200);
    expect((await b.call("/api/notes")).status).toBe(200);
    expect((await b.call("/api/memories")).status).toBe(200);
    expect((await b.call("/api/automations")).status).toBe(200);
    for (const [path, method] of [
      ["/api/tasks", "POST"],
      ["/api/notes", "POST"],
      [`/api/tasks/${ID}`, "PATCH"],
      [`/api/notes/${ID}`, "DELETE"],
      ["/api/memories", "POST"],
    ] as const) {
      const res = await b.call(path, { method, body: method === "DELETE" ? undefined : { title: "x" } });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as any).error.message).toBe("This access token is read-only.");
    }
    const count = await inAgent((agent) => agent.services.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_tasks WHERE title = 'x'`)!.n);
    expect(count).toBe(0);
  });

  it("allowlist deny: routes outside the allowlist are 403 for a write token", async () => {
    const b = bearer(await mint("write"));
    const denied: Array<[string, string]> = [
      ["GET", "/api/projects"],
      ["GET", "/api/export"],
      ["POST", "/api/import"],
      ["PATCH", "/api/settings"],
      ["POST", "/api/chat"],
      ["POST", "/api/auth/password"],
      ["POST", "/api/semantic/reindex"],
      ["DELETE", "/api/semantic/data"],
      ["GET", "/api/semantic/config"],
      ["GET", "/api/remote/tokens"],
      ["PATCH", "/api/remote/status"],
      ["GET", "/api/notifications"],
      ["GET", "/api/memories/reviews"],
      ["POST", `/api/memories/reviews/${ID}`],
      ["GET", `/api/memories/${ID}/history`],
      ["POST", `/api/memories/${ID}/correct`],
      ["POST", `/api/memories/${ID}/status`],
      ["DELETE", "/api/memories"],
      ["GET", "/api/memories/%72eviews"],
      ["GET", "/api/tasks/"],
      ["GET", `/api/tasks/${ID}/`],
      ["GET", "/api/tasks/not-a-uuid"],
      ["OPTIONS", "/api/tasks"],
    ];
    for (const [method, path] of denied) {
      const res = await b.call(path, { method, body: ["POST", "PATCH"].includes(method) ? {} : undefined });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(await inAgent((agent) => agent.services.remote.count())).toBe(1);

    const allowed: Array<[string, string]> = [
      ["GET", "/api/tasks"],
      ["HEAD", "/api/tasks"],
      ["POST", "/api/notes"],
      ["GET", `/api/automations/${ID}`],
      ["PATCH", `/api/memories/${ID.toUpperCase()}`],
      ["DELETE", `/api/notes/${ID}`],
      ["GET", "/api/semantic/search"],
      ["GET", "/api/health"],
    ];
    for (const [method, path] of allowed) expect(isRemoteAllowed(method, path), `${method} ${path}`).toBe(true);
    for (const [method, path] of [...denied, ["PUT", "/api/tasks"], ["POST", `/api/tasks/${ID}`], ["GET", "/api/memories/reviews/x"]]) {
      expect(isRemoteAllowed(method!, path!), `${method} ${path}`).toBe(false);
    }
  });

  it("auth ordering: bad credentials are 401 even with a valid cookie, and a header alone never skips CSRF", async () => {
    const token = await mint("write");
    const c = await loggedIn();
    const withAuth = (value: string) => c.call("/api/tasks", { headers: { authorization: value } });

    expect((await withAuth("Bearer tal_not-a-real-token")).status).toBe(401);
    expect((await withAuth("Basic dXNlcjpwYXNz")).status).toBe(401);
    expect((await withAuth("Bearer")).status).toBe(401);
    expect((await c.call("/api/tasks")).status).toBe(200);

    // A session request without the CSRF header stays 403, and adding a bogus Authorization
    // header turns it into 401 rather than letting it through.
    const noCsrf = { "x-talorys-request": "", origin: "" };
    expect((await c.call("/api/tasks", { method: "POST", body: { title: "x" }, headers: noCsrf })).status).toBe(403);
    const bogus = await c.call("/api/tasks", { method: "POST", body: { title: "x" }, headers: { ...noCsrf, authorization: "Bearer tal_bogus" } });
    expect(bogus.status).toBe(401);
    expect(((await bogus.json()) as any).error.message).toBe("Invalid or revoked access token.");

    const b = bearer(token);
    expect((await b.call("/api/tasks")).status).toBe(200);
    await inAgent((agent) => agent.services.remote.setEnabled(false));
    expect((await b.call("/api/tasks")).status).toBe(401);
    expect((await c.call("/api/tasks", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    await inAgent((agent) => agent.services.remote.setEnabled(true));
    expect((await b.call("/api/tasks")).status).toBe(200);

    await inAgent((agent) => agent.services.remote.revokeAll());
    expect((await b.call("/api/tasks")).status).toBe(401);
    expect((await client().call("/api/tasks")).status).toBe(401);
  });
});
