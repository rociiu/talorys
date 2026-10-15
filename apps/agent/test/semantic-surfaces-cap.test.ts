import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import { deleteSemanticConfig } from "../src/semantic/config";
import { embeddingsToday } from "../src/semantic/embeddings";
import { dropSemanticData, ensureSemanticSchema } from "../src/semantic/migrations";
import { ITEM_EMBEDDINGS_PER_DAY, itemUsageToday, reserveItemEmbedding } from "../src/semantic/itemIndex";
import type { Services } from "../src/services/container";

const DAY = "2026-10-14";

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
}

describe("item embedding cap", () => {
  it("CAP-request: the 51st request of a day is refused and not recorded", async () => {
    await inAgent((a) => {
      const s = a.services;
      reset(s);
      ensureSemanticSchema(s.db);
      for (let i = 0; i < ITEM_EMBEDDINGS_PER_DAY; i++) expect(reserveItemEmbedding(s.db, DAY, [10])).toBe(1);
      expect(reserveItemEmbedding(s.db, DAY, [10])).toBe(0);
      expect(itemUsageToday(s.db, DAY)).toEqual({ requests: 50, tokens: 500 });
      expect(reserveItemEmbedding(s.db, "2026-10-15", [10])).toBe(1);
      reset(s);
    });
  });

  it("CAP-tokens: a batch shrinks to the prefix that fits and tokens never pass the cap", async () => {
    await inAgent((a) => {
      const s = a.services;
      reset(s);
      ensureSemanticSchema(s.db);
      const caps = { requests: 50, tokens: 1000 };
      expect(reserveItemEmbedding(s.db, DAY, [], caps)).toBe(0);
      expect(reserveItemEmbedding(s.db, DAY, [400, 400, 400], caps)).toBe(2);
      expect(reserveItemEmbedding(s.db, DAY, [300], caps)).toBe(0);
      expect(itemUsageToday(s.db, DAY)).toEqual({ requests: 1, tokens: 800 });
      expect(reserveItemEmbedding(s.db, DAY, [200], caps)).toBe(1);
      expect(itemUsageToday(s.db, DAY)).toEqual({ requests: 2, tokens: 1000 });
      reset(s);
      expect(reserveItemEmbedding(s.db, DAY, [1], caps)).toBe(0);
    });
  });

  it("CAP-isolated: item reservations never touch the shared embedding counter", async () => {
    await inAgent((a) => {
      const s = a.services;
      reset(s);
      ensureSemanticSchema(s.db);
      expect(reserveItemEmbedding(s.db, DAY, [100, 200])).toBe(2);
      expect(embeddingsToday(s.db, DAY)).toBe(0);
      expect(s.db.one(`SELECT day FROM tal_semantic_usage WHERE day = ?`, DAY)).toBeNull();
      reset(s);
    });
  });
});
