/**
 * The escaping boundary.
 *
 * NFR-C22: the spec is untrusted data. Every value that reaches markup passes
 * through one of these functions, and the security gate in `verify/` then
 * re-checks the *output* rather than trusting the escaper. Two independent
 * checks is deliberate: a bug in the escaper and a bug in the gate are
 * different bugs, and only one of them is reachable by an attacker.
 */

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

/** Escapes a value for use in element text or a double-quoted attribute. */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"'`]/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}

/** Escapes a value for a URL. Rejects anything that is not a safe scheme. */
export function safeUrl(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (raw === "") return "#";
  // Relative paths and fragments are always allowed; they cannot execute.
  if (raw.startsWith("/") || raw.startsWith("#") || raw.startsWith("./") || raw.startsWith("../")) {
    return escapeHtml(raw);
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  if (scheme === undefined) return escapeHtml(raw); // bare relative, e.g. "about"
  if (scheme !== "http" && scheme !== "https" && scheme !== "mailto" && scheme !== "tel") {
    return "#";
  }
  return escapeHtml(raw);
}

/** Formats a number of seconds as an ISO-8601 duration. */
export function secondsToIso(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `PT${whole}S`;
}

export function escapeJsonLd(value: unknown): string {
  // JSON-LD is embedded in a <script type="application/ld+json"> block, so it
  // must not contain a sequence that can close that element early.
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Minimal, dependency-free markdown subset: paragraphs, lists, bold, italic, code, links. */
export function renderMarkdown(source: string): string {
  const paragraphs = source
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  return paragraphs
    .map((block) => {
      const lines = block.split("\n");
      const isList = lines.every((line) => /^\s*([-*]|\d+\.)\s+/.test(line));
      if (isList) {
        const ordered = /^\s*\d+\./.test(lines[0] ?? "");
        const items = lines
          .map((line) => `<li>${inline(line.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>`)
          .join("");
        return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
      }
      if (block.startsWith("### ")) return `<h3>${inline(block.slice(4))}</h3>`;
      if (block.startsWith("## ")) return `<h2>${inline(block.slice(3))}</h2>`;
      if (block.startsWith("# ")) return `<h1>${inline(block.slice(2))}</h1>`;
      if (block.startsWith("> ")) return `<blockquote><p>${inline(block.slice(2))}</p></blockquote>`;
      return `<p>${inline(block)}</p>`;
    })
    .join("\n");
}

/** Inline formatting. Raw HTML in the source is escaped, never passed through. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2">$1</a>');
}

export interface Attrs {
  [key: string]: string | number | boolean | null | undefined;
}

/** Serializes an attribute map, skipping null/undefined/false. */
export function attrs(map: Attrs): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(map)) {
    if (value === null || value === undefined || value === false) continue;
    if (value === true) {
      parts.push(escapeHtml(key));
      continue;
    }
    parts.push(`${escapeHtml(key)}="${escapeHtml(value)}"`);
  }
  return parts.length > 0 ? " " + parts.join(" ") : "";
}

/**
 * Deterministic, collision-resistant class name from a block id. Avoids
 * `noUncheckedIndexedAccess` gymnastics at call sites and guarantees the value
 * is a safe CSS identifier.
 */
export function blockClass(id: string): string {
  return "b-" + id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
