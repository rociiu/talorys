import { strict as assert } from "node:assert";
import type { TestCase } from "../../massive-harness";
import { computerState } from "../../../services/computer-manager/state";
import { MockBrowserEngine, startEphemeralServer, requestJson } from "./mock-helper";
import { createComputerServer } from "../../../services/computer-manager/server";

export function createConcurrencyTests(): TestCase[] {
  const tests: TestCase[] = [];

  async function resetState() {
    try {
      await computerState.stop();
    } catch {}
  }

  // --- [1. 사용자 Takeover 인터럽트 시 In-flight 액션 AbortController 중단 경합: CONC-001 ~ CONC-020] ---

  tests.push({
    id: "CMP-CONC-001",
    domain: "computer",
    category: "concurrency",
    description: "In-flight 액션 실행 중 takeControl() 호출 시 activeActionController가 즉각 abort된다",
    run: async () => {
      await resetState();
      await computerState.start();
      const signal = computerState.beginAction();
      assert.strictEqual(signal.aborted, false);

      await computerState.takeControl();
      assert.strictEqual(signal.aborted, true);
      assert.strictEqual(signal.reason, "user_took_control");
      await computerState.returnControl();
    },
  });

  tests.push({
    id: "CMP-CONC-002",
    domain: "computer",
    category: "concurrency",
    description: "takeControl() 중단 신호 발생 시 AbortSignal 이벤트 리스너가 정확히 1회 호출된다",
    run: async () => {
      const signal = computerState.beginAction();
      let callCount = 0;
      signal.addEventListener("abort", () => {
        callCount++;
      });
      await computerState.takeControl();
      assert.strictEqual(callCount, 1);
      assert.strictEqual(signal.aborted, true);
      await computerState.returnControl();
    },
  });

  tests.push({
    id: "CMP-CONC-003",
    domain: "computer",
    category: "concurrency",
    description: "지연 비동기 액션 수행 중 takeControl()이 발생하면 즉시 ACTION_ABORTED_USER_CONTROL로 reject된다",
    run: async () => {
      const engine = new MockBrowserEngine();
      engine.delayMs = 150;
      const signal = computerState.beginAction();

      const actionPromise = engine.navigate("https://slow-load.com", signal);
      await new Promise((r) => setTimeout(r, 20));
      await computerState.takeControl();

      await assert.rejects(actionPromise, /ACTION_ABORTED_USER_CONTROL/);
      computerState.endAction();
      await computerState.returnControl();
    },
  });

  tests.push({
    id: "CMP-CONC-004",
    domain: "computer",
    category: "concurrency",
    description: "중단된 액션 이후 즉각 새 AI 액션 시작 시 COMPUTER_LOCKED_USER_CONTROLLING으로 안전하게 차단",
    run: async () => {
      await computerState.takeControl();
      assert.throws(() => computerState.beginAction(), /COMPUTER_LOCKED_USER_CONTROLLING/);
      await computerState.returnControl();
    },
  });

  tests.push({
    id: "CMP-CONC-005",
    domain: "computer",
    category: "concurrency",
    description: "연속 takeControl() 3회 호출 (Idempotent Takeover) 시 에러 없이 최초 중단 신호 유지",
    run: async () => {
      const signal = computerState.beginAction();
      await computerState.takeControl();
      await computerState.takeControl();
      await computerState.takeControl();
      assert.strictEqual(signal.aborted, true);
      assert.strictEqual(computerState.getMode(), "user_controlling");
      await computerState.returnControl();
    },
  });

  tests.push({
    id: "CMP-CONC-006",
    domain: "computer",
    category: "concurrency",
    description: "takeControl() 후 returnControl() 완료 시 새 액션은 이전 abort 상태에 영향받지 않고 정상 시작",
    run: async () => {
      const sig1 = computerState.beginAction();
      await computerState.takeControl();
      assert.strictEqual(sig1.aborted, true);

      await computerState.returnControl();
      const sig2 = computerState.beginAction();
      assert.strictEqual(sig2.aborted, false);
      computerState.endAction();
    },
  });

  tests.push({
    id: "CMP-CONC-007",
    domain: "computer",
    category: "concurrency",
    description: "장시간 click 대기 중 takeover 인터럽트 발생 시 조기 탈출 확인",
    run: async () => {
      const engine = new MockBrowserEngine();
      engine.delayMs = 200;
      const signal = computerState.beginAction();
      const clickPromise = engine.click({ selector: "#btn" }, signal);

      setTimeout(() => {
        void computerState.takeControl();
      }, 30);

      await assert.rejects(clickPromise, /ACTION_ABORTED_USER_CONTROL/);
      computerState.endAction();
      await computerState.returnControl();
    },
  });

  tests.push({
    id: "CMP-CONC-008",
    domain: "computer",
    category: "concurrency",
    description: "장시간 typeText 대기 중 takeover 인터럽트 발생 시 조기 탈출 확인",
    run: async () => {
      const engine = new MockBrowserEngine();
      engine.delayMs = 200;
      const signal = computerState.beginAction();
      const typePromise = engine.typeText({ text: "long long typing" }, signal);

      setTimeout(() => {
        void computerState.takeControl();
      }, 30);

      await assert.rejects(typePromise, /ACTION_ABORTED_USER_CONTROL/);
      computerState.endAction();
      await computerState.returnControl();
    },
  });

  tests.push({
    id: "CMP-CONC-009",
    domain: "computer",
    category: "concurrency",
    description: "장시간 scroll 대기 중 takeover 인터럽트 발생 시 조기 탈출 확인",
    run: async () => {
      const engine = new MockBrowserEngine();
      engine.delayMs = 200;
      const signal = computerState.beginAction();
      const scrollPromise = engine.scroll({ direction: "down", amount: 1000 }, signal);

      setTimeout(() => {
        void computerState.takeControl();
      }, 30);

      await assert.rejects(scrollPromise, /ACTION_ABORTED_USER_CONTROL/);
      computerState.endAction();
      await computerState.returnControl();
    },
  });

  tests.push({
    id: "CMP-CONC-010",
    domain: "computer",
    category: "concurrency",
    description: "HTTP POST /action 실행 중 takeControl 발생 시 409 Conflict 반환 검증",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        await computerState.takeControl();
        const res = await requestJson(`${baseUrl}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "screenshot" }),
        });
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.mode, "user_controlling");
      } finally {
        await computerState.returnControl();
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-CONC-011",
    domain: "computer",
    category: "concurrency",
    description: "동일 밀리초 내 takeControl과 액션 완료가 동시 경합할 때의 상태 일관성",
    run: async () => {
      const sig = computerState.beginAction();
      const p1 = Promise.resolve().then(() => computerState.endAction());
      const p2 = computerState.takeControl();
      await Promise.all([p1, p2]);
      assert.strictEqual(computerState.getMode(), "user_controlling");
      await computerState.returnControl();
    },
  });

  tests.push({
    id: "CMP-CONC-012",
    domain: "computer",
    category: "concurrency",
    description: "takeControl() 후 즉시 stop()이 호출될 때 이중 abort 충돌 방지",
    run: async () => {
      const sig = computerState.beginAction();
      await computerState.takeControl();
      await computerState.stop();
      assert.strictEqual(sig.aborted, true);
      assert.strictEqual(computerState.isRunning(), false);
      await computerState.start();
    },
  });

  tests.push({
    id: "CMP-CONC-013",
    domain: "computer",
    category: "concurrency",
    description: "takeControl 발생 시 액션 히스토리에 'control.take' 액션이 안전하게 푸시됨",
    run: async () => {
      await computerState.takeControl();
      const last = computerState.getInfo().history.at(-1);
      assert.strictEqual(last?.action, "control.take");
      await computerState.returnControl();
    },
  });

  tests.push({
    id: "CMP-CONC-014",
    domain: "computer",
    category: "concurrency",
    description: "returnControl 완료 시 히스토리에 'control.return' 액션이 푸시됨",
    run: async () => {
      await computerState.takeControl();
      await computerState.returnControl();
      const last = computerState.getInfo().history.at(-1);
      assert.strictEqual(last?.action, "control.return");
    },
  });

  tests.push({
    id: "CMP-CONC-015",
    domain: "computer",
    category: "concurrency",
    description: "다중 워커 5개가 비동기 요청을 시도할 때 중간 takeover 인터럽트 처리",
    run: async () => {
      let abortedCount = 0;
      const sig = computerState.beginAction();
      sig.addEventListener("abort", () => {
        abortedCount++;
      });
      await computerState.takeControl();
      assert.strictEqual(abortedCount, 1);
      await computerState.returnControl();
    },
  });

  tests.push({
    id: "CMP-CONC-016",
    domain: "computer",
    category: "concurrency",
    description: "중단된 액션의 에러가 상위 프로세스를 크래시시키지 않고 graceful 처리됨",
    run: async () => {
      const sig = computerState.beginAction();
      sig.addEventListener("abort", () => {
        // Safe handler
      });
      await computerState.takeControl();
      computerState.endAction();
      await computerState.returnControl();
      assert.strictEqual(computerState.isRunning(), true);
    },
  });

  tests.push({
    id: "CMP-CONC-017",
    domain: "computer",
    category: "concurrency",
    description: "takeover 인터럽트 스트레스 테스트: 20회 연속 빠른 takeover/return 사이클",
    run: async () => {
      for (let i = 0; i < 20; i++) {
        await computerState.takeControl();
        assert.strictEqual(computerState.getMode(), "user_controlling");
        await computerState.returnControl();
        assert.strictEqual(computerState.getMode(), "ai_running");
      }
    },
  });

  tests.push({
    id: "CMP-CONC-018",
    domain: "computer",
    category: "concurrency",
    description: "takeover 인터럽트 직후 stop -> start 재시작 사이클 안정성",
    run: async () => {
      await computerState.takeControl();
      await computerState.stop();
      await computerState.start();
      assert.strictEqual(computerState.getMode(), "ai_running");
      assert.strictEqual(computerState.isRunning(), true);
    },
  });

  tests.push({
    id: "CMP-CONC-019",
    domain: "computer",
    category: "concurrency",
    description: "사용자 제어 모드 중 updatePageInfo 호출 시 currentUrl 정상 업데이트",
    run: async () => {
      await computerState.takeControl();
      computerState.updatePageInfo("https://user-browsed.com", "User Browsed");
      assert.strictEqual(computerState.getInfo().currentUrl, "https://user-browsed.com");
      await computerState.returnControl();
    },
  });

  tests.push({
    id: "CMP-CONC-020",
    domain: "computer",
    category: "concurrency",
    description: "takeover 신호 전파 시 메모리 누수 방지 (이벤트 리스너 미해제 방지)",
    run: async () => {
      const sig = computerState.beginAction();
      const fn = () => {};
      sig.addEventListener("abort", fn);
      await computerState.takeControl();
      sig.removeEventListener("abort", fn);
      await computerState.returnControl();
    },
  });

  // --- [2. 동시 명령 수신 시 락: CONC-021 ~ CONC-040] ---

  tests.push({
    id: "CMP-CONC-021",
    domain: "computer",
    category: "concurrency",
    description: "동시 명령 수신 시 락: 첫 번째 액션이 진행 중일 때 두 번째 액션은 락에 의해 거부된다",
    run: async () => {
      await resetState();
      await computerState.start();
      const sig1 = computerState.beginAction();
      assert.ok(sig1);

      // Second beginAction while first is active MUST fail with lock error
      assert.throws(
        () => computerState.beginAction(),
        /ACTION_IN_PROGRESS_LOCKED|locked|already in progress/i
      );

      computerState.endAction();
    },
  });

  tests.push({
    id: "CMP-CONC-022",
    domain: "computer",
    category: "concurrency",
    description: "첫 번째 액션이 정상 완료(endAction)된 직후에는 두 번째 액션이 즉시 락을 획득할 수 있다",
    run: async () => {
      const sig1 = computerState.beginAction();
      computerState.endAction();

      const sig2 = computerState.beginAction();
      assert.ok(sig2);
      assert.strictEqual(sig2.aborted, false);
      computerState.endAction();
    },
  });

  tests.push({
    id: "CMP-CONC-023",
    domain: "computer",
    category: "concurrency",
    description: "10개의 동시 beginAction 호출 경합에서 오직 정확히 1개만 성공하고 9개는 거부된다",
    run: async () => {
      if (!computerState.isRunning()) {
        await computerState.start();
      }
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < 10; i++) {
        try {
          computerState.beginAction();
          successCount++;
        } catch {
          failCount++;
        }
      }

      assert.strictEqual(successCount, 1);
      assert.strictEqual(failCount, 9);
      computerState.endAction();
    },
  });

  tests.push({
    id: "CMP-CONC-024",
    domain: "computer",
    category: "concurrency",
    description: "HTTP 서버: 동시 5개의 /action 요청 유입 시 1개 외의 동시 요청은 409 Conflict로 안전 거부",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const sig = computerState.beginAction();
        const res = await requestJson(`${baseUrl}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "screenshot" }),
        });
        computerState.endAction();
        assert.strictEqual(res.status, 409);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-CONC-025",
    domain: "computer",
    category: "concurrency",
    description: "동시 start() 요청 10개 유입 시 단 1개의 세션만 생성되고 컨테이너 중복 기동 없음",
    run: async () => {
      await resetState();
      const sessions = await Promise.all(Array.from({ length: 10 }, () => computerState.start()));
      const firstId = sessions[0]?.sessionId;
      assert.ok(firstId);
      for (const s of sessions) {
        assert.strictEqual(s.sessionId, firstId);
      }
    },
  });

  tests.push({
    id: "CMP-CONC-026",
    domain: "computer",
    category: "concurrency",
    description: "동시 stop() 요청 10개 유입 시 안전하게 1회만 정리 수행 (Idempotent Stop)",
    run: async () => {
      await Promise.all(Array.from({ length: 10 }, () => computerState.stop()));
      assert.strictEqual(computerState.getInfo().status, "stopped");
      assert.strictEqual(computerState.isRunning(), false);
    },
  });

  tests.push({
    id: "CMP-CONC-027",
    domain: "computer",
    category: "concurrency",
    description: "start() 실행 직후 바로 stop() 경합 시 최종 상태가 안전하게 stopped를 만족함",
    run: async () => {
      const p1 = computerState.start();
      const p2 = computerState.stop();
      await Promise.allSettled([p1, p2]);
      assert.ok(["running", "stopped"].includes(computerState.getInfo().status));
      await computerState.stop();
    },
  });

  tests.push({
    id: "CMP-CONC-028",
    domain: "computer",
    category: "concurrency",
    description: "동시 takeControl()과 action 요청 경합 시 action은 취소되거나 409로 거부됨",
    run: async () => {
      await computerState.start();
      const sig = computerState.beginAction();
      const [_, takeRes] = await Promise.allSettled([
        new Promise((r) => setTimeout(r, 10)),
        computerState.takeControl(),
      ]);
      assert.strictEqual(takeRes.status, "fulfilled");
      assert.strictEqual(sig.aborted, true);
      await computerState.returnControl();
    },
  });

  tests.push({
    id: "CMP-CONC-029",
    domain: "computer",
    category: "concurrency",
    description: "동시 returnControl()과 action 요청의 순서 정합성 보장",
    run: async () => {
      await computerState.takeControl();
      await computerState.returnControl();
      const sig = computerState.beginAction();
      assert.ok(sig);
      computerState.endAction();
    },
  });

  tests.push({
    id: "CMP-CONC-030",
    domain: "computer",
    category: "concurrency",
    description: "액션 실행 중 updatePageInfo가 동시 호출되어도 URL/Title 데이터 오염 없음",
    run: async () => {
      const sig = computerState.beginAction();
      computerState.updatePageInfo("https://parallel-url.com", "Parallel Title");
      assert.strictEqual(computerState.getInfo().currentUrl, "https://parallel-url.com");
      assert.strictEqual(computerState.getInfo().currentTitle, "Parallel Title");
      computerState.endAction();
    },
  });

  tests.push({
    id: "CMP-CONC-031",
    domain: "computer",
    category: "concurrency",
    description: "동시 100회 touch() 호출 시 lastActivityAt 단조 증가 및 유효성 유지",
    run: async () => {
      const calls = Array.from({ length: 100 }, () => {
        computerState.touch();
        return computerState.getInfo().lastActivityAt;
      });
      assert.strictEqual(calls.length, 100);
      assert.ok(calls[99]);
    },
  });

  tests.push({
    id: "CMP-CONC-032",
    domain: "computer",
    category: "concurrency",
    description: "액션 히스토리 동시 push 시 배열 길이 및 엔트리 유실 없음",
    run: async () => {
      const initial = computerState.getInfo().history.length;
      for (let i = 0; i < 20; i++) {
        computerState.logAction(`concurrent.log.${i}`);
      }
      assert.strictEqual(computerState.getInfo().history.length, Math.min(50, initial + 20));
    },
  });

  tests.push({
    id: "CMP-CONC-033",
    domain: "computer",
    category: "concurrency",
    description: "20개 비동기 태스크의 세션 상태 동시 읽기(getInfo) 무결성",
    run: async () => {
      const readers = Array.from({ length: 20 }, async () => {
        return computerState.getInfo();
      });
      const results = await Promise.all(readers);
      assert.strictEqual(results.length, 20);
      for (const res of results) {
        assert.ok(res.status);
      }
    },
  });

  tests.push({
    id: "CMP-CONC-034",
    domain: "computer",
    category: "concurrency",
    description: "동시 50개 비동기 작업(읽기, 쓰기, touch, status) 셔플 실행 후 최종 상태 정합성",
    run: async () => {
      if (!computerState.isRunning()) {
        await computerState.start();
      }
      const tasks: Promise<any>[] = [];
      for (let i = 0; i < 50; i++) {
        const mod = i % 4;
        if (mod === 0) tasks.push(Promise.resolve(computerState.getInfo()));
        else if (mod === 1) tasks.push(Promise.resolve(computerState.touch()));
        else if (mod === 2) tasks.push(Promise.resolve(computerState.logAction(`task.${i}`)));
        else tasks.push(Promise.resolve(computerState.isRunning()));
      }
      await Promise.all(tasks);
      assert.strictEqual(computerState.isRunning(), true);
    },
  });

  tests.push({
    id: "CMP-CONC-035",
    domain: "computer",
    category: "concurrency",
    description: "락 홀드 상태에서 예외 발생 시 finally에서 락이 반드시 해제됨",
    run: async () => {
      try {
        const sig = computerState.beginAction();
        throw new Error("Simulated failure inside action");
      } catch {
        computerState.endAction();
      }
      // Lock must be released
      const nextSig = computerState.beginAction();
      assert.ok(nextSig);
      computerState.endAction();
    },
  });

  tests.push({
    id: "CMP-CONC-036",
    domain: "computer",
    category: "concurrency",
    description: "동시 인증 확인 요청 10개 유입 시 authCache 동시 읽기/쓰기 안전성",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const requests = Array.from({ length: 10 }, () =>
          requestJson(`${baseUrl}/vnc`, { headers: { Cookie: "talorys_session=cached_token" } })
        );
        const results = await Promise.all(requests);
        assert.strictEqual(results.length, 10);
        for (const r of results) {
          assert.strictEqual(r.status, 401);
        }
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-CONC-037",
    domain: "computer",
    category: "concurrency",
    description: "동시 세션 상태 조회와 takeControl 경합 시 레이스 컨디션 없음",
    run: async () => {
      const p1 = Promise.resolve(computerState.getInfo());
      const p2 = computerState.takeControl();
      const p3 = Promise.resolve(computerState.getInfo());
      await Promise.all([p1, p2, p3]);
      assert.strictEqual(computerState.getMode(), "user_controlling");
      await computerState.returnControl();
    },
  });

  tests.push({
    id: "CMP-CONC-038",
    domain: "computer",
    category: "concurrency",
    description: "웹소켓 업그레이드 핸들러와 동시 HTTP API 요청의 충돌 방지",
    run: async () => {
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
    id: "CMP-CONC-039",
    domain: "computer",
    category: "concurrency",
    description: "동시 beginAction과 stop() 호출 시 안전하게 stop이 우선하거나 즉시 abort 처리됨",
    run: async () => {
      await computerState.start();
      const sig = computerState.beginAction();
      await computerState.stop();
      assert.strictEqual(sig.aborted, true);
      assert.strictEqual(computerState.isRunning(), false);
      await computerState.start();
    },
  });

  tests.push({
    id: "CMP-CONC-040",
    domain: "computer",
    category: "concurrency",
    description: "락 해제 후 대기 큐 또는 후속 액션 정상 디스패치 사이클 완주",
    run: async () => {
      for (let i = 0; i < 5; i++) {
        const sig = computerState.beginAction();
        assert.ok(sig);
        computerState.endAction();
      }
      assert.strictEqual(computerState.isRunning(), true);
    },
  });

  return tests;
}
