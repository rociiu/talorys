import { type ChatStreamEvent, chatRequestSchema, conversationCreateSchema, conversationUpdateSchema, taskPlanSubmitSchema } from "@talorys/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import { body, query } from "../middleware";
import { AppError, NotFoundError } from "../errors";
import { ALL_TOOLS, runApprovedAction } from "../../tools";

export const chatRoutes = new Hono<AppEnv>();

chatRoutes.get("/conversations", (c) => {
  const { q } = query(c, z.object({ q: z.string().max(200).optional() }));
  return c.json({ conversations: c.env.agent.services.conversations.list({ q }) });
});

chatRoutes.post("/conversations", async (c) => {
  const { title } = await body(c, conversationCreateSchema);
  return c.json({ conversation: c.env.agent.services.conversations.create(title || "New conversation") }, 201);
});

chatRoutes.get("/conversations/:id", (c) => {
  const s = c.env.agent.services;
  const conversation = s.conversations.require(c.req.param("id"));
  const { summary: _s, summary_upto: _u, ...rest } = conversation;
  return c.json({
    conversation: rest,
    messages: s.taskPlans.withCurrentState(s.pendingActions.withCurrentStatus(s.conversations.messages(conversation.id))),
    streaming: c.env.agent.activeRuns.has(conversation.id),
  });
});

chatRoutes.patch("/conversations/:id", async (c) => {
  const { title } = await body(c, conversationUpdateSchema);
  const { summary: _s, summary_upto: _u, ...rest } = c.env.agent.services.conversations.rename(c.req.param("id"), title);
  return c.json({ conversation: rest });
});

chatRoutes.delete("/conversations/:id", (c) => {
  const id = c.req.param("id");
  c.env.agent.activeRuns.get(id)?.abort();
  c.env.agent.services.conversations.delete(id);
  return c.json({ deleted: true });
});

chatRoutes.delete("/conversations", async (c) => {
  await body(c, z.object({ confirm: z.literal("DELETE") }));
  for (const controller of c.env.agent.activeRuns.values()) controller.abort();
  const deleted = c.env.agent.services.conversations.deleteAll();
  c.env.agent.services.activity.record("privacy.history_cleared", `Deleted ${deleted} conversation(s)`);
  return c.json({ deleted });
});

/**
 * Streams one agent turn as Server-Sent Events. The stream is produced inside the
 * Durable Object and passes unbuffered through the Worker and the Pages Function.
 */
chatRoutes.post("/chat", async (c) => {
  const input = await body(c, chatRequestSchema, 64 * 1024);
  const agent = c.env.agent;
  if (input.conversation_id && agent.activeRuns.has(input.conversation_id)) {
    throw new AppError("CONFLICT", "A response is already being generated in this conversation.");
  }
  const controller = new AbortController();
  // Claim the conversation now, before any await, so a concurrent request sees the conflict.
  if (input.conversation_id) agent.activeRuns.set(input.conversation_id, controller);
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let clientGone = false;

  const send = async (event: ChatStreamEvent) => {
    if (clientGone) return;
    try {
      await writer.write(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
    } catch {
      // The browser disconnected: stop generating to save AI usage.
      clientGone = true;
      controller.abort();
    }
  };

  const run = async () => {
    let conversationId: string | undefined = input.conversation_id;
    try {
      await writer.write(encoder.encode(`: stream open\n\n`));
      for await (const event of agent.runner().chat({
        conversationId: input.conversation_id,
        message: input.message,
        retry: input.retry,
        signal: controller.signal,
      })) {
        if (event.type === "start") {
          conversationId = event.conversation_id;
          agent.activeRuns.set(conversationId, controller);
        }
        await send(event);
      }
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError("INTERNAL_ERROR", "Something went wrong.");
      if (!(error instanceof AppError)) console.error("Chat turn failed", error);
      await send({ type: "error", code: appError.code, message: appError.message });
    } finally {
      if (conversationId && agent.activeRuns.get(conversationId) === controller) agent.activeRuns.delete(conversationId);
      try {
        await writer.close();
      } catch {
        /* already closed */
      }
    }
  };
  // The Durable Object stays alive while the response stream is open.
  void run();

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
});

chatRoutes.post("/chat/cancel", async (c) => {
  const { conversation_id } = await body(c, z.object({ conversation_id: z.string().min(1).max(64) }));
  const controller = c.env.agent.activeRuns.get(conversation_id);
  controller?.abort();
  return c.json({ cancelled: !!controller });
});

/** Owner approval of a destructive action the agent proposed. The agent has no way to call this. */
chatRoutes.post("/actions/:id/approve", async (c) => {
  const s = c.env.agent.services;
  const action = await runApprovedAction(ALL_TOOLS, { services: s, timezone: s.settings.get().timezone, mode: "chat" }, c.req.param("id"));
  return c.json({ action });
});

chatRoutes.post("/actions/:id/cancel", (c) => {
  const pending = c.env.agent.services.pendingActions;
  const id = c.req.param("id");
  if (!pending.get(id)) throw new NotFoundError("This action no longer exists.");
  pending.resolve(id, "cancelled");
  return c.json({ action: pending.view(id) });
});

/**
 * Task plans the agent proposed. Only these owner-facing routes can turn a plan into tasks;
 * every call names the conversation the plan was proposed in.
 */
chatRoutes.get("/conversations/:cid/task-plans/:id", (c) => {
  return c.json({ plan: c.env.agent.services.taskPlans.require(c.req.param("cid"), c.req.param("id")) });
});

chatRoutes.patch("/conversations/:cid/task-plans/:id", async (c) => {
  const { revision, plan } = await body(c, taskPlanSubmitSchema, 64 * 1024);
  return c.json({ plan: c.env.agent.services.taskPlans.update(c.req.param("cid"), c.req.param("id"), revision, plan) });
});

chatRoutes.post("/conversations/:cid/task-plans/:id/confirm", async (c) => {
  const { revision, plan } = await body(c, taskPlanSubmitSchema, 64 * 1024);
  const s = c.env.agent.services;
  const result = s.taskPlans.confirm(c.req.param("cid"), c.req.param("id"), revision, plan, s.settings.get().timezone);
  return c.json({ plan: result.draft, replayed: result.replayed });
});

chatRoutes.post("/conversations/:cid/task-plans/:id/cancel", (c) => {
  return c.json({ plan: c.env.agent.services.taskPlans.cancel(c.req.param("cid"), c.req.param("id")) });
});
