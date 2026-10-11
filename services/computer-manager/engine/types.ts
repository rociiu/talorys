export interface BrowserState {
  url: string;
  title: string;
  textSnippet: string;
  interactiveElements?: string;
  screenshotBase64?: string;
}

export interface ClickTarget {
  selector?: string;
  ref?: string; // e.g., "@e1" from agent-browser
  x?: number;
  y?: number;
}

export interface TypeTarget {
  text: string;
  selector?: string;
  ref?: string;
}

export interface ScrollOptions {
  direction: "up" | "down" | "left" | "right";
  amount?: number;
}

export interface BrowserEngineAdapter {
  readonly name: string;
  connect(cdpPort: number): Promise<void>;
  navigate(url: string, signal?: AbortSignal): Promise<BrowserState>;
  click(target: ClickTarget, signal?: AbortSignal): Promise<BrowserState>;
  typeText(target: TypeTarget, signal?: AbortSignal): Promise<BrowserState>;
  pressKey(key: string, signal?: AbortSignal): Promise<BrowserState>;
  scroll(options: ScrollOptions, signal?: AbortSignal): Promise<BrowserState>;
  getState(includeScreenshot?: boolean): Promise<BrowserState>;
  takeScreenshot(): Promise<string>;
  disconnect(): Promise<void>;
}
