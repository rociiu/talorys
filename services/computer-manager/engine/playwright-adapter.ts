import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { BrowserEngineAdapter, BrowserState, ClickTarget, TypeTarget, ScrollOptions } from "./types";

export class PlaywrightCdpAdapter implements BrowserEngineAdapter {
  readonly name = "playwright";
  private browserInstance: Browser | null = null;
  private activePage: Page | null = null;
  private cdpPort = 28791;

  async connect(cdpPort: number): Promise<void> {
    this.cdpPort = cdpPort;
    await this.ensurePage();
  }

  private async ensurePage(): Promise<Page> {
    if (this.activePage && !this.activePage.isClosed() && this.browserInstance && this.browserInstance.isConnected()) {
      return this.activePage;
    }

    try {
      if (!this.browserInstance || !this.browserInstance.isConnected()) {
        this.browserInstance = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`);
      }

      const contexts = this.browserInstance.contexts();
      const context: BrowserContext = contexts[0] || (await this.browserInstance.newContext());
      const pages = context.pages();

      if (pages.length > 0 && pages[0]) {
        this.activePage = pages[0];
      } else {
        this.activePage = await context.newPage();
      }

      await this.activePage.setViewportSize({ width: 1280, height: 750 }).catch(() => {});
      return this.activePage;
    } catch (error) {
      this.activePage = null;
      this.browserInstance = null;
      throw new Error(`Playwright CDP connection error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async navigate(url: string): Promise<BrowserState> {
    const page = await this.ensurePage();
    let target = url;
    if (!/^https?:\/\//i.test(target)) {
      target = `https://${target}`;
    }
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await page.waitForTimeout(800);
    return this.getState(true);
  }

  async click(target: ClickTarget): Promise<BrowserState> {
    const page = await this.ensurePage();
    if (target.selector) {
      await page.click(target.selector, { timeout: 10_000 });
    } else if (typeof target.x === "number" && typeof target.y === "number") {
      await page.mouse.click(target.x, target.y);
    } else {
      throw new Error("Must provide selector or coordinates for Playwright click");
    }
    await page.waitForTimeout(600);
    return this.getState(true);
  }

  async typeText(target: TypeTarget): Promise<BrowserState> {
    const page = await this.ensurePage();
    if (target.selector) {
      await page.fill(target.selector, target.text, { timeout: 10_000 });
    } else {
      await page.keyboard.type(target.text, { delay: 25 });
    }
    await page.waitForTimeout(400);
    return this.getState(true);
  }

  async pressKey(key: string): Promise<BrowserState> {
    const page = await this.ensurePage();
    await page.keyboard.press(key);
    await page.waitForTimeout(400);
    return this.getState(true);
  }

  async scroll(options: ScrollOptions): Promise<BrowserState> {
    const page = await this.ensurePage();
    const amount = options.amount || 400;
    const deltaX = options.direction === "left" ? -amount : options.direction === "right" ? amount : 0;
    const deltaY = options.direction === "up" ? -amount : options.direction === "down" ? amount : 0;
    await page.mouse.wheel(deltaX, deltaY);
    await page.waitForTimeout(400);
    return this.getState(true);
  }

  async takeScreenshot(): Promise<string> {
    const page = await this.ensurePage();
    const buf = await page.screenshot({ type: "jpeg", quality: 80 });
    return buf.toString("base64");
  }

  async getState(includeScreenshot = false): Promise<BrowserState> {
    const page = await this.ensurePage();
    const url = page.url();
    const title = await page.title().catch(() => "");
    let textSnippet = "";
    try {
      textSnippet = await page.evaluate(() => {
        const body = document.body;
        if (!body) return "";
        return body.innerText
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .slice(0, 50)
          .join(" ")
          .slice(0, 1500);
      });
    } catch {}

    let screenshotBase64: string | undefined;
    if (includeScreenshot) {
      screenshotBase64 = await this.takeScreenshot().catch(() => undefined);
    }

    return {
      url,
      title,
      textSnippet,
      screenshotBase64,
    };
  }

  async disconnect(): Promise<void> {
    if (this.browserInstance) {
      try {
        await this.browserInstance.close();
      } catch {}
      this.browserInstance = null;
      this.activePage = null;
    }
  }
}
