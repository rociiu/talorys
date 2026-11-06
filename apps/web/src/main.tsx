import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import "./styles/index.css";
import { initTheme } from "./lib/theme";
import { initLanguage } from "./lib/i18n";
import { App } from "./App";
import { SessionProvider } from "./hooks/session";
import { ToastProvider } from "./hooks/toast";
import { ApiError } from "./lib/api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { reloadForNewVersion } from "./lib/chunkErrors";

initTheme();
initLanguage();

// A chunk from before an update is gone. If the reload is refused, the error reaches the boundary.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadForNewVersion()) event.preventDefault();
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <SessionProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </SessionProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
