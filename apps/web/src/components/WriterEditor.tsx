import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";

/**
 * A distraction-free Markdown editor.
 *
 * A transparent <textarea> sits on top of a syntax-highlighted mirror of the same
 * text (same font, same wrapping), so Markdown stays plain text while markers
 * are dimmed, headings/bold/italic are styled in place and done todos are struck
 * through. Focus mode dims everything except the paragraph being written.
 */

export type WriterHandle = {
  focus: () => void;
  toggleTaskAtCursor: () => void;
  insertTask: () => void;
};

const TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](\s|$)/;
const FENCE_RE = /^\s*(```|~~~)/;
const LIST_RE = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;

/** For each line, whether it sits inside (or on the edge of) a fenced code block, which has no todos. */
function fencedLines(lines: string[]): boolean[] {
  let open = false;
  return lines.map((line) => {
    if (FENCE_RE.test(line)) {
      open = !open;
      return true;
    }
    return open;
  });
}

/** Flip the checkbox on a given 0-based line. Exported for the preview renderer. */
export function toggleTaskLine(text: string, line: number): string {
  const lines = text.split("\n");
  const cur = lines[line] ?? "";
  const m = TASK_RE.exec(cur);
  if (!m || fencedLines(lines)[line]) return text;
  const idx = (m[1] ?? "").length + 1;
  lines[line] = cur.slice(0, idx) + (m[2] === " " ? "x" : " ") + cur.slice(idx + 1);
  return lines.join("\n");
}

export function taskStats(text: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  for (const [i, line] of lines.entries()) {
    const m = fenced[i] ? null : TASK_RE.exec(line);
    if (m) {
      total++;
      if (m[2] !== " ") done++;
    }
  }
  return { done, total };
}

// ---------- highlighting ----------

function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(~~[^~]+~~)|(\[[^\]]*\]\([^)]*\))|(https?:\/\/\S+)|(#[A-Za-z][\w-]*)/g;
  let last = 0;
  let i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const s = m[0];
    const k = `${keyBase}-${i++}`;
    if (m[1]) out.push(<span key={k} className="w-code"><span className="w-mark">`</span>{s.slice(1, -1)}<span className="w-mark">`</span></span>);
    else if (m[2]) out.push(<strong key={k}><span className="w-mark">{s.slice(0, 2)}</span>{s.slice(2, -2)}<span className="w-mark">{s.slice(-2)}</span></strong>);
    else if (m[3]) out.push(<em key={k}><span className="w-mark">{s[0]}</span>{s.slice(1, -1)}<span className="w-mark">{s.slice(-1)}</span></em>);
    else if (m[4]) out.push(<span key={k} className="line-through"><span className="w-mark">~~</span>{s.slice(2, -2)}<span className="w-mark">~~</span></span>);
    else if (m[5]) {
      const close = s.indexOf("](");
      out.push(<span key={k}><span className="w-mark">[</span><span className="w-link">{s.slice(1, close)}</span><span className="w-mark">{s.slice(close)}</span></span>);
    } else if (m[6]) out.push(<span key={k} className="w-link">{s}</span>);
    else out.push(<span key={k} className="w-tag">{s}</span>);
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function highlightLine(line: string, inFence: boolean, key: string): React.ReactNode {
  if (inFence || /^\s*(```|~~~)/.test(line)) return <span className="w-code-block">{line}</span>;
  const h = /^(#{1,6}\s+)(.*)$/.exec(line);
  if (h) return <span className="w-heading"><span className="w-mark">{h[1]}</span>{inline(h[2] ?? "", key)}</span>;
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return <span className="w-mark">{line}</span>;
  const q = /^(\s*>\s?)(.*)$/.exec(line);
  if (q) return <span className="w-quote"><span className="w-mark">{q[1]}</span>{inline(q[2] ?? "", key)}</span>;
  const t = TASK_RE.exec(line);
  if (t) {
    const done = t[2] !== " ";
    const rest = line.slice(t[0].length);
    return (
      <span className={cn(done && "w-done")}>
        <span className="w-mark">{t[1]}</span>
        <span className={cn("w-box", done && "w-box-done")}>[{t[2]}]</span>
        {t[3]}
        <span className={cn(done && "line-through")}>{inline(rest, key)}</span>
      </span>
    );
  }
  const l = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/.exec(line);
  if (l) return <><span className="w-bullet">{l[1]}</span>{inline(l[2] ?? "", key)}</>;
  return inline(line, key);
}

/** Paragraph (blank-line separated block) range containing the cursor line. */
function blockRange(lines: string[], cur: number): [number, number] {
  if (!lines[cur]?.trim()) return [cur, cur];
  let a = cur;
  let b = cur;
  while (a > 0 && lines[a - 1]?.trim()) a--;
  while (b < lines.length - 1 && lines[b + 1]?.trim()) b++;
  return [a, b];
}

// ---------- component ----------

type Props = {
  value: string;
  onChange: (v: string) => void;
  focusMode?: boolean;
  placeholder?: string;
  "aria-label"?: string;
};

