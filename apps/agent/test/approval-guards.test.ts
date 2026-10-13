import { describe, expect, it } from "vitest";
import { inAgent, loggedIn, proposeAction } from "./helpers";
import { ALL_TOOLS, ToolExecutor } from "../src/tools";
import type { Services } from "../src/services/container";

const approve = async (id: string) => (await (await loggedIn()).json(`/api/actions/${id}/approve`, { method: "POST", body: {} })).action;

function chatExecutor(s: Services) {
  const conversation = s.conversations.create();
  return new ToolExecutor(ALL_TOOLS, { services: s, timezone: "UTC", mode: "chat", conversationId: conversation.id }, { maxToolCalls: 8 });
}

describe("approvals are bound to what the owner saw", () => {
  it("refuses an approval when the target changed after the proposal", async () => {
    const { changedId, changedNote, keptId, keptTask } = await inAgent(async (a) => {
      const s = a.services;
      const note = s.notes.create({ title: "Packing list", content: "tent, stove" });
      const changedId = await proposeAction(s, "delete_note", { id: note.id });
      // Edited in another tab (or by an import) before the owner clicks Approve.
      s.notes.update(note.id, { content: "passport, visa, tickets" });
      // Positive control: a target whose shown fields are unchanged is still deleted, even if it was completed meanwhile.
      const task = s.tasks.create({ title: "Return library books" });
      const keptId = await proposeAction(s, "delete_task", { task: task.id });
      s.tasks.complete(task.id);
      return { changedId, changedNote: note.id, keptId, keptTask: task.id };
    });
    const refused = await approve(changedId);
    expect(refused).toMatchObject({ status: "failed" });
    expect(refused.error).toContain("changed after it was proposed");
    expect((await approve(keptId)).status).toBe("approved");
    await inAgent((a) => {
      expect(a.services.notes.get(changedNote)?.content).toBe("passport, visa, tickets");
      expect(a.services.tasks.get(keptTask)).toBeNull();
    });
  });

  it("never approves a proposal stored without a target version", async () => {
    const { actionId, taskId } = await inAgent((a) => {
      const s = a.services;
      const task = s.tasks.create({ title: "Legacy proposal" });
      const action = s.pendingActions.create({
        conversation_id: s.conversations.create().id, tool: "delete_task", target_id: task.id, target_version: null, summary: "Delete task", payload: null,
      });
      return { actionId: action.id, taskId: task.id };
    });
    expect((await approve(actionId)).status).toBe("failed");
    await inAgent((a) => expect(a.services.tasks.get(taskId)?.title).toBe("Legacy proposal"));
  });
});

describe("the agent cannot erase notes or memories on its own", () => {
  it("update_note only renames and appends; replacing text waits for approval", async () => {
    const { noteId, actionId } = await inAgent(async (a) => {
      const s = a.services;
      const note = s.notes.create({ title: "Trip", content: "Day 1: hike" });
      const ex = chatExecutor(s);
      await expect(ex.execute("update_note", { id: note.id, content: "" })).rejects.toThrow(/Invalid input/);
      await expect(ex.execute("update_note", { id: note.id, append: "" })).rejects.toThrow(/Invalid input/);
      await ex.execute("update_note", { id: note.id, title: "Trip plan", append: "Day 2: lake" });
      expect(s.notes.get(note.id)).toMatchObject({ title: "Trip plan", content: "Day 1: hike\n\nDay 2: lake" });

      await expect(ex.execute("replace_note_content", { id: note.id, content: "" })).rejects.toThrow(/Invalid input/);
      expect(await ex.execute("replace_note_content", { id: note.id, content: "Cancelled" }, "rw")).toMatchObject({ status: "awaiting_owner_approval" });
      // The card gets the exact new text, not just a size.
      expect(ex.approvalFor("rw")).toMatchObject({ summary: "Rewrite note “Trip plan” (24 → 9 characters)", preview: "Cancelled" });
      expect(s.pendingActions.view(ex.approvalFor("rw")!.id)?.preview).toBe("Cancelled");
      expect(s.notes.get(note.id)?.content).toBe("Day 1: hike\n\nDay 2: lake");
      return { noteId: note.id, actionId: ex.approvalFor("rw")!.id };
    });
    expect((await approve(actionId)).status).toBe("approved");
    await inAgent((a) => expect(a.services.notes.get(noteId)?.content).toBe("Cancelled"));
  });

  it("update_memory keeps the old wording as a past fact", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      const old = s.memories.create({ content: "Drives a red Corolla", category: "fact", source: "manual" });
      const result = (await chatExecutor(s).execute("update_memory", { id: old.id, content: "Drives a blue Civic" })) as {
        updated: { id: string; content: string };
        previous_kept_as_history: string;
      };
      expect(result.updated.content).toBe("Drives a blue Civic");
      expect(result.updated.id).not.toBe(old.id);
      expect(result.previous_kept_as_history).toBe(old.id);
      expect(s.memories.get(old.id)).toMatchObject({ content: "Drives a red Corolla", status: "historical", superseded_by: result.updated.id });
      expect(s.memories.get(result.updated.id)).toMatchObject({ source: "agent", status: "active" });
    });
  });
});
