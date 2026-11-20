/**
 * A guard for scripts/write-evidence-doc.ts: a rerun must never drop a
 * section from docs/EVIDENCE.md. Sections added by hand would otherwise be lost
 * on the next `npm run evidence-doc`, which rewrites the whole file.
 */

/** Markdown headings (`#` to `######`) outside fenced code blocks, trimmed. */
export function headings(markdown: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && /^#{1,6}\s/.test(line)) out.push(line.trim());
  }
  return out;
}

/** The headings of `current` that `next` would no longer have. */
export function droppedHeadings(current: string, next: string): string[] {
  const kept = new Set(headings(next));
  return headings(current).filter((h) => !kept.has(h));
}

/** GitHub's anchor for a heading's text: lower case, punctuation removed, spaces to hyphens. */
export function anchor(heading: string): string {
  return heading
    .replace(/^#+\s*/, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}
