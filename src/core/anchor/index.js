// @ts-check
// Anchoring engine entry point (design 7, BUILD_AMENDMENTS 3.3, 3.4, 4.2, 4.5, 4.6):
//   createAnchor / anchorFromLines / anchorFromQuote / sectionRange   capture -> Anchor        (create.js)
//   reanchor                                                         Anchor on a -> on b      (reanchor.js)
//   fuzzyFind / exactFind                                            text relocation          (fuzzy.js)
//   elementFingerprint / fingerprintScore / FINGERPRINT_ACCEPT        element identity        (fingerprint.js)
//   describeAnchor / anchorLabel / elideDataUris                     packet presentation      (describe.js)
//   toDomTarget / mapAnchorToWorking                                 guest targets, live view (targets.js)

export { createAnchor, anchorFromLines, anchorFromQuote, sectionRange, codeTargetOf } from './create.js';
export { reanchor } from './reanchor.js';
export { fuzzyFind, exactFind, contextSim, UNIQUE_MIN_CHARS } from './fuzzy.js';
export {
  elementFingerprint, fingerprintScore, fingerprintOfElement, bestFingerprintMatch, anchorElement, ordinalOf,
  FINGERPRINT_ACCEPT,
} from './fingerprint.js';
export { describeAnchor, anchorLabel, regionLabel, elideDataUris } from './describe.js';
export { toDomTarget, mapAnchorToWorking } from './targets.js';
export { narrowMermaid, mermaidLabelIn } from './mermaid.js';
export { tableGrid, tableOf, findCell, cellInfoOf } from './table.js';
export { sridSpan, plainQuote, anchoringConfig, DEFAULT_ANCHORING, ELEMENT_ANCHOR_KINDS } from './util.js';
