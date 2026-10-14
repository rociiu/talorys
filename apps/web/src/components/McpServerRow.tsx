import { useState } from "react";
import type { McpServerPatch, McpServerView, McpToolPolicy } from "@talorys/shared";
import { Badge, Button, ConfirmDialog, Input, Select, Switch } from "./ui";
import { keys, useApiMutation } from "../hooks/queries";
import { api } from "../lib/api";

export function McpServerRow({ server: s }: { server: McpServerView }) {
  const patch = useApiMutation((body: McpServerPatch) => api(`/mcp/servers/${s.id}`, { method: "PATCH", body }), { invalidate: [keys.mcp] });
  return (
    <section aria-label={`MCP server ${s.name}`} className="space-y-3 border-t border-border p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">
          {s.name} <Badge>{s.status}</Badge>
        </h3>
        <Switch label={`Enabled for ${s.name}`} checked={s.enabled} onChange={(enabled) => patch.mutate({ enabled })} />
      </div>
      <p className="break-all text-xs text-fg-muted">{s.url}</p>
      {s.last_error && <p className="text-sm text-danger">{s.last_error}</p>}
      <p className="text-xs text-fg-muted">
        {s.calls_today} / {s.max_calls_per_day} calls today
      </p>
      <Input
        aria-label={`Daily call cap for ${s.name}`}
        type="number"
        min={1}
        max={500}
        defaultValue={s.max_calls_per_day}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n >= 1 && n <= 500 && n !== s.max_calls_per_day) patch.mutate({ max_calls_per_day: n });
        }}
      />
      <McpSecretForm server={s} />
      <McpServerActions server={s} />
      {s.tools.map((t) => (
        <McpToolRow key={t.name} serverId={s.id} tool={t} />
      ))}
    </section>
  );
}
function McpSecretForm({ server: s }: { server: McpServerView }) {
  const [value, setValue] = useState("");
  const [header, setHeader] = useState(s.auth?.header ?? "Authorization");
  const save = useApiMutation((auth: McpServerPatch["auth"]) => api(`/mcp/servers/${s.id}`, { method: "PATCH", body: { auth } }), {
    invalidate: [keys.mcp],
    onSuccess: () => setValue(""),
  });
  return (
    <form
      className="space-y-2"
      aria-label={`Authentication for ${s.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ header, value });
      }}
    >
      <p className="text-xs text-fg-muted">{s.auth ? "Secret set · Replace" : "No authentication header"}</p>
      <Input aria-label={`Auth header name for ${s.name}`} value={header} onChange={(e) => setHeader(e.target.value)} />
      <Input
        aria-label={`Replace auth header value for ${s.name}`}
        type="password"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button type="submit" variant="outline" disabled={!value} loading={save.isPending}>
        Save secret
      </Button>
      {s.auth && (
        <Button type="button" variant="ghost" onClick={() => save.mutate(null)}>
          Clear secret
        </Button>
      )}
    </form>
  );
}

function McpServerActions({ server: s }: { server: McpServerView }) {
  const [remove, setRemove] = useState(false);
  const action = useApiMutation(
    (kind: "test" | "refresh") => api<{ ok?: boolean; error?: string }>(`/mcp/servers/${s.id}/${kind}`, { method: "POST" }),
    {
      invalidate: [keys.mcp],
      success: (r) => (r.ok === false ? (r.error ?? "Connection failed") : "MCP server checked"),
    },
  );
  const del = useApiMutation(() => api(`/mcp/servers/${s.id}`, { method: "DELETE" }), { invalidate: [keys.mcp], onSuccess: () => setRemove(false) });
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" aria-label={`Test ${s.name}`} onClick={() => action.mutate("test")} loading={action.isPending}>
          Test
        </Button>
        <Button variant="outline" aria-label={`Refresh tools for ${s.name}`} onClick={() => action.mutate("refresh")}>
          Refresh tools
        </Button>
        <Button variant="ghost" aria-label={`Remove ${s.name}`} onClick={() => setRemove(true)}>
          Remove
        </Button>
      </div>
      <ConfirmDialog
        open={remove}
        title={`Remove ${s.name}?`}
        message="This removes the server and its cached tools."
        confirmLabel="Remove"
        onCancel={() => setRemove(false)}
        onConfirm={() => del.mutate(undefined)}
        loading={del.isPending}
      />
    </>
  );
}

function McpToolRow({ serverId, tool: t }: { serverId: string; tool: McpServerView["tools"][number] }) {
  const policy = useApiMutation(
    (next: McpToolPolicy) => api(`/mcp/servers/${serverId}/tools/${encodeURIComponent(t.name)}`, { method: "PATCH", body: { policy: next } }),
    { invalidate: [keys.mcp] },
  );
  return (
    <div className="space-y-1 rounded border border-border p-3">
      <p className="text-sm">
        {t.title ?? t.name} <Badge>{t.status}</Badge> {t.read_only && <Badge>Read only hint</Badge>} {t.destructive && <Badge>May change data</Badge>}
      </p>
      <p className="text-xs text-fg-muted">{t.description}</p>
      <Select
        aria-label={`Policy for ${t.name}`}
        value={t.policy}
        disabled={policy.isPending}
        onChange={(e) => policy.mutate(e.target.value as McpToolPolicy)}
      >
        <option value="off">Off</option>
        <option value="auto">Automatic</option>
        <option value="approve">Ask me first</option>
      </Select>
    </div>
  );
}
