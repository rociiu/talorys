import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { isChunkLoadError, reloadForNewVersion } from "../lib/chunkErrors";
import { useI18n } from "../lib/i18n";
import { Button } from "./ui";

function Fallback({ error }: { error: unknown }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="flex min-h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <AlertTriangle className="h-8 w-8 text-fg-subtle" aria-hidden />
      <h1 className="text-lg font-semibold text-fg">{t("error.title")}</h1>
      <p className="max-w-sm text-sm leading-6 text-fg-muted">{t(isChunkLoadError(error) ? "error.updatedBody" : "error.body")}</p>
      <Button className="mt-2" onClick={() => location.reload()}>
        {t("error.reload")}
      </Button>
    </div>
  );
}

interface Props {
  children: ReactNode;
  /** A change (the route, say) clears the error, so the owner can move on from a page that crashed. */
  resetKey?: string;
}

/** Shows a way forward instead of a blank screen when a page fails to render or load. */
export class ErrorBoundary extends Component<Props, { failed: boolean; error: unknown }> {
  override state = { failed: false, error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Page failed to render", error, info.componentStack);
    if (isChunkLoadError(error)) reloadForNewVersion();
  }

  override componentDidUpdate(prev: Props) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false, error: null });
  }

  override render() {
    return this.state.failed ? <Fallback error={this.state.error} /> : this.props.children;
  }
}
