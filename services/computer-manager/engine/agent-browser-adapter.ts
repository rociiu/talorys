import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BrowserEngineAdapter, BrowserState, ClickTarget, TypeTarget, ScrollOptions } from "./types";

const execFileAsync = promisify(execFile);

export class AgentBrowserAdapter implements BrowserEngineAdapter {
  readonly name = "agent-browser";
  private cdpPort = 28791;
  private binaryPath = "/home/wasuphj/.local/bin/agent-browser";

  async connect(cdpPort: number): Promise<void> {
    this.cdpPort = cdpPort;
    // Verify connection by getting current URL
    try {
      await this.runCli(["get", "url"]);
    } catch (err) {
      throw new Error(`AgentBrowser failed to connect to CDP port ${this.cdpPort}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async runCli(args: string[], signal?: AbortSignal): Promise<string> {
    const fullArgs = ["--cdp", String(this.cdpPort), ...args];
    try {
      const { stdout } = await execFileAsync(this.binaryPath, fullArgs, {
        timeout: 30_000,
        signal,
        env: {
          ...process.env,
          AGENT_BROWSER_HEADED: "false",
        },
      });
      return stdout.trim();
    } catch (err: unknown) {
      if (signal?.aborted) {
        throw new Error("ACTION_ABORTED_USER_CONTROL");
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`[agent-browser error] ${errorMsg}`);
    }
  }

  async navigate(url: string, signal?: AbortSignal): Promise<BrowserState> {
    let target = url;
    if (!/^https?:\/\//i.test(target)) {
      target = `https://${target}`;
    }
    await this.runCli(["open", target], signal);
    // Small settling wait
    await new Promise((r) => setTimeout(r, 800));
    return this.getState(true);
  }

  async click(target: ClickTarget, signal?: AbortSignal): Promise<BrowserState> {
    if (target.ref) {
      const cleanRef = target.ref.startsWith("@") ? target.ref : `@${target.ref}`;
      await this.runCli(["click", cleanRef], signal);
    } else if (target.selector) {
      await this.runCli(["click", target.selector], signal);
    } else if (typeof target.x === "number" && typeof target.y === "number") {
      await this.runCli(["mouse", "click", String(target.x), String(target.y)], signal);
    } else {
      throw new Error("Must provide ref, selector, or (x, y) coordinates for click.");
    }
    await new Promise((r) => setTimeout(r, 600));
    return this.getState(true);
  }

  async typeText(target: TypeTarget, signal?: AbortSignal): Promise<BrowserState> {
    if (target.ref) {
      const cleanRef = target.ref.startsWith("@") ? target.ref : `@${target.ref}`;
      await this.runCli(["fill", cleanRef, target.text], signal);
    } else if (target.selector) {
      await this.runCli(["fill", target.selector, target.text], signal);
    } else {
      await this.runCli(["keyboard", "type", target.text], signal);
    }
    await new Promise((r) => setTimeout(r, 400));
    return this.getState(true);
  }

  async pressKey(key: string, signal?: AbortSignal): Promise<BrowserState> {
    await this.runCli(["press", key], signal);
    await new Promise((r) => setTimeout(r, 400));
    return this.getState(true);
  }

  async scroll(options: ScrollOptions, signal?: AbortSignal): Promise<BrowserState> {
    const dir = options.direction || "down";
    const amount = options.amount ? String(options.amount) : "400";
    await this.runCli(["scroll", dir, amount], signal);
    await new Promise((r) => setTimeout(r, 400));
    return this.getState(true);
  }

  async takeScreenshot(): Promise<string> {
    const tmpPath = join(tmpdir(), `agent-browser-shot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`);
    try {
      await this.runCli(["screenshot", tmpPath]);
      const buf = await fs.readFile(tmpPath);
      return buf.toString("base64");
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }

  async getState(includeScreenshot = false): Promise<BrowserState> {
    let url = "about:blank";
    let title = "";
    let interactiveElements = "";
    let textSnippet = "";

    try {
      url = await this.runCli(["get", "url"]);
    } catch {}

    try {
      title = await this.runCli(["get", "title"]);
    } catch {}

    try {
      // agent-browser snapshot -i provides compact token-efficient accessibility tree with refs
      interactiveElements = await this.runCli(["snapshot", "-i"]);
    } catch {}

    try {
      textSnippet = await this.runCli(["get", "text", "body"]);
      if (textSnippet.length > 1500) {
        textSnippet = textSnippet.slice(0, 1500);
      }
    } catch {
      textSnippet = interactiveElements.slice(0, 1000);
    }

    let screenshotBase64: string | undefined;
    if (includeScreenshot) {
      try {
        screenshotBase64 = await this.takeScreenshot();
      } catch {}
    }

    return {
      url,
      title,
      textSnippet,
      interactiveElements,
      screenshotBase64,
    };
  }

  async disconnect(): Promise<void> {
    // agent-browser CLI handles ephemeral connection per command; no persistent lock to clean up
  }
}
