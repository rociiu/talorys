import { type ReactNode, useState } from "react";
import { GITHUB_URL, type RemoteScope, type RemoteTokenInfo, REMOTE_TOKEN_PREFIX } from "@talorys/shared";
import { Copy, KeyRound } from "lucide-react";
import { Badge, Button, Card, ConfirmDialog, ErrorNotice, Input, Label, Select, Switch } from "./ui";
import { keys, useApiMutation, useRemoteStatus, useRemoteTokens } from "../hooks/queries";
import { useToast } from "../hooks/toast";
import { api } from "../lib/api";
import { relativeTime } from "../lib/utils";
import { useI18n } from "../lib/i18n";

const DESCRIPTION =
  "Create personal access tokens so scripts and other apps can use your Talorys data over HTTPS.";
const SUSPENDED_HINT = "Tokens stay suspended until you turn this back on.";
const WRITE_HINT = "Write can create, update, and delete tasks, notes, reminders, and memories.";
const DOCS_URL = `${GITHUB_URL}/blob/main/docs/remote-access.md`;

/** A ready-to-run request for the once-only panel, against this install. */
function curlExample(token: string): string {
  return `curl -H "Authorization: Bearer ${token}" ${window.location.origin}/api/tasks`;
}

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-5 text-fg-subtle">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Settings card for personal access tokens: the on/off switch, a generate form, the once-only plaintext and the token list. */
export function RemoteAccessCard() {
  const i18n = useI18n();
  const toast = useToast();
  const status = useRemoteStatus();
  const tokens = useRemoteTokens();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<RemoteScope>("read");
  // The plaintext lives only here: the create mutation returns the name, never the token.
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const enabled = status.data?.enabled === true;
  const list = tokens.data ?? [];

  const toggle = useApiMutation((on: boolean) => api<{ enabled: boolean }>("/remote/status", { method: "PATCH", body: { enabled: on } }), {
    invalidate: [keys.remoteStatus],
    success: (r) => (r.enabled ? "Remote access turned on" : "Remote access turned off"),
  });
  const create = useApiMutation(
    async (input: { name: string; scope: RemoteScope }) => {
      const r = await api<{ token: RemoteTokenInfo & { token: string } }>("/remote/tokens", { method: "POST", body: input });
      setPlaintext(r.token.token);
      return r.token.name;
    },
    { invalidate: [keys.remoteTokens], success: (n) => `Created access token "${n}"`, onSuccess: () => setName("") },
  );
  const revoke = useApiMutation((t: RemoteTokenInfo) => api(`/remote/tokens/${t.id}`, { method: "DELETE" }), {
    invalidate: [keys.remoteTokens],
    success: "Access token revoked",
  });
  const revokeAll = useApiMutation(() => api<{ revoked: number }>("/remote/tokens", { method: "DELETE" }), {
    invalidate: [keys.remoteTokens],
    success: (r) => `Revoked ${r.revoked} access token(s)`,
    onSuccess: () => setConfirmAll(false),
  });

  async function copy(text: string, done = "Token copied") {
    try {
      await navigator.clipboard.writeText(text);
      toast(done);
    } catch {
      toast("Could not copy the token. Select it and copy it by hand.", "error");
    }
  }

  const error = status.error ?? tokens.error;
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-medium uppercase tracking-wider text-fg-subtle">Remote access</h2>
      <Card>
        <div className="divide-y divide-border">
          {error ? (
            <div className="px-5 py-4">
              <ErrorNotice error={error} onRetry={() => void Promise.all([status.refetch(), tokens.refetch()])} />
            </div>
          ) : !status.data ? null : (
            <>
              <Row
                label={
                  <span className="flex items-center gap-2">
                    Remote access {!enabled && <Badge tone="warning">Suspended</Badge>}
                  </span>
                }
                hint={
                  <>
                    {DESCRIPTION}{" "}
                    <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                      How to use access tokens
                    </a>
                    {!enabled && (
                      <>
                        {" "}
                        {SUSPENDED_HINT}
                      </>
                    )}
                  </>
                }
              >
                <Switch checked={enabled} onChange={(on) => toggle.mutate(on)} label="Remote access" disabled={toggle.isPending} />
              </Row>
              <form
                className="space-y-3 px-5 py-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (enabled && name.trim()) create.mutate({ name: name.trim(), scope });
                }}
              >
                <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
                  <div>
                    <Label htmlFor="remote-token-name">Token name</Label>
                    <Input id="remote-token-name" value={name} maxLength={64} placeholder="e.g. Home server" onChange={(e) => setName(e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="remote-token-scope">Scope</Label>
                    <Select id="remote-token-scope" value={scope} onChange={(e) => setScope(e.target.value as RemoteScope)}>
                      <option value="read">read</option>
                      <option value="write">write</option>
                    </Select>
                  </div>
                </div>
                {scope === "write" && <p className="text-xs leading-5 text-warning">{WRITE_HINT}</p>}
                <div className="flex justify-end">
                  <Button type="submit" loading={create.isPending} disabled={!enabled || !name.trim()}>
                    <KeyRound className="h-4 w-4" /> Generate token
                  </Button>
                </div>
              </form>
              {plaintext && (
                <div className="space-y-3 bg-subtle px-5 py-4" role="region" aria-label="New access token">
                  <p className="text-sm font-medium text-warning">Copy this token now. It will not be shown again.</p>
                  <code className="block break-all rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm">{plaintext}</code>
                  <p className="text-xs leading-5 text-fg-subtle">
                    Use it as a Bearer token.{" "}
                    <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                      Docs
                    </a>
                  </p>
                  <code
                    data-testid="remote-token-example"
                    className="block break-all rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs"
                  >
                    {curlExample(plaintext)}
                  </code>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => void copy(plaintext)}>
                      <Copy className="h-3.5 w-3.5" /> Copy
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void copy(curlExample(plaintext), "Example copied")}>
                      <Copy className="h-3.5 w-3.5" /> Copy example
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setPlaintext(null)}>
                      Done
                    </Button>
                  </div>
                </div>
              )}
              {list.length === 0 ? (
                <p className="px-5 py-4 text-sm text-fg-subtle">No access tokens yet.</p>
              ) : (
                list.map((t) => (
                  <Row
                    key={t.id}
                    label={t.name}
                    hint={`${REMOTE_TOKEN_PREFIX}…${t.hint} · created ${relativeTime(t.created_at, i18n)} · last used ${t.last_used_at ? relativeTime(t.last_used_at, i18n) : "Never"}`}
                  >
                    <div className="flex items-center gap-2">
                      <Badge tone={t.scope === "write" ? "warning" : "neutral"}>{t.scope}</Badge>
                      <Button variant="ghost" size="sm" aria-label={`Revoke ${t.name}`} onClick={() => revoke.mutate(t)} disabled={revoke.isPending}>
                        Revoke
                      </Button>
                    </div>
                  </Row>
                ))
              )}
              <div className="flex justify-between gap-2 px-5 py-3">
                <p className="self-center text-xs text-fg-subtle">
                  {list.length} of {status.data.max_tokens} tokens.
                </p>
                <Button variant="outline" size="sm" className="text-danger" onClick={() => setConfirmAll(true)} disabled={list.length === 0}>
                  Revoke all
                </Button>
              </div>
            </>
          )}
        </div>
      </Card>
      <ConfirmDialog
        open={confirmAll}
        title="Revoke all access tokens?"
        message="Every machine client using a token loses access at once. This cannot be undone."
        confirmLabel="Revoke all"
        onCancel={() => setConfirmAll(false)}
        onConfirm={() => revokeAll.mutate(undefined)}
        loading={revokeAll.isPending}
      />
    </section>
  );
}
