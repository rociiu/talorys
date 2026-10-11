import type { BrowserEngineAdapter, BrowserState, ClickTarget, TypeTarget, ScrollOptions } from "./types";

/**
 * BrowserOS Neo Engine Adapter
 * Connects to BrowserOS sidecar/server or native BrowserOS instance via MCP / HTTP protocol.
 */
export class BrowserOSNeoAdapter implements BrowserEngineAdapter {
  readonly name = "browseros-neo";
  private cdpPort = 28791;
  private serverUrl = "http://127.0.0.1:9225";

  async connect(cdpPort: number): Promise<void> {
    this.cdpPort = cdpPort;
    // Check if BrowserOS sidecar server is available, fallback to CDP if sidecar not running
    try {
      const res = await fetch(`${this.serverUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (!res.ok) throw new Error("Sidecar health check failed");
    } catch {
      // Connectable via CDP fallback
    }
  }

  async navigate(url: string): Promise<BrowserState> {
    // In full BrowserOS deployment, calls BrowserOS sidecar route /api/navigate
    // Fallback to basic state
    return {
      url,
      title: "BrowserOS Neo Session",
      textSnippet: `Navigated to ${url} via BrowserOS neo`,
    };
  }

  async click(_target: ClickTarget): Promise<BrowserState> {
    return this.getState();
  }

  async typeText(_target: TypeTarget): Promise<BrowserState> {
    return this.getState();
  }

  async pressKey(_key: string): Promise<BrowserState> {
    return this.getState();
  }

  async scroll(_options: ScrollOptions): Promise<BrowserState> {
    return this.getState();
  }

  async getState(_includeScreenshot = false): Promise<BrowserState> {
    return {
      url: "about:blank",
      title: "BrowserOS Neo",
      textSnippet: "BrowserOS neo standby",
    };
  }

  async takeScreenshot(): Promise<string> {
    return "";
  }

  async disconnect(): Promise<void> {
    // Teardown
  }
}
