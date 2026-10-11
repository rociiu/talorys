import { type ReactNode, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { checkPasswordStrength, GITHUB_URL, LIMIT_CEILINGS, type Limits, type Settings, TALORYS_VERSION } from "@talorys/shared";
import { Download, ExternalLink, LogOut, Monitor, Moon, Sun, Upload } from "lucide-react";
import { Badge, Button, Card, ConfirmDialog, ErrorNotice, Input, Label, PageHeader, Select, Spinner, Switch } from "../components/ui";
import { SemanticRecallCard } from "../components/SemanticRecallCard";
import { keys, useApiMutation, useSessions, useSettings, useSystemInfo, useUsage } from "../hooks/queries";
import { useSession } from "../hooks/session";
import { useToast, errorMessage } from "../hooks/toast";
import { api, ApiError } from "../lib/api";
import { applyTheme } from "../lib/theme";
import { cn, relativeTime } from "../lib/utils";

const TABS = ["General", "AI", "Privacy", "Security", "About"] as const;
type Tab = (typeof TABS)[number];

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-5 text-fg-subtle">{hint}</p>}
      </div>
      <div className="shrink-0 sm:w-64">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-medium uppercase tracking-wider text-fg-subtle">{title}</h2>
      <Card>
        <div className="divide-y divide-border">{children}</div>
      </Card>
    </section>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("General");
  const { data: settings, isLoading, error, refetch } = useSettings();
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
      <PageHeader title="Settings" />
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {TABS.map((t) => (
          <button type="button"
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === t ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg",
            )}
          >
            {t}
          </button>
        ))}
      </div>
      {error ? (
        <ErrorNotice error={error} onRetry={() => void refetch()} />
      ) : isLoading || !settings ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-8 animate-fade-in">
          {tab === "General" && <GeneralTab settings={settings} />}
          {tab === "AI" && <AiTab settings={settings} />}
          {tab === "Privacy" && <PrivacyTab />}
          {tab === "Security" && <SecurityTab />}
          {tab === "About" && <AboutTab />}
        </div>
      )}
    </div>
  );
}

function useSaveSettings() {
  const qc = useQueryClient();
  return useApiMutation((patch: Partial<Omit<Settings, "limits">> & { limits?: Partial<Limits> }) => api<{ settings: Settings }>("/settings", { method: "PATCH", body: patch }), {
    success: "Settings saved",
    onSuccess: (r) => {
      qc.setQueryData(keys.settings, r.settings);
      void qc.invalidateQueries({ queryKey: ["session"] });
      void qc.invalidateQueries({ queryKey: keys.automations });
    },
  });
}

function GeneralTab({ settings }: { settings: Settings }) {
  const save = useSaveSettings();
  const [name, setName] = useState(settings.agentName);
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [settings.timezone];
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <Section title="General">
      <Row label="Agent name" hint="How your assistant introduces itself.">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && name !== settings.agentName) save.mutate({ agentName: name.trim() });
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Agent name" />
          <Button type="submit" variant="outline" disabled={!name.trim() || name === settings.agentName}>
            Save
          </Button>
        </form>
      </Row>
      <Row
        label="Timezone"
        hint={
          settings.timezone !== browserTz ? (
            <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => save.mutate({ timezone: browserTz })}>
              Use this device's timezone ({browserTz})
            </button>
          ) : (
            "Used for due dates and schedules. Changing it re-schedules automations."
          )
        }
      >
        <Select value={settings.timezone} onChange={(e) => save.mutate({ timezone: e.target.value })} aria-label="Timezone">
          {(zones.includes(settings.timezone) ? zones : [settings.timezone, ...zones]).map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </Select>
      </Row>
      <Row label="Theme">
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
          {(
            [
              ["system", Monitor],
              ["light", Sun],
              ["dark", Moon],
            ] as const
          ).map(([value, Icon]) => (
            <button type="button"
              key={value}
              onClick={() => {
                applyTheme(value);
                save.mutate({ theme: value });
              }}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium capitalize",
                settings.theme === value ? "bg-surface shadow-sm" : "text-fg-muted",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {value}
            </button>
          ))}
        </div>
      </Row>
    </Section>
  );
}

