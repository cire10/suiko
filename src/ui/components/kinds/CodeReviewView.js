// @ts-check
// PLACEHOLDER (WP0b): the code review's center view (WP4), in place of the doc frame: one diff card per file (a new
// DiffTable), line selection (captures {kind: 'line', file, side, startLine, endLine} through actions.js
// openComposer), "Comment on file" ({kind: 'file', file}), thread markers keyed `${file}:${side}:${line}`,
// registerKindFocus / registerKindSelection. Its root carries the ready marker [data-view="code"][data-ready]; it
// hides itself in History mode.
// Renders nothing until it is replaced; the kind seam (./index.js) already mounts it with the current DocState.

/** @param {{ ds: any }} _props */
export function CodeReviewView(_props) {
  return null;
}
