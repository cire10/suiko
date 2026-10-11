// @ts-check
// Diff engine entry point (BUILD_AMENDMENTS 4.1): line hunks, offset mapping, word diffs and stats, the rendered
// change set, and source-mode diffs / unified patches.

export { lineHunks, countLines, splitLinesKeep } from './hunks.js';
export { offsetMapper } from './offsets.js';
export { wordDiff, hunkStats, hunkWordOps, rewriteRatio, countWords } from './words.js';
export { changeSet } from './changes.js';
export { sourceDiff, unifiedPatch } from './source-diff.js';
