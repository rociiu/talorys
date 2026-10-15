import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { deleteSemanticConfig, writeSemanticConfig } from "../src/semantic/config";
import { dropSemanticData } from "../src/semantic/migrations";
import type { Services } from "../src/services/container";
import { statusRefetchInterval } from "../../web/src/components/semanticPolling";

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
  for (const table of ["tal_tasks", "tal_notes", "tal_automations"]) s.db.run(`DELETE FROM ${table}`);
}

describe("semantic status polling", () => {
  it("R1: pending items with no item pass running do not keep the Settings card polling", async () => {
    await inAgent((a) => {
      const s = a.services;
      reset(s);
      writeSemanticConfig(s.settings, { enabled: true }, s.db);
      invalidateSemanticCache(s);
      s.tasks.create({ title: "Renew passport" });
    });
    const c = await loggedIn();
    const status = (await c.json("/api/semantic/status")) as { pending: number; items: { pending: number; indexing: boolean } };
    expect(status.items.pending).toBeGreaterThan(0);
    expect(status.items.indexing).toBe(false);
    expect(statusRefetchInterval(status)).toBe(false);
    expect(statusRefetchInterval({ ...status, items: { ...status.items, indexing: true } })).toBe(3000);
    expect(statusRefetchInterval({ ...status, pending: 1 })).toBe(3000);
    expect(statusRefetchInterval(undefined)).toBe(false);
    await inAgent((a) => reset(a.services));
  });
});
