import { startContainer, stopContainer, isContainerRunning } from "./container";
import { getComputerState, disconnectAutomation, type ComputerState } from "./automation";

export type ControlMode = "ai_running" | "user_controlling";
export type SessionStatus = "idle" | "running" | "paused" | "completed" | "stopped";

export interface ActionLogEntry {
  timestamp: string;
  action: string;
  input?: unknown;
  result?: string;
  screenshot?: string;
}

export interface StateTransitionEntry {
  from: SessionStatus;
  to: SessionStatus;
  timestamp: string;
  reason?: string;
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

export class ComputerStateManager {
  private sessionId: string | null = null;
  private status: SessionStatus = "idle";
  private controlMode: ControlMode = "ai_running";
  private createdAt: string | null = null;
  private lastActivityAt: string | null = null;
  private currentUrl = "about:blank";
  private currentTitle = "";
  private history: ActionLogEntry[] = [];
  private transitionHistory: StateTransitionEntry[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private activeActionController: AbortController | null = null;
  private listeners = new Set<(info: SessionInfo) => void>();

  private startingPromise: Promise<SessionInfo> | null = null;
  private stoppingPromise: Promise<void> | null = null;

  private readonly IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

  constructor() {
    this.resetTimer();
  }

  reset() {
    this.status = "idle";
    this.sessionId = null;
    this.controlMode = "ai_running";
    this.createdAt = null;
    this.lastActivityAt = null;
    this.currentUrl = "about:blank";
    this.currentTitle = "";
    this.history = [];
    this.transitionHistory = [];
    this.activeActionController = null;
    this.notifyListeners();
  }

  canTransitionTo(target: SessionStatus): boolean {
    switch (this.status) {
      case "idle":
        return target === "running";
      case "running":
        return target === "paused" || target === "completed" || target === "stopped" || target === "running";
      case "paused":
        return target === "running" || target === "completed" || target === "stopped" || target === "paused";
      case "completed":
        return target === "running" || target === "completed";
      case "stopped":
        return target === "running" || target === "stopped";
      default:
        return false;
    }
  }

  private notifyListeners() {
    const info = this.getInfo();
    for (const listener of this.listeners) {
      try {
        listener(info);
      } catch {}
    }
  }

  private setStatus(newStatus: SessionStatus, reason?: string) {
    const from = this.status;
    this.status = newStatus;
    this.transitionHistory.push({
      from,
      to: newStatus,
      timestamp: new Date().toISOString(),
      reason,
    });
    this.notifyListeners();
  }

  onStateChange(listener: (info: SessionInfo) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getTransitionHistory(): StateTransitionEntry[] {
    return [...this.transitionHistory];
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  beginAction(): AbortSignal {
    if (this.status !== "running") {
      throw new Error("Computer session is not running.");
    }
    if (this.controlMode === "user_controlling" || this.status === "paused") {
      throw new Error("COMPUTER_LOCKED_USER_CONTROLLING");
    }
    if (this.activeActionController !== null) {
      throw new Error("ACTION_IN_PROGRESS_LOCKED");
    }
    this.activeActionController = new AbortController();
    return this.activeActionController.signal;
  }

  endAction() {
    this.activeActionController = null;
  }

  forceUnlock() {
    if (this.activeActionController) {
      this.activeActionController.abort("force_unlock");
      this.activeActionController = null;
    }
  }

  destroy() {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.forceUnlock();
    this.listeners.clear();
  }

  private resetTimer() {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      void this.checkIdle();
    }, 60_000);
  }

  async checkIdle() {
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

    if (this.startingPromise) {
      return this.startingPromise;
    }

    this.startingPromise = (async () => {
      try {
        await startContainer();
        this.sessionId = `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        this.setStatus("running", "session_start");
        this.controlMode = "ai_running";
        this.createdAt = new Date().toISOString();
        this.lastActivityAt = this.createdAt;
        this.history = [];
        this.currentUrl = "https://www.google.co.kr";
        this.currentTitle = "Google";

        this.logAction("session.start", undefined, "Sandbox computer session initialized");
        return this.getInfo();
      } finally {
        this.startingPromise = null;
      }
    })();

    return this.startingPromise;
  }

  async stop(): Promise<void> {
    if (this.stoppingPromise) {
      return this.stoppingPromise;
    }

    this.stoppingPromise = (async () => {
      try {
        if (this.activeActionController) {
          this.activeActionController.abort("session_stop");
          this.activeActionController = null;
        }
        await disconnectAutomation();
        await stopContainer();
        this.setStatus("stopped", "session_stop");
        this.sessionId = null;
        this.touch();
      } finally {
        this.stoppingPromise = null;
      }
    })();

    return this.stoppingPromise;
  }

  async pause(): Promise<SessionInfo> {
    if (this.status === "paused") {
      return this.getInfo();
    }
    if (this.status !== "running") {
      throw new Error("Computer session is not running.");
    }
    this.controlMode = "user_controlling";
    this.setStatus("paused", "user_paused");
    if (this.activeActionController) {
      this.activeActionController.abort("user_paused");
      this.activeActionController = null;
    }
    this.touch();
    this.logAction("session.pause", undefined, "Session paused by user or policy.");
    return this.getInfo();
  }

  async resume(): Promise<{ info: SessionInfo; state: ComputerState }> {
    if (this.status !== "paused") {
      throw new Error("Computer session is not paused.");
    }
    this.controlMode = "ai_running";
    this.setStatus("running", "session_resumed");
    this.touch();

    let state: ComputerState;
    try {
      state = await getComputerState(true);
      this.currentUrl = state.url;
      this.currentTitle = state.title;
    } catch {
      state = { url: this.currentUrl, title: this.currentTitle, textSnippet: "" };
    }

    this.logAction("session.resume", undefined, "Session resumed.", state.screenshotBase64);
    return { info: this.getInfo(), state };
  }

  async complete(): Promise<SessionInfo> {
    if (this.status !== "running" && this.status !== "paused") {
      throw new Error("Computer session is not active.");
    }
    if (this.activeActionController) {
      this.activeActionController.abort("session_completed");
      this.activeActionController = null;
    }
    await disconnectAutomation();
    await stopContainer();
    this.setStatus("completed", "session_completed");
    this.sessionId = null;
    this.touch();
    this.logAction("session.complete", undefined, "Session completed successfully.");
    return this.getInfo();
  }

  async takeControl(): Promise<SessionInfo> {
    if (this.status !== "running" && this.status !== "paused") {
      throw new Error("Computer session is not running.");
    }
    this.controlMode = "user_controlling";
    // Safely abort any in-flight AI command immediately to eliminate race conditions
    if (this.activeActionController) {
      console.log("[ComputerManager] Aborting in-flight AI action due to manual takeover.");
      this.activeActionController.abort("user_took_control");
      this.activeActionController = null;
    }
    this.touch();
    this.logAction("control.take", undefined, "User took manual interactive control. Any in-flight AI action aborted.");
    this.notifyListeners();
    return this.getInfo();
  }

  async returnControl(): Promise<{ info: SessionInfo; state: ComputerState }> {
    if (this.status !== "running" && this.status !== "paused") {
      throw new Error("Computer session is not running.");
    }
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
    this.notifyListeners();
    return { info: this.getInfo(), state };
  }

  async enterSafeState(reason: string): Promise<void> {
    if (this.activeActionController) {
      this.activeActionController.abort(`safe_state:${reason}`);
      this.activeActionController = null;
    }
    try {
      await disconnectAutomation();
      await stopContainer();
    } catch {}
    this.setStatus("stopped", `safe_state:${reason}`);
    this.sessionId = null;
    this.touch();
    this.logAction("safe_state.enter", undefined, `Entered safe state due to: ${reason}`);
  }

  async reapZombies(): Promise<number> {
    let reaped = 0;
    if (this.status === "stopped" || this.status === "idle") {
      try {
        const running = await isContainerRunning();
        if (running) {
          await stopContainer();
          reaped++;
        }
      } catch {}
    }
    return reaped;
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
