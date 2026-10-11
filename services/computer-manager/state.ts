import { startContainer, stopContainer, isContainerRunning } from "./container";
import { getComputerState, disconnectAutomation, type ComputerState } from "./automation";

export type ControlMode = "ai_running" | "user_controlling";
export type SessionStatus = "idle" | "running" | "stopped";

export interface ActionLogEntry {
  timestamp: string;
  action: string;
  input?: unknown;
  result?: string;
  screenshot?: string;
}

export interface SessionInfo {
  sessionId: string | null;
  status: SessionStatus;
  controlMode: ControlMode;
  createdAt: string | null;
  lastActivityAt: string | null;
  currentUrl?: string;
  currentTitle?: string;
  history: ActionLogEntry[];
}

class ComputerStateManager {
  private sessionId: string | null = null;
  private status: SessionStatus = "idle";
  private controlMode: ControlMode = "ai_running";
  private createdAt: string | null = null;
  private lastActivityAt: string | null = null;
  private currentUrl = "about:blank";
  private currentTitle = "";
  private history: ActionLogEntry[] = [];
  private idleTimer: NodeJS.Timeout | null = null;

  private readonly IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

  constructor() {
    this.resetTimer();
  }

  private resetTimer() {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      void this.checkIdle();
    }, 60_000);
  }

  private async checkIdle() {
    if (this.status !== "running" || !this.lastActivityAt) return;
    const idleTime = Date.now() - new Date(this.lastActivityAt).getTime();
    if (idleTime > this.IDLE_TIMEOUT_MS) {
      console.log(`[ComputerManager] Session ${this.sessionId} idle for ${Math.round(idleTime / 1000)}s. Auto-stopping.`);
      await this.stop();
    }
  }

  touch() {
    this.lastActivityAt = new Date().toISOString();
  }

  async start(): Promise<SessionInfo> {
    if (this.status === "running" && (await isContainerRunning())) {
      this.touch();
      return this.getInfo();
    }

    await startContainer();
    this.sessionId = `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.status = "running";
    this.controlMode = "ai_running";
    this.createdAt = new Date().toISOString();
    this.lastActivityAt = this.createdAt;
    this.history = [];
    this.currentUrl = "https://www.google.co.kr";
    this.currentTitle = "Google";

    this.logAction("session.start", undefined, "Sandbox computer session initialized");
    return this.getInfo();
  }

  async stop(): Promise<void> {
    await disconnectAutomation();
    await stopContainer();
    this.status = "stopped";
    this.sessionId = null;
    this.touch();
  }

  async takeControl(): Promise<SessionInfo> {
    if (this.status !== "running") throw new Error("Computer session is not running.");
    this.controlMode = "user_controlling";
    this.touch();
    this.logAction("control.take", undefined, "User took manual interactive control.");
    return this.getInfo();
  }

  async returnControl(): Promise<{ info: SessionInfo; state: ComputerState }> {
    if (this.status !== "running") throw new Error("Computer session is not running.");
    this.controlMode = "ai_running";
    this.touch();

    // AI resumes: capture current screen & DOM state
    let state: ComputerState;
    try {
      state = await getComputerState(true);
      this.currentUrl = state.url;
      this.currentTitle = state.title;
    } catch {
      state = { url: this.currentUrl, title: this.currentTitle, textSnippet: "" };
    }

    this.logAction("control.return", undefined, "User returned control to AI.", state.screenshotBase64);
    return { info: this.getInfo(), state };
  }

  logAction(action: string, input?: unknown, result?: string, screenshot?: string) {
    const entry: ActionLogEntry = {
      timestamp: new Date().toISOString(),
      action,
      input,
      result,
      screenshot,
    };
    this.history.push(entry);
    if (this.history.length > 50) this.history.shift();
  }

  updatePageInfo(url: string, title: string) {
    this.currentUrl = url;
    this.currentTitle = title;
    this.touch();
  }

  getInfo(): SessionInfo {
    return {
      sessionId: this.sessionId,
      status: this.status,
      controlMode: this.controlMode,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      currentUrl: this.currentUrl,
      currentTitle: this.currentTitle,
      history: [...this.history],
    };
  }

  getMode(): ControlMode {
    return this.controlMode;
  }

  isRunning(): boolean {
    return this.status === "running";
  }
}

export const computerState = new ComputerStateManager();
