import type { ToolActivity } from "@talorys/shared";
import { describe, expect, it } from "vitest";
import { chatAlertFor, failedTurnAlert } from "../src/lib/chatAlerts";

describe("failedTurnAlert", () => {
  it("links to the conversation the turn failed in", () => {
    expect(failedTurnAlert("c1", "Connection lost.")).toEqual({ kind: "failed", body: "Connection lost.", url: "/chat/c1", tag: "chat-c1" });
  });

  it("works when the failure came before a conversation existed, or gave no reason", () => {
    expect(failedTurnAlert(null, null)).toEqual({ kind: "failed", body: "", url: "/chat", tag: "chat-new" });
  });
});

const message = (over: Partial<Parameters<typeof chatAlertFor>[0]> = {}) => ({
  conversation_id: "c1",
  content: "Done.",
  status: "complete" as const,
  error: null,
  tools: [] as ToolActivity[],
  ...over,
});
const tool = (extra: object) => ({ id: "t", name: "x", label: "x", status: "success", ...extra }) as ToolActivity;

describe("chatAlertFor", () => {
  it("announces a finished reply and links to its conversation", () => {
    expect(chatAlertFor(message({ content: "**Call** the [dentist](https://x.test)\n\n`now`" }))).toEqual({
      kind: "reply", body: "Call the dentist now", url: "/chat/c1", tag: "chat-c1",
    });
  });

  it("shortens a long reply", () => {
    const body = chatAlertFor(message({ content: "a".repeat(500) }))!.body;
    expect(body).toHaveLength(140);
    expect(body.endsWith("…")).toBe(true);
  });

  it("asks for the owner when an approval or a plan is pending", () => {
    expect(chatAlertFor(message({ tools: [tool({ approval: { status: "pending" } })] }))?.kind).toBe("needs-you");
    expect(chatAlertFor(message({ tools: [tool({ plan: { status: "pending" } })] }))?.kind).toBe("needs-you");
  });

  it("treats an already settled approval as a plain reply", () => {
    expect(chatAlertFor(message({ tools: [tool({ approval: { status: "approved" } })] }))?.kind).toBe("reply");
  });

  it("reports a failed turn, and stays quiet about one the owner stopped", () => {
    expect(chatAlertFor(message({ status: "error", error: "Limit reached" }))).toMatchObject({ kind: "failed", body: "Limit reached" });
    expect(chatAlertFor(message({ status: "cancelled" }))).toBeNull();
  });
});
