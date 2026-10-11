import http from "node:http";
import net from "node:net";
import { URL } from "node:url";
import { computerState } from "./state";
import {
  navigate,
  click,
  typeText,
  pressKey,
  scroll,
  takeScreenshot,
  getComputerState,
  xdotool,
} from "./automation";
import { VNC_PORT } from "./container";

export const COMPUTER_SERVICE_PORT = 28789;

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-csrf-token",
  });
  res.end(JSON.stringify(data));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Proxy HTTP request to KasmVNC */
function proxyVncHttp(req: http.IncomingMessage, res: http.ServerResponse, vncPath: string) {
  const targetPath = !vncPath || vncPath === "/" ? "/index.html" : vncPath;
  const authHeader = req.headers.authorization || `Basic ${Buffer.from("computer:vncpass").toString("base64")}`;

  const options: http.RequestOptions = {
    hostname: "127.0.0.1",
    port: VNC_PORT,
    path: targetPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${VNC_PORT}`,
      authorization: authHeader,
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (err) => {
    console.error("[VNC Proxy Error]", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("KasmVNC is not available yet. Please start session first.");
    }
  });

  req.pipe(proxyReq, { end: true });
}

const authCache = new Map<string, { ok: boolean; exp: number }>();

async function isRequestAuthenticated(req: http.IncomingMessage): Promise<boolean> {
  const cookie = req.headers.cookie;
  if (!cookie) return false;
  const tokenMatch = cookie.match(/(?:^|;\s*)(?:__Host-)?talorys_session=([^;]+)/);
  if (!tokenMatch || !tokenMatch[1] || !tokenMatch[1].trim()) return false;
  const token = tokenMatch[1].trim();

  const cached = authCache.get(token);
  if (cached && cached.exp > Date.now()) {
    return cached.ok;
  }

  try {
    const res = await fetch("http://127.0.0.1:28788/api/auth/session", {
      headers: {
        cookie: req.headers.cookie || "",
        host: "talorys.wasuphj.app",
      },
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const json = await res.json() as any;
      const isAuthed = json?.authenticated === true;
      authCache.set(token, { ok: isAuthed, exp: Date.now() + 30_000 });
      return isAuthed;
    }
  } catch {}
  return false;
}

export function createComputerServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const rawUrl = req.url || "/";
    const parsedUrl = new URL(rawUrl, `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;

    // Security check: Directory traversal attempt
    if (rawUrl.includes("..") || pathname.includes("etc/passwd") || pathname.includes("../")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: Directory traversal rejected." }));
      return;
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-csrf-token",
      });
      res.end();
      return;
    }

    try {
      // VNC Proxy route (/vnc or /vnc/...) - Requires valid Talorys session
      if (pathname === "/vnc" || pathname.startsWith("/vnc/")) {
        const authed = await isRequestAuthenticated(req);
        if (!authed) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Valid Talorys session required to access computer stream." }));
          return;
        }

        const vncPath = pathname.replace(/^\/vnc/, "") + parsedUrl.search;
        return proxyVncHttp(req, res, vncPath || "/");
      }

      // API Routes
      if (req.method === "POST" && pathname === "/session/start") {
        const info = await computerState.start();
        return sendJson(res, 200, { ok: true, session: info });
      }

      if (req.method === "POST" && pathname === "/session/stop") {
        await computerState.stop();
        return sendJson(res, 200, { ok: true, session: computerState.getInfo() });
      }

      if (req.method === "POST" && pathname === "/session/pause") {
        const info = await (computerState as any).pause();
        return sendJson(res, 200, { ok: true, session: info });
      }

      if (req.method === "POST" && pathname === "/session/resume") {
        const result = await (computerState as any).resume();
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (req.method === "POST" && pathname === "/session/complete") {
        const info = await (computerState as any).complete();
        return sendJson(res, 200, { ok: true, session: info });
      }

      if (req.method === "GET" && pathname === "/session/status") {
        return sendJson(res, 200, { ok: true, session: computerState.getInfo() });
      }

      if (req.method === "POST" && pathname === "/session/take-control") {
        const info = await computerState.takeControl();
        return sendJson(res, 200, { ok: true, session: info });
      }

      if (req.method === "POST" && pathname === "/session/return-control") {
        const result = await computerState.returnControl();
        return sendJson(res, 200, { ok: true, ...result });
      }

      // AI Action route
      if (req.method === "POST" && pathname === "/action") {
        if (!computerState.isRunning()) {
          return sendJson(res, 400, { error: "Computer session is not running. Launch it first." });
        }

        // Lock check: AI cannot act while user has manual control or paused
        if (computerState.getMode() === "user_controlling" || (computerState as any).getStatus() === "paused") {
          return sendJson(res, 409, {
            error: "Computer is currently under manual user control. AI execution is paused.",
            mode: "user_controlling",
          });
        }

        let body: any;
        try {
          body = await readBody(req);
        } catch (err: any) {
          return sendJson(res, 400, { error: err?.message || "Invalid JSON body" });
        }

        const { action } = body;
        if (!action) {
          return sendJson(res, 400, { error: "Action parameter is required." });
        }

        let actionSignal: AbortSignal;
        try {
          actionSignal = computerState.beginAction();
        } catch (lockErr: any) {
          if (lockErr?.message?.includes("ACTION_IN_PROGRESS_LOCKED")) {
            return sendJson(res, 409, {
              error: "An action is already in progress. Concurrent actions are locked.",
              mode: computerState.getMode(),
            });
          }
          return sendJson(res, 409, {
            error: "Computer is currently under manual user control. AI execution is paused.",
            mode: "user_controlling",
          });
        }

        let result: any;

        try {
          switch (action) {
            case "navigate":
              if (!body.url || typeof body.url !== "string") {
                return sendJson(res, 400, { error: "Missing or invalid url for navigate" });
              }
              result = await navigate(body.url, actionSignal);
              computerState.logAction("navigate", { url: body.url }, `Navigated to ${body.url}`, result.screenshotBase64);
              computerState.updatePageInfo(result.url, result.title);
              break;
            case "click":
              if (
                !body.ref &&
                !body.selector &&
                (typeof body.x !== "number" || typeof body.y !== "number" || isNaN(body.x) || isNaN(body.y) || !isFinite(body.x) || !isFinite(body.y))
              ) {
                return sendJson(res, 400, { error: "Must provide ref, selector, or valid (x, y) coordinates for click." });
              }
              result = await click({ selector: body.selector, ref: body.ref, x: body.x, y: body.y }, actionSignal);
              computerState.logAction("click", body, `Clicked ${body.ref || body.selector || `(${body.x}, ${body.y})`}`, result.screenshotBase64);
              computerState.updatePageInfo(result.url, result.title);
              break;
            case "type":
              if (typeof body.text !== "string") {
                return sendJson(res, 400, { error: "Missing or invalid text for type action" });
              }
              result = await typeText(body.text, body.ref || body.selector, actionSignal);
              computerState.logAction("type", { text: body.text, target: body.ref || body.selector }, `Typed "${body.text}"`, result.screenshotBase64);
              computerState.updatePageInfo(result.url, result.title);
              break;
            case "key":
              if (!body.key || typeof body.key !== "string") {
                return sendJson(res, 400, { error: "Missing or invalid key for key action" });
              }
              result = await pressKey(body.key, actionSignal);
              computerState.logAction("key", { key: body.key }, `Pressed key ${body.key}`, result.screenshotBase64);
              computerState.updatePageInfo(result.url, result.title);
              break;
            case "scroll": {
              const dir = body.direction || "down";
              if (!["up", "down", "left", "right"].includes(dir)) {
                return sendJson(res, 400, { error: `Invalid scroll direction: ${dir}` });
              }
              result = await scroll(dir, body.amount ?? 400, actionSignal);
              computerState.logAction("scroll", body, `Scrolled ${dir}`, result.screenshotBase64);
              break;
            }
            case "screenshot": {
              const shot = await takeScreenshot();
              result = { screenshotBase64: shot };
              break;
            }
            case "get_state":
              result = await getComputerState(body.includeScreenshot ?? true);
              computerState.updatePageInfo(result.url, result.title);
              break;
            case "xdotool": {
              const out = await xdotool(body.args || []);
              result = { stdout: out };
              computerState.logAction("xdotool", body.args, out);
              break;
            }
            default:
              return sendJson(res, 400, { error: `Unknown action: ${action}` });
          }

          return sendJson(res, 200, { ok: true, result });
        } catch (actionErr: any) {
          if (actionSignal.aborted || actionErr?.message?.includes("ABORTED")) {
            return sendJson(res, 409, {
              error: "AI action was safely aborted because user took control.",
              mode: "user_controlling",
            });
          }
          throw actionErr;
        } finally {
          computerState.endAction();
        }
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      console.error("[ComputerServer Error]", error);
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Handle WebSocket Upgrade for KasmVNC streaming
  server.on("upgrade", (req, clientSocket, head) => {
    const targetSocket = net.connect(VNC_PORT, "127.0.0.1", () => {
      // Forward HTTP upgrade headers to KasmVNC
      const upgradeHeaders = { ...req.headers };
      if (!upgradeHeaders.authorization) {
        upgradeHeaders.authorization = `Basic ${Buffer.from("computer:vncpass").toString("base64")}`;
      }
      upgradeHeaders.host = `127.0.0.1:${VNC_PORT}`;

      let reqStr = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (const [key, val] of Object.entries(upgradeHeaders)) {
        if (Array.isArray(val)) {
          for (const v of val) reqStr += `${key}: ${v}\r\n`;
        } else if (val !== undefined) {
          reqStr += `${key}: ${val}\r\n`;
        }
      }
      reqStr += "\r\n";

      targetSocket.write(reqStr);
      if (head && head.length > 0) targetSocket.write(head);

      // Pipe sockets together
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
    });

    targetSocket.on("error", (err) => {
      console.error("[VNC WS Error]", err.message);
      clientSocket.destroy();
    });

    clientSocket.on("error", () => {
      targetSocket.destroy();
    });
  });

  return server;
}

// Standalone runner when executed directly
if (
  process.argv[1]?.endsWith("server.ts") ||
  process.argv[1]?.endsWith("server.js") ||
  process.argv[1]?.endsWith("server.mjs")
) {
  const server = createComputerServer();
  server.listen(COMPUTER_SERVICE_PORT, "127.0.0.1", () => {
    console.log(`[ComputerManager] Running on http://127.0.0.1:${COMPUTER_SERVICE_PORT}`);
  });
}
