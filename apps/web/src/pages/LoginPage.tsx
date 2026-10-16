import { type FormEvent, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Lock } from "lucide-react";
import { Logo } from "../components/Logo";
import { Button } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useI18n } from "../lib/i18n";

export function LoginPage({ configured }: { configured: boolean }) {
  const { t, rich } = useI18n();
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!retryAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [retryAt]);
  const waitSeconds = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || pending || waitSeconds > 0) return;
    setPending(true);
    setError(null);
    try {
      await api("/auth/login", { method: "POST", body: { password } });
      setPassword("");
      await qc.invalidateQueries({ queryKey: ["session"] });
    } catch (err) {
      if (err instanceof ApiError && err.code === "RATE_LIMITED") {
        const seconds = (err.details as { retry_after?: number } | undefined)?.retry_after ?? 60;
        setRetryAt(Date.now() + seconds * 1000);
        setError(t("login.rateLimited"));
      } else {
        setError(err instanceof Error ? err.message : t("login.failed"));
      }
      setPassword("");
      inputRef.current?.focus();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-6">
      <div className="w-full max-w-[360px] animate-slide-up">
        <div className="mb-10 flex flex-col items-center text-center">
          <Logo className="h-12 w-12" />
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">Talorys</h1>
          <p className="mt-1.5 text-sm text-fg-muted">{t("login.tagline")}</p>
        </div>

        {!configured ? (
          <div role="alert" className="rounded-lg border border-border bg-surface p-4 text-sm leading-6 text-fg-muted">
            {rich("login.notConfigured", { command: <code className="rounded bg-muted px-1">npx create-talorys@latest</code> })}
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3" noValidate>
            <label htmlFor="password" className="sr-only">
              {t("login.password")}
            </label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
              <input
                ref={inputRef}
                id="password"
                type={show ? "text" : "password"}
                autoComplete="current-password"
                autoFocus
                placeholder={t("login.passwordPlaceholder")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={error ? "login-error" : undefined}
                className="h-12 w-full rounded-xl border border-border bg-surface pl-10 pr-11 text-[15px] shadow-sm placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-fg-subtle hover:text-fg"
                aria-label={show ? t("login.hidePassword") : t("login.showPassword")}
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button type="submit" className="h-12 w-full justify-center rounded-xl text-[15px]" loading={pending} disabled={!password || waitSeconds > 0}>
              {waitSeconds > 0 ? t("login.tryAgainIn", { seconds: waitSeconds }) : t("login.unlock")}
            </Button>
            {error && (
              <p id="login-error" role="alert" className="text-center text-sm text-danger">
                {error}
              </p>
            )}
          </form>
        )}

        <p className="mt-10 text-center text-xs leading-5 text-fg-subtle">
          {rich("login.forgotPassword", {
            lineBreak: <br />,
            command: <code className="rounded bg-muted px-1">npx create-talorys@latest reset-password</code>,
          })}
        </p>
      </div>
    </div>
  );
}
