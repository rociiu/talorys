import { type HealthReport, TALORYS_VERSION, type UsageReport, settingsUpdateSchema } from "@talorys/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import { body } from "../middleware";
import { schemaVersion } from "../../db/migrations";
import { exportData, importData } from "../../services/backup";
import { checkForUpdate } from "../../services/update-check";

export const systemRoutes = new Hono<AppEnv>();

/**
 * Non-inference health check used by the installer and monitoring.
 * Verifies storage and configuration without calling Workers AI.
 */
systemRoutes.get("/health", (c) => {
  const s = c.env.agent.services;
  let storage: HealthReport["storage"] = "ok";
  let version = 0;
  try {
    version = schemaVersion(s.db);
    s.db.one(`SELECT count(*) AS n FROM tal_settings`);
  } catch {
    storage = "error";
  }
  const configured = {
    password: s.auth.passwordConfigured(),
    session_secret: (c.env.env.SESSION_SECRET?.length ?? 0) >= 32,
  };
  const report: HealthReport = {
    ok: storage === "ok" && s.auth.isConfigured(),
    version: TALORYS_VERSION,
    storage,
    schema_version: version,
    configured,
    ai_binding: !!c.env.env.AI,
    push: s.push.configured(),
    time: new Date().toISOString(),
  };
  return c.json(report, report.ok ? 200 : 503);
});

systemRoutes.get("/settings", (c) => c.json({ settings: c.env.agent.services.settings.get() }));

systemRoutes.patch("/settings", async (c) => {
  const patch = await body(c, settingsUpdateSchema);
  const s = c.env.agent.services;
  const before = s.settings.get();
  const settings = s.settings.update(patch);
  if (settings.timezone !== before.timezone) await s.automations.rearmAll();
  if (settings.demoMode !== before.demoMode) {
    s.activity.record("settings.demo_mode", settings.demoMode ? "Demo mode enabled (mock AI)" : "Demo mode disabled");
  }
  return c.json({ settings });
});

systemRoutes.get("/usage", (c) => {
  const s = c.env.agent.services;
  const settings = s.settings.get();
  const report: UsageReport = {
    day: new Date().toISOString().slice(0, 10),
    today: s.usage.today(),
    last_7_days: s.usage.lastDays(7),
    limits: settings.limits,
    model: settings.model,
    note:
      "These numbers are estimates measured by Talorys itself (token counts reported by the model, or ~4 characters per token). Exact Workers AI Neuron usage and remaining free allocation are only available in the Cloudflare dashboard.",
    dashboard_url: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai",
  };
  return c.json(report);
});

systemRoutes.get("/system", (c) => {
  const s = c.env.agent.services;
  return c.json({
    version: TALORYS_VERSION,
    deployed_version: c.env.env.TALORYS_DEPLOYED_VERSION ?? null,
    installation_id: c.env.env.TALORYS_INSTALLATION_ID ?? null,
    schema_version: schemaVersion(s.db),
    ai_binding: !!c.env.env.AI,
    ai_provider: c.env.agent.aiProvider()?.id ?? "none",
    environment: c.env.env.TALORYS_ENV === "development" ? "development" : "production",
  });
});

systemRoutes.get("/system/update", async (c) => {
  const current = c.env.env.TALORYS_DEPLOYED_VERSION ?? TALORYS_VERSION;
  return c.json(await checkForUpdate(c.env.agent.services.settings, current));
});

systemRoutes.get("/activity", (c) => c.json({ activity: c.env.agent.services.activity.list(100) }));

systemRoutes.get("/export", (c) => {
  const backup = exportData(c.env.agent.services);
  c.env.agent.services.activity.record("data.exported", "Exported a backup");
  return new Response(JSON.stringify(backup, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="talorys-backup.json"`,
    },
  });
});

systemRoutes.post("/import", async (c) => {
  const raw = await body(c, z.unknown(), 25 * 1024 * 1024);
  const summary = await importData(c.env.agent.services, raw);
  return c.json({ imported: summary });
});
