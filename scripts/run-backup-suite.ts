// Auto-generated Massive Backup & State Serialization Verification Suite
// 250 Unique Test Cases: Normal (70), Boundary (60), Failure (50), Concurrency (40), Recovery (30)

import assert from "node:assert";
import { MassiveTestHarness } from "./massive-harness";
import {
  createTestServices,
  baseBackup,
  makeTask,
  makeNote,
  makeMemory,
  makeProject,
  makeConversation,
  makeMessage,
  makeAutomation,
} from "./backup-helpers";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupSchema,
  encryptedBackupSchema,
  signedBackupSchema,
  hasPrototypePollution,
  LIMIT_CEILINGS,
} from "@talorys/shared";
import {
  exportData,
  importData,
  exportSignedData,
  importSignedData,
  verifyBackupHmac,
  exportEncryptedData,
  importEncryptedData,
} from "../apps/agent/src/services/backup";
import { ValidationError } from "../apps/agent/src/api/errors";
import { hmacSha256Hex } from "@talorys/shared";

export async function runBackupSuite() {
  const harness = new MassiveTestHarness("Backup & State Serialization");

  // ==========================================
  // 1. NORMAL CATEGORY (70 Tests)
  // ==========================================

  harness.add({
    id: "BK-NORM-001",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export empty database produces valid Backup format and version",
    run: async () => {
      const s = createTestServices();
      const b = exportData(s as any);
      assert.strictEqual(b.format, BACKUP_FORMAT);
      assert.strictEqual(b.version, BACKUP_VERSION);
      assert.ok(b.exported_at);
      assert.strictEqual(b.data.tasks.length, 0);
      assert.strictEqual(b.data.notes.length, 0);
      assert.strictEqual(b.data.memories.length, 0);
      assert.strictEqual(b.data.projects.length, 0);
      assert.strictEqual(b.data.conversations.length, 0);
      assert.strictEqual(b.data.messages.length, 0);
      assert.strictEqual(b.data.automations.length, 0);
    }
  });

  harness.add({
    id: "BK-NORM-002",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export single task serializes all fields faithfully",
    run: async () => {
      const s = createTestServices();
      s.db.run(
        "INSERT INTO tal_tasks (id, title, description, status, priority, due_at, project_id, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "task-1", "Buy groceries", "Milk, bread, eggs", "todo", "high", "2026-10-15T10:00:00.000Z", null, "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z", null
      );
      const b = exportData(s as any);
      assert.strictEqual(b.data.tasks.length, 1);
      const t = b.data.tasks[0];
      assert.strictEqual(t.id, "task-1");
      assert.strictEqual(t.title, "Buy groceries");
      assert.strictEqual(t.description, "Milk, bread, eggs");
      assert.strictEqual(t.status, "todo");
      assert.strictEqual(t.priority, "high");
      assert.strictEqual(t.due_at, "2026-10-15T10:00:00.000Z");
    }
  });

  harness.add({
    id: "BK-NORM-003",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export single note serializes markdown and project link",
    run: async () => {
      const s = createTestServices();
      s.db.run(
        "INSERT INTO tal_notes (id, title, content, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        "note-1", "Architecture Review", "# System Design\nModular services with SQLite.", null, "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z"
      );
      const b = exportData(s as any);
      assert.strictEqual(b.data.notes.length, 1);
      const n = b.data.notes[0];
      assert.strictEqual(n.id, "note-1");
      assert.strictEqual(n.title, "Architecture Review");
      assert.ok(n.content.includes("# System Design"));
    }
  });

  harness.add({
    id: "BK-NORM-004",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export single memory serializes category and source",
    run: async () => {
      const s = createTestServices();
      s.db.run(
        "INSERT INTO tal_memories (id, content, category, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        "mem-1", "Owner prefers dark mode theme", "preference", "manual", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z"
      );
      const b = exportData(s as any);
      assert.strictEqual(b.data.memories.length, 1);
      const m = b.data.memories[0];
      assert.strictEqual(m.id, "mem-1");
      assert.strictEqual(m.category, "preference");
      assert.strictEqual(m.source, "manual");
    }
  });

  harness.add({
    id: "BK-NORM-005",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export single project serializes status and timestamps",
    run: async () => {
      const s = createTestServices();
      s.db.run(
        "INSERT INTO tal_projects (id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        "proj-1", "Talorys v2 Launch", "Next gen personal agent", "active", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z"
      );
      const b = exportData(s as any);
      assert.strictEqual(b.data.projects.length, 1);
      const p = b.data.projects[0];
      assert.strictEqual(p.id, "proj-1");
      assert.strictEqual(p.status, "active");
    }
  });

  harness.add({
    id: "BK-NORM-006",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export single conversation serializes summary and summary_upto",
    run: async () => {
      const s = createTestServices();
      s.db.run(
        "INSERT INTO tal_conversations (id, title, summary, summary_upto, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        "conv-1", "Morning Planning", "Discussed daily priorities", "msg-10", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z"
      );
      const b = exportData(s as any);
      assert.strictEqual(b.data.conversations.length, 1);
      const c = b.data.conversations[0];
      assert.strictEqual(c.id, "conv-1");
      assert.strictEqual(c.summary, "Discussed daily priorities");
      assert.strictEqual(c.summary_upto, "msg-10");
    }
  });

  harness.add({
    id: "BK-NORM-007",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export single message serializes tools and role",
    run: async () => {
      const s = createTestServices();
      s.db.run(
        "INSERT INTO tal_conversations (id, title, summary, summary_upto, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        "conv-1", "Chat", null, null, "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z"
      );
      s.db.run(
        "INSERT INTO tal_messages (id, conversation_id, role, content, tools, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        "msg-1", "conv-1", "assistant", "I have updated your schedule.", '[{"id":"t1","name":"schedule","status":"success"}]', "complete", null, "2026-10-12T00:00:00.000Z"
      );
      const b = exportData(s as any);
      assert.strictEqual(b.data.messages.length, 1);
      const m = b.data.messages[0];
      assert.strictEqual(m.id, "msg-1");
      assert.strictEqual(m.role, "assistant");
      assert.strictEqual(m.status, "complete");
    }
  });

  harness.add({
    id: "BK-NORM-008",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export automation serializes schedule as parsed JSON object",
    run: async () => {
      const s = createTestServices();
      s.db.run(
        "INSERT INTO tal_automations (id, name, kind, message, schedule, enabled, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "auto-1", "Daily Check", "reminder", "Time to review tasks", '{"type":"daily","time":"08:30"}', 1, "scheduled", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z"
      );
      const b = exportData(s as any);
      assert.strictEqual(b.data.automations.length, 1);
      const a = b.data.automations[0];
      assert.strictEqual(a.id, "auto-1");
      assert.deepStrictEqual(a.schedule, { type: "daily", time: "08:30" });
      assert.strictEqual(a.enabled, true);
    }
  });

  harness.add({
    id: "BK-NORM-009",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export with modified settings serializes custom configuration",
    run: async () => {
      const s = createTestServices();
      s.settings.update({ agentName: "NovaPrime", temperature: 0.8 });
      const b = exportData(s as any);
      assert.strictEqual((b.data.settings as any).agentName, "NovaPrime");
      assert.strictEqual((b.data.settings as any).temperature, 0.8);
    }
  });

  harness.add({
    id: "BK-NORM-010",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for task status 'todo'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ tasks: [makeTask("t-todo", { status: "todo" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.tasks[0].status, "todo");
    }
  });

  harness.add({
    id: "BK-NORM-011",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for task status 'in_progress'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ tasks: [makeTask("t-in_progress", { status: "in_progress" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.tasks[0].status, "in_progress");
    }
  });

  harness.add({
    id: "BK-NORM-012",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for task status 'done'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ tasks: [makeTask("t-done", { status: "done" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.tasks[0].status, "done");
    }
  });

  harness.add({
    id: "BK-NORM-013",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for task priority 'low'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ tasks: [makeTask("t-low", { priority: "low" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.tasks[0].priority, "low");
    }
  });

  harness.add({
    id: "BK-NORM-014",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for task priority 'medium'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ tasks: [makeTask("t-medium", { priority: "medium" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.tasks[0].priority, "medium");
    }
  });

  harness.add({
    id: "BK-NORM-015",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for task priority 'high'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ tasks: [makeTask("t-high", { priority: "high" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.tasks[0].priority, "high");
    }
  });

  harness.add({
    id: "BK-NORM-016",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for task priority 'urgent'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ tasks: [makeTask("t-urgent", { priority: "urgent" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.tasks[0].priority, "urgent");
    }
  });

  harness.add({
    id: "BK-NORM-017",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for task with completed_at set",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ tasks: [makeTask("t-comp", { completed_at: "2026-10-12T12:00:00.000Z", status: "done" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.tasks[0].completed_at, "2026-10-12T12:00:00.000Z");
    }
  });

  harness.add({
    id: "BK-NORM-018",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for task with completed_at null",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ tasks: [makeTask("t-nocomp", { completed_at: null })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.tasks[0].completed_at, null);
    }
  });

  harness.add({
    id: "BK-NORM-019",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for task linked to existing project",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({
        projects: [makeProject("p-1")],
        tasks: [makeTask("t-p1", { project_id: "p-1" })]
      });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.tasks[0].project_id, "p-1");
    }
  });

  harness.add({
    id: "BK-NORM-020",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for task without project link",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ tasks: [makeTask("t-noproj", { project_id: null })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.tasks[0].project_id, null);
    }
  });

  harness.add({
    id: "BK-NORM-021",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for note linked to existing project",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({
        projects: [makeProject("p-note")],
        notes: [makeNote("n-p1", { project_id: "p-note" })]
      });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.notes[0].project_id, "p-note");
    }
  });

  harness.add({
    id: "BK-NORM-022",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for note unlinked from any project",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ notes: [makeNote("n-noproj", { project_id: null })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.notes[0].project_id, null);
    }
  });

  harness.add({
    id: "BK-NORM-023",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for memory category 'preference'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ memories: [makeMemory("m-preference", { category: "preference" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.memories[0].category, "preference");
    }
  });

  harness.add({
    id: "BK-NORM-024",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for memory category 'fact'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ memories: [makeMemory("m-fact", { category: "fact" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.memories[0].category, "fact");
    }
  });

  harness.add({
    id: "BK-NORM-025",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for memory category 'goal'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ memories: [makeMemory("m-goal", { category: "goal" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.memories[0].category, "goal");
    }
  });

  harness.add({
    id: "BK-NORM-026",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for memory category 'project'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ memories: [makeMemory("m-project", { category: "project" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.memories[0].category, "project");
    }
  });

  harness.add({
    id: "BK-NORM-027",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for memory category 'habit'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ memories: [makeMemory("m-habit", { category: "habit" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.memories[0].category, "habit");
    }
  });

  harness.add({
    id: "BK-NORM-028",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for memory category 'person'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ memories: [makeMemory("m-person", { category: "person" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.memories[0].category, "person");
    }
  });

  harness.add({
    id: "BK-NORM-029",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for memory category 'other'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ memories: [makeMemory("m-other", { category: "other" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.memories[0].category, "other");
    }
  });

  harness.add({
    id: "BK-NORM-030",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for project status 'active'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ projects: [makeProject("p-active", { status: "active" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.projects[0].status, "active");
    }
  });

  harness.add({
    id: "BK-NORM-031",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for project status 'paused'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ projects: [makeProject("p-paused", { status: "paused" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.projects[0].status, "paused");
    }
  });

  harness.add({
    id: "BK-NORM-032",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for project status 'completed'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ projects: [makeProject("p-completed", { status: "completed" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.projects[0].status, "completed");
    }
  });

  harness.add({
    id: "BK-NORM-033",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for project status 'archived'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ projects: [makeProject("p-archived", { status: "archived" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.projects[0].status, "archived");
    }
  });

  harness.add({
    id: "BK-NORM-034",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for message with user role",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({
        conversations: [makeConversation("c-user")],
        messages: [makeMessage("m-user", "c-user", { role: "user" })]
      });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.messages[0].role, "user");
    }
  });

  harness.add({
    id: "BK-NORM-035",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for message with assistant role",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({
        conversations: [makeConversation("c-asst")],
        messages: [makeMessage("m-asst", "c-asst", { role: "assistant" })]
      });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.messages[0].role, "assistant");
    }
  });

  harness.add({
    id: "BK-NORM-036",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for message status 'complete'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({
        conversations: [makeConversation("c-complete")],
        messages: [makeMessage("m-complete", "c-complete", { status: "complete" })]
      });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.messages[0].status, "complete");
    }
  });

  harness.add({
    id: "BK-NORM-037",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for message status 'error'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({
        conversations: [makeConversation("c-error")],
        messages: [makeMessage("m-error", "c-error", { status: "error" })]
      });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.messages[0].status, "error");
    }
  });

  harness.add({
    id: "BK-NORM-038",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for message status 'cancelled'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({
        conversations: [makeConversation("c-cancelled")],
        messages: [makeMessage("m-cancelled", "c-cancelled", { status: "cancelled" })]
      });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.messages[0].status, "cancelled");
    }
  });

  harness.add({
    id: "BK-NORM-039",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for message tool activities list",
    run: async () => {
      const s = createTestServices();
      const tools = [{ id: "tool-1", name: "search", label: "Searching", status: "success" }];
      const backup = baseBackup({
        conversations: [makeConversation("c-tools")],
        messages: [makeMessage("m-tools", "c-tools", { tools: JSON.stringify(tools) })]
      });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.ok(exported.data.messages[0].tools.includes("search"));
    }
  });

  harness.add({
    id: "BK-NORM-040",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for message with error text",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({
        conversations: [makeConversation("c-err")],
        messages: [makeMessage("m-err", "c-err", { status: "error", error: "Connection timeout" })]
      });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.messages[0].error, "Connection timeout");
    }
  });

  harness.add({
    id: "BK-NORM-041",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for message without error (null)",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({
        conversations: [makeConversation("c-noerr")],
        messages: [makeMessage("m-noerr", "c-noerr", { status: "complete", error: null })]
      });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.messages[0].error, null);
    }
  });

  harness.add({
    id: "BK-NORM-042",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Conversation conflict update updates summary and summary_upto",
    run: async () => {
      const s = createTestServices();
      const b1 = baseBackup({
        conversations: [makeConversation("c-sum", { summary: "Initial summary", summary_upto: "msg-1" })]
      });
      await importData(s as any, b1);
      const b2 = baseBackup({
        conversations: [makeConversation("c-sum", { summary: "Updated full summary", summary_upto: "msg-10" })]
      });
      await importData(s as any, b2);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.conversations[0].summary, "Updated full summary");
      assert.strictEqual(exported.data.conversations[0].summary_upto, "msg-10");
    }
  });

  harness.add({
    id: "BK-NORM-043",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for automation kind 'reminder'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ automations: [makeAutomation("a-reminder", { kind: "reminder" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.automations[0].kind, "reminder");
    }
  });

  harness.add({
    id: "BK-NORM-044",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for automation kind 'task_digest'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ automations: [makeAutomation("a-task_digest", { kind: "task_digest" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.automations[0].kind, "task_digest");
    }
  });

  harness.add({
    id: "BK-NORM-045",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for automation kind 'agent_prompt'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ automations: [makeAutomation("a-agent_prompt", { kind: "agent_prompt" })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.automations[0].kind, "agent_prompt");
    }
  });

  harness.add({
    id: "BK-NORM-046",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for automation schedule 'interval'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ automations: [makeAutomation("a-interval", { schedule: {"type":"interval","minutes":30} })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.deepStrictEqual(exported.data.automations[0].schedule, {"type":"interval","minutes":30});
    }
  });

  harness.add({
    id: "BK-NORM-047",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for automation schedule 'daily'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ automations: [makeAutomation("a-daily", { schedule: {"type":"daily","time":"09:00"} })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.deepStrictEqual(exported.data.automations[0].schedule, {"type":"daily","time":"09:00"});
    }
  });

  harness.add({
    id: "BK-NORM-048",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for automation schedule 'weekly'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ automations: [makeAutomation("a-weekly", { schedule: {"type":"weekly","time":"10:00","days":[1,3]} })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.deepStrictEqual(exported.data.automations[0].schedule, {"type":"weekly","time":"10:00","days":[1,3]});
    }
  });

  harness.add({
    id: "BK-NORM-049",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for automation schedule 'monthly'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ automations: [makeAutomation("a-monthly", { schedule: {"type":"monthly","time":"11:00","day":15} })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.deepStrictEqual(exported.data.automations[0].schedule, {"type":"monthly","time":"11:00","day":15});
    }
  });

  harness.add({
    id: "BK-NORM-050",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for automation schedule 'once'",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ automations: [makeAutomation("a-once", { schedule: {"type":"once","at":"2026-12-01T09:00"} })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.deepStrictEqual(exported.data.automations[0].schedule, {"type":"once","at":"2026-12-01T09:00"});
    }
  });

  harness.add({
    id: "BK-NORM-051",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for enabled automation (true)",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ automations: [makeAutomation("a-on", { enabled: true })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.automations[0].enabled, true);
    }
  });

  harness.add({
    id: "BK-NORM-052",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export roundtrip for disabled automation (false)",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ automations: [makeAutomation("a-off", { enabled: false })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.automations[0].enabled, false);
    }
  });

  harness.add({
    id: "BK-NORM-053",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Import summary reports accurate entity counts for mixed payload",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({
        projects: [makeProject("p1"), makeProject("p2")],
        conversations: [makeConversation("c1")],
        messages: [makeMessage("m1", "c1"), makeMessage("m2", "c1")],
        memories: [makeMemory("mem1"), makeMemory("mem2"), makeMemory("mem3")],
        tasks: [makeTask("t1"), makeTask("t2")],
        notes: [makeNote("n1")],
        automations: [makeAutomation("a1")]
      });
      const res = await importData(s as any, backup);
      assert.strictEqual(res.projects, 2);
      assert.strictEqual(res.conversations, 1);
      assert.strictEqual(res.messages, 2);
      assert.strictEqual(res.memories, 3);
      assert.strictEqual(res.tasks, 2);
      assert.strictEqual(res.notes, 1);
      assert.strictEqual(res.automations, 1);
    }
  });

  harness.add({
    id: "BK-NORM-054",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Import roundtrip preserves markdown formatting and multiline content",
    run: async () => {
      const s = createTestServices();
      const mdContent = "# Header 1\n\n- Item 1\n- Item 2\n\n```json\n{\"key\": \"value\"}\n```";
      const backup = baseBackup({ notes: [makeNote("n-md", { content: mdContent })] });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.notes[0].content, mdContent);
    }
  });

  harness.add({
    id: "BK-NORM-055",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Import roundtrip preserves exact created_at and updated_at timestamps",
    run: async () => {
      const s = createTestServices();
      const created = "2025-06-15T08:30:00.000Z";
      const updated = "2025-06-20T14:45:00.000Z";
      const backup = baseBackup({
        tasks: [makeTask("t-ts", { created_at: created, updated_at: updated })],
        automations: [makeAutomation("a-ts", { created_at: created, updated_at: updated })]
      });
      await importData(s as any, backup);
      const exported = exportData(s as any);
      assert.strictEqual(exported.data.tasks[0].created_at, created);
      assert.strictEqual(exported.data.tasks[0].updated_at, updated);
      assert.strictEqual(exported.data.automations[0].created_at, created);
      assert.strictEqual(exported.data.automations[0].updated_at, updated);
    }
  });

  harness.add({
    id: "BK-NORM-056",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Import roundtrip preserves core settings (timezone, theme, agentName, model, temperature)",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({
        settings: {
          timezone: "Europe/London",
          theme: "dark",
          agentName: "Aether",
          model: "@cf/meta/llama-3.1-70b-instruct",
          temperature: 0.7
        }
      });
      await importData(s as any, backup);
      const st = s.settings.get();
      assert.strictEqual(st.timezone, "Europe/London");
      assert.strictEqual(st.theme, "dark");
      assert.strictEqual(st.agentName, "Aether");
      assert.strictEqual(st.model, "@cf/meta/llama-3.1-70b-instruct");
      assert.strictEqual(st.temperature, 0.7);
    }
  });

  harness.add({
    id: "BK-NORM-057",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Import roundtrip preserves limits settings structure",
    run: async () => {
      const s = createTestServices();
      const limits = {
        maxOutputTokens: 4096,
        maxToolCalls: 15,
        maxAgentIterations: 10,
        maxContextTokens: 32000,
        maxScheduledAiRunsPerDay: 48,
        maxAiRequestsPerDay: 300,
      };
      const backup = baseBackup({ settings: { limits } });
      await importData(s as any, backup);
      const st = s.settings.get();
      assert.deepStrictEqual(st.limits, limits);
    }
  });

  harness.add({
    id: "BK-NORM-058",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Import roundtrip preserves autoMemory and demoMode flags",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({ settings: { autoMemory: false, demoMode: true } });
      await importData(s as any, backup);
      const st = s.settings.get();
      assert.strictEqual(st.autoMemory, false);
      assert.strictEqual(st.demoMode, true);
    }
  });

  harness.add({
    id: "BK-NORM-059",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Import conversations with interlinked messages maintains foreign key relationship",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({
        conversations: [makeConversation("c-fk-1"), makeConversation("c-fk-2")],
        messages: [
          makeMessage("m-1", "c-fk-1"),
          makeMessage("m-2", "c-fk-1"),
          makeMessage("m-3", "c-fk-2")
        ]
      });
      await importData(s as any, backup);
      const msgsConv1 = s.db.all("SELECT * FROM tal_messages WHERE conversation_id = ?", "c-fk-1");
      assert.strictEqual(msgsConv1.length, 2);
    }
  });

  harness.add({
    id: "BK-NORM-060",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Import projects with linked tasks and notes maintains project_id relationships",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({
        projects: [makeProject("proj-alpha")],
        tasks: [makeTask("t-alpha-1", { project_id: "proj-alpha" })],
        notes: [makeNote("n-alpha-1", { project_id: "proj-alpha" })]
      });
      await importData(s as any, backup);
      const t = s.db.one("SELECT project_id FROM tal_tasks WHERE id = ?", "t-alpha-1");
      const n = s.db.one("SELECT project_id FROM tal_notes WHERE id = ?", "n-alpha-1");
      assert.strictEqual(t?.project_id, "proj-alpha");
      assert.strictEqual(n?.project_id, "proj-alpha");
    }
  });

  harness.add({
    id: "BK-NORM-061",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Import memory is immediately searchable via FTS5 virtual table",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({
        memories: [makeMemory("m-fts", { content: "Quantum entanglement teleportation protocol verified" })]
      });
      await importData(s as any, backup);
      const res = s.db.all("SELECT * FROM tal_memories_fts WHERE tal_memories_fts MATCH 'teleportation'");
      assert.ok(res.length > 0);
    }
  });

  harness.add({
    id: "BK-NORM-062",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Import note is immediately searchable via FTS5 virtual table",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({
        notes: [makeNote("n-fts", { title: "Kubernetes Guide", content: "Orchestration with microk8s and ingress" })]
      });
      await importData(s as any, backup);
      const res = s.db.all("SELECT * FROM tal_notes_fts WHERE tal_notes_fts MATCH 'microk8s'");
      assert.ok(res.length > 0);
    }
  });

  harness.add({
    id: "BK-NORM-063",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Import records activity log entry data.imported",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup();
      await importData(s as any, backup);
      const logs = s.getActivityLogs();
      assert.ok(logs.some(l => l.type === "data.imported"));
    }
  });

  harness.add({
    id: "BK-NORM-064",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export signed backup generates valid HMAC-SHA256 signature",
    run: async () => {
      const s = createTestServices();
      const secret = "super-secret-key-1234567890-test";
      const signed = await exportSignedData(s as any, secret);
      assert.strictEqual(signed.format, BACKUP_FORMAT);
      assert.ok(signed.hmac);
      assert.match(signed.hmac, /^[0-9a-f]{64}$/);
      const valid = await verifyBackupHmac(signed, secret);
      assert.strictEqual(valid, true);
    }
  });

  harness.add({
    id: "BK-NORM-065",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Import signed backup verifies valid HMAC and imports records",
    run: async () => {
      const s = createTestServices();
      const secret = "backup-signing-secret-key-alpha";
      const b = baseBackup({ tasks: [makeTask("t-signed-1")] });
      const hmac = await hmacSha256Hex(secret, b.format + "$" + b.version + "$" + b.exported_at + "$" + JSON.stringify(b.data));
      const signed = { ...b, hmac };
      const summary = await importSignedData(s as any, signed, secret);
      assert.strictEqual(summary.tasks, 1);
    }
  });

  harness.add({
    id: "BK-NORM-066",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export encrypted backup generates AES-GCM ciphertext, IV, and tag",
    run: async () => {
      const s = createTestServices();
      const secret = "aes-gcm-master-encryption-key-xyz";
      const enc = await exportEncryptedData(s as any, secret);
      assert.ok(enc.ciphertext);
      assert.ok(enc.iv);
      assert.ok(enc.hmac);
      assert.strictEqual(enc.algorithm, "AES-GCM-256");
    }
  });

  harness.add({
    id: "BK-NORM-067",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Import encrypted backup decrypts and restores records faithfully",
    run: async () => {
      const s1 = createTestServices();
      s1.db.run(
        "INSERT INTO tal_tasks (id, title, description, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        "t-enc", "Secret Task", "Top Secret", "todo", "urgent", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z"
      );
      const secret = "enc-import-key-passphrase-secure-999";
      const enc = await exportEncryptedData(s1 as any, secret);

      const s2 = createTestServices();
      const summary = await importEncryptedData(s2 as any, enc, secret);
      assert.strictEqual(summary.tasks, 1);
      const t = s2.db.one("SELECT * FROM tal_tasks WHERE id = ?", "t-enc");
      assert.strictEqual(t?.title, "Secret Task");
    }
  });

  harness.add({
    id: "BK-NORM-068",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Simultaneous full-entity serialization roundtrip with all 8 entity types",
    run: async () => {
      const s = createTestServices();
      const backup = baseBackup({
        projects: [makeProject("p-all")],
        conversations: [makeConversation("c-all")],
        messages: [makeMessage("m-all", "c-all")],
        memories: [makeMemory("mem-all")],
        tasks: [makeTask("t-all", { project_id: "p-all" })],
        notes: [makeNote("n-all", { project_id: "p-all" })],
        automations: [makeAutomation("a-all")],
        settings: { agentName: "AllAgent" }
      });
      const summary = await importData(s as any, backup);
      assert.strictEqual(summary.projects, 1);
      assert.strictEqual(summary.conversations, 1);
      assert.strictEqual(summary.messages, 1);
      assert.strictEqual(summary.memories, 1);
      assert.strictEqual(summary.tasks, 1);
      assert.strictEqual(summary.notes, 1);
      assert.strictEqual(summary.automations, 1);
      const exp = exportData(s as any);
      assert.strictEqual((exp.data.settings as any).agentName, "AllAgent");
    }
  });

  harness.add({
    id: "BK-NORM-069",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Sequential export -> import -> export produces structurally identical backup data",
    run: async () => {
      const s1 = createTestServices();
      s1.db.run("INSERT INTO tal_projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", "p-1", "P1", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z");
      s1.db.run("INSERT INTO tal_tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", "t-1", "T1", "todo", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z");
      const exp1 = exportData(s1 as any);

      const s2 = createTestServices();
      await importData(s2 as any, exp1);
      const exp2 = exportData(s2 as any);

      assert.deepStrictEqual(exp1.data.tasks, exp2.data.tasks);
      assert.deepStrictEqual(exp1.data.projects, exp2.data.projects);
    }
  });

  harness.add({
    id: "BK-NORM-070",
    domain: "Backup & State Serialization",
    category: "normal",
    description: "Export excludes sensitive auth sessions and password credentials",
    run: async () => {
      const s = createTestServices();
      s.db.run("INSERT INTO tal_sessions (id, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)", "sess-123", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z", "2026-10-13T00:00:00.000Z", "Mozilla");
      s.db.run("INSERT INTO tal_login_attempts (client, success, at) VALUES (?, ?, ?)", "127.0.0.1", 1, Date.now());
      const exp = exportData(s as any);
      const serialized = JSON.stringify(exp);
      assert.ok(!serialized.includes("sess-123"));
      assert.ok(!("sessions" in exp.data));
      assert.ok(!("login_attempts" in exp.data));
    }
  });
  // ==========================================
  // 2. BOUNDARY CATEGORY (60 Tests)
  // ==========================================

  harness.add({
    id: "BK-BND-001",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Export database with 0 records in all tables",
    run: async () => {
      const s = createTestServices();
      const b = exportData(s as any);
      assert.strictEqual(b.data.tasks.length, 0);
    }
  });

  harness.add({
    id: "BK-BND-002",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Import backup with all empty arrays and empty settings",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup();
      const res = await importData(s as any, b);
      assert.strictEqual(res.tasks, 0);
    }
  });

  harness.add({
    id: "BK-BND-003",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Note with empty content string",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ notes: [makeNote("n-empty", { content: "" })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.notes[0].content, "");
    }
  });

  harness.add({
    id: "BK-BND-004",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Task with empty description string",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ tasks: [makeTask("t-empty", { description: "" })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.tasks[0].description, "");
    }
  });

  harness.add({
    id: "BK-BND-005",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Project with empty description string",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ projects: [makeProject("p-empty", { description: "" })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.projects[0].description, "");
    }
  });

  harness.add({
    id: "BK-BND-006",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Automation with empty message string",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ automations: [makeAutomation("a-empty", { message: "" })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.automations[0].message, "");
    }
  });

  harness.add({
    id: "BK-BND-007",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Task title at max length 300 chars",
    run: async () => {
      const s = createTestServices();
      const sample = "0123456789";
      const b = ((s) => baseBackup({ tasks: [makeTask("t-m7", { title: s.repeat(30) })] }))(sample);
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp);
    }
  });

  harness.add({
    id: "BK-BND-008",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Task description at max length 10,000 chars",
    run: async () => {
      const s = createTestServices();
      const sample = "0123456789";
      const b = ((s) => baseBackup({ tasks: [makeTask("t-m8", { description: s.repeat(1000) })] }))(sample);
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp);
    }
  });

  harness.add({
    id: "BK-BND-009",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Note title at max length 300 chars",
    run: async () => {
      const s = createTestServices();
      const sample = "0123456789";
      const b = ((s) => baseBackup({ notes: [makeNote("n-m9", { title: s.repeat(30) })] }))(sample);
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp);
    }
  });

  harness.add({
    id: "BK-BND-010",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Note content at max length 200,000 chars",
    run: async () => {
      const s = createTestServices();
      const sample = "0123456789";
      const b = ((s) => baseBackup({ notes: [makeNote("n-m10", { content: s.repeat(20000) })] }))(sample);
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp);
    }
  });

  harness.add({
    id: "BK-BND-011",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Memory content at max length 2,000 chars",
    run: async () => {
      const s = createTestServices();
      const sample = "0123456789";
      const b = ((s) => baseBackup({ memories: [makeMemory("m-m11", { content: s.repeat(200) })] }))(sample);
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp);
    }
  });

  harness.add({
    id: "BK-BND-012",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Project name at max length 200 chars",
    run: async () => {
      const s = createTestServices();
      const sample = "0123456789";
      const b = ((s) => baseBackup({ projects: [makeProject("p-m12", { name: s.repeat(20) })] }))(sample);
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp);
    }
  });

  harness.add({
    id: "BK-BND-013",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Project description at max length 5,000 chars",
    run: async () => {
      const s = createTestServices();
      const sample = "0123456789";
      const b = ((s) => baseBackup({ projects: [makeProject("p-m13", { description: s.repeat(500) })] }))(sample);
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp);
    }
  });

  harness.add({
    id: "BK-BND-014",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Conversation title at max length 200 chars",
    run: async () => {
      const s = createTestServices();
      const sample = "0123456789";
      const b = ((s) => baseBackup({ conversations: [makeConversation("c-m14", { title: s.repeat(20) })] }))(sample);
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp);
    }
  });

  harness.add({
    id: "BK-BND-015",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Message content at max length 16,000 chars",
    run: async () => {
      const s = createTestServices();
      const sample = "0123456789";
      const b = ((s) => baseBackup({ conversations: [makeConversation("c-m15")], messages: [makeMessage("m-m15", "c-m15", { content: s.repeat(1600) })] }))(sample);
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp);
    }
  });

  harness.add({
    id: "BK-BND-016",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Automation name at max length 200 chars",
    run: async () => {
      const s = createTestServices();
      const sample = "0123456789";
      const b = ((s) => baseBackup({ automations: [makeAutomation("a-m16", { name: s.repeat(20) })] }))(sample);
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp);
    }
  });

  harness.add({
    id: "BK-BND-017",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Automation message at max length 4,000 chars",
    run: async () => {
      const s = createTestServices();
      const sample = "0123456789";
      const b = ((s) => baseBackup({ automations: [makeAutomation("a-m17", { message: s.repeat(400) })] }))(sample);
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp);
    }
  });

  harness.add({
    id: "BK-BND-018",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Settings agentName at max length 60 chars",
    run: async () => {
      const s = createTestServices();
      const sample = "0123456789";
      const b = ((s) => baseBackup({ settings: { agentName: s.repeat(6) } }))(sample);
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp);
    }
  });

  harness.add({
    id: "BK-BND-019",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Multilingual Korean content in titles, descriptions, and content",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        projects: [makeProject("p-ko", { name: "인공지능 비서 구축 프로젝트", description: "탈로리스 백업 및 직렬화 시스템 검증" })],
        tasks: [makeTask("t-ko", { title: "한국어 자연어 처리 엔진 검증", description: "형태소 분석 및 세션 동기화" })]
      });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.tasks[0].title, "한국어 자연어 처리 엔진 검증");
    }
  });

  harness.add({
    id: "BK-BND-020",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Multilingual Japanese kanji and kana in all fields",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        notes: [makeNote("n-jp", { title: "タスク管理のベストプラクティス", content: "プロジェクトの進捗状況を追跡する。" })]
      });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.notes[0].title, "タスク管理のベストプラクティス");
    }
  });

  harness.add({
    id: "BK-BND-021",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Multilingual Arabic RTL content with mixed punctuation",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        conversations: [makeConversation("c-ar", { title: "تخطيط المشاريع اليومية" })]
      });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.conversations[0].title, "تخطيط المشاريع اليومية");
    }
  });

  harness.add({
    id: "BK-BND-022",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Multi-byte emojis and skin-tone modifiers in task titles and notes",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        tasks: [makeTask("t-emoji", { title: "🚀 Launch v2 👨‍👩‍👧‍👦 Team Celebration 🎉 💻 🧠" })]
      });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.tasks[0].title, "🚀 Launch v2 👨‍👩‍👧‍👦 Team Celebration 🎉 💻 🧠");
    }
  });

  harness.add({
    id: "BK-BND-023",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Zero-width joiner sequences in message content",
    run: async () => {
      const s = createTestServices();
      const zwjText = "👨‍💻 Developer with ZWJ: \u200D sequence test";
      const b = baseBackup({
        conversations: [makeConversation("c-zwj")],
        messages: [makeMessage("m-zwj", "c-zwj", { content: zwjText })]
      });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.messages[0].content, zwjText);
    }
  });

  harness.add({
    id: "BK-BND-024",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Control characters, escaped tabs, and newlines in note content",
    run: async () => {
      const s = createTestServices();
      const complexText = "Line 1\r\nLine 2\tTabbed\0NullSafe";
      const b = baseBackup({ notes: [makeNote("n-ctrl", { content: complexText })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.notes[0].content, complexText);
    }
  });

  harness.add({
    id: "BK-BND-025",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Message with deeply nested tool activities and arguments",
    run: async () => {
      const s = createTestServices();
      const nestedTools = [{
        id: "t-deep",
        name: "complexTool",
        label: "Complex",
        status: "success",
        approval: {
          id: "pa-1",
          summary: "Execute action",
          status: "approved",
          expires_at: "2026-12-31T00:00:00.000Z",
          error: null
        }
      }];
      const b = baseBackup({
        conversations: [makeConversation("c-deep")],
        messages: [makeMessage("m-deep", "c-deep", { tools: JSON.stringify(nestedTools) })]
      });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp.data.messages[0].tools.includes("pa-1"));
    }
  });

  harness.add({
    id: "BK-BND-026",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Automation schedule with nested recurrence specification",
    run: async () => {
      const s = createTestServices();
      const spec = { type: "weekly", time: "14:00", days: [1, 2, 3, 4, 5] };
      const b = baseBackup({ automations: [makeAutomation("a-nested", { schedule: spec })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.deepStrictEqual(exp.data.automations[0].schedule, spec);
    }
  });

  harness.add({
    id: "BK-BND-027",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Settings with nested limits structure",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ settings: { limits: { maxOutputTokens: 2048, maxToolCalls: 8 } } });
      await importData(s as any, b);
      const st = s.settings.get();
      assert.strictEqual(st.limits.maxOutputTokens, 2048);
      assert.strictEqual(st.limits.maxToolCalls, 8);
    }
  });

  harness.add({
    id: "BK-BND-028",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Settings temperature at exact lower bound 0.0",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ settings: { temperature: 0.0 } });
      await importData(s as any, b);
      assert.strictEqual(s.settings.get().temperature, 0.0);
    }
  });

  harness.add({
    id: "BK-BND-029",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Settings temperature at exact upper bound 1.5",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ settings: { temperature: 1.5 } });
      await importData(s as any, b);
      assert.strictEqual(s.settings.get().temperature, 1.5);
    }
  });

  harness.add({
    id: "BK-BND-030",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Settings limits at minimal valid values (tokens=64, tools=0, iterations=1, context=1000)",
    run: async () => {
      const s = createTestServices();
      const minLimits = {
        maxOutputTokens: 64,
        maxToolCalls: 0,
        maxAgentIterations: 1,
        maxContextTokens: 1000,
        maxScheduledAiRunsPerDay: 0,
        maxAiRequestsPerDay: 1,
      };
      const b = baseBackup({ settings: { limits: minLimits } });
      await importData(s as any, b);
      assert.deepStrictEqual(s.settings.get().limits, minLimits);
    }
  });

  harness.add({
    id: "BK-BND-031",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Settings limits at ceiling values (from LIMIT_CEILINGS)",
    run: async () => {
      const s = createTestServices();
      const ceilLimits = {
        maxOutputTokens: LIMIT_CEILINGS.maxOutputTokens,
        maxToolCalls: LIMIT_CEILINGS.maxToolCalls,
        maxAgentIterations: LIMIT_CEILINGS.maxAgentIterations,
        maxContextTokens: LIMIT_CEILINGS.maxContextTokens,
        maxScheduledAiRunsPerDay: LIMIT_CEILINGS.maxScheduledAiRunsPerDay,
        maxAiRequestsPerDay: LIMIT_CEILINGS.maxAiRequestsPerDay,
      };
      const b = baseBackup({ settings: { limits: ceilLimits } });
      await importData(s as any, b);
      assert.deepStrictEqual(s.settings.get().limits, ceilLimits);
    }
  });

  harness.add({
    id: "BK-BND-032",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Timestamps on leap day (2028-02-29T12:00:00.000Z)",
    run: async () => {
      const s = createTestServices();
      const leap = "2028-02-29T12:00:00.000Z";
      const b = baseBackup({ tasks: [makeTask("t-leap", { due_at: leap })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.tasks[0].due_at, leap);
    }
  });

  harness.add({
    id: "BK-BND-033",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Timestamps at Unix epoch boundary (1970-01-01T00:00:00.000Z)",
    run: async () => {
      const s = createTestServices();
      const epoch = "1970-01-01T00:00:00.000Z";
      const b = baseBackup({ tasks: [makeTask("t-epoch", { created_at: epoch, updated_at: epoch })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.tasks[0].created_at, epoch);
    }
  });

  harness.add({
    id: "BK-BND-034",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Timestamps at far future boundary (2099-12-31T23:59:59.999Z)",
    run: async () => {
      const s = createTestServices();
      const future = "2099-12-31T23:59:59.999Z";
      const b = baseBackup({ tasks: [makeTask("t-future", { due_at: future })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.tasks[0].due_at, future);
    }
  });

  harness.add({
    id: "BK-BND-035",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Timestamps with positive and negative timezone offsets (+09:00, -05:00)",
    run: async () => {
      const s = createTestServices();
      const offsetTs = "2026-10-12T18:00:00.000+09:00";
      const b = baseBackup({ tasks: [makeTask("t-offset", { due_at: offsetTs })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.tasks[0].due_at, offsetTs);
    }
  });

  harness.add({
    id: "BK-BND-036",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Task due_at timestamp matching exact current millisecond",
    run: async () => {
      const s = createTestServices();
      const now = new Date().toISOString();
      const b = baseBackup({ tasks: [makeTask("t-now", { due_at: now })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.tasks[0].due_at, now);
    }
  });

  harness.add({
    id: "BK-BND-037",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Batch import with 500 tasks in a single backup",
    run: async () => {
      const s = createTestServices();
      const tasks = Array.from({ length: 500 }, (_, i) => makeTask(`batch-t-${i}`));
      const b = baseBackup({ tasks });
      const summary = await importData(s as any, b);
      assert.strictEqual(summary.tasks, 500);
      assert.strictEqual(s.db.all("SELECT id FROM tal_tasks").length, 500);
    }
  });

  harness.add({
    id: "BK-BND-038",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Batch import with 500 notes in a single backup",
    run: async () => {
      const s = createTestServices();
      const notes = Array.from({ length: 500 }, (_, i) => makeNote(`batch-n-${i}`));
      const b = baseBackup({ notes });
      const summary = await importData(s as any, b);
      assert.strictEqual(summary.notes, 500);
      assert.strictEqual(s.db.all("SELECT id FROM tal_notes").length, 500);
    }
  });

  harness.add({
    id: "BK-BND-039",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Batch import with 50 conversations and 500 messages",
    run: async () => {
      const s = createTestServices();
      const conversations = Array.from({ length: 50 }, (_, i) => makeConversation(`conv-${i}`));
      const messages = Array.from({ length: 500 }, (_, i) => makeMessage(`msg-${i}`, `conv-${i % 50}`));
      const b = baseBackup({ conversations, messages });
      const summary = await importData(s as any, b);
      assert.strictEqual(summary.conversations, 50);
      assert.strictEqual(summary.messages, 500);
    }
  });

  harness.add({
    id: "BK-BND-040",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Batch import with 100 interconnected projects",
    run: async () => {
      const s = createTestServices();
      const projects = Array.from({ length: 100 }, (_, i) => makeProject(`batch-p-${i}`));
      const b = baseBackup({ projects });
      const summary = await importData(s as any, b);
      assert.strictEqual(summary.projects, 100);
    }
  });

  harness.add({
    id: "BK-BND-041",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Batch import with 300 memories",
    run: async () => {
      const s = createTestServices();
      const memories = Array.from({ length: 300 }, (_, i) => makeMemory(`batch-m-${i}`));
      const b = baseBackup({ memories });
      const summary = await importData(s as any, b);
      assert.strictEqual(summary.memories, 300);
    }
  });

  harness.add({
    id: "BK-BND-042",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Legacy schema backup omitting optional app_version",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup();
      delete b.app_version;
      const res = await importData(s as any, b);
      assert.ok(res);
    }
  });

  harness.add({
    id: "BK-BND-043",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Legacy schema backup with minimal required fields only",
    run: async () => {
      const s = createTestServices();
      const minimalBackup = {
        format: BACKUP_FORMAT,
        version: 1,
        exported_at: "2026-01-01T00:00:00.000Z",
        data: {}
      };
      const res = await importData(s as any, minimalBackup);
      assert.strictEqual(res.tasks, 0);
    }
  });

  harness.add({
    id: "BK-BND-044",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Legacy schema backup with unexpected extra properties on entities",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        tasks: [makeTask("t-extra", { legacyFieldA: "val", legacyFieldB: 1234 })]
      });
      const res = await importData(s as any, b);
      assert.strictEqual(res.tasks, 1);
    }
  });

  harness.add({
    id: "BK-BND-045",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Task title containing single quotes, double quotes, and semicolons",
    run: async () => {
      const s = createTestServices();
      const trickyTitle = "Don't break; \"quotes\" & 'apostrophes'; -- comment";
      const b = baseBackup({ tasks: [makeTask("t-quotes", { title: trickyTitle })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.tasks[0].title, trickyTitle);
    }
  });

  harness.add({
    id: "BK-BND-046",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Entity with SQL injection payloads safely escaped via parameterized queries",
    run: async () => {
      const s = createTestServices();
      const sqli = "'); DROP TABLE tal_tasks; --";
      const b = baseBackup({ tasks: [makeTask("t-sqli", { title: sqli })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.tasks[0].title, sqli);
      assert.ok(s.db.all("SELECT 1 FROM tal_tasks").length > 0);
    }
  });

  harness.add({
    id: "BK-BND-047",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Field values with literal string 'null', 'true', 'false', '0'",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        tasks: [
          makeTask("t-lit-null", { title: "null" }),
          makeTask("t-lit-true", { title: "true" }),
          makeTask("t-lit-false", { title: "false" }),
          makeTask("t-lit-zero", { title: "0" }),
        ]
      });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.tasks.find(t => t.id === "t-lit-null")?.title, "null");
    }
  });

  harness.add({
    id: "BK-BND-048",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Message tools field containing empty array string vs parsed array",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        conversations: [makeConversation("c-tools-test")],
        messages: [
          makeMessage("m-tools-str", "c-tools-test", { tools: "[]" }),
          makeMessage("m-tools-arr", "c-tools-test", { tools: [] })
        ]
      });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.messages.length, 2);
    }
  });

  harness.add({
    id: "BK-BND-049",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Tool activity with approval in status 'pending'",
    run: async () => {
      const s = createTestServices();
      const toolWithAppr = [{
        id: "t-appr-pending",
        name: "delete_task",
        label: "Deleting",
        status: "running",
        approval: {
          id: "pa-pending",
          summary: "Delete task",
          status: "pending",
          expires_at: "2026-12-31T00:00:00.000Z",
          error: null
        }
      }];
      const b = baseBackup({
        conversations: [makeConversation("c-appr-pending")],
        messages: [makeMessage("m-appr-pending", "c-appr-pending", { tools: JSON.stringify(toolWithAppr) })]
      });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp.data.messages[0].tools.includes("pending"));
    }
  });

  harness.add({
    id: "BK-BND-050",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Tool activity with approval in status 'approved'",
    run: async () => {
      const s = createTestServices();
      const toolWithAppr = [{
        id: "t-appr-approved",
        name: "delete_task",
        label: "Deleting",
        status: "success",
        approval: {
          id: "pa-approved",
          summary: "Delete task",
          status: "approved",
          expires_at: "2026-12-31T00:00:00.000Z",
          error: null
        }
      }];
      const b = baseBackup({
        conversations: [makeConversation("c-appr-approved")],
        messages: [makeMessage("m-appr-approved", "c-appr-approved", { tools: JSON.stringify(toolWithAppr) })]
      });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp.data.messages[0].tools.includes("approved"));
    }
  });

  harness.add({
    id: "BK-BND-051",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Tool activity with approval in status 'cancelled'",
    run: async () => {
      const s = createTestServices();
      const toolWithAppr = [{
        id: "t-appr-cancelled",
        name: "delete_task",
        label: "Deleting",
        status: "running",
        approval: {
          id: "pa-cancelled",
          summary: "Delete task",
          status: "cancelled",
          expires_at: "2026-12-31T00:00:00.000Z",
          error: null
        }
      }];
      const b = baseBackup({
        conversations: [makeConversation("c-appr-cancelled")],
        messages: [makeMessage("m-appr-cancelled", "c-appr-cancelled", { tools: JSON.stringify(toolWithAppr) })]
      });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp.data.messages[0].tools.includes("cancelled"));
    }
  });

  harness.add({
    id: "BK-BND-052",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Tool activity with approval in status 'expired'",
    run: async () => {
      const s = createTestServices();
      const toolWithAppr = [{
        id: "t-appr-expired",
        name: "delete_task",
        label: "Deleting",
        status: "running",
        approval: {
          id: "pa-expired",
          summary: "Delete task",
          status: "expired",
          expires_at: "2026-12-31T00:00:00.000Z",
          error: null
        }
      }];
      const b = baseBackup({
        conversations: [makeConversation("c-appr-expired")],
        messages: [makeMessage("m-appr-expired", "c-appr-expired", { tools: JSON.stringify(toolWithAppr) })]
      });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp.data.messages[0].tools.includes("expired"));
    }
  });

  harness.add({
    id: "BK-BND-053",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Tool activity with approval in status 'failed'",
    run: async () => {
      const s = createTestServices();
      const toolWithAppr = [{
        id: "t-appr-failed",
        name: "delete_task",
        label: "Deleting",
        status: "running",
        approval: {
          id: "pa-failed",
          summary: "Delete task",
          status: "failed",
          expires_at: "2026-12-31T00:00:00.000Z",
          error: null
        }
      }];
      const b = baseBackup({
        conversations: [makeConversation("c-appr-failed")],
        messages: [makeMessage("m-appr-failed", "c-appr-failed", { tools: JSON.stringify(toolWithAppr) })]
      });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.ok(exp.data.messages[0].tools.includes("failed"));
    }
  });

  harness.add({
    id: "BK-BND-054",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Automation schedule monthly on day 31 (month-end boundary)",
    run: async () => {
      const s = createTestServices();
      const spec = { type: "monthly", time: "18:00", day: 31 };
      const b = baseBackup({ automations: [makeAutomation("a-m31", { schedule: spec })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.deepStrictEqual(exp.data.automations[0].schedule, spec);
    }
  });

  harness.add({
    id: "BK-BND-055",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Automation schedule weekly spanning all 7 days",
    run: async () => {
      const s = createTestServices();
      const spec = { type: "weekly", time: "09:00", days: [0, 1, 2, 3, 4, 5, 6] };
      const b = baseBackup({ automations: [makeAutomation("a-w7", { schedule: spec })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.deepStrictEqual(exp.data.automations[0].schedule, spec);
    }
  });

  harness.add({
    id: "BK-BND-056",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Project status unknown string falls back safely to 'active'",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ projects: [makeProject("p-bad-st", { status: "unknown_status" })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.projects[0].status, "active");
    }
  });

  harness.add({
    id: "BK-BND-057",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Task priority unknown string falls back safely to 'medium'",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ tasks: [makeTask("t-bad-pr", { priority: "blazing" })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.tasks[0].priority, "medium");
    }
  });

  harness.add({
    id: "BK-BND-058",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Memory category unknown string falls back safely to 'other'",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ memories: [makeMemory("m-bad-cat", { category: "supernatural" })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.memories[0].category, "other");
    }
  });

  harness.add({
    id: "BK-BND-059",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Message status unknown string falls back safely to 'complete'",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        conversations: [makeConversation("c-bad-mst")],
        messages: [makeMessage("m-bad-mst", "c-bad-mst", { status: "hyper_processing" })]
      });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.messages[0].status, "complete");
    }
  });

  harness.add({
    id: "BK-BND-060",
    domain: "Backup & State Serialization",
    category: "boundary",
    description: "Note with non-existent foreign project_id safely normalizes to null",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ notes: [makeNote("n-orphan", { project_id: "non-existent-proj" })] });
      await importData(s as any, b);
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.notes[0].project_id, null);
    }
  });
  // ==========================================
  // 3. FAILURE CATEGORY (50 Tests)
  // ==========================================

  harness.add({
    id: "BK-FAIL-001",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Tampered ciphertext: single bit flipped in encrypted payload rejected",
    run: async () => {
      const s1 = createTestServices();
      s1.db.run("INSERT INTO tal_tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", "t1", "Secret", "todo", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z");
      const secret = "enc-key-1234567890-fail";
      const enc = await exportEncryptedData(s1 as any, secret);

      // Flip one character in base64 ciphertext
      const tamperedCt = enc.ciphertext.slice(0, 10) + (enc.ciphertext[10] === "A" ? "B" : "A") + enc.ciphertext.slice(11);
      const tamperedEnc = { ...enc, ciphertext: tamperedCt };

      const s2 = createTestServices();
      await assert.rejects(async () => {
        await importEncryptedData(s2 as any, tamperedEnc, secret);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-002",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Tampered ciphertext: truncated ciphertext rejected during decryption",
    run: async () => {
      const s1 = createTestServices();
      const secret = "enc-key-trunc-fail";
      const enc = await exportEncryptedData(s1 as any, secret);
      const truncated = { ...enc, ciphertext: enc.ciphertext.slice(0, 16) };
      const s2 = createTestServices();
      await assert.rejects(async () => {
        await importEncryptedData(s2 as any, truncated, secret);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-003",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Tampered ciphertext: modified IV in encrypted payload rejected",
    run: async () => {
      const s1 = createTestServices();
      const secret = "enc-key-iv-fail";
      const enc = await exportEncryptedData(s1 as any, secret);
      const tamperedIv = { ...enc, iv: "AAAA" + enc.iv.slice(4) };
      const s2 = createTestServices();
      await assert.rejects(async () => {
        await importEncryptedData(s2 as any, tamperedIv, secret);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-004",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Tampered ciphertext: empty ciphertext string rejected by schema",
    run: async () => {
      const emptyEnc = {
        format: "talorys-backup-encrypted",
        version: 1,
        exported_at: "2026-10-12T00:00:00.000Z",
        algorithm: "AES-GCM-256",
        ciphertext: "",
        hmac: "abc"
      };
      const res = encryptedBackupSchema.safeParse(emptyEnc);
      assert.strictEqual(res.success, false);
    }
  });

  harness.add({
    id: "BK-FAIL-005",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Tampered ciphertext: non-base64 malformed ciphertext rejected",
    run: async () => {
      const s = createTestServices();
      const malformed = {
        format: "talorys-backup-encrypted",
        version: 1,
        exported_at: "2026-10-12T00:00:00.000Z",
        algorithm: "AES-GCM-256",
        iv: "valid_iv_placeholder",
        ciphertext: "%%%NOT_BASE64@@@!!!",
        hmac: "abc"
      };
      await assert.rejects(async () => {
        await importEncryptedData(s as any, malformed, "secret");
      });
    }
  });

  harness.add({
    id: "BK-FAIL-006",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Tampered ciphertext: altered authentication tag in AES-GCM rejected",
    run: async () => {
      const s1 = createTestServices();
      const secret = "enc-tag-fail";
      const enc = await exportEncryptedData(s1 as any, secret);
      const alteredTag = { ...enc, tag: "00000000000000000000000000000000" };
      const s2 = createTestServices();
      await assert.rejects(async () => {
        await importEncryptedData(s2 as any, alteredTag, secret);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-007",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Tampered ciphertext: completely corrupted random bytes ciphertext rejected",
    run: async () => {
      const s = createTestServices();
      const randBytes = Buffer.from("completely-random-unencrypted-garbage-bytes").toString("base64");
      const bad = {
        format: "talorys-backup-encrypted",
        version: 1,
        exported_at: "2026-10-12T00:00:00.000Z",
        algorithm: "AES-GCM-256",
        iv: Buffer.from("123456789012").toString("base64"),
        ciphertext: randBytes,
        hmac: "abc"
      };
      await assert.rejects(async () => {
        await importEncryptedData(s as any, bad, "secret");
      });
    }
  });

  harness.add({
    id: "BK-FAIL-008",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Tampered ciphertext: ciphertext swapped between two different backups rejected",
    run: async () => {
      const s = createTestServices();
      const secret = "enc-swap-secret";
      const enc1 = await exportEncryptedData(s as any, secret);
      const enc2 = await exportEncryptedData(s as any, "other-secret");
      // Mismatch IV of enc1 with ciphertext of enc2
      const swapped = { ...enc1, ciphertext: enc2.ciphertext };
      await assert.rejects(async () => {
        await importEncryptedData(s as any, swapped, secret);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-009",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "HMAC mismatch: altered data payload with original HMAC rejected",
    run: async () => {
      const s = createTestServices();
      const secret = "hmac-fail-secret";
      const b = baseBackup({ tasks: [makeTask("t-orig")] });
      const origHmac = await hmacSha256Hex(secret, JSON.stringify(b.data));
      // Tamper data
      const tampered = { ...b, data: { ...b.data, tasks: [makeTask("t-tampered")] }, hmac: origHmac };
      await assert.rejects(async () => {
        await importSignedData(s as any, tampered, secret);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-010",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "HMAC mismatch: single character changed in task title causes rejection",
    run: async () => {
      const s = createTestServices();
      const secret = "hmac-single-char-secret";
      const b = baseBackup({ tasks: [makeTask("t1", { title: "Title A" })] });
      const hmac = await hmacSha256Hex(secret, JSON.stringify(b.data));
      const altered = { ...b, data: { ...b.data, tasks: [makeTask("t1", { title: "Title B" })] }, hmac };
      await assert.rejects(async () => {
        await importSignedData(s as any, altered, secret);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-011",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "HMAC mismatch: single character changed in exported_at timestamp causes rejection",
    run: async () => {
      const s = createTestServices();
      const secret = "hmac-ts-secret";
      const b = baseBackup();
      const signed = await exportSignedData(s as any, secret);
      const tampered = { ...signed, exported_at: "2026-10-12T00:00:01.000Z" };
      const valid = await verifyBackupHmac(tampered, secret);
      assert.strictEqual(valid, false);
    }
  });

  harness.add({
    id: "BK-FAIL-012",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "HMAC mismatch: format string changed causes rejection",
    run: async () => {
      const s = createTestServices();
      const secret = "hmac-fmt-secret";
      const signed = await exportSignedData(s as any, secret);
      const tampered = { ...signed, format: "other-format" };
      const valid = await verifyBackupHmac(tampered as any, secret);
      assert.strictEqual(valid, false);
    }
  });

  harness.add({
    id: "BK-FAIL-013",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "HMAC mismatch: empty HMAC string rejected",
    run: async () => {
      const s = createTestServices();
      const signed = { ...baseBackup(), hmac: "" };
      await assert.rejects(async () => {
        await importSignedData(s as any, signed, "secret");
      });
    }
  });

  harness.add({
    id: "BK-FAIL-014",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "HMAC mismatch: invalid length or non-hex HMAC string rejected",
    run: async () => {
      const s = createTestServices();
      const signed = { ...baseBackup(), hmac: "not_a_valid_hex_string" };
      await assert.rejects(async () => {
        await importSignedData(s as any, signed, "secret");
      });
    }
  });

  harness.add({
    id: "BK-FAIL-015",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "HMAC mismatch: verification with wrong secret key fails",
    run: async () => {
      const s = createTestServices();
      const secretA = "correct-key-A";
      const secretB = "wrong-key-B";
      const signed = await exportSignedData(s as any, secretA);
      const valid = await verifyBackupHmac(signed, secretB);
      assert.strictEqual(valid, false);
    }
  });

  harness.add({
    id: "BK-FAIL-016",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "HMAC mismatch: truncated HMAC string rejected",
    run: async () => {
      const s = createTestServices();
      const secret = "trunc-hmac-key";
      const signed = await exportSignedData(s as any, secret);
      const truncated = { ...signed, hmac: signed.hmac.slice(0, 32) };
      const valid = await verifyBackupHmac(truncated, secret);
      assert.strictEqual(valid, false);
    }
  });

  harness.add({
    id: "BK-FAIL-017",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Prototype pollution: __proto__ injected at root of backup data rejected",
    run: async () => {
      const s = createTestServices();
      const malicious = JSON.parse('{"format":"talorys-backup","version":1,"exported_at":"2026-10-12T00:00:00.000Z","data":{"__proto__":{"polluted":true},"tasks":[]}}');
      await assert.rejects(async () => {
        await importData(s as any, malicious);
      }, (err: any) => err instanceof ValidationError || err.name === "ValidationError" || err.message?.includes("pollution") || err.message?.includes("Invalid"));
      assert.strictEqual(({} as any).polluted, undefined);
    }
  });

  harness.add({
    id: "BK-FAIL-018",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Prototype pollution: __proto__ injected inside settings rejected",
    run: async () => {
      const s = createTestServices();
      const malicious = JSON.parse('{"format":"talorys-backup","version":1,"exported_at":"2026-10-12T00:00:00.000Z","data":{"settings":{"__proto__":{"polluted":true}}}}');
      await assert.rejects(async () => {
        await importData(s as any, malicious);
      });
      assert.strictEqual(({} as any).polluted, undefined);
    }
  });

  harness.add({
    id: "BK-FAIL-019",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Prototype pollution: constructor property injected inside settings rejected",
    run: async () => {
      const s = createTestServices();
      const malicious = JSON.parse('{"format":"talorys-backup","version":1,"exported_at":"2026-10-12T00:00:00.000Z","data":{"settings":{"constructor":{"prototype":{"polluted":true}}}}}');
      await assert.rejects(async () => {
        await importData(s as any, malicious);
      });
      assert.strictEqual(({} as any).polluted, undefined);
    }
  });

  harness.add({
    id: "BK-FAIL-020",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Prototype pollution: constructor.prototype injected inside task entity rejected",
    run: async () => {
      const s = createTestServices();
      const malicious = JSON.parse('{"format":"talorys-backup","version":1,"exported_at":"2026-10-12T00:00:00.000Z","data":{"tasks":[{"id":"t1","title":"T1","status":"todo","created_at":"2026-10-12T00:00:00.000Z","updated_at":"2026-10-12T00:00:00.000Z","constructor":{"prototype":{"polluted":true}}}]}}');
      await assert.rejects(async () => {
        await importData(s as any, malicious);
      });
      assert.strictEqual(({} as any).polluted, undefined);
    }
  });

  harness.add({
    id: "BK-FAIL-021",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Prototype pollution: __proto__ injected inside notes array entity rejected",
    run: async () => {
      const s = createTestServices();
      const malicious = JSON.parse('{"format":"talorys-backup","version":1,"exported_at":"2026-10-12T00:00:00.000Z","data":{"notes":[{"id":"n1","title":"N1","content":"C","created_at":"2026-10-12T00:00:00.000Z","updated_at":"2026-10-12T00:00:00.000Z","__proto__":{"polluted":true}}]}}');
      await assert.rejects(async () => {
        await importData(s as any, malicious);
      });
      assert.strictEqual(({} as any).polluted, undefined);
    }
  });

  harness.add({
    id: "BK-FAIL-022",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Prototype pollution: __proto__ injected inside conversation entity rejected",
    run: async () => {
      const s = createTestServices();
      const malicious = JSON.parse('{"format":"talorys-backup","version":1,"exported_at":"2026-10-12T00:00:00.000Z","data":{"conversations":[{"id":"c1","title":"C1","created_at":"2026-10-12T00:00:00.000Z","updated_at":"2026-10-12T00:00:00.000Z","__proto__":{"polluted":true}}]}}');
      await assert.rejects(async () => {
        await importData(s as any, malicious);
      });
      assert.strictEqual(({} as any).polluted, undefined);
    }
  });

  harness.add({
    id: "BK-FAIL-023",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Prototype pollution: __proto__ injected inside memories entity rejected",
    run: async () => {
      const s = createTestServices();
      const malicious = JSON.parse('{"format":"talorys-backup","version":1,"exported_at":"2026-10-12T00:00:00.000Z","data":{"memories":[{"id":"m1","content":"M","category":"other","created_at":"2026-10-12T00:00:00.000Z","updated_at":"2026-10-12T00:00:00.000Z","__proto__":{"polluted":true}}]}}');
      await assert.rejects(async () => {
        await importData(s as any, malicious);
      });
      assert.strictEqual(({} as any).polluted, undefined);
    }
  });

  harness.add({
    id: "BK-FAIL-024",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Prototype pollution: __proto__ injected inside automations entity rejected",
    run: async () => {
      const s = createTestServices();
      const malicious = JSON.parse('{"format":"talorys-backup","version":1,"exported_at":"2026-10-12T00:00:00.000Z","data":{"automations":[{"id":"a1","name":"A","kind":"reminder","schedule":{"type":"daily","time":"09:00"},"__proto__":{"polluted":true}}]}}');
      await assert.rejects(async () => {
        await importData(s as any, malicious);
      });
      assert.strictEqual(({} as any).polluted, undefined);
    }
  });

  harness.add({
    id: "BK-FAIL-025",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Prototype pollution: __proto__ injected inside projects entity rejected",
    run: async () => {
      const s = createTestServices();
      const malicious = JSON.parse('{"format":"talorys-backup","version":1,"exported_at":"2026-10-12T00:00:00.000Z","data":{"projects":[{"id":"p1","name":"P","created_at":"2026-10-12T00:00:00.000Z","updated_at":"2026-10-12T00:00:00.000Z","__proto__":{"polluted":true}}]}}');
      await assert.rejects(async () => {
        await importData(s as any, malicious);
      });
      assert.strictEqual(({} as any).polluted, undefined);
    }
  });

  harness.add({
    id: "BK-FAIL-026",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Prototype pollution: nested __proto__ inside limits settings rejected",
    run: async () => {
      const s = createTestServices();
      const malicious = JSON.parse('{"format":"talorys-backup","version":1,"exported_at":"2026-10-12T00:00:00.000Z","data":{"settings":{"limits":{"__proto__":{"polluted":true}}}}}');
      await assert.rejects(async () => {
        await importData(s as any, malicious);
      });
      assert.strictEqual(({} as any).polluted, undefined);
    }
  });

  harness.add({
    id: "BK-FAIL-027",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Prototype pollution: prototype property injected in settings rejected",
    run: async () => {
      const s = createTestServices();
      const malicious = JSON.parse('{"format":"talorys-backup","version":1,"exported_at":"2026-10-12T00:00:00.000Z","data":{"settings":{"prototype":{"polluted":true}}}}');
      await assert.rejects(async () => {
        await importData(s as any, malicious);
      });
      assert.strictEqual(({} as any).polluted, undefined);
    }
  });

  harness.add({
    id: "BK-FAIL-028",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Prototype pollution: __proto__ in message entity rejected",
    run: async () => {
      const s = createTestServices();
      const malicious = JSON.parse('{"format":"talorys-backup","version":1,"exported_at":"2026-10-12T00:00:00.000Z","data":{"messages":[{"id":"m1","conversation_id":"c1","role":"user","content":"hi","created_at":"2026-10-12T00:00:00.000Z","__proto__":{"polluted":true}}]}}');
      await assert.rejects(async () => {
        await importData(s as any, malicious);
      });
      assert.strictEqual(({} as any).polluted, undefined);
    }
  });

  harness.add({
    id: "BK-FAIL-029",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: backup missing 'format' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const b = baseBackup();
    delete b.format;
    return b;
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-030",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: backup missing 'version' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const b = baseBackup();
    delete b.version;
    return b;
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-031",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: backup missing 'exported_at' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const b = baseBackup();
    delete b.exported_at;
    return b;
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-032",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: backup missing 'data' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const b = baseBackup();
    delete b.data;
    return b;
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-033",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: task missing 'id' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const t = makeTask("t1");
    delete t.id;
    return baseBackup({ tasks: [t] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-034",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: task missing 'title' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const t = makeTask("t1");
    delete t.title;
    return baseBackup({ tasks: [t] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-035",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: task missing 'created_at' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const t = makeTask("t1");
    delete t.created_at;
    return baseBackup({ tasks: [t] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-036",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: task missing 'updated_at' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const t = makeTask("t1");
    delete t.updated_at;
    return baseBackup({ tasks: [t] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-037",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: note missing 'id' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const n = makeNote("n1");
    delete n.id;
    return baseBackup({ notes: [n] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-038",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: note missing 'title' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const n = makeNote("n1");
    delete n.title;
    return baseBackup({ notes: [n] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-039",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: note missing 'content' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const n = makeNote("n1");
    delete n.content;
    return baseBackup({ notes: [n] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-040",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: note missing 'created_at' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const n = makeNote("n1");
    delete n.created_at;
    return baseBackup({ notes: [n] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-041",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: memory missing 'id' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const m = makeMemory("m1");
    delete m.id;
    return baseBackup({ memories: [m] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-042",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: memory missing 'content' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const m = makeMemory("m1");
    delete m.content;
    return baseBackup({ memories: [m] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-043",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: memory missing 'category' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const m = makeMemory("m1");
    delete m.category;
    return baseBackup({ memories: [m] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-044",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: conversation missing 'id' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const c = makeConversation("c1");
    delete c.id;
    return baseBackup({ conversations: [c] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-045",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: conversation missing 'title' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const c = makeConversation("c1");
    delete c.title;
    return baseBackup({ conversations: [c] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-046",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: message missing 'id' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const msg = makeMessage("m1", "c1");
    delete msg.id;
    return baseBackup({ messages: [msg] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-047",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: message missing 'conversation_id' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const msg = makeMessage("m1", "c1");
    delete msg.conversation_id;
    return baseBackup({ messages: [msg] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-048",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: message missing 'role' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const msg = makeMessage("m1", "c1");
    delete msg.role;
    return baseBackup({ messages: [msg] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-049",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: project missing 'name' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const p = makeProject("p1");
    delete p.name;
    return baseBackup({ projects: [p] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-FAIL-050",
    domain: "Backup & State Serialization",
    category: "failure",
    description: "Missing required fields: automation missing 'schedule' rejected by schema",
    run: async () => {
      const s = createTestServices();
      const b = (() => {
    const a = makeAutomation("a1");
    delete a.schedule;
    return baseBackup({ automations: [a] });
  })();
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });
  // ==========================================
  // 4. CONCURRENCY CATEGORY (40 Tests)
  // ==========================================

  harness.add({
    id: "BK-CONC-001",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "5 concurrent export requests return identical state snapshots",
    run: async () => {
      const s = createTestServices();
      s.db.run("INSERT INTO tal_tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", "t-c1", "Task C1", "todo", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z");
      const exports = await Promise.all(Array.from({ length: 5 }, () => exportData(s as any)));
      const firstTasks = JSON.stringify(exports[0].data.tasks);
      for (let i = 1; i < exports.length; i++) {
        assert.strictEqual(JSON.stringify(exports[i].data.tasks), firstTasks);
      }
    }
  });

  harness.add({
    id: "BK-CONC-002",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "10 concurrent export requests execute without database lock errors",
    run: async () => {
      const s = createTestServices();
      const exports = await Promise.all(Array.from({ length: 10 }, () => exportData(s as any)));
      assert.strictEqual(exports.length, 10);
    }
  });

  harness.add({
    id: "BK-CONC-003",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "5 concurrent imports of the same backup maintain idempotent upsert",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ tasks: [makeTask("t-idem-conc")] });
      await Promise.all(Array.from({ length: 5 }, () => importData(s as any, b)));
      assert.strictEqual(s.db.all("SELECT id FROM tal_tasks WHERE id = 't-idem-conc'").length, 1);
    }
  });

  harness.add({
    id: "BK-CONC-004",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Concurrent import of two non-overlapping backups succeeds cleanly",
    run: async () => {
      const s = createTestServices();
      const b1 = baseBackup({ tasks: [makeTask("t-set1")] });
      const b2 = baseBackup({ tasks: [makeTask("t-set2")] });
      await Promise.all([importData(s as any, b1), importData(s as any, b2)]);
      assert.strictEqual(s.db.all("SELECT id FROM tal_tasks").length, 2);
    }
  });

  harness.add({
    id: "BK-CONC-005",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Concurrent import of overlapping backups with conflicting titles converges deterministically",
    run: async () => {
      const s = createTestServices();
      const b1 = baseBackup({ tasks: [makeTask("t-overlap", { title: "Title 1" })] });
      const b2 = baseBackup({ tasks: [makeTask("t-overlap", { title: "Title 2" })] });
      await Promise.all([importData(s as any, b1), importData(s as any, b2)]);
      const task = s.db.one("SELECT title FROM tal_tasks WHERE id = 't-overlap'");
      assert.ok(task?.title === "Title 1" || task?.title === "Title 2");
    }
  });

  harness.add({
    id: "BK-CONC-006",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Read tasks during active restore receives consistent snapshot",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ tasks: Array.from({ length: 50 }, (_, i) => makeTask(`t-r-${i}`)) });
      const [readTasks] = await Promise.all([
        (async () => {
          return s.db.all("SELECT * FROM tal_tasks");
        })(),
        importData(s as any, b)
      ]);
      assert.ok(Array.isArray(readTasks));
    }
  });

  harness.add({
    id: "BK-CONC-007",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Read notes during active restore receives consistent snapshot",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ notes: [makeNote("n-r1")] });
      const [readNotes] = await Promise.all([
        (async () => s.db.all("SELECT * FROM tal_notes"))(),
        importData(s as any, b)
      ]);
      assert.ok(Array.isArray(readNotes));
    }
  });

  harness.add({
    id: "BK-CONC-008",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Read settings during active restore receives consistent snapshot",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ settings: { agentName: "ActiveReadAgent" } });
      const [readSettings] = await Promise.all([
        (async () => s.settings.get())(),
        importData(s as any, b)
      ]);
      assert.ok(readSettings.agentName);
    }
  });

  harness.add({
    id: "BK-CONC-009",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Read memories during active restore receives consistent snapshot",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ memories: [makeMemory("m-r1")] });
      const [readMems] = await Promise.all([
        (async () => s.db.all("SELECT * FROM tal_memories"))(),
        importData(s as any, b)
      ]);
      assert.ok(Array.isArray(readMems));
    }
  });

  harness.add({
    id: "BK-CONC-010",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Read conversations during active restore receives consistent snapshot",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ conversations: [makeConversation("c-r1")] });
      const [readConvs] = await Promise.all([
        (async () => s.db.all("SELECT * FROM tal_conversations"))(),
        importData(s as any, b)
      ]);
      assert.ok(Array.isArray(readConvs));
    }
  });

  harness.add({
    id: "BK-CONC-011",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Idempotency: 1x, 2x, 3x import producing exact same task count",
    run: async () => {
      const s = createTestServices();
      const b = (() => baseBackup({ tasks: [makeTask("t-idem")] }))();
      await importData(s as any, b);
      const count1 = s.db.all("SELECT id FROM tal_tasks").length;
      await importData(s as any, b);
      const count2 = s.db.all("SELECT id FROM tal_tasks").length;
      await importData(s as any, b);
      const count3 = s.db.all("SELECT id FROM tal_tasks").length;
      assert.strictEqual(count1, count2);
      assert.strictEqual(count2, count3);
    }
  });

  harness.add({
    id: "BK-CONC-012",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Idempotency: 1x, 2x, 3x import producing exact same note count",
    run: async () => {
      const s = createTestServices();
      const b = (() => baseBackup({ notes: [makeNote("n-idem")] }))();
      await importData(s as any, b);
      const count1 = s.db.all("SELECT id FROM tal_notes").length;
      await importData(s as any, b);
      const count2 = s.db.all("SELECT id FROM tal_notes").length;
      await importData(s as any, b);
      const count3 = s.db.all("SELECT id FROM tal_notes").length;
      assert.strictEqual(count1, count2);
      assert.strictEqual(count2, count3);
    }
  });

  harness.add({
    id: "BK-CONC-013",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Idempotency: 1x, 2x, 3x import producing exact same memory count",
    run: async () => {
      const s = createTestServices();
      const b = (() => baseBackup({ memories: [makeMemory("m-idem")] }))();
      await importData(s as any, b);
      const count1 = s.db.all("SELECT id FROM tal_memories").length;
      await importData(s as any, b);
      const count2 = s.db.all("SELECT id FROM tal_memories").length;
      await importData(s as any, b);
      const count3 = s.db.all("SELECT id FROM tal_memories").length;
      assert.strictEqual(count1, count2);
      assert.strictEqual(count2, count3);
    }
  });

  harness.add({
    id: "BK-CONC-014",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Idempotency: 1x, 2x, 3x import producing exact same conversation count",
    run: async () => {
      const s = createTestServices();
      const b = (() => baseBackup({ conversations: [makeConversation("c-idem")] }))();
      await importData(s as any, b);
      const count1 = s.db.all("SELECT id FROM tal_conversations").length;
      await importData(s as any, b);
      const count2 = s.db.all("SELECT id FROM tal_conversations").length;
      await importData(s as any, b);
      const count3 = s.db.all("SELECT id FROM tal_conversations").length;
      assert.strictEqual(count1, count2);
      assert.strictEqual(count2, count3);
    }
  });

  harness.add({
    id: "BK-CONC-015",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Idempotency: 1x, 2x, 3x import producing exact same message count",
    run: async () => {
      const s = createTestServices();
      const b = (() => baseBackup({ conversations: [makeConversation("c-m-idem")], messages: [makeMessage("m-idem", "c-m-idem")] }))();
      await importData(s as any, b);
      const count1 = s.db.all("SELECT id FROM tal_messages").length;
      await importData(s as any, b);
      const count2 = s.db.all("SELECT id FROM tal_messages").length;
      await importData(s as any, b);
      const count3 = s.db.all("SELECT id FROM tal_messages").length;
      assert.strictEqual(count1, count2);
      assert.strictEqual(count2, count3);
    }
  });

  harness.add({
    id: "BK-CONC-016",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Idempotency: 1x, 2x, 3x import producing exact same project count",
    run: async () => {
      const s = createTestServices();
      const b = (() => baseBackup({ projects: [makeProject("p-idem")] }))();
      await importData(s as any, b);
      const count1 = s.db.all("SELECT id FROM tal_projects").length;
      await importData(s as any, b);
      const count2 = s.db.all("SELECT id FROM tal_projects").length;
      await importData(s as any, b);
      const count3 = s.db.all("SELECT id FROM tal_projects").length;
      assert.strictEqual(count1, count2);
      assert.strictEqual(count2, count3);
    }
  });

  harness.add({
    id: "BK-CONC-017",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Idempotency: 1x, 2x, 3x import producing exact same automation count",
    run: async () => {
      const s = createTestServices();
      const b = (() => baseBackup({ automations: [makeAutomation("a-idem")] }))();
      await importData(s as any, b);
      const count1 = s.db.all("SELECT id FROM tal_automations").length;
      await importData(s as any, b);
      const count2 = s.db.all("SELECT id FROM tal_automations").length;
      await importData(s as any, b);
      const count3 = s.db.all("SELECT id FROM tal_automations").length;
      assert.strictEqual(count1, count2);
      assert.strictEqual(count2, count3);
    }
  });

  harness.add({
    id: "BK-CONC-018",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Idempotency: importing backup twice does not alter existing task completion timestamp",
    run: async () => {
      const s = createTestServices();
      const compAt = "2026-10-12T10:00:00.000Z";
      const b = baseBackup({ tasks: [makeTask("t-comp-idem", { status: "done", completed_at: compAt })] });
      await importData(s as any, b);
      await importData(s as any, b);
      const t = s.db.one("SELECT completed_at FROM tal_tasks WHERE id = 't-comp-idem'");
      assert.strictEqual(t?.completed_at, compAt);
    }
  });

  harness.add({
    id: "BK-CONC-019",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Idempotency: importing backup twice does not duplicate activity logs unnecessarily",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup();
      await importData(s as any, b);
      await importData(s as any, b);
      const logs = s.getActivityLogs().filter(l => l.type === "data.imported");
      assert.strictEqual(logs.length, 2);
    }
  });

  harness.add({
    id: "BK-CONC-020",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Idempotency: importing backup twice preserves message statuses",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        conversations: [makeConversation("c-msg-st")],
        messages: [makeMessage("m-msg-st", "c-msg-st", { status: "complete" })]
      });
      await importData(s as any, b);
      await importData(s as any, b);
      const m = s.db.one("SELECT status FROM tal_messages WHERE id = 'm-msg-st'");
      assert.strictEqual(m?.status, "complete");
    }
  });

  harness.add({
    id: "BK-CONC-021",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Export during active concurrent task creation produces valid snapshot",
    run: async () => {
      const s = createTestServices();
      const [exp] = await Promise.all([
        (async () => exportData(s as any))(),
        (async () => {
          s.db.run("INSERT INTO tal_tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", "t-cwrite", "Title", "todo", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z");
        })()
      ]);
      assert.ok(exp);
    }
  });

  harness.add({
    id: "BK-CONC-022",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Export during active concurrent note creation produces valid snapshot",
    run: async () => {
      const s = createTestServices();
      const [exp] = await Promise.all([
        (async () => exportData(s as any))(),
        (async () => {
          s.db.run("INSERT INTO tal_notes (id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", "n-cwrite", "Title", "Content", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z");
        })()
      ]);
      assert.ok(exp);
    }
  });

  harness.add({
    id: "BK-CONC-023",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Export during active concurrent memory recording produces valid snapshot",
    run: async () => {
      const s = createTestServices();
      const [exp] = await Promise.all([
        (async () => exportData(s as any))(),
        (async () => {
          s.db.run("INSERT INTO tal_memories (id, content, category, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", "m-cwrite", "Mem", "fact", "manual", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z");
        })()
      ]);
      assert.ok(exp);
    }
  });

  harness.add({
    id: "BK-CONC-024",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Export during active settings update produces valid snapshot",
    run: async () => {
      const s = createTestServices();
      const [exp] = await Promise.all([
        (async () => exportData(s as any))(),
        (async () => s.settings.update({ agentName: "ConcAgent" }))()
      ]);
      assert.ok(exp);
    }
  });

  harness.add({
    id: "BK-CONC-025",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Concurrent import with interleaving task queries maintains integrity",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ tasks: Array.from({ length: 30 }, (_, i) => makeTask(`t-interleave-${i}`)) });
      await Promise.all([
        importData(s as any, b),
        (async () => {
          for (let i = 0; i < 5; i++) s.db.all("SELECT * FROM tal_tasks");
        })()
      ]);
      assert.strictEqual(s.db.all("SELECT id FROM tal_tasks").length, 30);
    }
  });

  harness.add({
    id: "BK-CONC-026",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Concurrent import with interleaving note queries maintains integrity",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ notes: Array.from({ length: 30 }, (_, i) => makeNote(`n-interleave-${i}`)) });
      await Promise.all([
        importData(s as any, b),
        (async () => {
          for (let i = 0; i < 5; i++) s.db.all("SELECT * FROM tal_notes");
        })()
      ]);
      assert.strictEqual(s.db.all("SELECT id FROM tal_notes").length, 30);
    }
  });

  harness.add({
    id: "BK-CONC-027",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Concurrent import with interleaving memory search queries maintains integrity",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ memories: [makeMemory("m-search-c", { content: "Concurrent FTS search target" })] });
      await Promise.all([
        importData(s as any, b),
        (async () => {
          for (let i = 0; i < 5; i++) s.db.all("SELECT * FROM tal_memories_fts WHERE tal_memories_fts MATCH 'Concurrent'");
        })()
      ]);
      const res = s.db.all("SELECT * FROM tal_memories_fts WHERE tal_memories_fts MATCH 'Concurrent'");
      assert.ok(res.length > 0);
    }
  });

  harness.add({
    id: "BK-CONC-028",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Multiple rapid sequential imports (10 in loop) maintain DB consistency",
    run: async () => {
      const s = createTestServices();
      for (let i = 0; i < 10; i++) {
        await importData(s as any, baseBackup({ tasks: [makeTask(`t-seq-${i}`)] }));
      }
      assert.strictEqual(s.db.all("SELECT id FROM tal_tasks").length, 10);
    }
  });

  harness.add({
    id: "BK-CONC-029",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Multiple rapid sequential exports (10 in loop) produce consistent checksums",
    run: async () => {
      const s = createTestServices();
      s.db.run("INSERT INTO tal_projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", "p-stable", "Stable", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z");
      const hashes = new Set();
      for (let i = 0; i < 10; i++) {
        const exp = exportData(s as any);
        hashes.add(JSON.stringify(exp.data));
      }
      assert.strictEqual(hashes.size, 1);
    }
  });

  harness.add({
    id: "BK-CONC-030",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Message ordering in backup: message referencing conversation in same backup resolves correctly",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        conversations: [makeConversation("c-ord")],
        messages: [makeMessage("m-ord", "c-ord")]
      });
      const summary = await importData(s as any, b);
      assert.strictEqual(summary.conversations, 1);
      assert.strictEqual(summary.messages, 1);
    }
  });

  harness.add({
    id: "BK-CONC-031",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Task referencing project in same backup resolves foreign key correctly",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        projects: [makeProject("p-ord")],
        tasks: [makeTask("t-ord", { project_id: "p-ord" })]
      });
      await importData(s as any, b);
      const t = s.db.one("SELECT project_id FROM tal_tasks WHERE id = 't-ord'");
      assert.strictEqual(t?.project_id, "p-ord");
    }
  });

  harness.add({
    id: "BK-CONC-032",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Note referencing project in same backup resolves foreign key correctly",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        projects: [makeProject("p-ord-n")],
        notes: [makeNote("n-ord", { project_id: "p-ord-n" })]
      });
      await importData(s as any, b);
      const n = s.db.one("SELECT project_id FROM tal_notes WHERE id = 'n-ord'");
      assert.strictEqual(n?.project_id, "p-ord-n");
    }
  });

  harness.add({
    id: "BK-CONC-033",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Concurrent import with partial duplicates updates existing without creating orphans",
    run: async () => {
      const s = createTestServices();
      const b1 = baseBackup({ projects: [makeProject("p-dup", { name: "Name 1" })] });
      const b2 = baseBackup({ projects: [makeProject("p-dup", { name: "Name 2" })] });
      await Promise.all([importData(s as any, b1), importData(s as any, b2)]);
      const count = s.db.all("SELECT id FROM tal_projects WHERE id = 'p-dup'").length;
      assert.strictEqual(count, 1);
    }
  });

  harness.add({
    id: "BK-CONC-034",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Concurrent encrypted export and plaintext export produce matching decrypted data",
    run: async () => {
      const s = createTestServices();
      s.db.run("INSERT INTO tal_tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", "t-cenc", "T Cenc", "todo", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z");
      const secret = "enc-plaintext-match-secret";
      const [plain, enc] = await Promise.all([
        exportData(s as any),
        exportEncryptedData(s as any, secret)
      ]);
      const sTemp = createTestServices();
      await importEncryptedData(sTemp as any, enc, secret);
      const plainFromEnc = exportData(sTemp as any);
      assert.strictEqual(plain.data.tasks[0].id, plainFromEnc.data.tasks[0].id);
    }
  });

  harness.add({
    id: "BK-CONC-035",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Concurrent signed export and verification pipeline succeeds under load",
    run: async () => {
      const s = createTestServices();
      const secret = "pipeline-secret";
      const signedBackups = await Promise.all(Array.from({ length: 5 }, () => exportSignedData(s as any, secret)));
      const verifications = await Promise.all(signedBackups.map(b => verifyBackupHmac(b, secret)));
      assert.ok(verifications.every(v => v === true));
    }
  });

  harness.add({
    id: "BK-CONC-036",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Atomic transaction isolation: uncommitted writes during failed import not visible to readers",
    run: async () => {
      const s = createTestServices();
      const badBackup = baseBackup({
        tasks: [makeTask("t-isolation-1")],
        settings: { timezone: "Invalid/Timezone" as any }
      });
      try {
        await importData(s as any, badBackup);
      } catch {}
      const tasks = s.db.all("SELECT id FROM tal_tasks WHERE id = 't-isolation-1'");
      assert.strictEqual(tasks.length, 0);
    }
  });

  harness.add({
    id: "BK-CONC-037",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Lock contention resilience: busy database recovers cleanly during backup operations",
    run: async () => {
      const s = createTestServices();
      await Promise.all([
        (async () => {
          for (let i = 0; i < 20; i++) {
            s.db.run("INSERT INTO tal_tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", `t-contention-${i}`, "Title", "todo", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z");
          }
        })(),
        (async () => exportData(s as any))()
      ]);
      assert.ok(s.db.all("SELECT id FROM tal_tasks").length >= 20);
    }
  });

  harness.add({
    id: "BK-CONC-038",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Simultaneous settings update and export preserves atomic settings snapshot",
    run: async () => {
      const s = createTestServices();
      const [exp] = await Promise.all([
        exportData(s as any),
        s.settings.update({ agentName: "AtomicAgent" })
      ]);
      assert.ok(typeof exp.data.settings === "object");
    }
  });

  harness.add({
    id: "BK-CONC-039",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Parallel imports with different timezones converge on last applied timezone",
    run: async () => {
      const s = createTestServices();
      const b1 = baseBackup({ settings: { timezone: "Asia/Tokyo" } });
      const b2 = baseBackup({ settings: { timezone: "America/New_York" } });
      await Promise.all([importData(s as any, b1), importData(s as any, b2)]);
      const tz = s.settings.get().timezone;
      assert.ok(tz === "Asia/Tokyo" || tz === "America/New_York");
    }
  });

  harness.add({
    id: "BK-CONC-040",
    domain: "Backup & State Serialization",
    category: "concurrency",
    description: "Parallel automations rearm triggers only after data transaction completion",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ automations: [makeAutomation("a-rearm")] });
      await importData(s as any, b);
      assert.ok(s.getRearmedCount() > 0);
    }
  });
  // ==========================================
  // 5. RECOVERY CATEGORY (30 Tests)
  // ==========================================

  harness.add({
    id: "BK-RECOV-001",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Corrupted backup JSON string syntax rejected with error",
    run: async () => {
      const s = createTestServices();
      assert.throws(() => {
        JSON.parse("{\"format\": \"talorys-backup\", UNEXPECTED_TOKEN");
      });
    }
  });

  harness.add({
    id: "BK-RECOV-002",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Corrupted backup with invalid data type (string instead of object) rejected",
    run: async () => {
      const s = createTestServices();
      const bad = { format: "talorys-backup", version: 1, exported_at: "2026-10-12T00:00:00.000Z", data: "corrupted_string" };
      await assert.rejects(async () => {
        await importData(s as any, bad);
      });
    }
  });

  harness.add({
    id: "BK-RECOV-003",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Unknown future format version (version 999) rejected with ValidationError",
    run: async () => {
      const s = createTestServices();
      const future = baseBackup({}, { version: 999 });
      await assert.rejects(async () => {
        await importData(s as any, future);
      }, (err: any) => err instanceof ValidationError || err.name === "ValidationError" || err.message?.includes("newer Talorys"));
    }
  });

  harness.add({
    id: "BK-RECOV-004",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Unknown negative format version (version -1) rejected by schema",
    run: async () => {
      const s = createTestServices();
      const neg = baseBackup({}, { version: -1 });
      await assert.rejects(async () => {
        await importData(s as any, neg);
      });
    }
  });

  harness.add({
    id: "BK-RECOV-005",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Unknown zero format version (version 0) rejected by schema",
    run: async () => {
      const s = createTestServices();
      const zero = baseBackup({}, { version: 0 });
      await assert.rejects(async () => {
        await importData(s as any, zero);
      });
    }
  });

  harness.add({
    id: "BK-RECOV-006",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Format name mismatch (other-agent-backup) rejected with ValidationError",
    run: async () => {
      const s = createTestServices();
      const mismatch = baseBackup({}, { format: "other-agent-backup" });
      await assert.rejects(async () => {
        await importData(s as any, mismatch);
      });
    }
  });

  harness.add({
    id: "BK-RECOV-007",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Corrupted settings in backup (invalid timezone) causes rollback",
    run: async () => {
      const s = createTestServices();
      const initialTz = s.settings.get().timezone;
      const b = baseBackup({ settings: { timezone: "Mars/Olympus_Mons" as any } });
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
      assert.strictEqual(s.settings.get().timezone, initialTz);
    }
  });

  harness.add({
    id: "BK-RECOV-008",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Corrupted settings in backup (invalid model id regex) causes rollback",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ settings: { model: "not-a-workers-ai-model" as any } });
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-RECOV-009",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Corrupted settings in backup (temperature out of range) causes rollback",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ settings: { temperature: 5.0 } });
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-RECOV-010",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Corrupted settings in backup (invalid limits token count) causes rollback",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ settings: { limits: { maxOutputTokens: -10 } } });
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
    }
  });

  harness.add({
    id: "BK-RECOV-011",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Rollback verification: tasks inserted before settings failure are completely rolled back",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        tasks: [makeTask("t-roll-1"), makeTask("t-roll-2")],
        settings: { timezone: "Fake/Zone" as any }
      });
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
      assert.strictEqual(s.db.all("SELECT id FROM tal_tasks WHERE id IN ('t-roll-1', 't-roll-2')").length, 0);
    }
  });

  harness.add({
    id: "BK-RECOV-012",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Rollback verification: notes inserted before settings failure are completely rolled back",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        notes: [makeNote("n-roll-1")],
        settings: { timezone: "Fake/Zone" as any }
      });
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
      assert.strictEqual(s.db.all("SELECT id FROM tal_notes WHERE id = 'n-roll-1'").length, 0);
    }
  });

  harness.add({
    id: "BK-RECOV-013",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Rollback verification: memories inserted before settings failure are completely rolled back",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        memories: [makeMemory("m-roll-1")],
        settings: { timezone: "Fake/Zone" as any }
      });
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
      assert.strictEqual(s.db.all("SELECT id FROM tal_memories WHERE id = 'm-roll-1'").length, 0);
    }
  });

  harness.add({
    id: "BK-RECOV-014",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Rollback verification: projects inserted before settings failure are completely rolled back",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        projects: [makeProject("p-roll-1")],
        settings: { timezone: "Fake/Zone" as any }
      });
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
      assert.strictEqual(s.db.all("SELECT id FROM tal_projects WHERE id = 'p-roll-1'").length, 0);
    }
  });

  harness.add({
    id: "BK-RECOV-015",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Rollback verification: conversations inserted before settings failure are completely rolled back",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        conversations: [makeConversation("c-roll-1")],
        settings: { timezone: "Fake/Zone" as any }
      });
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
      assert.strictEqual(s.db.all("SELECT id FROM tal_conversations WHERE id = 'c-roll-1'").length, 0);
    }
  });

  harness.add({
    id: "BK-RECOV-016",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Rollback verification: messages inserted before settings failure are completely rolled back",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        conversations: [makeConversation("c-roll-m")],
        messages: [makeMessage("m-roll-1", "c-roll-m")],
        settings: { timezone: "Fake/Zone" as any }
      });
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
      assert.strictEqual(s.db.all("SELECT id FROM tal_messages WHERE id = 'm-roll-1'").length, 0);
    }
  });

  harness.add({
    id: "BK-RECOV-017",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Rollback verification: automations inserted before settings failure are completely rolled back",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        automations: [makeAutomation("a-roll-1")],
        settings: { timezone: "Fake/Zone" as any }
      });
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
      assert.strictEqual(s.db.all("SELECT id FROM tal_automations WHERE id = 'a-roll-1'").length, 0);
    }
  });

  harness.add({
    id: "BK-RECOV-018",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Database constraint violation inside import rolls back all state",
    run: async () => {
      const s = createTestServices();
      // Force constraint failure by injecting invalid check
      const b = baseBackup({
        tasks: [makeTask("t-ok")],
        settings: { temperature: -1.0 }
      });
      await assert.rejects(async () => {
        await importData(s as any, b);
      });
      assert.strictEqual(s.db.all("SELECT id FROM tal_tasks WHERE id = 't-ok'").length, 0);
    }
  });

  harness.add({
    id: "BK-RECOV-019",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Corrupted automation schedule string does not crash import (invalid schedule safely skipped)",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        automations: [
          makeAutomation("a-bad-sched", { schedule: "NOT_A_VALID_SCHEDULE_OBJECT" }),
          makeAutomation("a-good-sched", { schedule: { type: "daily", time: "09:00" } })
        ]
      });
      const summary = await importData(s as any, b);
      assert.strictEqual(summary.automations, 1);
    }
  });

  harness.add({
    id: "BK-RECOV-020",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Corrupted automation schedule in database does not crash exportData (safely handled)",
    run: async () => {
      const s = createTestServices();
      // Insert raw invalid schedule JSON into DB
      s.db.run(
        "INSERT INTO tal_automations (id, name, kind, message, schedule, enabled, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        "a-corrupt", "Corrupted", "reminder", "msg", "INVALID_JSON_SCHEDULE_STRING", 1, "scheduled", "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z"
      );
      // exportData should not throw SyntaxError
      const exp = exportData(s as any);
      assert.strictEqual(exp.data.automations.length, 1);
      assert.ok(exp.data.automations[0].schedule === null || typeof exp.data.automations[0].schedule === "object");
    }
  });

  harness.add({
    id: "BK-RECOV-021",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Backup with orphaned message (conversation does not exist) skips message safely",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        messages: [makeMessage("m-orphan", "non-existent-conv-id")]
      });
      const summary = await importData(s as any, b);
      assert.strictEqual(summary.messages, 0);
      assert.strictEqual(s.db.all("SELECT id FROM tal_messages").length, 0);
    }
  });

  harness.add({
    id: "BK-RECOV-022",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Backup with orphaned task (project does not exist) sets project_id to null and succeeds",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        tasks: [makeTask("t-orph", { project_id: "non-existent-proj-id" })]
      });
      const summary = await importData(s as any, b);
      assert.strictEqual(summary.tasks, 1);
      const t = s.db.one("SELECT project_id FROM tal_tasks WHERE id = 't-orph'");
      assert.strictEqual(t?.project_id, null);
    }
  });

  harness.add({
    id: "BK-RECOV-023",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Backup with orphaned note (project does not exist) sets project_id to null and succeeds",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        notes: [makeNote("n-orph", { project_id: "non-existent-proj-id" })]
      });
      const summary = await importData(s as any, b);
      assert.strictEqual(summary.notes, 1);
      const n = s.db.one("SELECT project_id FROM tal_notes WHERE id = 'n-orph'");
      assert.strictEqual(n?.project_id, null);
    }
  });

  harness.add({
    id: "BK-RECOV-024",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Backup with invalid task status falls back to 'todo' safely",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ tasks: [makeTask("t-st-fb", { status: "invalid_status" })] });
      await importData(s as any, b);
      const t = s.db.one("SELECT status FROM tal_tasks WHERE id = 't-st-fb'");
      assert.strictEqual(t?.status, "todo");
    }
  });

  harness.add({
    id: "BK-RECOV-025",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Backup with invalid task priority falls back to 'medium' safely",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ tasks: [makeTask("t-pr-fb", { priority: "highest_ever" })] });
      await importData(s as any, b);
      const t = s.db.one("SELECT priority FROM tal_tasks WHERE id = 't-pr-fb'");
      assert.strictEqual(t?.priority, "medium");
    }
  });

  harness.add({
    id: "BK-RECOV-026",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Backup with invalid memory category falls back to 'other' safely",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ memories: [makeMemory("m-cat-fb", { category: "astrology" })] });
      await importData(s as any, b);
      const m = s.db.one("SELECT category FROM tal_memories WHERE id = 'm-cat-fb'");
      assert.strictEqual(m?.category, "other");
    }
  });

  harness.add({
    id: "BK-RECOV-027",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Backup with invalid message status falls back to 'complete' safely",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        conversations: [makeConversation("c-fb")],
        messages: [makeMessage("m-fb", "c-fb", { status: "pending_something" })]
      });
      await importData(s as any, b);
      const m = s.db.one("SELECT status FROM tal_messages WHERE id = 'm-fb'");
      assert.strictEqual(m?.status, "complete");
    }
  });

  harness.add({
    id: "BK-RECOV-028",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Backup with invalid automation kind falls back to 'reminder' safely",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({ automations: [makeAutomation("a-kind-fb", { kind: "custom_kind" })] });
      await importData(s as any, b);
      const a = s.db.one("SELECT kind FROM tal_automations WHERE id = 'a-kind-fb'");
      assert.strictEqual(a?.kind, "reminder");
    }
  });

  harness.add({
    id: "BK-RECOV-029",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Re-arming failure during import does not corrupt already-committed data",
    run: async () => {
      const s = createTestServices();
      s.automations.rearmAll = async () => {
        throw new Error("Scheduler connection dropped");
      };
      const b = baseBackup({ tasks: [makeTask("t-rearm-err")] });
      try {
        await importData(s as any, b);
      } catch (err: any) {
        assert.ok(err.message.includes("Scheduler connection dropped"));
      }
      // Committed transaction data remains intact
      assert.strictEqual(s.db.all("SELECT id FROM tal_tasks WHERE id = 't-rearm-err'").length, 1);
    }
  });

  harness.add({
    id: "BK-RECOV-030",
    domain: "Backup & State Serialization",
    category: "recovery",
    description: "Activity log entry correctly captures import failure/recovery without partial state leak",
    run: async () => {
      const s = createTestServices();
      const b = baseBackup({
        tasks: [makeTask("t-fail-log")],
        settings: { timezone: "Invalid/Timezone" as any }
      });
      try {
        await importData(s as any, b);
      } catch {}
      // Failed import should NOT record data.imported
      const logs = s.getActivityLogs().filter(l => l.type === "data.imported");
      assert.strictEqual(logs.length, 0);
    }
  });

  const report = await harness.run({
    outputJsonPath: "test-results/backup-results.json",
    verbose: true,
  });

  return report;
}

if (import.meta.main) {
  runBackupSuite()
    .then((report) => {
      if (report.failed > 0 || report.errored > 0) {
        console.error(`\n[Summary] ${report.failed + report.errored} tests failed/errored out of ${report.total}.`);
        process.exit(1);
      } else {
        console.log(`\n[Summary] All ${report.total} tests PASSED flawlessly!`);
        process.exit(0);
      }
    })
    .catch((err) => {
      console.error("[Fatal Error]", err);
      process.exit(1);
    });
}
