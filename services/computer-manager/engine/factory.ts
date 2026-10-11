import type { BrowserEngineAdapter } from "./types";
import { AgentBrowserAdapter } from "./agent-browser-adapter";
import { BrowserOSNeoAdapter } from "./browseros-adapter";
import { PlaywrightCdpAdapter } from "./playwright-adapter";

export function createBrowserEngine(preferredEngine?: string): BrowserEngineAdapter {
  const engineType = preferredEngine || process.env.TALORYS_BROWSER_ENGINE || "agent-browser";

  switch (engineType.toLowerCase()) {
    case "browseros":
    case "browseros-neo":
      return new BrowserOSNeoAdapter();
    case "playwright":
    case "playwright-core":
      return new PlaywrightCdpAdapter();
    case "agent-browser":
    default:
      return new AgentBrowserAdapter();
  }
}
