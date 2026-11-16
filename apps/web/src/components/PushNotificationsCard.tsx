import { type ReactNode, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PushStatus } from "@talorys/shared";
import { Send, Trash2 } from "lucide-react";
import { Badge, Button, Card, ErrorNotice, Switch } from "./ui";
import { useApiMutation } from "../hooks/queries";
import { api } from "../lib/api";
import { currentSubscription, disablePush, enablePush, pushBlocker, PushRegistrationError, thisDeviceId } from "../lib/push";
import { relativeTime } from "../lib/utils";
import { useI18n } from "../lib/i18n";

const KEY = ["push"] as const;

const BLOCKER_TEXT = {
  "ios-not-installed": "On iPhone and iPad, notifications only work from the Home Screen app: tap Share, then Add to Home Screen, open Talorys from there and come back here.",
  unsupported: "This browser does not support push notifications.",
  denied: "Notifications are blocked for this site. Allow them in your browser's site settings, then reload this page.",
} as const;

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-5 text-fg-subtle">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Settings card for Web Push: this device's switch, the device list and a test send. */
export function PushNotificationsCard() {
  const status = useQuery({ queryKey: KEY, queryFn: () => api<PushStatus>("/push") });
  const s = status.data;
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-xs font-medium uppercase tracking-wider text-fg-subtle">Push notifications</h2>
      <Card>
        <div className="divide-y divide-border">
          {status.error ? (
            <div className="px-5 py-4"><ErrorNotice error={status.error} onRetry={() => void status.refetch()} /></div>
          ) : !s ? null : !s.available ? (
            <Row label="Push notifications" hint="Not set up on this deployment. Re-run the installer to add push keys (see docs/deployment.md).">
              <Badge>Unavailable</Badge>
            </Row>
          ) : (
            <PushControls status={s} />
          )}
        </div>
      </Card>
    </section>
  );
}

function DiagnosticDetails({ error }: { error: PushRegistrationError }) {
  const d = error.diagnostics;
  const entries = [
    ["Stage", d.stage],
    ["Browser error", d.exceptionName ? `${d.exceptionName}: ${d.exceptionMessage}` : "None"],
    ["Notification permission", d.permission],
    ["Service worker active", d.serviceWorkerActive ? "Yes" : "No"],
    ["Existing subscription", d.existingSubscription ? "Yes" : "No"],
    ["Backend request attempted", d.backendAttempted ? "Yes" : "No"],
  ];
  return (
    <details className="mt-2 text-xs text-fg-subtle">
      <summary className="cursor-pointer">Diagnostic details</summary>
      <dl className="mt-2 space-y-1">
        {entries.map(([label, value]) => (
          <div key={label} className="flex gap-2">
            <dt className="font-medium">{label}:</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function usePushMutations() {
  const qc = useQueryClient();
  const setStatus = (s: PushStatus) => qc.setQueryData(KEY, s);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [failure, setFailure] = useState<{ error: unknown; on: boolean } | null>(null);
  useEffect(() => {
    void currentSubscription().then((s) => setSubscribed(!!s), () => setSubscribed(false));
  }, []);
  const toggle = useApiMutation(
    async (v: { on: boolean; publicKey: string }) => {
      setFailure(null);
      try {
        return v.on ? (await enablePush(v.publicKey)).status : disablePush();
      } catch (error) {
        if (v.on) setSubscribed(false);
        setFailure({ error, on: v.on });
        throw error;
      }
    },
    {
      quiet: true,
      success: (s) => (s.devices.some((d) => d.id === thisDeviceId()) ? "Notifications turned on for this device" : "Notifications turned off for this device"),
      onSuccess: (s, v) => { setStatus(s); setSubscribed(v.on); },
    },
  );
  const remove = useApiMutation((id: string) => api<PushStatus>(`/push/subscriptions/${id}`, { method: "DELETE" }), {
    success: "Device removed",
    onSuccess: setStatus,
  });
  const test = useApiMutation(() => api<{ result: { sent: number; gone: number; failed: number }; status: PushStatus }>("/push/test", { method: "POST" }), {
    success: (r) => (r.result.sent > 0 ? `Test sent to ${r.result.sent} device(s)` : "No device could be reached"),
    onSuccess: (r) => setStatus(r.status),
  });
  return { subscribed, failure, toggle, remove, test };
}

function PushControls({ status: s }: { status: PushStatus }) {
  const i18n = useI18n();
  const { subscribed, failure, toggle, remove, test } = usePushMutations();
  const blocker = pushBlocker();
  const current = thisDeviceId();
  return (
    <>
      <Row label="This device" hint={blocker ? BLOCKER_TEXT[blocker] : "Reminders, digests and routines also arrive as system notifications, even when Talorys is closed."}>
        <Switch
          checked={subscribed === true && !blocker}
          onChange={(on) => toggle.mutate({ on, publicKey: s.public_key! })}
          label="Push notifications on this device"
          disabled={!!blocker || subscribed === null || toggle.isPending}
        />
      </Row>
      {failure && (
        <div className="px-5 py-4">
          <ErrorNotice
            error={failure.error}
            onRetry={() => {
              if (!toggle.isPending) toggle.mutate({ on: failure.on, publicKey: s.public_key! });
            }}
          />
          {failure.error instanceof PushRegistrationError && <DiagnosticDetails error={failure.error} />}
        </div>
      )}
      {s.devices.map((d) => (
        <Row key={d.id} label={d.label} hint={`${d.service} · added ${relativeTime(d.created_at, i18n)}${d.failures ? ` · ${d.failures} failed send(s)` : ""}`}>
          <div className="flex items-center gap-2">
            {d.id === current && <Badge tone="accent">This device</Badge>}
            <Button variant="ghost" aria-label={`Remove ${d.label}`} onClick={() => remove.mutate(d.id)} disabled={remove.isPending}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </Row>
      ))}
      <Row label="Send a test" hint={`${s.devices.length} of ${s.max_devices} devices registered.`}>
        <Button variant="outline" onClick={() => test.mutate(undefined)} disabled={s.devices.length === 0 || test.isPending}>
          <Send className="h-4 w-4" /> Send test
        </Button>
      </Row>
    </>
  );
}