export const WriterEditor = forwardRef<WriterHandle, Props>(function WriterEditor({ value, onChange, focusMode, placeholder, ...rest }, ref) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0);
  const lines = useMemo(() => value.split("\n"), [value]);
  const cursorLine = useMemo(() => value.slice(0, cursor).split("\n").length - 1, [value, cursor]);
  const [focusA, focusB] = focusMode ? blockRange(lines, cursorLine) : [-1, -1];

  /** Replace the textarea contents via execCommand so native undo keeps working. */
  const replace = (start: number, end: number, text: string, caret?: number) => {
    const el = ta.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(start, end);
    if (!document.execCommand("insertText", false, text)) {
      onChange(el.value.slice(0, start) + text + el.value.slice(end));
    }
    const pos = caret ?? start + text.length;
    el.setSelectionRange(pos, pos);
    setCursor(pos);
  };

  const lineBounds = (pos: number) => {
    const start = value.lastIndexOf("\n", pos - 1) + 1;
    const nl = value.indexOf("\n", pos);
    return [start, nl === -1 ? value.length : nl] as const;
  };

  const toggleTaskAt = (pos: number) => {
    const [s, e] = lineBounds(pos);
    const line = value.slice(s, e);
    const m = TASK_RE.exec(line);
    const keep = ta.current?.selectionStart ?? pos;
    if (m) {
      const i = s + (m[1] ?? "").length + 1;
      replace(i, i + 1, m[2] === " " ? "x" : " ", keep);
    } else {
      // Turn the line into a todo (keeping any existing bullet).
      const l = /^(\s*)(?:[-*+]\s+)?/.exec(line)!;
      const ins = `${l[1]}- [ ] `;
      replace(s, s + l[0].length, ins, keep - l[0].length + ins.length);
    }
  };

  useImperativeHandle(ref, () => ({
    focus: () => ta.current?.focus(),
    toggleTaskAtCursor: () => toggleTaskAt(ta.current?.selectionStart ?? value.length),
    insertTask: () => {
      const pos = ta.current?.selectionStart ?? value.length;
      const [s, e] = lineBounds(pos);
      if (!value.slice(s, e).trim()) replace(s, e, "- [ ] ");
      else replace(e, e, "\n- [ ] ");
    },
  }));

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const { selectionStart: ss, selectionEnd: se } = el;
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      toggleTaskAt(ss);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "b" || e.key === "i")) {
      e.preventDefault();
      const mark = e.key === "b" ? "**" : "_";
      const sel = value.slice(ss, se);
      replace(ss, se, `${mark}${sel}${mark}`, sel ? ss + sel.length + mark.length * 2 : ss + mark.length);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const [s] = lineBounds(ss);
      if (e.shiftKey) {
        const lead = /^ {1,2}/.exec(value.slice(s))?.[0].length ?? 0;
        if (lead) replace(s, s + lead, "", Math.max(s, ss - lead));
      } else if (LIST_RE.test(value.slice(s, lineBounds(ss)[1]))) {
        replace(s, s, "  ", ss + 2);
      } else {
        replace(ss, se, "  ");
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && ss === se) {
      const [s, end] = lineBounds(ss);
      const line = value.slice(s, end);
      const m = LIST_RE.exec(line);
      if (!m || ss < s + m[0].length) return;
      e.preventDefault();
      if (!line.slice(m[0].length).trim()) {
        // Empty item: end the list.
        replace(s, end, "");
        return;
      }
      const num = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2];
      replace(ss, ss, `\n${m[1]}${num}${m[5]}${m[6] ? "[ ] " : ""}`);
    }
  };

  // Clicking directly on a "[ ]" box toggles it, like a real checkbox.
  const onClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (el.selectionStart !== el.selectionEnd) return;
    const pos = el.selectionStart;
    const [s, end] = lineBounds(pos);
    const m = TASK_RE.exec(value.slice(s, end));
    if (!m) return;
    const boxStart = s + (m[1] ?? "").length;
    if (pos >= boxStart && pos <= boxStart + 3) toggleTaskAt(pos);
  };

  let fence = false;
  return (
    <div className={cn("writer relative grid", focusMode && "writer-focus")}>
      <div aria-hidden className="writer-layer pointer-events-none col-start-1 row-start-1">
        {lines.map((line, i) => {
          const fenceLine = /^\s*(```|~~~)/.test(line);
          const node = highlightLine(line, fence, `l${i}`);
          if (fenceLine) fence = !fence;
          const dim = focusMode && (i < focusA || i > focusB);
          return (
            <div key={i} className={cn("transition-opacity duration-200", dim && "opacity-25")}>
              {node}
              {line === "" ? "​" : null}
            </div>
          );
        })}
        {!value && placeholder && <div className="absolute inset-0 text-fg-subtle">{placeholder}</div>}
      </div>
      <textarea
        ref={ta}
        {...rest}
        value={value}
        spellCheck
        onChange={(e) => {
          onChange(e.target.value);
          setCursor(e.target.selectionStart);
        }}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        onClick={onClick}
        className="writer-layer col-start-1 row-start-1 h-full w-full resize-none overflow-hidden bg-transparent text-transparent caret-accent focus:outline-none"
      />
    </div>
  );
});
