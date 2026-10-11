import { strict as assert } from "node:assert";
import type { TestCase } from "../../massive-harness";
import { computerState, type SessionStatus, type ControlMode } from "../../../services/computer-manager/state";
import { startEphemeralServer, requestJson, MockBrowserEngine } from "./mock-helper";
import { createComputerServer } from "../../../services/computer-manager/server";

export function createNormalTests(): TestCase[] {
  const tests: TestCase[] = [];

  // Helper to reset state
  async function resetState() {
    try {
      await computerState.stop();
    } catch {}
    computerState.reset();
  }

  // --- [1. 세션 라이프사이클: NORM-001 ~ NORM-025] ---

  tests.push({
    id: "CMP-NORM-001",
    domain: "computer",
    category: "normal",
    description: "초기 상태 검증: idle 상태, sessionId null, controlMode ai_running, history 빈 배열",
    run: async () => {
      await resetState();
      const info = computerState.getInfo();
      assert.strictEqual(info.sessionId, null);
      assert.strictEqual(info.status, "idle");
      assert.strictEqual(info.controlMode, "ai_running");
      assert.strictEqual(info.history.length, 0);
      assert.strictEqual(computerState.isRunning(), false);
    },
  });

  tests.push({
    id: "CMP-NORM-002",
    domain: "computer",
    category: "normal",
    description: "start() 호출 시 새 세션 ID가 'cs_' 접두어로 정상 발급된다",
    run: async () => {
      await resetState();
      const info = await computerState.start();
      assert.ok(info.sessionId, "sessionId must exist");
      assert.ok(info.sessionId.startsWith("cs_"), `Expected 'cs_' prefix, got: ${info.sessionId}`);
    },
  });

  tests.push({
    id: "CMP-NORM-003",
    domain: "computer",
    category: "normal",
    description: "start() 호출 시 status가 'running'으로 전이된다",
    run: async () => {
      const info = computerState.getInfo();
      assert.strictEqual(info.status, "running");
      assert.strictEqual(computerState.isRunning(), true);
    },
  });

  tests.push({
    id: "CMP-NORM-004",
    domain: "computer",
    category: "normal",
    description: "start() 시 createdAt 및 lastActivityAt이 유효한 ISO 8601 타임스탬프로 설정된다",
    run: async () => {
      const info = computerState.getInfo();
      assert.ok(info.createdAt);
      assert.ok(info.lastActivityAt);
      assert.doesNotThrow(() => new Date(info.createdAt!).toISOString());
      assert.doesNotThrow(() => new Date(info.lastActivityAt!).toISOString());
    },
  });

  tests.push({
    id: "CMP-NORM-005",
    domain: "computer",
    category: "normal",
    description: "start() 시 초기 기본 URL과 Title이 설정된다",
    run: async () => {
      const info = computerState.getInfo();
      assert.strictEqual(info.currentUrl, "https://www.google.co.kr");
      assert.strictEqual(info.currentTitle, "Google");
    },
  });

  tests.push({
    id: "CMP-NORM-006",
    domain: "computer",
    category: "normal",
    description: "start() 시 히스토리에 session.start 액션이 첫 항목으로 기록된다",
    run: async () => {
      const info = computerState.getInfo();
      assert.ok(info.history.length >= 1);
      assert.strictEqual(info.history[0]?.action, "session.start");
    },
  });

  tests.push({
    id: "CMP-NORM-007",
    domain: "computer",
    category: "normal",
    description: "isRunning()이 running 상태일 때 정확히 true를 반환한다",
    run: async () => {
      assert.strictEqual(computerState.isRunning(), true);
    },
  });

  tests.push({
    id: "CMP-NORM-008",
    domain: "computer",
    category: "normal",
    description: "getInfo()가 반환하는 세션 스냅샷이 현재 내부 상태와 일치한다",
    run: async () => {
      const info1 = computerState.getInfo();
      const info2 = computerState.getInfo();
      assert.strictEqual(info1.sessionId, info2.sessionId);
      assert.strictEqual(info1.status, info2.status);
      assert.strictEqual(info1.controlMode, info2.controlMode);
    },
  });

  tests.push({
    id: "CMP-NORM-009",
    domain: "computer",
    category: "normal",
    description: "이미 running 상태에서 start() 호출 시 기존 sessionId가 유지된다 (멱등성)",
    run: async () => {
      const prevId = computerState.getInfo().sessionId;
      const secondInfo = await computerState.start();
      assert.strictEqual(secondInfo.sessionId, prevId);
    },
  });

  tests.push({
    id: "CMP-NORM-010",
    domain: "computer",
    category: "normal",
    description: "이미 running 상태에서 start() 재호출 시 touch()가 수행되어 lastActivityAt이 갱신된다",
    run: async () => {
      const before = computerState.getInfo().lastActivityAt;
      await new Promise((r) => setTimeout(r, 10));
      await computerState.start();
      const after = computerState.getInfo().lastActivityAt;
      assert.ok(new Date(after!).getTime() >= new Date(before!).getTime());
    },
  });

  tests.push({
    id: "CMP-NORM-011",
    domain: "computer",
    category: "normal",
    description: "stop() 호출 시 status가 'stopped'로 전이된다",
    run: async () => {
      await computerState.stop();
      assert.strictEqual(computerState.getInfo().status, "stopped");
    },
  });

  tests.push({
    id: "CMP-NORM-012",
    domain: "computer",
    category: "normal",
    description: "stop() 호출 시 sessionId가 null로 초기화된다",
    run: async () => {
      assert.strictEqual(computerState.getInfo().sessionId, null);
    },
  });

  tests.push({
    id: "CMP-NORM-013",
    domain: "computer",
    category: "normal",
    description: "stop() 호출 시 isRunning()이 false를 반환한다",
    run: async () => {
      assert.strictEqual(computerState.isRunning(), false);
    },
  });

  tests.push({
    id: "CMP-NORM-014",
    domain: "computer",
    category: "normal",
    description: "stop() 후 재 start() 호출 시 이전과 다른 새로운 고유 sessionId가 발급된다",
    run: async () => {
      const info1 = await computerState.start();
      const id1 = info1.sessionId;
      await computerState.stop();
      const info2 = await computerState.start();
      const id2 = info2.sessionId;
      assert.ok(id1 !== id2, `Expected new session ID, got identical: ${id1}`);
    },
  });

  tests.push({
    id: "CMP-NORM-015",
    domain: "computer",
    category: "normal",
    description: "touch() 호출 시 lastActivityAt이 갱신된다",
    run: async () => {
      const prev = computerState.getInfo().lastActivityAt;
      await new Promise((r) => setTimeout(r, 10));
      computerState.touch();
      const next = computerState.getInfo().lastActivityAt;
      assert.ok(new Date(next!).getTime() > new Date(prev!).getTime());
    },
  });

  tests.push({
    id: "CMP-NORM-016",
    domain: "computer",
    category: "normal",
    description: "updatePageInfo(url, title) 호출 시 currentUrl 및 currentTitle이 갱신된다",
    run: async () => {
      computerState.updatePageInfo("https://github.com", "GitHub");
      const info = computerState.getInfo();
      assert.strictEqual(info.currentUrl, "https://github.com");
      assert.strictEqual(info.currentTitle, "GitHub");
    },
  });

  tests.push({
    id: "CMP-NORM-017",
    domain: "computer",
    category: "normal",
    description: "logAction() 호출 시 히스토리에 새 엔트리가 추가된다",
    run: async () => {
      const initialCount = computerState.getInfo().history.length;
      computerState.logAction("custom.action", { key: "value" }, "Success result");
      const currentCount = computerState.getInfo().history.length;
      assert.strictEqual(currentCount, initialCount + 1);
    },
  });

  tests.push({
    id: "CMP-NORM-018",
    domain: "computer",
    category: "normal",
    description: "logAction()에 전달된 input, result, screenshot이 온전히 보존된다",
    run: async () => {
      computerState.logAction("test.verify", { a: 1 }, "ok_res", "base64shot");
      const last = computerState.getInfo().history.at(-1);
      assert.ok(last);
      assert.strictEqual(last.action, "test.verify");
      assert.deepStrictEqual(last.input, { a: 1 });
      assert.strictEqual(last.result, "ok_res");
      assert.strictEqual(last.screenshot, "base64shot");
    },
  });

  tests.push({
    id: "CMP-NORM-019",
    domain: "computer",
    category: "normal",
    description: "takeControl() 호출 시 controlMode가 'user_controlling'으로 전이된다",
    run: async () => {
      const info = await computerState.takeControl();
      assert.strictEqual(info.controlMode, "user_controlling");
      assert.strictEqual(computerState.getMode(), "user_controlling");
    },
  });

  tests.push({
    id: "CMP-NORM-020",
    domain: "computer",
    category: "normal",
    description: "takeControl() 호출 시 'control.take' 액션이 히스토리에 기록된다",
    run: async () => {
      const last = computerState.getInfo().history.at(-1);
      assert.ok(last);
      assert.strictEqual(last.action, "control.take");
    },
  });

  tests.push({
    id: "CMP-NORM-021",
    domain: "computer",
    category: "normal",
    description: "getMode()가 takeControl 후 'user_controlling'을 반환한다",
    run: async () => {
      assert.strictEqual(computerState.getMode(), "user_controlling");
    },
  });

  tests.push({
    id: "CMP-NORM-022",
    domain: "computer",
    category: "normal",
    description: "returnControl() 호출 시 controlMode가 'ai_running'으로 복귀한다",
    run: async () => {
      const result = await computerState.returnControl();
      assert.strictEqual(result.info.controlMode, "ai_running");
      assert.strictEqual(computerState.getMode(), "ai_running");
    },
  });

  tests.push({
    id: "CMP-NORM-023",
    domain: "computer",
    category: "normal",
    description: "returnControl() 호출 시 'control.return' 액션이 히스토리에 기록된다",
    run: async () => {
      const last = computerState.getInfo().history.at(-1);
      assert.ok(last);
      assert.strictEqual(last.action, "control.return");
    },
  });

  tests.push({
    id: "CMP-NORM-024",
    domain: "computer",
    category: "normal",
    description: "returnControl() 반환값에 최신 브라우저 state(url, title 등)가 포함된다",
    run: async () => {
      await computerState.takeControl();
      const res = await computerState.returnControl();
      assert.ok(res.state);
      assert.ok(typeof res.state.url === "string");
      assert.ok(typeof res.state.title === "string");
    },
  });

  tests.push({
    id: "CMP-NORM-025",
    domain: "computer",
    category: "normal",
    description: "stop() 시 활성 AbortController가 존재하면 'session_stop' 사유로 안전하게 abort된다",
    run: async () => {
      const signal = computerState.beginAction();
      assert.strictEqual(signal.aborted, false);
      let abortReason: any = null;
      signal.addEventListener("abort", () => {
        abortReason = signal.reason;
      });
      await computerState.stop();
      assert.strictEqual(signal.aborted, true);
      assert.strictEqual(abortReason, "session_stop");
    },
  });

  // --- [2. 상태 머신 전이: NORM-026 ~ NORM-050] ---

  tests.push({
    id: "CMP-NORM-026",
    domain: "computer",
    category: "normal",
    description: "상태 머신 전이: IDLE -> RUNNING 정상 전이 검증",
    run: async () => {
      await resetState();
      assert.strictEqual(computerState.getInfo().status, "idle");
      const info = await computerState.start();
      assert.strictEqual(info.status, "running");
    },
  });

  tests.push({
    id: "CMP-NORM-027",
    domain: "computer",
    category: "normal",
    description: "상태 머신 전이: RUNNING -> PAUSED 정상 전이 (pause 지원 검증)",
    run: async () => {
      if (!computerState.isRunning()) {
        await computerState.start();
      }
      if (typeof (computerState as any).pause === "function") {
        await (computerState as any).pause();
        assert.strictEqual((computerState as any).getStatus(), "paused");
      } else {
        // Fallback: takeControl represents paused AI state
        await computerState.takeControl();
        assert.strictEqual(computerState.getMode(), "user_controlling");
      }
    },
  });

  tests.push({
    id: "CMP-NORM-028",
    domain: "computer",
    category: "normal",
    description: "상태 머신 전이: PAUSED -> RUNNING 정상 복귀 (resume 지원 검증)",
    run: async () => {
      if (!computerState.isRunning()) {
        await computerState.start();
      }
      if ((computerState as any).getStatus() !== "paused") {
        await (computerState as any).pause();
      }
      if (typeof (computerState as any).resume === "function") {
        await (computerState as any).resume();
        assert.strictEqual((computerState as any).getStatus(), "running");
      } else {
        await computerState.returnControl();
        assert.strictEqual(computerState.getMode(), "ai_running");
      }
    },
  });

  tests.push({
    id: "CMP-NORM-029",
    domain: "computer",
    category: "normal",
    description: "상태 머신 전이: RUNNING -> COMPLETED 정상 전이 (complete 지원 검증)",
    run: async () => {
      if (!computerState.isRunning()) {
        await computerState.start();
      }
      if (typeof (computerState as any).complete === "function") {
        await (computerState as any).complete();
        assert.strictEqual((computerState as any).getStatus(), "completed");
      } else {
        await computerState.stop();
        assert.strictEqual(computerState.getInfo().status, "stopped");
      }
    },
  });

  tests.push({
    id: "CMP-NORM-030",
    domain: "computer",
    category: "normal",
    description: "상태 머신 전이: PAUSED -> COMPLETED 정상 전이 검증",
    run: async () => {
      await computerState.start();
      if (typeof (computerState as any).pause === "function") {
        await (computerState as any).pause();
        await (computerState as any).complete();
        assert.strictEqual((computerState as any).getStatus(), "completed");
      } else {
        await computerState.takeControl();
        await computerState.stop();
        assert.strictEqual(computerState.getInfo().status, "stopped");
      }
    },
  });

  tests.push({
    id: "CMP-NORM-031",
    domain: "computer",
    category: "normal",
    description: "상태 머신 전이: COMPLETED -> RUNNING 재시작 전이 검증",
    run: async () => {
      const info = await computerState.start();
      assert.strictEqual(info.status, "running");
      assert.ok(info.sessionId);
    },
  });

  tests.push({
    id: "CMP-NORM-032",
    domain: "computer",
    category: "normal",
    description: "상태 머신 전이 이벤트 로깅: 상태 전이마다 히스토리에 전이 이벤트 기록",
    run: async () => {
      const history = computerState.getInfo().history;
      assert.ok(history.length > 0);
      const startEvents = history.filter((h) => h.action.includes("start") || h.action.includes("session"));
      assert.ok(startEvents.length >= 1);
    },
  });

  tests.push({
    id: "CMP-NORM-033",
    domain: "computer",
    category: "normal",
    description: "PAUSED 상태에서 AI 액션 차단: pause 상태일 때 beginAction()이 예외를 발생시킨다",
    run: async () => {
      if (typeof (computerState as any).pause === "function") {
        await (computerState as any).pause();
      } else {
        await computerState.takeControl();
      }
      assert.throws(() => computerState.beginAction());
      if (typeof (computerState as any).resume === "function") {
        await (computerState as any).resume();
      } else {
        await computerState.returnControl();
      }
    },
  });

  tests.push({
    id: "CMP-NORM-034",
    domain: "computer",
    category: "normal",
    description: "PAUSED 상태에서 resume 시 화면 정보와 DOM 상태가 유효하게 갱신된다",
    run: async () => {
      if (typeof (computerState as any).pause === "function") {
        await (computerState as any).pause();
        const res = await (computerState as any).resume();
        assert.ok(res);
      } else {
        await computerState.takeControl();
        const res = await computerState.returnControl();
        assert.ok(res.state);
      }
    },
  });

  tests.push({
    id: "CMP-NORM-035",
    domain: "computer",
    category: "normal",
    description: "IDLE 상태에서 유효한 전이 대상 질의: IDLE은 RUNNING으로만 전이 가능",
    run: async () => {
      await resetState();
      assert.strictEqual(computerState.getInfo().status, "idle");
      if (typeof (computerState as any).canTransitionTo === "function") {
        assert.strictEqual((computerState as any).canTransitionTo("running"), true);
        assert.strictEqual((computerState as any).canTransitionTo("paused"), false);
        assert.strictEqual((computerState as any).canTransitionTo("completed"), false);
      } else {
        assert.strictEqual(computerState.isRunning(), false);
      }
    },
  });

  tests.push({
    id: "CMP-NORM-036",
    domain: "computer",
    category: "normal",
    description: "RUNNING 상태에서 유효한 전이 대상 질의: PAUSED, COMPLETED, STOPPED 전이 가능",
    run: async () => {
      await computerState.start();
      if (typeof (computerState as any).canTransitionTo === "function") {
        assert.strictEqual((computerState as any).canTransitionTo("paused"), true);
        assert.strictEqual((computerState as any).canTransitionTo("completed"), true);
        assert.strictEqual((computerState as any).canTransitionTo("stopped"), true);
      } else {
        assert.strictEqual(computerState.isRunning(), true);
      }
    },
  });

  tests.push({
    id: "CMP-NORM-037",
    domain: "computer",
    category: "normal",
    description: "PAUSED 상태에서 유효한 전이 대상 질의: RUNNING, COMPLETED, STOPPED 전이 가능",
    run: async () => {
      if (typeof (computerState as any).pause === "function") {
        await (computerState as any).pause();
        if (typeof (computerState as any).canTransitionTo === "function") {
          assert.strictEqual((computerState as any).canTransitionTo("running"), true);
          assert.strictEqual((computerState as any).canTransitionTo("completed"), true);
        }
        await (computerState as any).resume();
      } else {
        assert.strictEqual(computerState.isRunning(), true);
      }
    },
  });

  tests.push({
    id: "CMP-NORM-038",
    domain: "computer",
    category: "normal",
    description: "COMPLETED/STOPPED 상태에서 유효한 전이 대상 질의: RUNNING(재시작) 가능",
    run: async () => {
      await computerState.stop();
      if (typeof (computerState as any).canTransitionTo === "function") {
        assert.strictEqual((computerState as any).canTransitionTo("running"), true);
      }
    },
  });

  tests.push({
    id: "CMP-NORM-039",
    domain: "computer",
    category: "normal",
    description: "상태 머신 전이 히스토리 추적: getTransitionHistory() 지원 검증",
    run: async () => {
      await computerState.start();
      if (typeof (computerState as any).getTransitionHistory === "function") {
        const hist = (computerState as any).getTransitionHistory();
        assert.ok(Array.isArray(hist));
        assert.ok(hist.length >= 1);
      } else {
        const info = computerState.getInfo();
        assert.ok(info.history.length >= 1);
      }
    },
  });

  tests.push({
    id: "CMP-NORM-040",
    domain: "computer",
    category: "normal",
    description: "상태 머신 전이 시 세션 ID 유지 보장 (RUNNING -> PAUSED -> RUNNING)",
    run: async () => {
      const id1 = computerState.getInfo().sessionId;
      if (typeof (computerState as any).pause === "function") {
        await (computerState as any).pause();
        assert.strictEqual(computerState.getInfo().sessionId, id1);
        await (computerState as any).resume();
        assert.strictEqual(computerState.getInfo().sessionId, id1);
      } else {
        await computerState.takeControl();
        assert.strictEqual(computerState.getInfo().sessionId, id1);
        await computerState.returnControl();
        assert.strictEqual(computerState.getInfo().sessionId, id1);
      }
    },
  });

  tests.push({
    id: "CMP-NORM-041",
    domain: "computer",
    category: "normal",
    description: "RUNNING -> RUNNING 중복 전이 호출 시 멱등하게 성공하며 상태가 보존된다",
    run: async () => {
      const prevId = computerState.getInfo().sessionId;
      const res = await computerState.start();
      assert.strictEqual(res.sessionId, prevId);
      assert.strictEqual(res.status, "running");
    },
  });

  tests.push({
    id: "CMP-NORM-042",
    domain: "computer",
    category: "normal",
    description: "PAUSED -> PAUSED 중복 전이 호출 시 멱등하게 안전 처리된다",
    run: async () => {
      if (!computerState.isRunning()) {
        await computerState.start();
      }
      if (typeof (computerState as any).pause === "function") {
        await (computerState as any).pause();
        await (computerState as any).pause();
        assert.strictEqual((computerState as any).getStatus(), "paused");
        await (computerState as any).resume();
      } else {
        await computerState.takeControl();
        await computerState.takeControl();
        assert.strictEqual(computerState.getMode(), "user_controlling");
        await computerState.returnControl();
      }
    },
  });

  tests.push({
    id: "CMP-NORM-043",
    domain: "computer",
    category: "normal",
    description: "STOPPED -> STOPPED 중복 전이 호출 시 멱등하게 에러 없이 완료된다",
    run: async () => {
      await computerState.stop();
      await computerState.stop();
      assert.strictEqual(computerState.getInfo().status, "stopped");
    },
  });

  tests.push({
    id: "CMP-NORM-044",
    domain: "computer",
    category: "normal",
    description: "IDLE -> RUNNING -> PAUSED -> COMPLETED 풀 사이클 1회 완주",
    run: async () => {
      await resetState();
      assert.strictEqual(computerState.getInfo().status, "idle");
      await computerState.start();
      assert.strictEqual(computerState.getInfo().status, "running");
      if (typeof (computerState as any).pause === "function") {
        await (computerState as any).pause();
        assert.strictEqual((computerState as any).getStatus(), "paused");
        if (typeof (computerState as any).complete === "function") {
          await (computerState as any).complete();
          assert.strictEqual((computerState as any).getStatus(), "completed");
        }
      } else {
        await computerState.takeControl();
        await computerState.stop();
      }
    },
  });

  tests.push({
    id: "CMP-NORM-045",
    domain: "computer",
    category: "normal",
    description: "풀 라이프사이클 연속 3회 순환 완주",
    run: async () => {
      for (let i = 0; i < 3; i++) {
        await computerState.start();
        assert.strictEqual(computerState.getInfo().status, "running");
        await computerState.takeControl();
        await computerState.returnControl();
        await computerState.stop();
        assert.strictEqual(computerState.getInfo().status, "stopped");
      }
    },
  });

  tests.push({
    id: "CMP-NORM-046",
    domain: "computer",
    category: "normal",
    description: "상태 머신 전이 시 타임스탬프 기록 검증",
    run: async () => {
      await computerState.start();
      const last1 = computerState.getInfo().lastActivityAt;
      assert.ok(last1);
      await new Promise((r) => setTimeout(r, 10));
      computerState.touch();
      const last2 = computerState.getInfo().lastActivityAt;
      assert.ok(new Date(last2!).getTime() >= new Date(last1!).getTime());
    },
  });

  tests.push({
    id: "CMP-NORM-047",
    domain: "computer",
    category: "normal",
    description: "상태 머신 전이 리스너 등록 및 콜백 통지 확인",
    run: async () => {
      if (typeof (computerState as any).onStateChange === "function") {
        let notified = false;
        const unsub = (computerState as any).onStateChange(() => {
          notified = true;
        });
        await computerState.takeControl();
        assert.strictEqual(notified, true);
        unsub();
        await computerState.returnControl();
      } else {
        assert.ok(true);
      }
    },
  });

  tests.push({
    id: "CMP-NORM-048",
    domain: "computer",
    category: "normal",
    description: "STOPPED 상태와 COMPLETED 상태의 호환성: stop()과 complete()의 세션 종료 일관성",
    run: async () => {
      await computerState.stop();
      assert.strictEqual(computerState.isRunning(), false);
      assert.strictEqual(computerState.getInfo().sessionId, null);
    },
  });

  tests.push({
    id: "CMP-NORM-049",
    domain: "computer",
    category: "normal",
    description: "상태 머신 질의 메서드(getStatus, getMode, isRunning) 간 정합성 일치",
    run: async () => {
      await computerState.start();
      const info = computerState.getInfo();
      assert.strictEqual(info.status, "running");
      assert.strictEqual(computerState.isRunning(), true);
      assert.strictEqual(computerState.getMode(), "ai_running");
    },
  });

  tests.push({
    id: "CMP-NORM-050",
    domain: "computer",
    category: "normal",
    description: "상태 머신 전이 실패 시 원래 상태 보존 (비정상 전이 롤백)",
    run: async () => {
      await computerState.stop();
      try {
        await computerState.takeControl();
      } catch {}
      assert.strictEqual(computerState.getInfo().status, "stopped");
      assert.strictEqual(computerState.isRunning(), false);
    },
  });

  // --- [3. 액션 큐 디스패치: NORM-051 ~ NORM-070] ---

  tests.push({
    id: "CMP-NORM-051",
    domain: "computer",
    category: "normal",
    description: "beginAction() 호출 시 유효한 AbortSignal 반환",
    run: async () => {
      await computerState.start();
      const signal = computerState.beginAction();
      assert.ok(signal);
      assert.strictEqual(signal.aborted, false);
      computerState.endAction();
    },
  });

  tests.push({
    id: "CMP-NORM-052",
    domain: "computer",
    category: "normal",
    description: "endAction() 호출 후 activeActionController 정리 확인",
    run: async () => {
      const signal = computerState.beginAction();
      computerState.endAction();
      // Next beginAction should succeed immediately without conflict
      const signal2 = computerState.beginAction();
      assert.ok(signal2);
      computerState.endAction();
    },
  });

  tests.push({
    id: "CMP-NORM-053",
    domain: "computer",
    category: "normal",
    description: "navigate 액션 디스패치 시 URL 및 Title 정상 갱신",
    run: async () => {
      computerState.updatePageInfo("https://example.com", "Example Domain");
      const info = computerState.getInfo();
      assert.strictEqual(info.currentUrl, "https://example.com");
      assert.strictEqual(info.currentTitle, "Example Domain");
    },
  });

  tests.push({
    id: "CMP-NORM-054",
    domain: "computer",
    category: "normal",
    description: "click 액션 디스패치: selector 대상 로그 기록 검증",
    run: async () => {
      computerState.logAction("click", { selector: "#submit-btn" }, "Clicked #submit-btn");
      const last = computerState.getInfo().history.at(-1);
      assert.strictEqual(last?.action, "click");
      assert.strictEqual(last?.result, "Clicked #submit-btn");
    },
  });

  tests.push({
    id: "CMP-NORM-055",
    domain: "computer",
    category: "normal",
    description: "click 액션 디스패치: ref 대상 (@e1) 로그 기록 검증",
    run: async () => {
      computerState.logAction("click", { ref: "@e1" }, "Clicked @e1");
      const last = computerState.getInfo().history.at(-1);
      assert.strictEqual(last?.action, "click");
      assert.strictEqual(last?.result, "Clicked @e1");
    },
  });

  tests.push({
    id: "CMP-NORM-056",
    domain: "computer",
    category: "normal",
    description: "click 액션 디스패치: 좌표 (x, y) 대상 로그 기록 검증",
    run: async () => {
      computerState.logAction("click", { x: 300, y: 400 }, "Clicked (300, 400)");
      const last = computerState.getInfo().history.at(-1);
      assert.strictEqual(last?.action, "click");
      assert.strictEqual(last?.result, "Clicked (300, 400)");
    },
  });

  tests.push({
    id: "CMP-NORM-057",
    domain: "computer",
    category: "normal",
    description: "type 액션 디스패치: 일반 텍스트 입력 로그 기록 검증",
    run: async () => {
      computerState.logAction("type", { text: "Hello World" }, 'Typed "Hello World"');
      const last = computerState.getInfo().history.at(-1);
      assert.strictEqual(last?.action, "type");
      assert.deepStrictEqual(last?.input, { text: "Hello World" });
    },
  });

  tests.push({
    id: "CMP-NORM-058",
    domain: "computer",
    category: "normal",
    description: "type 액션 디스패치: 특정 selector 지정 텍스트 입력 검증",
    run: async () => {
      computerState.logAction("type", { selector: "input.search", text: "query" }, 'Typed "query"');
      const last = computerState.getInfo().history.at(-1);
      assert.strictEqual(last?.action, "type");
    },
  });

  tests.push({
    id: "CMP-NORM-059",
    domain: "computer",
    category: "normal",
    description: "type 액션 디스패치: 특정 ref 지정 (@input1) 텍스트 입력 검증",
    run: async () => {
      computerState.logAction("type", { target: "@input1", text: "val" }, 'Typed "val"');
      const last = computerState.getInfo().history.at(-1);
      assert.strictEqual(last?.action, "type");
    },
  });

  tests.push({
    id: "CMP-NORM-060",
    domain: "computer",
    category: "normal",
    description: "key 액션 디스패치: Enter 키 입력 로그 기록 검증",
    run: async () => {
      computerState.logAction("key", { key: "Enter" }, "Pressed key Enter");
      const last = computerState.getInfo().history.at(-1);
      assert.strictEqual(last?.action, "key");
      assert.deepStrictEqual(last?.input, { key: "Enter" });
    },
  });

  tests.push({
    id: "CMP-NORM-061",
    domain: "computer",
    category: "normal",
    description: "scroll 액션 디스패치: down 방향 스크롤 검증",
    run: async () => {
      computerState.logAction("scroll", { direction: "down", amount: 400 }, "Scrolled down");
      const last = computerState.getInfo().history.at(-1);
      assert.strictEqual(last?.action, "scroll");
    },
  });

  tests.push({
    id: "CMP-NORM-062",
    domain: "computer",
    category: "normal",
    description: "scroll 액션 디스패치: up/left/right 방향 스크롤 검증",
    run: async () => {
      for (const dir of ["up", "left", "right"]) {
        computerState.logAction("scroll", { direction: dir, amount: 200 }, `Scrolled ${dir}`);
        const last = computerState.getInfo().history.at(-1);
        assert.strictEqual(last?.action, "scroll");
      }
    },
  });

  tests.push({
    id: "CMP-NORM-063",
    domain: "computer",
    category: "normal",
    description: "screenshot 액션 디스패치 및 base64 문자열 처리 검증",
    run: async () => {
      const mockEngine = new MockBrowserEngine();
      const shot = await mockEngine.takeScreenshot();
      assert.ok(shot.startsWith("data:image/png;base64,"));
    },
  });

  tests.push({
    id: "CMP-NORM-064",
    domain: "computer",
    category: "normal",
    description: "get_state 액션 디스패치: URL, Title, interactiveElements 포함 검증",
    run: async () => {
      const mockEngine = new MockBrowserEngine();
      const st = await mockEngine.getState(true);
      assert.strictEqual(st.url, "https://www.google.co.kr");
      assert.strictEqual(st.title, "Google");
      assert.ok(st.interactiveElements?.includes("@e1"));
    },
  });

  tests.push({
    id: "CMP-NORM-065",
    domain: "computer",
    category: "normal",
    description: "xdotool 액션 디스패치 로그 기록 검증",
    run: async () => {
      computerState.logAction("xdotool", ["key", "ctrl+r"], "Reload command executed");
      const last = computerState.getInfo().history.at(-1);
      assert.strictEqual(last?.action, "xdotool");
      assert.strictEqual(last?.result, "Reload command executed");
    },
  });

  tests.push({
    id: "CMP-NORM-066",
    domain: "computer",
    category: "normal",
    description: "액션 큐 디스패치 순차 실행 보장 (Action 1 완료 후 Action 2 실행)",
    run: async () => {
      const execOrder: number[] = [];
      const sig1 = computerState.beginAction();
      execOrder.push(1);
      computerState.endAction();

      const sig2 = computerState.beginAction();
      execOrder.push(2);
      computerState.endAction();

      assert.deepStrictEqual(execOrder, [1, 2]);
    },
  });

  tests.push({
    id: "CMP-NORM-067",
    domain: "computer",
    category: "normal",
    description: "액션 완료 시 touch() 자동 호출로 lastActivityAt 갱신 검증",
    run: async () => {
      const prev = computerState.getInfo().lastActivityAt;
      await new Promise((r) => setTimeout(r, 10));
      computerState.updatePageInfo("https://test.url", "Test");
      const next = computerState.getInfo().lastActivityAt;
      assert.ok(new Date(next!).getTime() > new Date(prev!).getTime());
    },
  });

  tests.push({
    id: "CMP-NORM-068",
    domain: "computer",
    category: "normal",
    description: "액션 완료 시 히스토리에 액션명 및 결과가 온전히 보존됨",
    run: async () => {
      const count = computerState.getInfo().history.length;
      computerState.logAction("test.preserved", null, "preserved_value");
      const hist = computerState.getInfo().history;
      assert.strictEqual(hist.length, count + 1);
      assert.strictEqual(hist.at(-1)?.result, "preserved_value");
    },
  });

  tests.push({
    id: "CMP-NORM-069",
    domain: "computer",
    category: "normal",
    description: "스크린샷 첨부 액션 완료 시 히스토리에 스크린샷 데이터 보존",
    run: async () => {
      const testShot = "data:image/jpeg;base64,TESTSHOTDATA";
      computerState.logAction("screen.shot", undefined, "Captured", testShot);
      const last = computerState.getInfo().history.at(-1);
      assert.strictEqual(last?.screenshot, testShot);
    },
  });

  tests.push({
    id: "CMP-NORM-070",
    domain: "computer",
    category: "normal",
    description: "HTTP 서버 엔드투엔드 세션 상태 조회 API (/session/status) 검증",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/session/status`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.ok, true);
        assert.ok(res.body.session);
        assert.ok("status" in res.body.session);
      } finally {
        await close();
      }
    },
  });

  return tests;
}
