/** Notes longer than this many characters are embedded in chunks instead of one body row. */
export const NOTE_SPLIT_CHARS = 4000;
/** Largest chunk of a long note's body. */
export const NOTE_CHUNK_CHARS = 1200;
/** Chunks embedded per note; text past the last one is left to full-text search. */
export const NOTE_MAX_CHUNKS = 40;

// These text shapes are hashed and stored as content_hash, so changing one re-embeds every item.

/** The text embedded for a task. Status, priority and due date are left out so they never trigger a re-embed. */
export function taskText(t: { title: string; description: string | null }): string {
  const description = t.description ?? "";
  return description.trim() ? `Task: ${t.title}\n${description.slice(0, 1000)}` : `Task: ${t.title}`;
}

/**
 * The text embedded for an automation: its name, plus the message when the name does not
 * already contain it. Kind, schedule and run state are left out so the vector carries what the
 * automation is about and runs never trigger a re-embed.
 */
export function automationText(a: { name: string; message: string }): string {
  const name = a.name.trim();
  const message = a.message.trim();
  const fold = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
  if (!message || fold(name).includes(fold(message))) return name;
  return name ? `${name}\n${message.slice(0, 1000)}` : message.slice(0, 1000);
}

/**
 * Version of the embedded text shape per type. Raising one makes every row of that type a
 * change-check candidate once, so a new text shape is compared against the stored hashes.
 */
export const ITEM_TEXT_VERSIONS = { task: 1, automation: 2 } as const;

/** The source stamp stored with a task or automation vector: text version plus the row's updated_at. */
export function itemSourceStamp(type: keyof typeof ITEM_TEXT_VERSIONS, updatedAt: string): string {
  return `v${ITEM_TEXT_VERSIONS[type]}:${updatedAt}`;
}

/** Greedily joins pieces with `sep` into chunks of at most NOTE_CHUNK_CHARS. */
function pack(pieces: string[], sep: string, out: string[]): void {
  let current = "";
  for (const piece of pieces) {
    if (!current) current = piece;
    else if (current.length + sep.length + piece.length <= NOTE_CHUNK_CHARS) current += sep + piece;
    else {
      out.push(current);
      current = piece;
    }
  }
  if (current) out.push(current);
}

/** Splits text that has no usable break every NOTE_CHUNK_CHARS characters. */
function hardSplit(text: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += NOTE_CHUNK_CHARS) parts.push(text.slice(i, i + NOTE_CHUNK_CHARS));
  return parts;
}

/**
 * Splits a long note body into chunks of at most NOTE_CHUNK_CHARS: whole paragraphs where they
 * fit, then sentences, then fixed-width pieces. No overlap; at most NOTE_MAX_CHUNKS chunks.
 */
export function chunkNote(content: string): string[] {
  const chunks: string[] = [];
  let paragraphs: string[] = [];
  const flush = () => {
    pack(paragraphs, "\n\n", chunks);
    paragraphs = [];
  };
  for (const raw of content.split(/\n\s*\n/)) {
    const paragraph = raw.trim();
    if (!paragraph) continue;
    if (paragraph.length <= NOTE_CHUNK_CHARS) {
      paragraphs.push(paragraph);
      continue;
    }
    flush();
    const sentences = paragraph.split(/(?<=[.!?])\s+/).flatMap((s) => (s.length > NOTE_CHUNK_CHARS ? hardSplit(s) : [s]));
    pack(sentences, " ", chunks);
  }
  flush();
  return chunks.slice(0, NOTE_MAX_CHUNKS);
}

/**
 * The parts embedded for a note. Part 0 is the title row; the rest carry the body, whole for a
 * note up to NOTE_SPLIT_CHARS and chunked beyond it. The array index is the stored part number.
 */
export function noteParts(n: { title: string; content: string }): { text: string; body: string | null }[] {
  const parts: { text: string; body: string | null }[] = [{ text: `Note: ${n.title}`, body: null }];
  if (!n.content.trim()) return parts;
  const bodies = n.content.length <= NOTE_SPLIT_CHARS ? [n.content] : chunkNote(n.content);
  for (const body of bodies) parts.push({ text: `${n.title}: ${body}`, body });
  return parts;
}
