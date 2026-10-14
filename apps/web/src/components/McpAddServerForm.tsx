import { useState } from "react";
import type { McpServerCreate } from "@talorys/shared";
import { Button, Input, Label, Select } from "./ui";
import { useApiMutation, keys } from "../hooks/queries";
import { api } from "../lib/api";

export function McpAddServerForm() {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [header, setHeader] = useState("Authorization");
  const [value, setValue] = useState("");
  const [transport, setTransport] = useState<McpServerCreate["transport"]>("streamable-http");
  const add = useApiMutation(
    () => api("/mcp/servers", { method: "POST", body: { name, url, transport, ...(value ? { auth: { header, value } } : {}) } }),
    {
      invalidate: [keys.mcp],
      success: "MCP server added",
      onSuccess: () => {
        setName("");
        setUrl("");
        setValue("");
      },
    },
  );
  return (
    <form
      aria-label="Add MCP server"
      className="space-y-3 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(undefined);
      }}
    >
      <h3 className="text-sm font-medium">Add MCP server</h3>
      <div>
        <Label htmlFor="mcp-name">Server name</Label>
        <Input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
      </div>
      <div>
        <Label htmlFor="mcp-url">Server URL</Label>
        <Input id="mcp-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2048} required />
      </div>
      <div>
        <Label htmlFor="mcp-transport">Transport</Label>
        <Select id="mcp-transport" value={transport} onChange={(e) => setTransport(e.target.value as McpServerCreate["transport"])}>
          <option value="streamable-http">Streamable HTTP</option>
          <option value="sse">SSE</option>
        </Select>
      </div>
      <McpAuthFields header={header} value={value} onHeader={setHeader} onValue={setValue} />
      <Button type="submit" loading={add.isPending} disabled={!name.trim() || !url}>
        Add server
      </Button>
    </form>
  );
}

function McpAuthFields(p: { header: string; value: string; onHeader: (v: string) => void; onValue: (v: string) => void }) {
  return (
    <>
      <div>
        <Label htmlFor="mcp-header">Auth header name</Label>
        <Input id="mcp-header" value={p.header} onChange={(e) => p.onHeader(e.target.value)} maxLength={64} />
      </div>
      <div>
        <Label htmlFor="mcp-secret">Auth header value</Label>
        <Input id="mcp-secret" type="password" autoComplete="off" value={p.value} onChange={(e) => p.onValue(e.target.value)} maxLength={4096} />
      </div>
    </>
  );
}
