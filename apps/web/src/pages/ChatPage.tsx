import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ChatMessage, Conversation, ToolActivity } from "@talorys/shared";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  CheckCircle2,
  Copy,
  History,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Square,
  Trash2,
  XCircle,
} from "lucide-react";
import { ApprovalCard } from "../components/ApprovalCard";
import { ChatUsage } from "../components/ChatUsage";
import { Markdown } from "../components/Markdown";
import { Button, ConfirmDialog, Dialog, Input, Spinner } from "../components/ui";
import { Logo } from "../components/Logo";
import { keys, useApiMutation, useConversation, useConversations, useSettings } from "../hooks/queries";
import { api, ApiError, streamChat } from "../lib/api";
import { cn, copyText, relativeTime } from "../lib/utils";

interface StreamState {
  conversationId: string | null;
  userText: string;
  assistantId: string | null;
  text: string;
  tools: ToolActivity[];
  error: string | null;
  done: boolean;
}

const SUGGESTIONS = [
  "What should I work on today?",
  "Add a task to review my project tomorrow",
  "Remember that I prefer short answers",
  "Every Friday at 5pm, remind me to plan next week",
];

export function ChatPage() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const settings = useSettings();
  const conversation = useConversation(conversationId);
  const [stream, setStream] = useState<StreamState | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const messages = conversation.data?.messages ?? [];
  const streaming = !!stream && !stream.done;
  // The local stream may belong to a conversation the owner navigated away from; only render it in its own.
  const streamHere = stream && stream.conversationId === (conversationId ?? null) ? stream : null;
  // A reply generating server-side that this page isn't streaming (started before a reload or in another tab).
  const remoteStreaming = !streamHere && !!conversation.data?.streaming;

  // Reset transient stream state when switching conversations (unless it belongs to the new one).
  useEffect(() => {
    setStream((s) => (s && s.conversationId === (conversationId ?? null) ? s : streaming ? s : null));
    stickToBottom.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, stream?.text, stream?.tools.length, stream?.error]);

  async function send(text: string, opts: { retry?: boolean } = {}) {
    if (streaming) return;
    const controller = new AbortController();
    abortRef.current = controller;
    stickToBottom.current = true;
    let convId = conversationId ?? null;
    if (opts.retry && convId) {
      // Optimistically hide the failed reply that the server is about to replace.
      qc.setQueryData<{ conversation: Conversation; messages: ChatMessage[] }>(keys.conversation(convId), (old) =>
        old ? { ...old, messages: old.messages.filter((m) => !(m.role === "assistant" && m.status !== "complete" && m === old.messages.at(-1))) } : old,
      );
    }
    setStream({ conversationId: convId, userText: opts.retry ? "" : text, assistantId: null, text: "", tools: [], error: null, done: false });
    try {
      await streamChat(
        { conversation_id: convId ?? undefined, message: opts.retry ? "retry" : text, retry: opts.retry },
        (event) => {
          switch (event.type) {
            case "title":
              void qc.invalidateQueries({ queryKey: ["conversations"] });
              break;
            case "start":
              if (!convId) {
                convId = event.conversation_id;
                navigate(`/chat/${convId}`, { replace: true });
              }
              setStream((s) => s && { ...s, conversationId: event.conversation_id, assistantId: event.assistant_message_id });
              break;
            case "text":
              setStream((s) => s && { ...s, text: s.text + event.delta });
              break;
            case "tool":
              setStream((s) => {
                if (!s) return s;
                const tools = s.tools.some((t) => t.id === event.tool.id)
                  ? s.tools.map((t) => (t.id === event.tool.id ? event.tool : t))
                  : [...s.tools, event.tool];
                return { ...s, tools };
              });
              break;
            case "error":
              setStream((s) => s && { ...s, error: event.message });
              break;
            case "done": {
              const id = event.message.conversation_id;
              void qc
                .invalidateQueries({ queryKey: keys.conversation(id) })
                .then(() => setStream((s) => (s && s.assistantId === event.message.id ? null : s)));
              setStream((s) => s && { ...s, done: true });
              break;
            }
          }
        },
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        setStream((s) => s && { ...s, done: true });
      } else {
        const message = error instanceof ApiError || error instanceof Error ? error.message : "Connection lost.";
        setStream((s) => s && { ...s, error: message, done: true });
      }
    } finally {
      abortRef.current = null;
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void qc.invalidateQueries({ queryKey: keys.usage });
      if (convId) void qc.invalidateQueries({ queryKey: keys.conversation(convId) });
      // Drop the transient bubble once persisted messages are back.
      setTimeout(() => setStream((s) => (s?.done ? null : s)), 400);
    }
  }

  function stop() {
    const convId = stream?.conversationId ?? (remoteStreaming ? conversationId : null);
    abortRef.current?.abort();
    if (convId) void api("/chat/cancel", { method: "POST", body: { conversation_id: convId } }).catch(() => {});
  }

  const lastFailed = useMemo(() => {
    const last = messages.at(-1);
    return last && last.role === "assistant" && last.status === "error" ? last : null;
  }, [messages]);

  const showEmpty = !conversationId && !streamHere;

  return (
    <div className="flex h-full">
      <aside className="hidden w-72 shrink-0 flex-col border-r border-border lg:flex">
        <ConversationList activeId={conversationId} onNavigate={() => {}} />
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          conversation={conversation.data?.conversation}
          onOpenHistory={() => setHistoryOpen(true)}
          onNew={() => navigate("/chat")}
        />

        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="scrollbar-thin min-h-0 flex-1 overflow-y-auto"
        >
          {showEmpty ? (
            <EmptyChat name={settings.data?.agentName ?? "Talorys"} onPick={(s) => void send(s)} />
          ) : conversation.isLoading && !streamHere ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : conversation.isError && !streamHere ? (
            <div className="p-8 text-center text-sm text-fg-muted">This conversation could not be loaded.</div>
          ) : (
            <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 md:px-6">
              {messages.map((m) =>
                stream && stream.assistantId === m.id ? null : (
                  <MessageView
                    key={m.id}
                    message={m}
                    onRetry={lastFailed?.id === m.id && !streaming && !remoteStreaming ? () => void send("", { retry: true }) : undefined}
                  />
                ),
              )}
              {streamHere && (
                <>
                  {streamHere.userText && !messages.some((m) => m.role === "user" && m.content === streamHere.userText && streamHere.done) && (
                    <UserBubble text={streamHere.userText} />
                  )}
                  <AssistantBubble
                    text={streamHere.text}
                    tools={streamHere.tools}
                    error={streamHere.error}
                    streaming={!streamHere.done}
                    onRetry={streamHere.error && streamHere.done && conversationId ? () => void send("", { retry: true }) : undefined}
                  />
                </>
              )}
              {remoteStreaming && <AssistantBubble text="" tools={[]} error={null} streaming />}
            </div>
          )}
        </div>

        <Composer streaming={streaming || remoteStreaming} onSend={(t) => void send(t)} onStop={stop} autoFocus={showEmpty} />
      </section>

      <Dialog open={historyOpen} onClose={() => setHistoryOpen(false)} title="Conversations">
        <div className="-mx-5 -my-4 h-[60vh]">
          <ConversationList activeId={conversationId} onNavigate={() => setHistoryOpen(false)} />
        </div>
      </Dialog>
    </div>
  );
}

