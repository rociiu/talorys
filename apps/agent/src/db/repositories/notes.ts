import type { Note, Project } from "@talorys/shared";
import { type Database, ftsQuery, likePattern, newId, now } from "../database";
import { NotFoundError } from "../../api/errors";
import { stripUndefined } from "./tasks";

export class NoteRepository {
  constructor(private readonly db: Database) {}

  list(opts: { q?: string; project_id?: string; limit?: number } = {}): Note[] {
    if (opts.q) return this.search(opts.q, opts.limit ?? 50, opts.project_id);
    const params: unknown[] = [];
    let where = "";
    if (opts.project_id) {
      where = "WHERE project_id = ?";
      params.push(opts.project_id);
    }
    return this.db.all<Note>(`SELECT * FROM tal_notes ${where} ORDER BY updated_at DESC LIMIT ?`, ...params, opts.limit ?? 500);
  }

  search(q: string, limit = 20, projectId?: string): Note[] {
    const projectParams = projectId ? [projectId] : [];
    const match = ftsQuery(q);
    if (match) {
      return this.db.all<Note>(
        `SELECT n.* FROM tal_notes_fts f JOIN tal_notes n ON n.rowid = f.rowid
         WHERE tal_notes_fts MATCH ?${projectId ? " AND n.project_id = ?" : ""} ORDER BY bm25(tal_notes_fts, 2.0, 1.0) LIMIT ?`,
        match,
        ...projectParams,
        limit,
      );
    }
    return this.db.all<Note>(
      `SELECT * FROM tal_notes WHERE (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')${projectId ? " AND project_id = ?" : ""} ORDER BY updated_at DESC LIMIT ?`,
      likePattern(q), likePattern(q), ...projectParams, limit,
    );
  }

  get(id: string): Note | null {
    return this.db.one<Note>(`SELECT * FROM tal_notes WHERE id = ?`, id);
  }

  require(id: string): Note {
    const n = this.get(id);
    if (!n) throw new NotFoundError("Note not found");
    return n;
  }

  create(input: { title: string; content?: string; project_id?: string | null }): Note {
    const ts = now();
    const note: Note = {
      id: newId(),
      title: input.title.trim(),
      content: input.content ?? "",
      project_id: input.project_id ?? null,
      created_at: ts,
      updated_at: ts,
    };
    this.db.run(
      `INSERT INTO tal_notes (id, title, content, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      note.id, note.title, note.content, note.project_id, note.created_at, note.updated_at,
    );
    return note;
  }

  update(id: string, patch: { title?: string; content?: string; project_id?: string | null }): Note {
    const existing = this.require(id);
    const next = { ...existing, ...stripUndefined(patch), updated_at: now() };
    this.db.run(
      `UPDATE tal_notes SET title = ?, content = ?, project_id = ?, updated_at = ? WHERE id = ?`,
      next.title, next.content, next.project_id, next.updated_at, id,
    );
    return next;
  }

  delete(id: string): void {
    this.require(id);
    this.db.run(`DELETE FROM tal_notes WHERE id = ?`, id);
  }
}

export class ProjectRepository {
  constructor(private readonly db: Database) {}

  list(opts: { status?: string } = {}): Project[] {
    if (opts.status) {
      return this.db.all<Project>(`SELECT * FROM tal_projects WHERE status = ? ORDER BY updated_at DESC`, opts.status);
    }
    return this.db.all<Project>(`SELECT * FROM tal_projects ORDER BY status = 'archived', updated_at DESC`);
  }

  get(id: string): Project | null {
    return this.db.one<Project>(`SELECT * FROM tal_projects WHERE id = ?`, id);
  }

  require(id: string): Project {
    const p = this.get(id);
    if (!p) throw new NotFoundError("Project not found");
    return p;
  }

  resolve(ref: string): Project | null {
    return (
      this.get(ref) ??
      this.db.one<Project>(`SELECT * FROM tal_projects WHERE lower(name) = lower(?)`, ref.trim()) ??
      null
    );
  }

  create(input: { name: string; description?: string; status?: Project["status"] }): Project {
    const ts = now();
    const project: Project = {
      id: newId(),
      name: input.name.trim(),
      description: input.description ?? "",
      status: input.status ?? "active",
      created_at: ts,
      updated_at: ts,
    };
    this.db.run(
      `INSERT INTO tal_projects (id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      project.id, project.name, project.description, project.status, project.created_at, project.updated_at,
    );
    return project;
  }

  update(id: string, patch: { name?: string; description?: string; status?: Project["status"] }): Project {
    const existing = this.require(id);
    const next = { ...existing, ...stripUndefined(patch), updated_at: now() };
    this.db.run(
      `UPDATE tal_projects SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?`,
      next.name, next.description, next.status, next.updated_at, id,
    );
    return next;
  }

  delete(id: string): void {
    this.require(id);
    this.db.transaction(() => {
      this.db.run(`UPDATE tal_tasks SET project_id = NULL WHERE project_id = ?`, id);
      this.db.run(`UPDATE tal_notes SET project_id = NULL WHERE project_id = ?`, id);
      this.db.run(`DELETE FROM tal_projects WHERE id = ?`, id);
    });
  }
}
