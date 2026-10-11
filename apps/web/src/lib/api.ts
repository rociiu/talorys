import { CSRF_HEADER, type ApiErrorBody, type ApiErrorCode, type ChatStreamEvent } from "@talorys/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> = {};
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    /* non-JSON error */
  }
  const code = body.error?.code ?? (res.status === 401 ? "UNAUTHORIZED" : "INTERNAL_ERROR");
  const message = body.error?.message ?? (res.status >= 500 ? "Talorys 서비스를 일시적으로 사용할 수 없습니다." : `요청에 실패했습니다 (${res.status})`);
  return new ApiError(res.status, code, message, body.error?.details);
}

/** Same-origin JSON API call. Cookies carry the session; the custom header defeats CSRF. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: {
      [CSRF_HEADER]: "1",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  });
  if (!res.ok) {
    const error = await toApiError(res);
    if (res.status === 401 && !path.startsWith("/auth/")) for (const fn of unauthorizedListeners) fn();
    throw error;
  }
  return (await res.json()) as T;
}

/**
 * POSTs a chat message and consumes the Server-Sent Events response incrementally.
 */
export async function streamChat(
  payload: { conversation_id?: string; message: string; retry?: boolean },
  onEvent: (event: ChatStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    credentials: "same-origin",
    headers: { [CSRF_HEADER]: "1", "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok || !res.body) {
    const error = await toApiError(res);
    if (res.status === 401) for (const fn of unauthorizedListeners) fn();
    throw error;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as ChatStreamEvent);
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}
