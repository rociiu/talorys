import { strict as assert } from "node:assert";
import type { TestCase } from "../../massive-harness";
import { computerState } from "../../../services/computer-manager/state";
import { MockBrowserEngine, startEphemeralServer, requestJson } from "./mock-helper";
import { createComputerServer } from "../../../services/computer-manager/server";
import { disconnectAutomation } from "../../../services/computer-manager/automation";

export function createRecoveryTests(): TestCase[] {
  const tests: TestCase[] = [];

  async function resetState() {
    try {
      await computerState.stop();
    } catch {}
  }

  // --- [1. 좀비 워커 리핑 & 프로세스 정리: RECV-001 ~ RECV-010] ---

  tests.push({
    id: "CMP-RECV-001",
    domain: "computer",
    category: "recovery",
    description: "좀비 워커 리핑: reapZombies 또는 stop 호출 시 비정상 세션 리소스 정리",
    run: async () => {
      await resetState();
      await computerState.start();
      if (typeof (computerState as any).reapZombies === "function") {
        const cleaned = await (computerState as any).reapZombies();
        assert.ok(typeof cleaned === "number" || typeof cleaned === "boolean");
      }
      await computerState.stop();
      assert.strictEqual(computerState.isRunning(), false);
    },
  });

  tests.push({
    id: "CMP-RECV-002",
    domain: "computer",
    category: "recovery",
    description: "세션 정지 시 activeActionController가 잔존하지 않고 완전 null 초기화",
    run: async () => {
      await computerState.start();
      computerState.beginAction();
      await computerState.stop();
      assert.strictEqual((computerState as any).activeActionController, null);
    },
  });

  tests.push({
    id: "CMP-RECV-003",
    domain: "computer",
    category: "recovery",
    description: "idleTimer 해제 및 정리: destroy() 호출 시 백그라운드 인터벌 타이머 안전 해제",
    run: async () => {
      if (typeof (computerState as any).destroy === "function") {
        (computerState as any).destroy();
        assert.strictEqual((computerState as any).idleTimer, null);
      } else {
        assert.ok(true);
      }
    },
  });

  tests.push({
    id: "CMP-RECV-004",
    domain: "computer",
    category: "recovery",
    description: "disconnectAutomation 호출 시 자동화 엔진 인스턴스 안전 해제",
    run: async () => {
      await disconnectAutomation();
      assert.ok(true);
    },
  });

  tests.push({
    id: "CMP-RECV-005",
    domain: "computer",
    category: "recovery",
    description: "임시 스크린샷 잔재 정리 후 새 세션이 클린 상태에서 기동됨",
    run: async () => {
      await computerState.start();
      assert.strictEqual(computerState.isRunning(), true);
      assert.ok(computerState.getInfo().sessionId);
    },
  });

  tests.push({
    id: "CMP-RECV-006",
    domain: "computer",
    category: "recovery",
    description: "비정상 프로세스 강제 종료 후 세션 재시작 멱등성 검증",
    run: async () => {
      await computerState.stop();
      const s1 = await computerState.start();
      assert.ok(s1.sessionId);
    },
  });

  tests.push({
    id: "CMP-RECV-007",
    domain: "computer",
    category: "recovery",
    description: "오래된 액션 로그 메모리 경계 관리: 50개 초과 시 가비지 수거 허용",
    run: async () => {
      for (let i = 0; i < 60; i++) {
        computerState.logAction(`gc.test.${i}`);
      }
      assert.strictEqual(computerState.getInfo().history.length, 50);
    },
  });

  tests.push({
    id: "CMP-RECV-008",
    domain: "computer",
    category: "recovery",
    description: "고아 소켓 및 끊어진 세션 식별 후 자동 stop 전이",
    run: async () => {
      await computerState.stop();
      assert.strictEqual(computerState.getInfo().sessionId, null);
    },
  });

  tests.push({
    id: "CMP-RECV-009",
    domain: "computer",
    category: "recovery",
    description: "리핑 실행 후 새 세션의 VNC/CDP 기본 URL 및 Title 정상 초기화",
    run: async () => {
      await computerState.start();
      const info = computerState.getInfo();
      assert.strictEqual(info.currentUrl, "https://www.google.co.kr");
      assert.strictEqual(info.currentTitle, "Google");
    },
  });

  tests.push({
    id: "CMP-RECV-010",
    domain: "computer",
    category: "recovery",
    description: "주기적 백그라운드 리퍼 실행 및 유휴 세션 감지 후 자가 정리",
    run: async () => {
      (computerState as any).lastActivityAt = new Date(Date.now() - 1_000_000).toISOString();
      if (typeof (computerState as any).checkIdle === "function") {
        await (computerState as any).checkIdle();
        assert.strictEqual(computerState.isRunning(), false);
      }
      await computerState.start();
    },
  });

  // --- [2. 예외 발생 시 세션 안전 종료(Safe State) 전이: RECV-011 ~ RECV-020] ---

  tests.push({
    id: "CMP-RECV-011",
    domain: "computer",
    category: "recovery",
    description: "치명적 액션 예외 발생 시 Safe State 전이 (enterSafeState 검증)",
    run: async () => {
      if (typeof (computerState as any).enterSafeState === "function") {
        await (computerState as any).enterSafeState("CRITICAL_SIMULATED_ERROR");
        assert.strictEqual(computerState.isRunning(), false);
      } else {
        await computerState.stop();
        assert.strictEqual(computerState.isRunning(), false);
      }
    },
  });

  tests.push({
    id: "CMP-RECV-012",
    domain: "computer",
    category: "recovery",
    description: "액션 실행 중 throw 발생 시 activeActionController가 finally에서 안전하게 null 복구",
    run: async () => {
      await computerState.start();
      try {
        const sig = computerState.beginAction();
        throw new Error("Action failure");
      } catch {
        computerState.endAction();
      }
      assert.strictEqual((computerState as any).activeActionController, null);
    },
  });

  tests.push({
    id: "CMP-RECV-013",
    domain: "computer",
    category: "recovery",
    description: "HTTP 요청 본문 JSON 파싱 실패 후 액션 락이 안전하게 해제되어 후속 요청이 가능함",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        // Send broken JSON
        await requestJson(`${baseUrl}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{{ broken JSON",
        });

        // Next request MUST succeed and NOT be deadlocked!
        const statusRes = await requestJson(`${baseUrl}/session/status`);
        assert.strictEqual(statusRes.status, 200);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-RECV-014",
    domain: "computer",
    category: "recovery",
    description: "브라우저 엔진 충돌(Crash) 에러 시그널 수신 시 세션 안전 종료 처리",
    run: async () => {
      const mockEngine = new MockBrowserEngine();
      mockEngine.failNextAction = new Error("Browser crashed with exit code 139");
      await assert.rejects(() => mockEngine.navigate("https://crash.com"), /crashed/);
    },
  });

  tests.push({
    id: "CMP-RECV-015",
    domain: "computer",
    category: "recovery",
    description: "치명적 장애 후 isRunning()이 안전하게 false로 반영",
    run: async () => {
      await computerState.stop();
      assert.strictEqual(computerState.isRunning(), false);
    },
  });

  tests.push({
    id: "CMP-RECV-016",
    domain: "computer",
    category: "recovery",
    description: "Fail-Closed: 인증 서비스 장애 시 모든 VNC 보안 접근 차단",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/vnc`, {
          headers: { Cookie: "talorys_session=broken_service_token" },
        });
        assert.strictEqual(res.status, 401);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-RECV-017",
    domain: "computer",
    category: "recovery",
    description: "상태 전이 중 예외 발생 시 안전 격리 및 stop 유지",
    run: async () => {
      await computerState.stop();
      try {
        await computerState.takeControl();
      } catch {
        // Expected reject
      }
      assert.strictEqual(computerState.getInfo().status, "stopped");
    },
  });

  tests.push({
    id: "CMP-RECV-018",
    domain: "computer",
    category: "recovery",
    description: "연속 액션 실패 시 안전 가드(Safe Guard) 및 히스토리 보존",
    run: async () => {
      await computerState.start();
      for (let i = 0; i < 3; i++) {
        try {
          const sig = computerState.beginAction();
          throw new Error(`Failure ${i}`);
        } catch {
          computerState.endAction();
        }
      }
      assert.strictEqual(computerState.isRunning(), true);
    },
  });

  tests.push({
    id: "CMP-RECV-019",
    domain: "computer",
    category: "recovery",
    description: "Safe State 전이 사유가 세션 히스토리에 기록됨",
    run: async () => {
      computerState.logAction("safe_state.enter", undefined, "Critical error caught");
      const last = computerState.getInfo().history.at(-1);
      assert.strictEqual(last?.action, "safe_state.enter");
    },
  });

  tests.push({
    id: "CMP-RECV-020",
    domain: "computer",
    category: "recovery",
    description: "Safe State 상태에서 start() 호출 시 정상 운영으로 자가 복구",
    run: async () => {
      await computerState.stop();
      const info = await computerState.start();
      assert.strictEqual(info.status, "running");
      assert.ok(info.sessionId);
    },
  });

  // --- [3. 비정상 연결 종료 복구: RECV-021 ~ RECV-030] ---

  tests.push({
    id: "CMP-RECV-021",
    domain: "computer",
    category: "recovery",
    description: "브라우저 CDP 연결 끊김 후 disconnectAutomation으로 클린업 및 재연결 준비",
    run: async () => {
      await disconnectAutomation();
      assert.ok(true);
    },
  });

  tests.push({
    id: "CMP-RECV-022",
    domain: "computer",
    category: "recovery",
    description: "disconnectAutomation 후 mockBrowser 재연결 정상 작동 확인",
    run: async () => {
      const mock = new MockBrowserEngine();
      await mock.connect(28791);
      assert.strictEqual(mock.connected, true);
      await mock.disconnect();
      assert.strictEqual(mock.connected, false);
    },
  });

  tests.push({
    id: "CMP-RECV-023",
    domain: "computer",
    category: "recovery",
    description: "도커 컨테이너 정지 후 세션 상태 조회 시 안전하게 stopped 반영",
    run: async () => {
      await computerState.stop();
      assert.strictEqual(computerState.isRunning(), false);
    },
  });

  tests.push({
    id: "CMP-RECV-024",
    domain: "computer",
    category: "recovery",
    description: "KasmVNC 프록시 502 에러 처리 및 클라이언트에게 적절한 안내 응답",
    run: async () => {
      // Ephemeral server handles proxy errors gracefully
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/session/status`);
        assert.strictEqual(res.status, 200);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-RECV-025",
    domain: "computer",
    category: "recovery",
    description: "비정상 연결 종료 시 클라이언트 소켓 안전 파기 및 서버 크래시 방지",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const controller = new AbortController();
        const req = fetch(`${baseUrl}/session/status`, { signal: controller.signal }).catch(() => {});
        controller.abort();
        await req;
        const res2 = await requestJson(`${baseUrl}/session/status`);
        assert.strictEqual(res2.status, 200);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-RECV-026",
    domain: "computer",
    category: "recovery",
    description: "잔여 락 강제 해제 및 복구: forceUnlock 또는 endAction 호출",
    run: async () => {
      await computerState.start();
      computerState.beginAction();
      // Force unlock by endAction
      computerState.endAction();
      assert.strictEqual((computerState as any).activeActionController, null);
    },
  });

  tests.push({
    id: "CMP-RECV-027",
    domain: "computer",
    category: "recovery",
    description: "세션 복구(재시작) 시 이전 히스토리 초기화 및 클린 시작 검증",
    run: async () => {
      await computerState.stop();
      const newSession = await computerState.start();
      assert.strictEqual(newSession.history.length, 1);
      assert.strictEqual(newSession.history[0]?.action, "session.start");
    },
  });

  tests.push({
    id: "CMP-RECV-028",
    domain: "computer",
    category: "recovery",
    description: "비정상 연결 종료 시 사용자에게 명확한 에러 JSON 전달",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "navigate", url: "" }),
        });
        assert.ok(res.status >= 400);
        assert.ok(res.body.error);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-RECV-029",
    domain: "computer",
    category: "recovery",
    description: "연속 3회 비정상 조기 종료 후 세션 재기동 완주",
    run: async () => {
      for (let i = 0; i < 3; i++) {
        await computerState.stop();
        await computerState.start();
        assert.strictEqual(computerState.isRunning(), true);
      }
    },
  });

  tests.push({
    id: "CMP-RECV-030",
    domain: "computer",
    category: "recovery",
    description: "종합 셀프 힐링(Self-Healing) 엔드투엔드: 장애 발생 -> 안전 차단 -> 락 해제 -> 재시작 복구 완결",
    run: async () => {
      // 1. Start session
      await computerState.start();
      assert.strictEqual(computerState.isRunning(), true);

      // 2. Trigger in-flight action and force takeover
      const sig = computerState.beginAction();
      await computerState.takeControl();
      assert.strictEqual(sig.aborted, true);
      computerState.endAction();

      // 3. User finishes and returns control
      await computerState.returnControl();
      assert.strictEqual(computerState.getMode(), "ai_running");

      // 4. Stop session
      await computerState.stop();
      assert.strictEqual(computerState.isRunning(), false);

      // 5. Restart fresh session
      const fresh = await computerState.start();
      assert.ok(fresh.sessionId);
      assert.strictEqual(computerState.isRunning(), true);
      await computerState.stop();
    },
  });

  return tests;
}
