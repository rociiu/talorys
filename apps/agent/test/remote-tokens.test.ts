import { MAX_REMOTE_TOKENS } from "@talorys/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { AppError } from "../src/api/errors";
import { exportData, importData } from "../src/services/backup";

beforeEach(async () => {
  await inAgent((agent) => {
    agent.services.remote.revokeAll();
    agent.services.remote.setEnabled(false);
  });
});

const rejection = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
};

describe("remote access tokens", () => {
  it("returns the plaintext once and stores only its hash", async () => {
    await inAgent(async (agent) => {
      const remote = agent.services.remote;
      remote.setEnabled(true);
      const a = await remote.create({ name: "laptop" });
      const b = await remote.create({ name: "script", scope: "write" });
      expect(a.token).toMatch(/^tal_[A-Za-z0-9_-]{43}$/);
      expect(a.scope).toBe("read");
      expect(b.scope).toBe("write");
      expect(a.hint).toBe(a.token.slice(-4));
      expect(a.id).not.toBe(b.id);

      const rows = agent.services.db.all<Record<string, unknown>>(`SELECT * FROM tal_remote_tokens`);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.token_hash)).size).toBe(2);
      for (const r of rows) expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/);
      const stored = JSON.stringify([...rows, ...agent.services.db.all(`SELECT * FROM tal_settings`)]);
      expect(stored).not.toContain(a.token);
      expect(stored).not.toContain(b.token);

      const listed = remote.list();
      expect(listed.map((t) => t.name)).toEqual(["laptop", "script"]);
      expect(listed[0]).not.toHaveProperty("token");
      expect(listed[0]).not.toHaveProperty("token_hash");
      expect(await remote.validate(a.token)).toEqual({ id: a.id, name: "laptop", scope: "read" });
      expect(remote.list()[0]!.last_used_at).not.toBeNull();

      expect((await rejection(remote.create({ name: "  LAPTOP " }))).code).toBe("CONFLICT");
    });
  });

  it("enforces the token cap and refuses creation while disabled", async () => {
    await inAgent(async (agent) => {
      const remote = agent.services.remote;
      const off = await rejection(remote.create({ name: "early" }));
      expect(off.status).toBe(403);
      expect(remote.count()).toBe(0);

      remote.setEnabled(true);
      const created = [];
      for (let i = 1; i <= MAX_REMOTE_TOKENS; i++) created.push(await remote.create({ name: `token ${i}` }));
      expect(remote.count()).toBe(MAX_REMOTE_TOKENS);
      const over = await rejection(remote.create({ name: "one too many" }));
      expect(over.status).toBe(403);
      expect(remote.revoke(created[0]!.id)).toBe(true);
      await remote.create({ name: "one too many" });
      expect(remote.count()).toBe(MAX_REMOTE_TOKENS);
    });
  });

  it("follows the lifecycle: suspend, resume, revoke and revoke all", async () => {
    await inAgent(async (agent) => {
      const remote = agent.services.remote;
      remote.setEnabled(true);
      const a = await remote.create({ name: "a" });
      const b = await remote.create({ name: "b" });
      const c = await remote.create({ name: "c" });

      remote.setEnabled(false);
      expect(await remote.validate(a.token)).toBeNull();
      expect(remote.count()).toBe(3);
      remote.setEnabled(true);
      expect(await remote.validate(a.token)).not.toBeNull();

      const session = await agent.services.auth.createSession("test");
      for (const bad of ["tal_", "", "x".repeat(201), `tal_${"x".repeat(197)}`, session.token, a.token.slice(0, -1)]) {
        expect(await remote.validate(bad)).toBeNull();
      }

      expect(remote.revoke(a.id)).toBe(true);
      expect(remote.revoke(a.id)).toBe(false);
      expect(await remote.validate(a.token)).toBeNull();
      expect(await remote.validate(b.token)).not.toBeNull();
      expect(remote.revokeAll()).toBe(2);
      expect(await remote.validate(b.token)).toBeNull();
      expect(await remote.validate(c.token)).toBeNull();
    });
  });

  it("keeps tokens and the enabled flag out of backup export and import", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      s.remote.setEnabled(true);
      const t = await s.remote.create({ name: "backup check" });
      const exported = JSON.stringify(exportData(s));
      expect(exported).not.toContain(t.token);
      expect(exported).not.toContain(t.id);
      expect(exported).not.toContain("remote");

      s.remote.revokeAll();
      s.remote.setEnabled(false);
      const crafted = exportData(s) as unknown as { data: { settings: Record<string, unknown> } & Record<string, unknown> };
      crafted.data.settings = { ...crafted.data.settings, remote: { enabled: true }, "remote.enabled": true };
      crafted.data.remote_tokens = [{ id: "x", name: "evil", token_hash: "0".repeat(64), hint: "evil", scope: "write" }];
      await importData(s, crafted);
      expect(s.remote.isEnabled()).toBe(false);
      expect(s.remote.count()).toBe(0);
    });
  });
});
