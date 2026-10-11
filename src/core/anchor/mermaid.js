// @ts-check
// Mermaid node narrowing (design 7.2 "Mermaid node", BUILD_AMENDMENTS 3.3): a comment on a node of a rendered
// mermaid diagram is anchored on the fence line(s) that define the node, so the agent edits exactly those lines.
//
// Inside the diagram's verbatim content (SrcNode.c), lines mentioning the node id as a whole word are collected;
// when some of them also carry the node's label (the definition, e.g. `Gateway[API Gateway]`), only those are
// kept; failing that, lines that give the node a shape/label (`Gateway[...]`, after a label edit) are kept.
// Without an id match, lines containing the label are used. The result is the contiguous range of whole lines
// from the first to the last kept line; null when nothing matches (callers fall back to the whole fence).

/**
 * @typedef {import('../text/lines.js').LineIndex} LineIndex
 */

/** @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word matcher for a mermaid identifier (ids may contain '-' and '.', so only letters/digits/_ bound it).
 * @param {string} id
 */
function idMatcher(id) {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRe(id)}(?![A-Za-z0-9_])`);
}

/**
 * Narrow to the fence lines defining a node.
 * @param {string} source
 * @param {LineIndex} li
 * @param {{ contentStart: number, contentEnd: number }} content
 * @param {{ nodeId?: string|null, label?: string|null }} svg
 * @returns {{ start: number, end: number } | null}
 */
export function narrowMermaid(source, li, content, svg) {
  const nodeId = String(svg?.nodeId ?? '').trim();
  const label = String(svg?.label ?? '').replace(/\s+/g, ' ').trim();
  if (!nodeId && !label) return null;
  if (content.contentEnd <= content.contentStart) return null;
  const first = li.lineOf(content.contentStart);
  const last = li.lineOf(Math.max(content.contentStart, content.contentEnd - 1));
  /** @type {number[]} */
  const idLines = [];
  /** @type {number[]} */
  const labelLines = [];
  const re = nodeId ? idMatcher(nodeId) : null;
  for (let line = first; line <= last; line++) {
    const text = li.lineText(line).replace(/\s+/g, ' ');
    if (re && re.test(text)) idLines.push(line);
    if (label && text.includes(label)) labelLines.push(line);
  }
  let chosen = idLines;
  if (idLines.length) {
    // Prefer the definition: lines with the node's label, else lines giving the node a shape/label.
    const withLabel = label && label !== nodeId ? idLines.filter((l) => labelLines.includes(l)) : [];
    const defs = withLabel.length ? withLabel : idLines.filter((l) => mermaidLabelIn(li.lineText(l), nodeId) != null);
    if (defs.length) chosen = defs;
  }
  if (!chosen.length) chosen = labelLines;
  if (!chosen.length) return null;
  const a = chosen[0];
  const b = chosen[chosen.length - 1];
  return { start: Math.max(li.startOf(a), content.contentStart), end: Math.min(li.endOf(b), content.contentEnd) };
}

/**
 * The label a mermaid line gives a node, e.g. `Gateway[API Gateway]` -> 'API Gateway',
 * `participant G as Gateway` -> 'Gateway'. Null when the line does not define one.
 * @param {string} text
 * @param {string} nodeId
 * @returns {string|null}
 */
export function mermaidLabelIn(text, nodeId) {
  if (!nodeId) return null;
  const id = escapeRe(nodeId);
  const shape = new RegExp(
    `(?<![A-Za-z0-9_])${id}\\s*(?:\\[\\[|\\[\\(|\\(\\[|\\(\\(\\(|\\(\\(|\\[\\/|\\[\\\\|\\{\\{|\\[|\\(|\\{|>)\\s*"?([^"\\]\\)\\}\\n]*?)"?\\s*(?:\\]\\]|\\)\\]|\\]\\)|\\)\\)\\)|\\)\\)|\\/\\]|\\\\\\]|\\}\\}|\\]|\\)|\\})`,
  );
  const m = shape.exec(text);
  if (m && m[1].trim()) return m[1].trim();
  const alias = new RegExp(`\\b(?:participant|actor)\\s+${id}\\s+as\\s+(.+?)\\s*$`).exec(text);
  if (alias) return alias[1].trim();
  return null;
}
