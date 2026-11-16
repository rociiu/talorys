import { type ReactNode, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PushDevice, PushStatus } from "@talorys/shared";
import { Send, Trash2 } from "lucide-react";
import { Badge, Button, Card, ErrorNotice, Spinner, Switch } from "./ui";
import { useApiMutation } from "../hooks/queries";
import { api } from "../lib/api";
import {
  confirmPushRegistration,
  disablePush,
  enablePush,
  forgetPushDevice,
  pushBlocker,
  PushRegistrationError,
} from "../lib/push";
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

type ToggleVariables = { on: boolean; publicKey: string };
type ToggleResult = { on: boolean; status: PushStatus; device?: PushDevice };
type FailureAction = "check" | "enable" | "disable";
type PushFailure = { error: unknown; action: FailureAction };
let retainedFailure: PushFailure | null = null;
const failureListeners = new Set<() => void>();

function storeFailure(next: PushFailure | null) {
  retainedFailure = next;
  for (const listener of failureListeners) listener();
}

function usePushMutations(publicKey: string) {
  const qc = useQueryClient();
  const setStatus = (s: PushStatus) => qc.setQueryData(KEY, s);
  const [browserSubscription, setBrowserSubscription] = useState<boolean | null>(null);
  const [confirmedDeviceId, setConfirmedDeviceId] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [failure, setFailureState] = useState<PushFailure | null>(retainedFailure);
  const generation = useRef(0);

  const reconcile = async ({ newAttempt = false, reportFailure = true } = {}) => {
    const ownGeneration = ++generation.current;
    if (newAttempt) storeFailure(null);
    setChecking(true);
    try {
      const result = await confirmPushRegistration(publicKey);
      if (generation.current !== ownGeneration) return;
      setBrowserSubscription(!!result.subscription);
      setConfirmedDeviceId(result.device?.id ?? null);
      if (result.status) setStatus(result.status);
    } catch (error) {
      if (reportFailure) {
        const checkError = new Error(`Talorys could not confirm this browser's push registration: ${error instanceof Error ? error.message : "Unknown error"}`, { cause: error });
        storeFailure({ error: checkError, action: "check" });
      }
      if (generation.current === ownGeneration) {
        setBrowserSubscription(null);
        setConfirmedDeviceId(null);
      }
    } finally {
      if (generation.current === ownGeneration) setChecking(false);
    }
  };

  useEffect(() => {
    const listener = () => setFailureState(retainedFailure);
    failureListeners.add(listener);
    void reconcile();
    return () => {
      failureListeners.delete(listener);
      generation.current++;
    };
  }, []);

  const toggle = useApiMutation<ToggleVariables, ToggleResult>(
    async (v) => {
      generation.current++;
      setChecking(false);
      storeFailure(null);
      try {
        if (v.on) {
          const result = await enablePush(v.publicKey);
          return { on: true, ...result };
        }
        return { on: false, status: await disablePush() };
      } catch (error) {
        if (v.on && error instanceof PushRegistrationError && error.diagnostics.stage === "backend") setBrowserSubscription(true);
        storeFailure({ error, action: v.on ? "enable" : "disable" });
        if (!v.on) void reconcile({ reportFailure: false });
        throw error;
      }
    },
    {
      success: (result) => result.on ? "Notifications turned on for this device" : "Notifications turned off for this device",
      onSuccess: (result) => {
        setStatus(result.status);
        setBrowserSubscription(result.on);
        setConfirmedDeviceId(result.on ? result.device!.id : null);
        if (!result.on) forgetPushDevice();
      },
    },
  );
  const remove = useApiMutation((id: string) => api<PushStatus>(`/push/subscriptions/${id}`, { method: "DELETE" }), {
    success: "Device removed",
    onSuccess: (next, id) => {
      setStatus(next);
      if (id === confirmedDeviceId) {
        setConfirmedDeviceId(null);
        forgetPushDevice();
      }
    },
  });
  const test = useApiMutation(() => api<{ result: { sent: number; gone: number; failed: number }; status: PushStatus }>("/push/test", { method: "POST" }), {
    success: (r) => (r.result.sent > 0 ? `Test sent to ${r.result.sent} device(s)` : "No device could be reached"),
    onSuccess: (r) => {
      setStatus(r.status);
      if (confirmedDeviceId && !r.status.devices.some((device) => device.id === confirmedDeviceId)) {
        setConfirmedDeviceId(null);
        forgetPushDevice();
      }
    },
  });
  return {
    browserSubscription,
    checking,
    confirmedDeviceId,
    failure,
    dismissFailure: () => storeFailure(null),
    reconcile,
    toggle,
    remove,
    test,
  };
}

const OPERATION_TEXT = {
  checking: "Checking current registration",
  disabled: "Off",
  enabling: "Turning on…",
  enabled: "On",
  disabling: "Turning off…",
  failed: "Action failed",
} as const;

function PushControls({ status: s }: { status: PushStatus }) {
  const i18n = useI18n();
  const { browserSubscription, checking, confirmedDeviceId, failure, dismissFailure, reconcile, toggle, remove, test } = usePushMutations(s.public_key!);
  const blocker = pushBlocker();
  const registered = !!confirmedDeviceId && s.devices.some((d) => d.id === confirmedDeviceId);
  const enabled = browserSubscription === true && registered;
  const busy = checking || toggle.isPending;
  const operation = toggle.isPending ? (toggle.variables.on ? "enabling" : "disabling")
    : failure ? "failed" : checking ? "checking" : enabled ? "enabled" : "disabled";
  const start = (on: boolean) => {
    if (!busy) toggle.mutate({ on, publicKey: s.public_key! });
  };
  return (
    <>
      <Row label="This device" hint={blocker ? BLOCKER_TEXT[blocker] : "Reminders, digests and routines also arrive as system notifications, even when Talorys is closed."}>
        <div className="flex items-center gap-2">
          {(operation === "checking" || operation === "enabling" || operation === "disabling") && <Spinner className="h-4 w-4" />}
          <Badge tone={operation === "enabled" ? "success" : operation === "failed" ? "danger" : "neutral"}>{OPERATION_TEXT[operation]}</Badge>
          <Switch
            checked={enabled && !blocker}
            onChange={start}
            label="Push notifications on this device"
            disabled={!!blocker || browserSubscription === null || busy}
          />
          <span className="sr-only" role="status" aria-live="polite">{OPERATION_TEXT[operation]}</span>
        </div>
      </Row>
      {failure && (
        <div className="px-5 py-4">
          <ErrorNotice
            error={failure.error}
            onRetry={() => {
              if (busy) return;
              if (failure.action === "check") void reconcile({ newAttempt: true });
              else start(failure.action === "enable");
            }}
            onDismiss={dismissFailure}
          />
          {failure.error instanceof PushRegistrationError && <DiagnosticDetails error={failure.error} />}
        </div>
      )}
      {s.devices.map((d) => (
        <Row key={d.id} label={d.label} hint={`${d.service} · added ${relativeTime(d.created_at, i18n)}${d.failures ? ` · ${d.failures} failed send(s)` : ""}`}>
          <div className="flex items-center gap-2">
            {d.id === confirmedDeviceId && <Badge tone="accent">This device</Badge>}
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
