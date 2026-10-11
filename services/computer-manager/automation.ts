import { createBrowserEngine } from "./engine/factory";
import type { BrowserEngineAdapter, BrowserState, ClickTarget, TypeTarget, ScrollOptions } from "./engine/types";
import { CDP_PORT, execInContainer } from "./container";

export type { BrowserState, ClickTarget, TypeTarget, ScrollOptions } from "./engine/types";
export type ComputerState = import("./engine/types").BrowserState;

let currentEngine: BrowserEngineAdapter | null = null;

export async function getBrowserEngine(): Promise<BrowserEngineAdapter> {
  if (currentEngine) {
    return currentEngine;
  }

  currentEngine = createBrowserEngine();
  try {
    await currentEngine.connect(CDP_PORT);
    return currentEngine;
  } catch (error) {
    currentEngine = null;
    throw error;
  }
}

export async function disconnectAutomation(): Promise<void> {
  if (currentEngine) {
    try {
      await currentEngine.disconnect();
    } catch {}
    currentEngine = null;
  }
}

/** Navigate active page to URL */
export async function navigate(url: string, signal?: AbortSignal): Promise<BrowserState> {
  const engine = await getBrowserEngine();
  return engine.navigate(url, signal);
}

/** Click an element or specific coordinates or ref */
export async function click(target: ClickTarget, signal?: AbortSignal): Promise<BrowserState> {
  const engine = await getBrowserEngine();
  return engine.click(target, signal);
}

/** Type text into an active element or selector or ref */
export async function typeText(text: string, selectorOrRef?: string, signal?: AbortSignal): Promise<BrowserState> {
  const engine = await getBrowserEngine();
  const isRef = selectorOrRef?.startsWith("@");
  return engine.typeText({
    text,
    ref: isRef ? selectorOrRef : undefined,
    selector: !isRef ? selectorOrRef : undefined,
  }, signal);
}

/** Press a keyboard key (Enter, Escape, Tab, Backspace, etc.) */
export async function pressKey(key: string, signal?: AbortSignal): Promise<BrowserState> {
  const engine = await getBrowserEngine();
  return engine.pressKey(key, signal);
}

/** Scroll page vertically or horizontally */
export async function scroll(direction: "up" | "down" | "left" | "right", amount = 400, signal?: AbortSignal): Promise<BrowserState> {
  const engine = await getBrowserEngine();
  return engine.scroll({ direction, amount }, signal);
}

/** Take screenshot as Base64 string */
export async function takeScreenshot(): Promise<string> {
  const engine = await getBrowserEngine();
  return engine.takeScreenshot();
}

/** Get current state (URL, Title, readable text summary, and optional screenshot) */
export async function getComputerState(includeScreenshot = false): Promise<BrowserState> {
  const engine = await getBrowserEngine();
  return engine.getState(includeScreenshot);
}

/** Execute low-level OS GUI command via xdotool if needed */
export async function xdotool(args: string[]): Promise<string> {
  const { stdout } = await execInContainer(["xdotool", ...args]);
  return stdout;
}
