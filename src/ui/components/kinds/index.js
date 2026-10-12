// @ts-check
// The UI kind seam (design 2.14): what the doc view renders depends on the doc's kind (model.js docKindOf: 'file',
// 'snapshot', 'code'). App.js asks these dispatchers first and falls back to the spec-doc components when one returns
// null, so a kind's view is added here (and in its own files) without touching App.js again.
//
//   KindBanners({ds})  non-null REPLACES the banner stack (components/Banners.js): plan docs -> PlanBanner,
//                      code docs -> CodeBanner (which may render <Banners /> under its own banner)
//   KindMain({ds})     non-null replaces <DocFrame /> in main.center: code docs -> CodeReviewView
//   KindRail({ds})     non-null replaces <Outline /> in the left rail: code docs -> FileTree
//   KindSide({ds})     non-null replaces the side panel's Changes list (changes mode): code docs -> CodeSide
//   kindCaps(ds)       {frame, pick, snip, hide, pageErrors, applyNow, liveBanners, locks} (model.js, re-exported)
//
// The dispatchers are plain functions of the DocState (call them, do not mount them): they only pick a component,
// so `KindMain({ ds }) ?? html`<${DocFrame} />`` works. The kind components themselves are ordinary components that
// get `ds` (the current DocState) as a prop; they read everything else (version, mode, focus) with useStore and act
// through actions.js (openComposer, recordWorkingCopy, registerKindFocus, registerKindSelection...).
// WP0b ships the code components as placeholders that render nothing; WP4 replaces CodeReviewView, FileTree,
// CodeBanner and CodeSide, and WP1 PlanBanner.

import { html } from 'preact-htm';
import { docKindOf, kindCaps } from '../../model.js';
import { CodeBanner } from './CodeBanner.js';
import { CodeReviewView } from './CodeReviewView.js';
import { CodeSide } from './CodeSide.js';
import { FileTree } from './FileTree.js';
import { PlanBanner } from './PlanBanner.js';

export { kindCaps };

/** @typedef {any} DocState */

/** A plan snapshot (Claude Code plan mode). @param {DocState} ds */
function isPlanDoc(ds) {
  return docKindOf(ds) === 'snapshot' && ds?.doc?.origin?.type === 'plan';
}

/**
 * The banner of the doc's kind, replacing the banner stack; null keeps the stack.
 * @param {{ ds: DocState }} props
 */
export function KindBanners({ ds }) {
  if (!ds) return null;
  if (isPlanDoc(ds)) return html`<${PlanBanner} ds=${ds} />`;
  if (docKindOf(ds) === 'code') return html`<${CodeBanner} ds=${ds} />`;
  return null;
}

/**
 * The center view of the doc's kind, replacing the doc frame; null keeps the frame.
 * @param {{ ds: DocState }} props
 */
export function KindMain({ ds }) {
  return docKindOf(ds) === 'code' ? html`<${CodeReviewView} ds=${ds} />` : null;
}

/**
 * The left rail of the doc's kind, replacing the outline; null keeps the outline.
 * @param {{ ds: DocState }} props
 */
export function KindRail({ ds }) {
  return docKindOf(ds) === 'code' ? html`<${FileTree} ds=${ds} />` : null;
}

/**
 * The side panel's Changes list of the doc's kind (changes mode); null keeps ChangesView.
 * @param {{ ds: DocState }} props
 */
export function KindSide({ ds }) {
  return docKindOf(ds) === 'code' ? html`<${CodeSide} ds=${ds} />` : null;
}
