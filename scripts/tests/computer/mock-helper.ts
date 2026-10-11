import http from "node:http";
import type { BrowserEngineAdapter, BrowserState, ClickTarget, TypeTarget, ScrollOptions } from "../../services/computer-manager/engine/types";
import type { ContainerDriver, ContainerInfo } from "../../services/computer-manager/container";

export class FastMockContainerDriver implements ContainerDriver {
  public running = false;
  public startCalls = 0;
  public stopCalls = 0;

  async isContainerRunning(): Promise<boolean> {
    return this.running;
  }

  async stopContainer(): Promise<void> {
    this.running = false;
    this.stopCalls++;
  }

  async startContainer(): Promise<ContainerInfo> {
    this.running = true;
    this.startCalls++;
    return {
      running: true,
      name: "talorys-computer-sandbox",
      vncPort: 28790,
      cdpPort: 28791,
      id: "mock_container_id_123",
    };
  }

  async execInContainer(cmd: string[]): Promise<{ stdout: string; stderr: string }> {
    return { stdout: "mock stdout", stderr: "" };
  }
}

export class MockBrowserEngine implements BrowserEngineAdapter {
  readonly name = "mock-browser";
  public calls: Array<{ action: string; args: any }> = [];
  public delayMs = 0;
  public failNextAction?: Error;
  public cdpPort = 28791;
  public connected = false;

  public state: BrowserState = {
    url: "https://www.google.co.kr",
    title: "Google",
    textSnippet: "Search the world's information",
    interactiveElements: 'button "Google Search" @e1\ninput "Search" @e2',
    screenshotBase64: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  };

  async connect(cdpPort: number): Promise<void> {
    this.cdpPort = cdpPort;
    this.connected = true;
    this.calls.push({ action: "connect", args: { cdpPort } });
  }

  private async handleDelayAndSignal(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error("ACTION_ABORTED_USER_CONTROL");
    }
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve();
        }, this.delayMs);

        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("ACTION_ABORTED_USER_CONTROL"));
        };

        if (signal) {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
    if (this.failNextAction) {
      const err = this.failNextAction;
      this.failNextAction = undefined;
      throw err;
    }
  }

  async navigate(url: string, signal?: AbortSignal): Promise<BrowserState> {
    this.calls.push({ action: "navigate", args: { url } });
    await this.handleDelayAndSignal(signal);
    this.state.url = url.startsWith("http") ? url : `https://${url}`;
    this.state.title = `Title of ${this.state.url}`;
    return { ...this.state };
  }

  async click(target: ClickTarget, signal?: AbortSignal): Promise<BrowserState> {
    this.calls.push({ action: "click", args: target });
    await this.handleDelayAndSignal(signal);
    return { ...this.state };
  }

  async typeText(target: TypeTarget, signal?: AbortSignal): Promise<BrowserState> {
    this.calls.push({ action: "typeText", args: target });
    await this.handleDelayAndSignal(signal);
    return { ...this.state };
  }

  async pressKey(key: string, signal?: AbortSignal): Promise<BrowserState> {
    this.calls.push({ action: "pressKey", args: { key } });
    await this.handleDelayAndSignal(signal);
    return { ...this.state };
  }

  async scroll(options: ScrollOptions, signal?: AbortSignal): Promise<BrowserState> {
    this.calls.push({ action: "scroll", args: options });
    await this.handleDelayAndSignal(signal);
    return { ...this.state };
  }

  async getState(includeScreenshot?: boolean): Promise<BrowserState> {
    this.calls.push({ action: "getState", args: { includeScreenshot } });
    await this.handleDelayAndSignal();
    return {
      ...this.state,
      screenshotBase64: includeScreenshot ? this.state.screenshotBase64 : undefined,
    };
  }

  async takeScreenshot(): Promise<string> {
    this.calls.push({ action: "takeScreenshot", args: {} });
    await this.handleDelayAndSignal();
    return this.state.screenshotBase64 || "";
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.calls.push({ action: "disconnect", args: {} });
  }

  reset() {
    this.calls = [];
    this.delayMs = 0;
    this.failNextAction = undefined;
    this.connected = false;
  }
}

export interface EphemeralServerInfo {
  server: http.Server;
  baseUrl: string;
  port: number;
  close: () => Promise<void>;
}

export async function startEphemeralServer(serverFactory: () => http.Server): Promise<EphemeralServerInfo> {
  const server = serverFactory();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const addr = server.address() as any;
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    baseUrl,
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function requestJson(url: string, options: RequestInit = {}): Promise<{ status: number; headers: Headers; body: any }> {
  const res = await fetch(url, options);
  let body: any;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return {
    status: res.status,
    headers: res.headers,
    body,
  };
}
