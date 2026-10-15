export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

/**
 * Thin, synchronous wrapper around Durable Object SQLite storage.
 * All queries use bound parameters; never interpolate values into SQL.
 */
export class Database {
  constructor(private readonly storage: DurableObjectStorage) {}

  all<T = Row>(query: string, ...params: unknown[]): T[] {
    return this.storage.sql.exec(query, ...params.map(normalize)).toArray() as T[];
  }

  one<T = Row>(query: string, ...params: unknown[]): T | null {
    const rows = this.all<T>(query, ...params);
    return rows[0] ?? null;
  }

  run(query: string, ...params: unknown[]): { changes: number } {
    const cursor = this.storage.sql.exec(query, ...params.map(normalize));
    // Drain the cursor so the statement fully executes.
    cursor.toArray();
    return { changes: cursor.rowsWritten };
  }

  /** Runs `fn` atomically. Throwing rolls the transaction back. */
  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}

function normalize(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  return JSON.stringify(value);
}

export const now = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

/** Escapes a user query for SQLite LIKE with ESCAPE '\'. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The keyword terms of free text: lower-cased, stopwords dropped, the first `maxTerms` deduplicated. */
export function ftsTerms(q: string, maxTerms = 8): string[] {
  const terms = (q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])
    .filter((t) => !STOPWORDS.has(t))
    .slice(0, maxTerms);
  return [...new Set(terms)];
}

/** Builds a safe FTS5 MATCH expression (OR of quoted prefix terms) from free text. */
export function ftsQuery(q: string, maxTerms = 8): string | null {
  const terms = ftsTerms(q, maxTerms);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(" OR ");
}

const STOPWORDS = new Set(
  "a an and are as at be but by can could do does for from had has have how i if in into is it its me my of on or our please should so than that the their them then there these they this to us was we were what when where which who why will with would you your about also just like want need tell show give make get remember".split(
    " ",
  ),
);
