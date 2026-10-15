// @ts-check
// The review engine's operations (design 4.4 "src/core/review/ops.js"). CLI, MCP server and daemon call these with
// a Ctx (context.js). Every mutating op is one per-doc critical section (Store.withDocLock, re-entrant) that runs
// recoverDoc first and appends store events (SSE names from protocol.js) after its commits. Agent ops (revise,
// reply, apply, edit, show, feedback, ask, reanchor, revert, final) acknowledge reviews delivered to the agent.
// The implementation lives in ./ops/*.js; this module is the stable import path.

export { createContext, resolveAgentName } from './context.js';

// docs and reading
export {
  openDoc, docState, listDocsAcrossWorkspaces, docsByActivity, status, log, sourceLines, closeSession, saveAttachment,
} from './ops/docs.js';
export { threads, show } from './ops/threads.js';

// reviewer: drafts, submit, threads, locks, recorded versions
export { resolveCapture, saveDraft, updateDraft, deleteDraft, listDrafts } from './ops/drafts.js';
export { submitReview } from './ops/submit.js';
export {
  resolveThread, unresolveThread, resolveThreads, unresolveThreads, acceptRevisions, unacceptRevisions, moveThread,
} from './ops/threads.js';
export { addLock, removeLock, relock } from './ops/locks.js';
export { recordReviewerVersion, applySuggestionAsReviewer } from './ops/revise.js';

// agent: feedback, edits, revisions, replies
export { feedback, buildDocPacket } from './ops/feedback.js';
export { waitForFeedback } from './ops/wait.js';
export { applySuggestions, taggedEdit, taggedEdits, revert } from './ops/edits.js';
export { revise, parseReviseInput } from './ops/revise.js';
export { openSnapshot, recordSnapshot, takeSnapshot } from './ops/snapshot.js';
export { reply, ask, reanchorThread } from './ops/threads.js';
export { finalize } from './ops/final.js';

// changes
export { changes, sourceDiffOp, unifiedDiff, threadMiniDiff, domTargets } from './ops/changes.js';

// code reviews (doc kind 'code'): `suiko review` / MCP suiko_review, and the daemon's D/files routes
export { openCodeReview, codeFiles, codeFileDiff, codeFileSource } from '../code/index.js';
