// Performance budget (design 6.7): rendering a 200 KB spec must take < 500 ms (after module warm-up). Each
// measurement is the best of three runs so CPU contention from parallel test processes does not cause flakes.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SPECREVIEW_HOME ??= mkdtempSync(path.join(tmpdir(), 'sr-home-'));

const { renderSource } = await import('../../src/core/render/index.js');
const { changeSet, lineHunks } = await import('../../src/core/diff/index.js');

const BUDGET_MS = 500;

/** Best-of-n wall time of an async function. */
async function bestOf(n, fn) {
  let best = Infinity;
  let result;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    result = await fn();
    best = Math.min(best, performance.now() - t0);
  }
  return { ms: best, result };
}

/** A realistic ~200 KB Markdown spec: sections with prose, lists, tables, code, math and links. */
function bigMarkdown(targetBytes = 200 * 1024) {
  const parts = ['---\ntitle: Big spec\n---\n\n# Big spec\n'];
  let i = 0;
  while (parts.join('').length < targetBytes) {
    i++;
    parts.push(`
## ${i} Section ${i}

The **service ${i}** handles *requests* for [tenant ${i}](https://example.com/t/${i}) and stores state in \`table_${i}\`.
Tokens are rotated on every use; the previous token is invalidated after a grace window of $t_${i} = 30s$.

- Requirement ${i}.1: validate input &amp; reject malformed payloads.
- Requirement ${i}.2: emit \`event.${i}\` on success.
  - Nested detail for ${i}.
- [ ] Open task ${i}

| Field | Type | Notes |
|-------|------|-------|
| id_${i} | uuid | primary key |
| owner_${i} | string | indexed |

\`\`\`ts
export function handler${i}(req: Request): Response {
  return new Response(JSON.stringify({ ok: true, n: ${i} }));
}
\`\`\`

> Note ${i}: keep this section stable.
`);
  }
  return parts.join('');
}

/** A ~200 KB HTML spec. */
function bigHtml(targetBytes = 200 * 1024) {
  const parts = ['<!doctype html><html><head><meta charset="utf-8"><title>Big</title><style>p{margin:0}</style></head><body>\n'];
  let i = 0;
  while (parts.join('').length < targetBytes) {
    i++;
    parts.push(`<section id="s${i}"><h2>${i}. Section</h2>
<p>The <strong>service ${i}</strong> handles requests &amp; stores state in <code>table_${i}</code>.<br/>Second line.</p>
<ul><li>Requirement ${i}.1</li><li>Requirement ${i}.2 <a href="#s${i}">link</a></li></ul>
<table><tr><th>Field</th><th>Type</th></tr><tr><td>id_${i}</td><td>uuid</td></tr></table>
<svg viewBox="0 0 10 10"><g id="g${i}"><rect width="10" height="10"/><text>n${i}</text></g></svg>
<img src="img/arch.png" alt="diagram ${i}"/>
</section>
`);
  }
  parts.push('</body></html>\n');
  return parts.join('');
}

test(`render a 200 KB Markdown doc in < ${BUDGET_MS} ms`, async () => {
  await renderSource({ format: 'markdown', source: '# warm\n\n$x$ `y` **z**\n\n```ts\nlet a = 1;\n```\n', docPath: 'w.md' });
  const src = bigMarkdown();
  assert.ok(src.length >= 200 * 1024);
  const { ms, result: r } = await bestOf(3, () => renderSource({ format: 'markdown', source: src, docPath: 'docs/big.md' }));
  assert.ok(r.srcmap.order.length > 1000);
  assert.ok(ms < BUDGET_MS, `markdown render took ${ms.toFixed(0)} ms`);
});

test(`render a 200 KB HTML doc in < ${BUDGET_MS} ms`, async () => {
  await renderSource({ format: 'html', source: '<p>warm</p>', docPath: 'w.html' });
  const src = bigHtml();
  const { ms, result: r } = await bestOf(3, () => renderSource({ format: 'html', source: src, docPath: 'docs/big.html' }));
  assert.ok(r.srcmap.order.length > 1000);
  assert.ok(ms < BUDGET_MS, `html render took ${ms.toFixed(0)} ms`);
});

test(`changeSet over a 200 KB doc with scattered edits stays < ${BUDGET_MS} ms`, async () => {
  const a = bigMarkdown();
  const b = a.replace(/Note (\d+)0: keep/g, 'Note $10: please keep').replace(/Requirement (\d+)5\.2/g, 'Requirement $15.2 (updated)');
  const toRender = await renderSource({ format: 'markdown', source: b, docPath: 'docs/big.md' });
  const { ms, result: changes } = await bestOf(3, async () => {
    const hunks = lineHunks(a, b);
    return changeSet({ fromSource: a, toSource: b, toRender, format: 'markdown', hunks });
  });
  assert.ok(changes.hunks.length > 20);
  assert.ok(changes.hunks.every((h) => h.srids.length >= 1 && h.words.length >= 1));
  assert.ok(ms < BUDGET_MS, `changeSet took ${ms.toFixed(0)} ms`);
});
