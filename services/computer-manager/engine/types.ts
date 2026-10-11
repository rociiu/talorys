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
  navigate(url: string): Promise<BrowserState>;
  click(target: ClickTarget): Promise<BrowserState>;
  typeText(target: TypeTarget): Promise<BrowserState>;
  pressKey(key: string): Promise<BrowserState>;
  scroll(options: ScrollOptions): Promise<BrowserState>;
  getState(includeScreenshot?: boolean): Promise<BrowserState>;
  takeScreenshot(): Promise<string>;
  disconnect(): Promise<void>;
}
