// @ts-check
// Unit tests for src/shared/vendor.js: every mapped directory exists in node_modules, the files the UI and the
// rendered docs load resolve, and traversal/unknown prefixes are rejected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { VENDOR_UI, VENDOR_DOC, resolveVendor, listVendorDirs } from '../../src/shared/vendor.js';

test('every mapped vendor directory exists', () => {
  for (const map of [VENDOR_UI, VENDOR_DOC]) {
    for (const [prefix, dir] of Object.entries(listVendorDirs(map))) {
      assert.ok(dir, `missing vendor dir for ${prefix}`);
      assert.ok(fs.statSync(dir).isDirectory(), prefix);
    }
  }
});

test('UI vendor files resolve', () => {
  for (const p of ['htm/preact/standalone.module.js', 'marked/marked.esm.js', 'dompurify/purify.es.mjs', 'diff/index.js']) {
    const abs = resolveVendor(VENDOR_UI, p);
    assert.ok(abs && fs.statSync(abs).isFile(), p);
  }
  assert.ok(resolveVendor(VENDOR_UI, '/htm/preact/standalone.module.js'), 'leading slash tolerated');
});

test('doc vendor files resolve', () => {
  for (const p of [
    'github-markdown-css/github-markdown-light.css',
    'github-markdown-css/github-markdown-dark.css',
    'highlight.js/styles/github.css',
    'highlight.js/styles/github-dark.css',
    'katex/katex.min.css',
    'mermaid/mermaid.min.js',
  ]) {
    const abs = resolveVendor(VENDOR_DOC, p);
    assert.ok(abs && fs.statSync(abs).isFile(), p);
  }
  const font = fs.readdirSync(path.dirname(/** @type {string} */ (resolveVendor(VENDOR_DOC, 'katex/katex.min.css'))) + '/fonts')[0];
  assert.ok(resolveVendor(VENDOR_DOC, `katex/fonts/${font}`), 'nested files resolve');
});

test('rejects traversal, unknown prefixes, directories and missing files', () => {
  for (const p of [
    'marked/../package.json',
    'marked/./marked.esm.js',
    'marked//marked.esm.js',
    'htm/../../package.json',
    'unknown/x.js',
    'marked/',
    'marked',
    'katex/fonts',
    'marked/nope.js',
    'marked\\marked.esm.js',
    'marked/marked.esm.js\0',
  ]) {
    assert.equal(resolveVendor(VENDOR_UI, p) ?? resolveVendor(VENDOR_DOC, p), null, JSON.stringify(p));
  }
  // marked's map points at marked/lib: the package root is not reachable
  assert.equal(resolveVendor(VENDOR_UI, 'marked/package.json'), null);
  // maps are separate allowlists
  assert.equal(resolveVendor(VENDOR_UI, 'katex/katex.min.css'), null);
});
