import { describe, expect, it } from "vitest";
import { BACKUP_FORMAT, computeNextRun } from "@talorys/shared";
import { SettingsService } from "../src/services/settings";
import { inAgent, loggedIn } from "./helpers";

describe("portable backup settings", () => {
  it("exports effective installer defaults before the owner edits Settings", async () => {
    const c = await loggedIn();
    await inAgent((agent) => {
      const s = agent.services;
      s.settings.delete("app.settings");
      s.settings = new SettingsService(s.db, {
        timezone: "Asia/Tokyo",
        agentName: "Nova",
      });
    });
    try {
      const backup = await c.json("/api/export");
      expect(backup.data.settings).toMatchObject({
        timezone: "Asia/Tokyo",
        agentName: "Nova",
      });
      expect(JSON.stringify(backup)).not.toContain("test-session-secret");
    } finally {
      await inAgent((agent) => {
        agent.services.settings = new SettingsService(agent.services.db);
      });
    }
  });

  it("reads an unknown stored language as system and keeps the other settings", async () => {
    const c = await loggedIn();
    const before = (await c.json("/api/settings")).settings;
    await inAgent((agent) => {
      agent.services.settings.setJson("app.settings", { ...before, language: "zz", agentName: "Kept", timezone: "Europe/Warsaw" });
    });
    try {
      const { settings } = await c.json("/api/settings");
      expect(settings).toMatchObject({ language: "system", agentName: "Kept", timezone: "Europe/Warsaw", model: before.model, limits: before.limits });
    } finally {
      await inAgent((agent) => {
        agent.services.settings.setJson("app.settings", before);
      });
    }
  });

  it("imports a backup that names an unknown language and keeps the current one", async () => {
    const c = await loggedIn();
    const before = (await c.json("/api/settings")).settings;
    await c.json("/api/settings", { method: "PATCH", body: { language: "en" } });
    try {
      const res = await c.call("/api/import", {
        method: "POST",
        body: { format: BACKUP_FORMAT, version: 1, exported_at: new Date().toISOString(), data: { settings: { language: "zz", theme: "dark" } } },
      });
      expect(res.status).toBe(200);
      const { settings } = await c.json("/api/settings");
      expect(settings).toMatchObject({ language: "en", theme: "dark" });
    } finally {
      await c.json("/api/settings", { method: "PATCH", body: { language: before.language, theme: before.theme } });
    }
  });

  it.each([true, false])(
    "re-arms retained local schedules only if imported timezone changed: %s",
    async (changed) => {
      const c = await loggedIn();
      const timezone = changed ? "Asia/Tokyo" : "UTC";
      await c.json("/api/settings", { method: "PATCH", body: { timezone } });
      // This is a genuine exported backup from before the target's automation exists.
      const backup = await c.json("/api/export");
      expect(backup.data.automations).toHaveLength(0);
      await c.json("/api/settings", {
        method: "PATCH",
        body: { timezone: "UTC" },
      });
      const { automation } = await c.json("/api/automations", {
        method: "POST",
        body: {
          name: "Retained reminder",
          kind: "reminder",
          message: "Take a break",
          schedule: { type: "daily", time: "09:00" },
        },
      });
      try {
        const res = await c.call("/api/import", {
          method: "POST",
          body: backup,
        });
        expect(res.status).toBe(200);
        const current = (await c.json("/api/automations")).automations.find(
          (a: any) => a.id === automation.id,
        );
        expect(current.next_run).toBe(
          computeNextRun(current.schedule, timezone, new Date())!.toISOString(),
        );
        if (changed) {
          expect(current.schedule_id).not.toBe(automation.schedule_id);
          expect(
            await inAgent((agent) =>
              agent.getScheduleById(automation.schedule_id),
            ),
          ).toBeUndefined();
        } else {
          expect(current.schedule_id).toBe(automation.schedule_id);
        }
      } finally {
        await c.call(`/api/automations/${automation.id}`, { method: "DELETE" });
        await c.json("/api/settings", {
          method: "PATCH",
          body: { timezone: "UTC" },
        });
      }
    },
  );
});