const LIMIT_FIELDS: { key: keyof Limits; label: string; hint: string }[] = [
  { key: "maxOutputTokens", label: "Max output tokens", hint: "Upper bound for each AI reply." },
  { key: "maxContextTokens", label: "Max context tokens", hint: "Recent history sent to the model. Older messages are summarized." },
  { key: "maxToolCalls", label: "Max tool calls per request", hint: "0 disables tools entirely." },
  { key: "maxAgentIterations", label: "Max reasoning steps", hint: "Model round-trips per request." },
  { key: "maxAiRequestsPerDay", label: "Max AI requests per day", hint: "Hard daily cap enforced by Talorys." },
  { key: "maxScheduledAiRunsPerDay", label: "Max scheduled AI runs per day", hint: "Budget for AI routines. Reminders never use AI." },
];

function AiTab({ settings }: { settings: Settings }) {
  const save = useSaveSettings();
  const usage = useUsage();
  const [model, setModel] = useState(settings.model);
  const [limits, setLimits] = useState<Limits>(settings.limits);
  const [temperature, setTemperature] = useState(settings.temperature);
  const dirtyLimits = JSON.stringify(limits) !== JSON.stringify(settings.limits) || temperature !== settings.temperature;
  return (
    <>
      <Section title="Model">
        <Row label="Workers AI model" hint="Default: @cf/zai-org/glm-4.7-flash. Must support tool calling.">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (model !== settings.model) save.mutate({ model: model.trim() });
            }}
          >
            <Input value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model id" className="font-mono text-xs" />
            <Button type="submit" variant="outline" disabled={model === settings.model}>
              Save
            </Button>
          </form>
        </Row>
        <Row label="Learn from conversations" hint="Let Talorys save clearly lasting preferences without being asked. Off = only explicit “remember …”.">
          <div className="flex justify-end">
            <Switch checked={settings.autoMemory} onChange={(v) => save.mutate({ autoMemory: v })} label="Learn from conversations" />
          </div>
        </Row>
        <Row label="Demo mode" hint="Replaces Workers AI with a simple offline responder. Useful when your AI quota is exhausted. Never enabled automatically.">
          <div className="flex justify-end">
            <Switch checked={settings.demoMode} onChange={(v) => save.mutate({ demoMode: v })} label="Demo mode" />
          </div>
        </Row>
      </Section>

      <Section title="Generation & execution limits">
        <Row label="Temperature" hint="Lower is more focused and predictable.">
          <div className="flex items-center gap-3">
            <input type="range" min={0} max={1.5} step={0.1} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} className="flex-1 accent-[var(--accent)]" aria-label="Temperature" />
            <span className="w-8 text-right text-sm tabular-nums">{temperature.toFixed(1)}</span>
          </div>
        </Row>
        {LIMIT_FIELDS.map((f) => (
          <Row key={f.key} label={f.label} hint={`${f.hint} Max ${LIMIT_CEILINGS[f.key]}.`}>
            <Input
              type="number"
              min={0}
              max={LIMIT_CEILINGS[f.key]}
              value={limits[f.key]}
              onChange={(e) => setLimits({ ...limits, [f.key]: Number(e.target.value) })}
              aria-label={f.label}
            />
          </Row>
        ))}
        <div className="flex justify-end gap-2 px-5 py-3">
          <Button
            variant="ghost"
            disabled={!dirtyLimits}
            onClick={() => {
              setLimits(settings.limits);
              setTemperature(settings.temperature);
            }}
          >
            Reset
          </Button>
          <Button disabled={!dirtyLimits} loading={save.isPending} onClick={() => save.mutate({ limits, temperature })}>
            Save limits
          </Button>
        </div>
      </Section>

      <Section title="Usage">
        {usage.isLoading || !usage.data ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
              {[
                ["AI requests today", `${usage.data.today.ai_requests} / ${usage.data.limits.maxAiRequestsPerDay}`],
                ["Tokens today (est.)", (usage.data.today.input_tokens_estimate + usage.data.today.output_tokens_estimate).toLocaleString()],
                ["Tool calls today", String(usage.data.today.tool_calls)],
                ["Scheduled AI runs", `${usage.data.today.scheduled_ai_runs} / ${usage.data.limits.maxScheduledAiRunsPerDay}`],
              ].map(([label, value]) => (
                <div key={label} className="bg-surface px-5 py-4">
                  <p className="text-xs text-fg-subtle">{label}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
                </div>
              ))}
            </div>
            <Row label="Last 7 days" hint="Local estimates measured by Talorys.">
              <p className="text-right text-sm tabular-nums text-fg-muted">
                {usage.data.last_7_days.ai_requests} requests · {usage.data.last_7_days.ai_errors} errors
              </p>
            </Row>
            <div className="px-5 py-4 text-xs leading-5 text-fg-subtle">
              <Badge tone="warning" className="mb-2">
                Estimates, not billing data
              </Badge>
              <p>{usage.data.note}</p>
              <a href={usage.data.dashboard_url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-accent hover:underline">
                Open Workers AI usage in the Cloudflare dashboard <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </>
        )}
      </Section>
      <SemanticRecallCard />
    </>
  );
}

function PrivacyTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [confirm, setConfirm] = useState<"history" | "memories" | null>(null);
  const clear = useApiMutation(
    (what: "history" | "memories") => api(what === "history" ? "/conversations" : "/memories", { method: "DELETE", body: { confirm: "DELETE" } }),
    {
      invalidate: [["conversations"], ["memories"]],
      success: (r) => `Deleted ${(r as { deleted: number }).deleted} item(s)`,
      onSuccess: () => setConfirm(null),
    },
  );

  async function onImport(file: File) {
    setImporting(true);
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error("Backup file is larger than 25 MB.");
      const json = JSON.parse(await file.text());
      const r = await api<{ imported: Record<string, number> & { automations_paused: number; ignored_settings: string[] } }>("/import", {
        method: "POST",
        body: json,
      });
      const { automations_paused, ignored_settings, ...counts } = r.imported;
      const notes = [
        automations_paused ? `${automations_paused} automation(s) imported paused — enable them in Automations` : "",
        ignored_settings.length ? `kept your current ${ignored_settings.join(", ")} settings` : "",
      ].filter(Boolean);
      toast(`Imported ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}${notes.length ? `. ${notes.join("; ")}.` : ""}`);
      await qc.invalidateQueries();
    } catch (error) {
      toast(error instanceof SyntaxError ? "That file is not valid JSON." : errorMessage(error), "error");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <>
      <Section title="Your data">
        <div className="px-5 py-4 text-sm leading-6 text-fg-muted">
          Everything Talorys stores lives in a Durable Object in your own Cloudflare account. Nothing is sent to the Talorys developers. Messages are processed by Cloudflare Workers AI when you chat.
        </div>
        <Row label="Export data" hint="Conversations, memories, tasks, notes, projects, settings and automations as talorys-backup.json. Sessions and credentials are never exported.">
          <a href="/api/export" download="talorys-backup.json" className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium hover:bg-subtle">
            <Download className="h-4 w-4" /> Download backup
          </a>
        </Row>
        <Row label="Import data" hint="Merges a backup into your data. Existing items with the same id are updated, except automations, which are kept as they are; new automations arrive paused. Model, limits, demo mode and auto-memory settings are not imported. Nothing is deleted.">
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && void onImport(e.target.files[0])} />
          <Button variant="outline" className="w-full justify-center" loading={importing} onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" /> Choose backup file
          </Button>
        </Row>
      </Section>
      <Section title="Danger zone">
        <Row label="Delete conversation history" hint="Permanently deletes all conversations and messages.">
          <Button variant="outline" className="w-full justify-center text-danger" onClick={() => setConfirm("history")}>
            Delete history
          </Button>
        </Row>
        <Row label="Clear memories" hint="Talorys forgets everything it learned about you.">
          <Button variant="outline" className="w-full justify-center text-danger" onClick={() => setConfirm("memories")}>
            Clear memories
          </Button>
        </Row>
      </Section>
      <ConfirmDialog
        open={!!confirm}
        title={confirm === "history" ? "Delete all conversations?" : "Clear all memories?"}
        message="This cannot be undone. Consider exporting a backup first."
        confirmLabel={confirm === "history" ? "Delete all" : "Clear all"}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && clear.mutate(confirm)}
        loading={clear.isPending}
      />
    </>
  );
}

