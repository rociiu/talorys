import { z } from "zod";
import { defineTool, ToolError } from "./registry";

const COMPUTER_API = "http://127.0.0.1:28789";

async function callComputerApi(endpoint: string, body?: unknown) {
  try {
    const res = await fetch(`${COMPUTER_API}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 409) {
      throw new ToolError("현재 사용자가 직접 마우스와 키보드로 컴퓨터를 조작 중입니다. 사용자가 화면의 'AI에게 넘기기' 버튼을 눌러 제어권을 반환한 후 작업을 재개하세요.");
    }

    const json = (await res.json()) as any;
    if (!res.ok) {
      throw new ToolError(json.error || `Computer service error (${res.status})`);
    }
    return json.result ?? json.session ?? json;
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(`컴퓨터 서비스 통신 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const computerTools = [
  defineTool({
    name: "computer_launch",
    description: "Launch or verify the isolated sandbox computer desktop and browser session.",
    permission: "write",
    maxCallsPerTurn: 1,
    input: z.object({}),
    label: () => "격리된 클라우드 컴퓨터 데스크톱 기동 중",
    execute: async () => {
      const res = await callComputerApi("/session/start");
      return { status: "running", message: "컴퓨터 세션이 준비되었습니다.", currentUrl: res.currentUrl };
    },
  }),

  defineTool({
    name: "computer_navigate",
    description: "Navigate the sandbox web browser to a URL. Launches the session automatically if not already running.",
    permission: "write",
    maxCallsPerTurn: 5,
    input: z.object({
      url: z.string().min(1).describe("The URL to visit (e.g. https://ko.wikipedia.org)"),
    }),
    label: (i) => `웹 브라우저에서 “${i.url}” 방문 중`,
    execute: async (i) => {
      // Auto-start session if needed
      await callComputerApi("/session/start");
      const result = await callComputerApi("/action", { action: "navigate", url: i.url });
      return {
        url: result.url,
        title: result.title,
        textSnippet: result.textSnippet?.slice(0, 1000),
      };
    },
  }),

  defineTool({
    name: "computer_click",
    description: "Click an element by element reference id (e.g. '@e1'), CSS selector, or (x, y) coordinates.",
    permission: "write",
    maxCallsPerTurn: 5,
    input: z.object({
      ref: z.string().optional().describe("Element reference from page state/snapshot (e.g. '@e1')"),
      selector: z.string().optional().describe("CSS selector of element to click (e.g. 'button.submit')"),
      x: z.number().optional().describe("X coordinate to click"),
      y: z.number().optional().describe("Y coordinate to click"),
    }),
    label: (i) => `화면 클릭 중 (${i.ref || i.selector || `${i.x}, ${i.y}`})`,
    execute: async (i) => {
      const result = await callComputerApi("/action", { action: "click", ...i });
      return {
        url: result.url,
        title: result.title,
        textSnippet: result.textSnippet?.slice(0, 800),
        interactiveElements: result.interactiveElements?.slice(0, 1200),
      };
    },
  }),

  defineTool({
    name: "computer_type",
    description: "Type text into an input element (by ref or selector) or active focus area.",
    permission: "write",
    maxCallsPerTurn: 5,
    input: z.object({
      text: z.string().describe("Text to type"),
      ref: z.string().optional().describe("Element reference id (e.g. '@e2')"),
      selector: z.string().optional().describe("Target input element selector"),
    }),
    label: (i) => `텍스트 “${i.text.slice(0, 30)}” 입력 중`,
    execute: async (i) => {
      const result = await callComputerApi("/action", { action: "type", ...i });
      return {
        url: result.url,
        title: result.title,
        textSnippet: result.textSnippet?.slice(0, 800),
        interactiveElements: result.interactiveElements?.slice(0, 1200),
      };
    },
  }),

  defineTool({
    name: "computer_key",
    description: "Press a special key (e.g. 'Enter', 'Escape', 'Tab', 'Backspace', 'ArrowDown').",
    permission: "write",
    maxCallsPerTurn: 5,
    input: z.object({
      key: z.string().describe("Key name to press (e.g. 'Enter')"),
    }),
    label: (i) => `키보드 키 [${i.key}] 입력 중`,
    execute: async (i) => {
      const result = await callComputerApi("/action", { action: "key", key: i.key });
      return {
        url: result.url,
        title: result.title,
        textSnippet: result.textSnippet?.slice(0, 800),
      };
    },
  }),

  defineTool({
    name: "computer_scroll",
    description: "Scroll the page up or down.",
    permission: "write",
    maxCallsPerTurn: 5,
    input: z.object({
      direction: z.enum(["up", "down"]).default("down"),
      amount: z.number().optional().default(400),
    }),
    label: (i) => `화면 스크롤 (${i.direction === "down" ? "아래로" : "위로"})`,
    execute: async (i) => {
      const result = await callComputerApi("/action", { action: "scroll", ...i });
      return {
        url: result.url,
        title: result.title,
        textSnippet: result.textSnippet?.slice(0, 800),
      };
    },
  }),

  defineTool({
    name: "computer_get_state",
    description: "Inspect the current browser state, URL, page title, and visible text content.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({}),
    label: () => "현재 컴퓨터 화면 및 웹페이지 내용 확인 중",
    execute: async () => {
      const result = await callComputerApi("/action", { action: "get_state", includeScreenshot: false });
      return {
        url: result.url,
        title: result.title,
        content: result.textSnippet,
        interactiveElements: result.interactiveElements?.slice(0, 1500),
      };
    },
  }),

  defineTool({
    name: "computer_stop",
    description: "Stop the computer session and clean up the container after completing the task.",
    permission: "write",
    maxCallsPerTurn: 1,
    input: z.object({}),
    label: () => "컴퓨터 세션 종료 및 자원 정리 중",
    execute: async () => {
      await callComputerApi("/session/stop");
      return { stopped: true, message: "컴퓨터 세션이 종료되었습니다." };
    },
  }),
];
