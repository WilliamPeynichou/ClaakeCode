const BLOCK = /<spoken>([\s\S]*?)<\/spoken>/g;
const OPEN = "<spoken>";

const lastClosed = (text: string) => {
  let last: RegExpExecArray | null = null;
  for (const m of text.matchAll(BLOCK)) last = m as RegExpExecArray;
  return last;
};

/** Removes the last <spoken> block from displayed text; an unclosed tag (streaming) is pending. */
export function splitSpoken(text: string): { body: string; spoken: string | null; pending: boolean } {
  const closed = lastClosed(text);
  const open = text.lastIndexOf(OPEN);
  if (open >= 0 && (!closed || open > closed.index)) {
    return { body: text.slice(0, open).trimEnd(), spoken: text.slice(open + OPEN.length).trim(), pending: true };
  }
  if (!closed) return { body: text, spoken: null, pending: false };
  const body = (text.slice(0, closed.index) + text.slice(closed.index + closed[0].length)).trimEnd();
  return { body, spoken: closed[1].replace(/\s+/g, " ").trim(), pending: false };
}

export function extractSpoken(text: string): string | null {
  const closed = lastClosed(text);
  const spoken = closed?.[1].replace(/\s+/g, " ").trim();
  return spoken || null;
}