function ChatHeader({
  conversation,
  onOpenHistory,
  onNew,
}: {
  conversation?: Conversation;
  onOpenHistory: () => void;
  onNew: () => void;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3 md:px-4">
      <div className="flex min-w-0 items-center gap-1">
        <button type="button" onClick={onOpenHistory} className="rounded-lg p-2 text-fg-muted hover:bg-muted lg:hidden" aria-label="Conversation history">
          <History className="h-[18px] w-[18px]" />
        </button>
        <h2 className="truncate text-sm font-medium text-fg">{conversation?.title ?? "New conversation"}</h2>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <ChatUsage />
        <Button variant="ghost" size="sm" onClick={onNew}>
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">New chat</span>
        </Button>
      </div>
    </div>
  );
}

function EmptyChat({ name, onPick }: { name: string; onPick: (s: string) => void }) {
  const recent = useConversations();
  const navigate = useNavigate();
  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  })();
  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-5 py-10 animate-fade-in">
      <div className="flex items-center gap-3 text-fg-muted">
        <Logo className="h-8 w-8" />
        <span className="text-sm font-medium">{name}</span>
      </div>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight text-fg md:text-4xl">{greeting}.</h1>
      <p className="mt-2 text-lg text-fg-muted">What would you like to do today?</p>
      <div className="mt-8 grid gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button type="button"
            key={s}
            onClick={() => onPick(s)}
            className="rounded-xl border border-border bg-surface px-4 py-3 text-left text-sm text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
          >
            {s}
          </button>
        ))}
      </div>
      {!!recent.data?.length && (
        <div className="mt-10">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">Recent conversations</h3>
          <ul className="space-y-0.5">
            {recent.data.slice(0, 4).map((c) => (
              <li key={c.id}>
                <button type="button"
                  onClick={() => navigate(`/chat/${c.id}`)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left text-sm text-fg-muted hover:bg-muted hover:text-fg"
                >
                  <span className="truncate">{c.title}</span>
                  <span className="shrink-0 text-xs text-fg-subtle">{relativeTime(c.updated_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ConversationList({ activeId, onNavigate }: { activeId?: string; onNavigate: () => void }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const list = useConversations(debounced || undefined);
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [title, setTitle] = useState("");

  const rename = useApiMutation(
    (v: { id: string; title: string }) => api(`/conversations/${v.id}`, { method: "PATCH", body: { title: v.title } }),
    { invalidate: [["conversations"], ["conversation"]], onSuccess: () => setRenaming(null) },
  );
  const remove = useApiMutation((id: string) => api(`/conversations/${id}`, { method: "DELETE" }), {
    invalidate: [["conversations"]],
    success: "Conversation deleted",
    onSuccess: (_r, id) => {
      setDeleting(null);
      if (id === activeId) navigate("/chat");
    },
  });

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 p-3">
        <Button
          variant="outline"
          className="w-full justify-start"
          onClick={() => {
            navigate("/chat");
            onNavigate();
          }}
        >
          <Plus className="h-4 w-4" /> New conversation
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search history" className="h-9 pl-9 text-sm" aria-label="Search conversations" />
        </div>
      </div>
      <nav className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Conversations">
        {list.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : !list.data?.length ? (
          <p className="px-3 py-6 text-center text-sm text-fg-subtle">{debounced ? "No matches." : "No conversations yet."}</p>
        ) : (
          <ul className="space-y-0.5">
            {list.data.map((c) => (
              <li key={c.id} className="group relative">
                <button type="button"
                  onClick={() => {
                    navigate(`/chat/${c.id}`);
                    onNavigate();
                  }}
                  className={cn(
                    "flex w-full flex-col rounded-lg px-3 py-2 pr-9 text-left transition-colors",
                    c.id === activeId ? "bg-muted text-fg" : "text-fg-muted hover:bg-muted/60 hover:text-fg",
                  )}
                >
                  <span className="truncate text-sm">{c.title}</span>
                  <span className="text-xs text-fg-subtle">{relativeTime(c.updated_at)}</span>
                </button>
                <button type="button"
                  onClick={() => setMenu(menu === c.id ? null : c.id)}
                  className="absolute right-1.5 top-2 rounded-md p-1 text-fg-subtle opacity-100 hover:bg-border hover:text-fg md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
                  aria-label={`Options for ${c.title}`}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {menu === c.id && (
                  <div className="absolute right-1 top-9 z-10 w-36 rounded-lg border border-border bg-surface py-1 shadow-lg animate-fade-in" onMouseLeave={() => setMenu(null)}>
                    <button type="button"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted"
                      onClick={() => {
                        setTitle(c.title);
                        setRenaming(c);
                        setMenu(null);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" /> Rename
                    </button>
                    <button type="button"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-danger hover:bg-danger-soft"
                      onClick={() => {
                        setDeleting(c);
                        setMenu(null);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </nav>

      <Dialog
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title="Rename conversation"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => renaming && title.trim() && rename.mutate({ id: renaming.id, title: title.trim() })}
              loading={rename.isPending}
            >
              Save
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (renaming && title.trim()) rename.mutate({ id: renaming.id, title: title.trim() });
          }}
        >
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus aria-label="Title" />
        </form>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        title="Delete conversation?"
        message={`“${deleting?.title}” and all its messages will be permanently deleted.`}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        loading={remove.isPending}
      />
    </div>
  );
}

function MessageView({ message, onRetry }: { message: ChatMessage; onRetry?: () => void }) {
  if (message.role === "user") return <UserBubble text={message.content} />;
  return (
    <AssistantBubble
      text={message.content}
      tools={message.tools}
      error={message.status === "error" ? message.error : null}
      cancelled={message.status === "cancelled"}
      streaming={false}
      onRetry={onRetry}
    />
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end animate-fade-in">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-[15px] leading-6 text-fg">{text}</div>
    </div>
  );
}

function ToolChip({ tool }: { tool: ToolActivity }) {
  return (
    <span
      title={tool.error}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
        tool.status === "error" ? "border-danger/30 bg-danger-soft text-danger" : "border-border bg-subtle text-fg-muted",
      )}
    >
      {tool.status === "running" ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      ) : tool.status === "success" ? (
        <CheckCircle2 className="h-3 w-3 shrink-0 text-success" />
      ) : (
        <XCircle className="h-3 w-3 shrink-0" />
      )}
      <span className="truncate">{tool.label}</span>
    </span>
  );
}

function AssistantBubble({
  text,
  tools,
  error,
  streaming,
  cancelled,
  onRetry,
}: {
  text: string;
  tools: ToolActivity[];
  error: string | null;
  streaming: boolean;
  cancelled?: boolean;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group flex gap-3 animate-fade-in">
      <Logo className="mt-0.5 h-6 w-6 shrink-0" />
      <div className="min-w-0 flex-1 space-y-2.5">
        {tools.length > 0 && (
          <div role="group" className="flex flex-wrap gap-1.5" aria-label="Actions taken">
            {tools.map((t) => (
              <ToolChip key={t.id} tool={t} />
            ))}
          </div>
        )}
        {tools.map((t) => t.approval && <ApprovalCard key={t.approval.id} action={t.approval} />)}
        {text ? (
          <Markdown content={text} />
        ) : streaming && tools.every((t) => t.status !== "running") ? (
          <div role="status" className="flex h-7 items-center gap-1" aria-label="Thinking">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-subtle" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-subtle [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-subtle [animation-delay:300ms]" />
          </div>
        ) : null}
        {cancelled && <p className="text-xs text-fg-subtle">Stopped.</p>}
        {error && (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="flex-1">{error}</span>
            {onRetry && (
              <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline">
                <RotateCcw className="h-3.5 w-3.5" /> Retry
              </button>
            )}
          </div>
        )}
        {!streaming && text && (
          <div className="flex gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
            <button type="button"
              onClick={() =>
                void copyText(text).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-fg-subtle hover:bg-muted hover:text-fg"
              aria-label="Copy response"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({ streaming, onSend, onStop, autoFocus }: { streaming: boolean; onSend: (t: string) => void; onStop: () => void; autoFocus?: boolean }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  function submit() {
    const text = value.trim();
    if (!text || streaming) return;
    onSend(text);
    setValue("");
  }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="shrink-0 border-t border-border bg-bg px-3 pb-[calc(env(safe-area-inset-bottom)+4.5rem)] pt-3 md:px-6 md:pb-5">
      <div className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border border-border bg-surface p-2 shadow-sm focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus={autoFocus}
          maxLength={16000}
          placeholder="Ask Talorys anything…"
          aria-label="Message"
          className="max-h-[200px] min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-6 placeholder:text-fg-subtle focus:outline-none"
        />
        {streaming ? (
          <Button variant="secondary" size="icon" onClick={onStop} aria-label="Stop generating" className="rounded-xl">
            <Square className="h-3.5 w-3.5 fill-current" />
          </Button>
        ) : (
          <Button size="icon" onClick={submit} disabled={!value.trim()} aria-label="Send message" className="rounded-xl">
            <ArrowUp className="h-4 w-4" />
          </Button>
        )}
      </div>
      <p className="mx-auto mt-2 hidden max-w-3xl text-center text-[11px] text-fg-subtle md:block">
        Runs on your Cloudflare account. Talorys can make mistakes — check important details.
      </p>
    </div>
  );
}
