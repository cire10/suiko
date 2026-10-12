// @ts-check
// The code-review engine (doc kind 'code'): one import point for the ops, the kind adapter and the daemon.
//
//   review.js   openCodeReview                       `suiko review`, MCP suiko_review
//   round.js    reviseCode, recordCodeRound          `revise` on a code doc; UI Re-snapshot / apply rounds
//   state.js    codeWorkingState                     the dirty state (kind adapter workingState)
//   capture.js  resolveCodeCapture, codeSuggestionFor  captures and suggestions (kind adapter capture)
//   forward.js  codeForwarder                        anchors across rounds (kind adapter forwarder)
//   packet.js   loadCodeSnapshot, describeCodeThread, codePacketLabel, codeLineBasis, codeNextStep
//   apply.js    applyCodeSuggestions                 suggestions written to the repo files
//   files.js    codeFiles, codeFileDiff, codeFileSource, codeChanges, codeUnifiedDiff, codeThreadMiniDiff
//   threads.js  askCode, reanchorCode
//
// WP0b ships these files as stubs with the frozen signatures (each throws UsageError('code review is not available
// in this build')); WP3 replaces their bodies and adds git.js, spec.js, snapshot.js and diff-text.js.

export { openCodeReview } from './review.js';
export { reviseCode, recordCodeRound } from './round.js';
export { codeWorkingState } from './state.js';
export { resolveCodeCapture, codeSuggestionFor } from './capture.js';
export { codeForwarder } from './forward.js';
export { loadCodeSnapshot, describeCodeThread, codePacketLabel, codeLineBasis, codeNextStep } from './packet.js';
export { applyCodeSuggestions } from './apply.js';
export { codeFiles, codeFileDiff, codeFileSource, codeChanges, codeUnifiedDiff, codeThreadMiniDiff } from './files.js';
export { askCode, reanchorCode } from './threads.js';

/** The message every stub throws (UsageError, exit 1) until the engine lands. */
export const CODE_NOT_AVAILABLE = 'code review is not available in this build';
