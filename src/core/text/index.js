// @ts-check
// Text utilities shared by render, diff and anchoring: line index, whitespace normalisation, entity decoding,
// markup-stripped projections and quote search.

export { lineIndex, linesOfRange } from './lines.js';
export { normalizeWs, collapseWs, squeezeWs, isWsCode } from './normalize.js';
export { decodeEntities, decodeEntity } from './entities.js';
export { toPlain } from './plain.js';
export { findQuote, sourceToPlainText, similarity, levenshtein, balanceMarkdown, balanceHtml } from './quote.js';
