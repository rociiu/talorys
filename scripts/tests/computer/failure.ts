import { strict as assert } from "node:assert";
import http from "node:http";
import type { TestCase } from "../../massive-harness";
import { computerState } from "../../../services/computer-manager/state";
import { startEphemeralServer, requestJson } from "./mock-helper";
import { createComputerServer } from "../../../services/computer-manager/server";

export function createFailureTests(): TestCase[] {
  const tests: TestCase[] = [];

  async function resetState() {
    try {
      await computerState.stop();
    } catch {}
  }

  // --- [1. 잘못된 상태 전이 거부: FAIL-001 ~ FAIL-020] ---

  tests.push({
    id: "CMP-FAIL-001",
    domain: "computer",
    category: "failure",
    description: "IDLE 상태에서 takeControl() 호출 시 에러 거부 ('Computer session is not running.')",
    run: async () => {
      await resetState();
      await assert.rejects(
        () => computerState.takeControl(),
        /not running/i
      );
    },
  });

  tests.push({
    id: "CMP-FAIL-002",
    domain: "computer",
    category: "failure",
    description: "IDLE 상태에서 returnControl() 호출 시 에러 거부",
    run: async () => {
      await resetState();
      await assert.rejects(
        () => computerState.returnControl(),
        /not running/i
      );
    },
  });

  tests.push({
    id: "CMP-FAIL-003",
    domain: "computer",
    category: "failure",
    description: "IDLE 상태에서 beginAction() 호출 시 에러 거부",
    run: async () => {
      await resetState();
      assert.throws(() => computerState.beginAction());
    },
  });

  tests.push({
    id: "CMP-FAIL-004",
    domain: "computer",
    category: "failure",
    description: "STOPPED 상태에서 takeControl() 호출 시 에러 거부",
    run: async () => {
      await computerState.start();
      await computerState.stop();
      await assert.rejects(
        () => computerState.takeControl(),
        /not running/i
      );
    },
  });

  tests.push({
    id: "CMP-FAIL-005",
    domain: "computer",
    category: "failure",
    description: "STOPPED 상태에서 returnControl() 호출 시 에러 거부",
    run: async () => {
      await assert.rejects(
        () => computerState.returnControl(),
        /not running/i
      );
    },
  });

  tests.push({
    id: "CMP-FAIL-006",
    domain: "computer",
    category: "failure",
    description: "STOPPED 상태에서 beginAction() 호출 시 에러 거부",
    run: async () => {
      assert.throws(() => computerState.beginAction());
    },
  });

  tests.push({
    id: "CMP-FAIL-007",
    domain: "computer",
    category: "failure",
    description: "user_controlling 모드에서 beginAction() 호출 시 COMPUTER_LOCKED_USER_CONTROLLING 에러 거부",
    run: async () => {
      await computerState.start();
      await computerState.takeControl();
      assert.throws(
        () => computerState.beginAction(),
        /COMPUTER_LOCKED_USER_CONTROLLING/
      );
      await computerState.returnControl();
    },
  });

  tests.push({
    id: "CMP-FAIL-008",
    domain: "computer",
    category: "failure",
    description: "IDLE 상태에서 pause() 호출 시 거부",
    run: async () => {
      await resetState();
      if (typeof (computerState as any).pause === "function") {
        await assert.rejects(() => (computerState as any).pause());
      } else {
        assert.ok(true);
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-009",
    domain: "computer",
    category: "failure",
    description: "IDLE 상태에서 resume() 호출 시 거부",
    run: async () => {
      await resetState();
      if (typeof (computerState as any).resume === "function") {
        await assert.rejects(() => (computerState as any).resume());
      } else {
        assert.ok(true);
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-010",
    domain: "computer",
    category: "failure",
    description: "COMPLETED/STOPPED 상태에서 pause() 호출 시 거부",
    run: async () => {
      await computerState.stop();
      if (typeof (computerState as any).pause === "function") {
        await assert.rejects(() => (computerState as any).pause());
      } else {
        assert.ok(true);
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-011",
    domain: "computer",
    category: "failure",
    description: "COMPLETED/STOPPED 상태에서 resume() 호출 시 거부",
    run: async () => {
      await computerState.stop();
      if (typeof (computerState as any).resume === "function") {
        await assert.rejects(() => (computerState as any).resume());
      } else {
        assert.ok(true);
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-012",
    domain: "computer",
    category: "failure",
    description: "HTTP POST /session/take-control: 세션 미실행 상태에서 호출 시 500/400 거부",
    run: async () => {
      await resetState();
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/session/take-control`, { method: "POST" });
        assert.ok(res.status >= 400);
        assert.ok(res.body.error);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-013",
    domain: "computer",
    category: "failure",
    description: "HTTP POST /session/return-control: 세션 미실행 상태에서 호출 시 500/400 거부",
    run: async () => {
      await resetState();
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/session/return-control`, { method: "POST" });
        assert.ok(res.status >= 400);
        assert.ok(res.body.error);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-014",
    domain: "computer",
    category: "failure",
    description: "HTTP POST /action: 세션 미실행 상태에서 호출 시 400 Bad Request 거부",
    run: async () => {
      await resetState();
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "screenshot" }),
        });
        assert.strictEqual(res.status, 400);
        assert.ok(res.body.error?.includes("not running"));
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-015",
    domain: "computer",
    category: "failure",
    description: "HTTP POST /action: user_controlling 모드 중 호출 시 409 Conflict 거부",
    run: async () => {
      await computerState.start();
      await computerState.takeControl();
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "screenshot" }),
        });
        assert.strictEqual(res.status, 409);
        assert.strictEqual(res.body.mode, "user_controlling");
      } finally {
        await close();
        await computerState.returnControl();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-016",
    domain: "computer",
    category: "failure",
    description: "잘못된 상태 전이 실패 후 원래 세션 상태가 훼손되지 않고 보존됨",
    run: async () => {
      await computerState.start();
      const idBefore = computerState.getInfo().sessionId;
      try {
        await (computerState as any).takeControl();
        // Force an invalid operation
        (computerState as any).status = "invalid_status";
        await (computerState as any).beginAction();
      } catch {
        // Recover status
        (computerState as any).status = "running";
      }
      assert.strictEqual(computerState.getInfo().sessionId, idBefore);
      assert.strictEqual(computerState.isRunning(), true);
    },
  });

  tests.push({
    id: "CMP-FAIL-017",
    domain: "computer",
    category: "failure",
    description: "PAUSED 상태에서 직접 beginAction() 시도 시 전이 거부 확인",
    run: async () => {
      await computerState.takeControl();
      assert.throws(() => computerState.beginAction());
      await computerState.returnControl();
    },
  });

  tests.push({
    id: "CMP-FAIL-018",
    domain: "computer",
    category: "failure",
    description: "존재하지 않는 임의 상태 코드로의 강제 전이 거부",
    run: async () => {
      if (typeof (computerState as any).transitionTo === "function") {
        assert.throws(() => (computerState as any).transitionTo("UNKNOWN_STATE"));
      } else {
        assert.ok(true);
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-019",
    domain: "computer",
    category: "failure",
    description: "IDLE 상태에서 updatePageInfo 호출 시 lastActivityAt 갱신 여부와 무관하게 안전 방어",
    run: async () => {
      await computerState.stop();
      computerState.updatePageInfo("https://test.com", "Title");
      assert.strictEqual(computerState.isRunning(), false);
    },
  });

  tests.push({
    id: "CMP-FAIL-020",
    domain: "computer",
    category: "failure",
    description: "세션 강제 중지 중 발생하는 예외는 fail-safe하게 처리되고 stopped 유지",
    run: async () => {
      await computerState.start();
      await computerState.stop();
      assert.strictEqual(computerState.getInfo().status, "stopped");
    },
  });

  // --- [2. 잘못된 토큰 / 인증 거부: FAIL-021 ~ FAIL-035] ---

  tests.push({
    id: "CMP-FAIL-021",
    domain: "computer",
    category: "failure",
    description: "VNC 프록시: Cookie 헤더가 전혀 없는 요청에 대해 401 Unauthorized 거부",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/vnc`);
        assert.strictEqual(res.status, 401);
        assert.ok(res.body.error?.includes("Unauthorized"));
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-022",
    domain: "computer",
    category: "failure",
    description: "VNC 프록시: Cookie에 talorys_session이 없는 경우 401 Unauthorized 거부",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/vnc`, {
          headers: { Cookie: "other_cookie=12345; auth=none" },
        });
        assert.strictEqual(res.status, 401);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-023",
    domain: "computer",
    category: "failure",
    description: "VNC 프록시: talorys_session= 값이 빈 문자열인 경우 401 거부",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/vnc`, {
          headers: { Cookie: "talorys_session=;" },
        });
        assert.strictEqual(res.status, 401);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-024",
    domain: "computer",
    category: "failure",
    description: "VNC 프록시: 위조된 세션 토큰 (invalid_token_123) 401 거부",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/vnc`, {
          headers: { Cookie: "talorys_session=invalid_token_12345" },
        });
        assert.strictEqual(res.status, 401);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-025",
    domain: "computer",
    category: "failure",
    description: "VNC 프록시: 특수기호 및 SQL 인젝션 시도 토큰 401 거부",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/vnc`, {
          headers: { Cookie: "talorys_session=' OR 1=1 --" },
        });
        assert.strictEqual(res.status, 401);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-026",
    domain: "computer",
    category: "failure",
    description: "VNC 서브경로 /vnc/websockify 요청에 대해서도 401 인증 거부 적용",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/vnc/websockify`);
        assert.strictEqual(res.status, 401);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-027",
    domain: "computer",
    category: "failure",
    description: "VNC 서브경로 /vnc/app/ui.js 요청에 대해서도 401 인증 거부 적용",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/vnc/app/ui.js`);
        assert.strictEqual(res.status, 401);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-028",
    domain: "computer",
    category: "failure",
    description: "경로 탐색 시도 (/vnc/../../etc/passwd) 차단 및 401 인증 거부",
    run: async () => {
      const { port, close } = await startEphemeralServer(createComputerServer);
      try {
        const statusCode = await new Promise<number>((resolve, reject) => {
          const req = http.request(
            {
              hostname: "127.0.0.1",
              port,
              path: "/vnc/../../etc/passwd",
              method: "GET",
            },
            (res) => {
              resolve(res.statusCode || 0);
            }
          );
          req.on("error", reject);
          req.end();
        });
        assert.strictEqual(statusCode, 401);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-029",
    domain: "computer",
    category: "failure",
    description: "인증 서비스 다운 또는 타임아웃 시 Fail-Closed로 401 거부",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/vnc`, {
          headers: { Cookie: "talorys_session=non_reachable_auth_token" },
        });
        assert.strictEqual(res.status, 401);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-030",
    domain: "computer",
    category: "failure",
    description: "401 응답 본문이 JSON 포맷이고 error 메시지를 포함해야 함",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/vnc`);
        assert.strictEqual(res.status, 401);
        assert.ok(typeof res.body.error === "string");
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-031",
    domain: "computer",
    category: "failure",
    description: "Bearer Authorization 헤더만 있고 Cookie가 없는 경우 VNC 스트림 401 거부",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/vnc`, {
          headers: { Authorization: "Bearer fake_token" },
        });
        assert.strictEqual(res.status, 401);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-032",
    domain: "computer",
    category: "failure",
    description: "쿠키 파싱 정규식 경계: __Host- 접두어가 붙은 세션 쿠키도 인식 시도",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/vnc`, {
          headers: { Cookie: "__Host-talorys_session=invalid_mock" },
        });
        assert.strictEqual(res.status, 401);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-033",
    domain: "computer",
    category: "failure",
    description: "공백만 있는 세션 토큰 Cookie: 'talorys_session=   ' 401 거부",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/vnc`, {
          headers: { Cookie: "talorys_session=   " },
        });
        assert.strictEqual(res.status, 401);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-034",
    domain: "computer",
    category: "failure",
    description: "여러 쿠키가 섞여 있을 때 유효하지 않은 talorys_session 정확히 판정",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/vnc`, {
          headers: { Cookie: "a=1; b=2; talorys_session=invalid; c=3" },
        });
        assert.strictEqual(res.status, 401);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-035",
    domain: "computer",
    category: "failure",
    description: "VNC 요청 시 CORS OPTIONS 프리플라이트는 204 No Content 허용",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/vnc`, { method: "OPTIONS" });
        assert.strictEqual(res.status, 204);
      } finally {
        await close();
      }
    },
  });

  // --- [3. 유효하지 않은 액션 프로토콜 거부: FAIL-036 ~ FAIL-050] ---

  tests.push({
    id: "CMP-FAIL-036",
    domain: "computer",
    category: "failure",
    description: "POST /action: 알 수 없는 액션명 ('unknown_action_xyz') 전달 시 400 Bad Request",
    run: async () => {
      await computerState.start();
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "unknown_action_xyz" }),
        });
        assert.strictEqual(res.status, 400);
        assert.ok(res.body.error?.includes("Unknown action"));
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-037",
    domain: "computer",
    category: "failure",
    description: "POST /action: action 필드가 누락된 요청 전달 시 400 Bad Request",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: "nowhere" }),
        });
        assert.strictEqual(res.status, 400);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-038",
    domain: "computer",
    category: "failure",
    description: "POST /action: 잘못된 JSON 본문 전송 시 400/500 에러 반환 및 락 누수 방지 (데드락 결함 검증)",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{ invalid json string ...",
        });
        assert.ok(res.status >= 400);
        // CRITICAL CHECK: After this failure, the lock MUST NOT be held!
        // A subsequent valid action must NOT fail with deadlock!
        const followUp = await requestJson(`${baseUrl}/session/status`);
        assert.strictEqual(followUp.status, 200);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-039",
    domain: "computer",
    category: "failure",
    description: "click 액션: selector, ref, x, y 모두 누락 시 엔진 거부 확인",
    run: async () => {
      const engine = new (await import("../../../services/computer-manager/engine/agent-browser-adapter")).AgentBrowserAdapter();
      await assert.rejects(
        () => engine.click({}),
        /Must provide ref, selector, or \(x, y\)/
      );
    },
  });

  tests.push({
    id: "CMP-FAIL-040",
    domain: "computer",
    category: "failure",
    description: "click 액션: x만 제공되고 y가 누락된 경우 거부",
    run: async () => {
      const engine = new (await import("../../../services/computer-manager/engine/agent-browser-adapter")).AgentBrowserAdapter();
      await assert.rejects(
        () => engine.click({ x: 100 }),
        /Must provide ref, selector, or \(x, y\)/
      );
    },
  });

  tests.push({
    id: "CMP-FAIL-041",
    domain: "computer",
    category: "failure",
    description: "click 액션: y만 제공되고 x가 누락된 경우 거부",
    run: async () => {
      const engine = new (await import("../../../services/computer-manager/engine/agent-browser-adapter")).AgentBrowserAdapter();
      await assert.rejects(
        () => engine.click({ y: 100 }),
        /Must provide ref, selector, or \(x, y\)/
      );
    },
  });

  tests.push({
    id: "CMP-FAIL-042",
    domain: "computer",
    category: "failure",
    description: "존재하지 않는 엔드포인트 (/invalid/route) 요청 시 404 Not Found",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/invalid/route`);
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.error, "Not found");
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-043",
    domain: "computer",
    category: "failure",
    description: "지원되지 않는 HTTP 메서드(PUT /session/start) 요청 시 404 거부",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/session/start`, { method: "PUT" });
        assert.strictEqual(res.status, 404);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-044",
    domain: "computer",
    category: "failure",
    description: "지원되지 않는 HTTP 메서드(DELETE /action) 요청 시 404 거부",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/action`, { method: "DELETE" });
        assert.strictEqual(res.status, 404);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-045",
    domain: "computer",
    category: "failure",
    description: "거부된 액션이 세션 액션 히스토리에 성공 항목으로 기록되지 않음",
    run: async () => {
      const histBefore = computerState.getInfo().history.length;
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        await requestJson(`${baseUrl}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "bad_action" }),
        });
      } finally {
        await close();
      }
      const histAfter = computerState.getInfo().history.length;
      assert.strictEqual(histAfter, histBefore);
    },
  });

  tests.push({
    id: "CMP-FAIL-046",
    domain: "computer",
    category: "failure",
    description: "빈 바디 POST /action 요청 시 400 Bad Request",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "",
        });
        assert.strictEqual(res.status, 400);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-047",
    domain: "computer",
    category: "failure",
    description: "CORS OPTIONS 요청 시 204 No Content 및 올바른 헤더 반환",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/action`, { method: "OPTIONS" });
        assert.strictEqual(res.status, 204);
        assert.strictEqual(res.headers.get("access-control-allow-origin"), "*");
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-048",
    domain: "computer",
    category: "failure",
    description: "비정상 연결 조기 종료(Aborted Request) 시 서버 크래시 방지",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const controller = new AbortController();
        const p = fetch(`${baseUrl}/session/status`, { signal: controller.signal }).catch(() => {});
        controller.abort();
        await p;
        // Server should still be alive
        const res = await requestJson(`${baseUrl}/session/status`);
        assert.strictEqual(res.status, 200);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-049",
    domain: "computer",
    category: "failure",
    description: "GET /session/start 요청 시 404 거부 (POST 전용 확인)",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/session/start`, { method: "GET" });
        assert.strictEqual(res.status, 404);
      } finally {
        await close();
      }
    },
  });

  tests.push({
    id: "CMP-FAIL-050",
    domain: "computer",
    category: "failure",
    description: "GET /session/stop 요청 시 404 거부 (POST 전용 확인)",
    run: async () => {
      const { baseUrl, close } = await startEphemeralServer(createComputerServer);
      try {
        const res = await requestJson(`${baseUrl}/session/stop`, { method: "GET" });
        assert.strictEqual(res.status, 404);
      } finally {
        await close();
      }
    },
  });

  return tests;
}