function SecurityTab() {
  const { logout } = useSession();
  const sessions = useSessions();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmNext, setConfirmNext] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const strength = next ? checkPasswordStrength(next) : null;
  const change = useApiMutation(() => api("/auth/password", { method: "POST", body: { current_password: current, new_password: next } }), {
    invalidate: [keys.sessions],
    success: "Password changed. Other devices were signed out.",
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirmNext("");
    },
  });
  const revoke = useApiMutation((id: string) => api(`/auth/sessions/${id}`, { method: "DELETE" }), { invalidate: [keys.sessions], success: "Session signed out" });
  const revokeOthers = useApiMutation(() => api("/auth/sessions/revoke-others", { method: "POST", body: {} }), {
    invalidate: [keys.sessions],
    success: "Signed out other sessions",
  });
  useEffect(() => setFormError(change.error instanceof ApiError ? change.error.message : null), [change.error]);

  return (
    <>
      <Section title="Change password">
        <form
          className="space-y-4 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (next !== confirmNext) return setFormError("New passwords do not match.");
            if (strength) return setFormError(strength);
            setFormError(null);
            change.mutate(undefined);
          }}
        >
          <input type="text" autoComplete="username" value="owner" readOnly hidden />
          <div>
            <Label htmlFor="pw-current">Current password</Label>
            <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="pw-new">New password</Label>
              <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
              {next && <p className={cn("mt-1 text-xs", strength ? "text-warning" : "text-success")}>{strength ?? "Strong enough"}</p>}
            </div>
            <div>
              <Label htmlFor="pw-confirm">Confirm new password</Label>
              <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirmNext} onChange={(e) => setConfirmNext(e.target.value)} />
            </div>
          </div>
          {formError && <p className="text-sm text-danger">{formError}</p>}
          <div className="flex justify-end">
            <Button type="submit" loading={change.isPending} disabled={!current || !next || !confirmNext}>
              Change password
            </Button>
          </div>
        </form>
      </Section>
      <Section title="Active sessions">
        {sessions.isLoading ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : (
          sessions.data?.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {describeAgent(s.user_agent)} {s.current && <Badge tone="accent">This device</Badge>}
                </p>
                <p className="text-xs text-fg-subtle">
                  Signed in {relativeTime(s.created_at)} · active {relativeTime(s.last_seen_at)}
                </p>
              </div>
              {!s.current && (
                <Button variant="ghost" size="sm" onClick={() => revoke.mutate(s.id)}>
                  Sign out
                </Button>
              )}
            </div>
          ))
        )}
        <div className="flex flex-wrap justify-end gap-2 px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => revokeOthers.mutate(undefined)} loading={revokeOthers.isPending}>
            Sign out other sessions
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void logout()}>
            <LogOut className="h-3.5 w-3.5" /> Lock this device
          </Button>
        </div>
      </Section>
      <p className="px-1 text-xs leading-5 text-fg-subtle">
        Forgot your password? On your computer, run <code className="rounded bg-muted px-1">npx create-talorys@latest reset-password</code> in your Talorys
        directory. This signs out every device.
      </p>
    </>
  );
}

function describeAgent(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function AboutTab() {
  const info = useSystemInfo();
  return (
    <Section title="About Talorys">
      <Row label="Version">
        <p className="text-right font-mono text-sm">{info.data?.deployed_version ?? TALORYS_VERSION}</p>
      </Row>
      <Row label="Deployment" hint="Your own Cloudflare account. Pages frontend → service binding → private Worker → Durable Object.">
        <div className="space-y-1 text-right text-xs text-fg-muted">
          {info.data ? (
            <>
              <p>Installation: <span className="font-mono">{info.data.installation_id ?? "local"}</span></p>
              <p>Schema v{info.data.schema_version} · {info.data.environment}</p>
              <p>AI: {info.data.ai_provider === "workers-ai" ? "Cloudflare Workers AI" : info.data.ai_provider === "mock" ? "Demo responder" : "Not available"}</p>
            </>
          ) : (
            <Spinner className="ml-auto h-4 w-4" />
          )}
        </div>
      </Row>
      <Row label="Source code" hint="Free and open source under the MIT license.">
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="flex items-center justify-end gap-1 text-sm text-accent hover:underline">
          GitHub <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </Row>
      <Row label="Update" hint="Run in your Talorys directory. Your data is preserved.">
        <code className="block rounded bg-muted px-2 py-1 text-right text-xs">npx create-talorys@latest update</code>
      </Row>
    </Section>
  );
}
