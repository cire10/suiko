// @ts-check
// Workspace configuration (`.specreview/config.json`, design 5.3): defaults, merging and reviewer-name lookup.
// Merging is a deep merge over plain objects; a user value whose type differs from the default's (or an enum value
// outside its allowed set) is ignored with a warning, so a typo can never disable a guard silently.

import { execFile } from 'node:child_process';
import os from 'node:os';
import { createLogger } from '../util/log.js';

const log = createLogger('config');

/** @typedef {import('../../shared/types.js').Config} Config */

/**
 * The full default configuration (reviewer.name is resolved at runtime).
 * @returns {Config}
 */
export function defaultConfig() {
  return {
    schema: 1,
    reviewer: { name: '' },
    guards: {
      enforceLocks: true,
      maxRewriteRatio: 0.5,
      unexplainedWords: 20,
      unexplainedDeletionLines: 3,
      unexplainedDeletion: 'refuse',
      writeHook: 'deny',
      writeHookRatio: 0.4,
    },
    anchoring: { minScore: 0.65, minQuoteSim: 0.6, contextChars: 32 },
    render: { network: 'allow', mermaid: true, math: true, highlight: true },
    git: { autoCommit: false },
    assets: { maxBytes: 20971520 },
  };
}

/**
 * What `initStoreDir` writes into a new config.json: the defaults without the reviewer section (the reviewer name
 * is per person, not per repository).
 * @returns {Record<string, unknown>}
 */
export function defaultConfigFile() {
  const { reviewer: _reviewer, ...rest } = defaultConfig();
  return rest;
}

/** Allowed values of enum-like settings, by dotted path. */
const ENUMS = /** @type {Record<string, string[]>} */ ({
  'guards.unexplainedDeletion': ['refuse', 'warn', 'off'],
  'guards.writeHook': ['deny', 'warn', 'off'],
  'render.network': ['allow', 'block'],
});

/**
 * Deep-merges a user config over the defaults.
 * @param {Config} defaults
 * @param {unknown} user
 * @returns {Config}
 */
export function mergeConfig(defaults, user) {
  return /** @type {Config} */ (mergeInto(defaults, user, ''));
}

/**
 * @param {any} base
 * @param {any} over
 * @param {string} where dotted path for messages
 * @returns {any}
 */
function mergeInto(base, over, where) {
  if (!isPlainObject(over)) {
    if (over !== undefined && where) log.warn(`ignoring config ${where}: expected an object`);
    return structuredClone(base);
  }
  /** @type {Record<string, any>} */
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(over)) {
    const at = where ? `${where}.${key}` : key;
    if (!(key in base)) {
      out[key] = value; // unknown keys are kept (forward compatibility)
      continue;
    }
    const def = base[key];
    if (isPlainObject(def)) {
      out[key] = mergeInto(def, value, at);
    } else if (typeof value !== typeof def) {
      log.warn(`ignoring config ${at}: expected a ${typeof def}`);
    } else if (ENUMS[at] && !ENUMS[at].includes(/** @type {string} */ (value))) {
      log.warn(`ignoring config ${at}: expected one of ${ENUMS[at].join(', ')}`);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** @type {Map<string, Promise<string>>} */
const reviewerCache = new Map();

/**
 * Default reviewer name for a workspace: `git config user.name` (run in `cwd`), else the OS user name, else
 * 'reviewer'. Cached per directory for the life of the process.
 * @param {string} cwd
 * @returns {Promise<string>}
 */
export function defaultReviewerName(cwd) {
  let pending = reviewerCache.get(cwd);
  if (!pending) {
    pending = gitUserName(cwd).then((name) => name || osUserName() || 'reviewer');
    reviewerCache.set(cwd, pending);
  }
  return pending;
}

/**
 * @param {string} cwd
 * @returns {Promise<string>}
 */
function gitUserName(cwd) {
  return new Promise((resolve) => {
    try {
      execFile('git', ['config', 'user.name'], { cwd, timeout: 2000, windowsHide: true }, (err, stdout) => {
        resolve(err ? '' : String(stdout).trim());
      });
    } catch {
      resolve('');
    }
  });
}

/** @returns {string} */
function osUserName() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || '';
  }
}
