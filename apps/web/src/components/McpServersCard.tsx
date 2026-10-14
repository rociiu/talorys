import { useQuery } from "@tanstack/react-query";
import type { McpConfig, McpServerView } from "@talorys/shared";
import { Card, ErrorNotice, Input, Spinner } from "./ui";
import { keys, useApiMutation } from "../hooks/queries";
import { api } from "../lib/api";
import { McpAddServerForm } from "./McpAddServerForm";
import { McpServerRow } from "./McpServerRow";

export function McpServersCard() {
  const query = useQuery({ queryKey: keys.mcp, queryFn: () => api<{ servers: McpServerView[]; config: McpConfig }>("/mcp") });
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium uppercase tracking-wider text-fg-subtle">MCP servers</h2>
      <p className="text-sm text-fg-muted">
        Connected servers provide external tools in chat. Review their policies before use. Servers and credentials are excluded from backups.
      </p>
      {query.error ? (
        <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data ? (
        <Spinner />
      ) : (
        <Card>
          <McpConfigForm config={query.data.config} />
          <McpAddServerForm />
          {query.data.servers.map((s) => (
            <McpServerRow key={s.id} server={s} />
          ))}
        </Card>
      )}
    </section>
  );
}
function McpConfigForm({ config }: { config: McpConfig }) {
  const save = useApiMutation((body: Partial<McpConfig>) => api("/mcp/config", { method: "PUT", body }), { invalidate: [keys.mcp] });
  return (
    <div className="space-y-2 p-5">
      <label className="block text-sm">
        MCP calls per turn
        <Input
          aria-label="MCP calls per turn"
          type="number"
          min={0}
          max={10}
          defaultValue={config.maxCallsPerTurn}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (Number.isInteger(n) && n >= 0 && n <= 10) save.mutate({ maxCallsPerTurn: n });
          }}
        />
      </label>
      <label className="block text-sm">
        MCP result characters
        <Input
          aria-label="MCP result characters"
          type="number"
          min={1}
          max={20000}
          defaultValue={config.maxResultChars}
          onBlur={(e) => {
            const n = Number(e.target.value);
            if (Number.isInteger(n) && n >= 1 && n <= 20000) save.mutate({ maxResultChars: n });
          }}
        />
      </label>
    </div>
  );
}
