// @ts-check
// The agent-facing text (integrations/**, docs/agent-protocol.md, the MCP server's instructions and tool descriptions)
// only says how to handle feedback, never how to write or shape the document: the skills trigger on using Suiko, not
// on writing a document; the Claude Code skill opens with the one sentence that makes it harmless while the document
// is being written; no "write it once / never regenerate / never Write again" rule, no writing section; a document
// built from sources is edited at its sources and rebuilt, and so is a suggestion on it (every piece of `suiko apply`
// advice says so: `apply` patches only the built file, and the `reverted` refusal names that case); a change no
// thread asked for is undone where it was made (`suiko revert` restores only the built file), and no quoted fix line
// leads with `suiko revert`; the hand-overs point at the tool dock and "select text and press c", never at b or e
// (a document with its own key handling keeps those keys); the freshness advice passes on the command `open` prints
// instead of naming one; doc-id examples are what `open` names the file; the new protocol pieces (planned / APPLY,
// attachments, use: lines) and reading only the cited ranges are documented; the section numbers the commands cite
// exist. The docs quote what Suiko prints: the PROTOCOL, NEXT, EDITS and APPLY lines and the JSON `next` of real
// packets, the fix lines of a real refusal and the reason of the real pre-write hook (built here through the engine,
// in a temp workspace).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ops from '../../src/core/review/index.js';
import { preWrite } from '../../src/cli/hooks.js';
import { slugify } from '../../src/core/util/paths.js';
import { TOOLS } from '../../src/mcp/tools.js';
import { engineCtx, makeWorkspace, textCapture } from '../helpers/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** @param {string} dir @param {string[]} [out] */
function files(dir, out = []) {
  for (const name of fs.readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) files(rel, out);
    else if (/\.(md|toml|json)$/.test(name)) out.push(rel);
  }
  return out;
}

/** What agents read about Suiko: the integrations, the protocol doc and the MCP server's text. */
const AGENT_DOCS = [...files('integrations'), 'docs/agent-protocol.md'];
const AGENT_TEXT = [...AGENT_DOCS, 'src/mcp/server.js', 'src/mcp/tools.js'];
const SKILL = 'integrations/claude-code/skills/spec-review/SKILL.md';
const REFERENCE = 'integrations/claude-code/skills/spec-review/reference.md';
const SNIPPET = 'integrations/agents-md/AGENTS.snippet.md';
const PROTOCOL_DOC = 'docs/agent-protocol.md';
/** The texts that walk an agent through handling a packet. */
const PROTOCOL_TEXTS = [SKILL, REFERENCE, SNIPPET, PROTOCOL_DOC];

/** @param {string} text */
const description = (text) => /^description:\s*(.*)$/m.exec(text)?.[1] ?? '';

/**
 * The prose lines of a Markdown text: no fenced code blocks, and nothing about code reviews (a code review's files
 * are edited directly, so `suiko apply` is right there).
 * @param {string} text
 */
function proseLines(text) {
  const out = [];
  let fenced = false;
  let codeSection = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading) codeSection = /code (review|packet)|PR review/i.test(heading[2]);
    if (codeSection || /code review/i.test(line)) continue;
    out.push(line);
  }
  return out;
}

test('the skills trigger on using Suiko, never on writing a document', () => {
  for (const rel of [SKILL, 'integrations/agent-skills/suiko-review/SKILL.md']) {
    const d = description(read(rel));
    assert.match(d, /already exists/, rel);
    assert.match(d, /in Suiko/, rel);
    assert.doesNotMatch(d, /\bwhen (?:writing|you write)\b|\bwrit(?:e|ing) (?:a|one|the) (?:spec|doc)/i, rel);
    assert.doesNotMatch(d, /\bspecs?\b/i, `${rel}: no spec genre`);
  }
});

test('the Claude Code skill opens with the one sentence that leaves the writing alone', () => {
  const body = read(SKILL).split(/^# .*$/m)[1] ?? '';
  const first = body.trim().split('\n\n')[0];
  assert.match(first, /^If the document does not exist yet, write it first exactly as you would without Suiko, with whatever HTML, CSS, JavaScript, libraries, data files or build scripts the best document needs; nothing below applies until you run `suiko open`\.$/);
});

test('no agent-facing text tells the agent how to write the document or forbids rebuilding it', () => {
  const banned = [
    /write the (?:spec|doc|document) once/i,
    /never regenerate/i,
    /never (?:use )?Write\b/,
    /only whole-file write/i,
    /## (?:\d+\.\s*)?Writing the doc/i,
    /Never simplify, restructure or restyle/i,
    /Use Markdown by default|No CDN|static markup|Pretty-print/i,
  ];
  for (const rel of AGENT_TEXT) {
    const text = read(rel);
    for (const re of banned) assert.doesNotMatch(text, re, `${rel}: ${re}`);
  }
});

test('documents built from sources are changed at their sources and rebuilt', () => {
  for (const rel of PROTOCOL_TEXTS) {
    assert.match(read(rel), /built from sources[\s\S]{0,200}rebuild/i, rel);
  }
});

test('a suggestion on a document built from sources goes into the sources: every `suiko apply` advice says so', () => {
  const caveat = /built from sources|built (?:document|doc|file)\b|edit(?:ed)? directly|into (?:the|its) sources/i;
  for (const rel of PROTOCOL_TEXTS) {
    const advice = proseLines(read(rel)).filter((l) => /suiko apply/.test(l) && /suggest/i.test(l));
    assert.ok(advice.length > 0, `${rel}: says how suggestions are applied`);
    for (const line of advice) assert.match(line, caveat, `${rel}: \`suiko apply\` advice without the built-document caveat: ${line.trim().slice(0, 140)}`);
    // the refusal a rebuild that drops an applied suggestion gets is named
    assert.match(read(rel), /`?reverted`?/, `${rel}: names the reverted refusal`);
  }
  // the MCP surface: the instructions every client gets, and the apply tool itself
  const server = read('src/mcp/server.js');
  const instructions = /const INSTRUCTIONS = \[([\s\S]*?)\]\.join/.exec(server)?.[1] ?? '';
  assert.match(instructions, /suiko_apply for suggestions[\s\S]{0,120}built from sources[\s\S]{0,120}put the suggested text into the sources and rebuild/);
  const apply = TOOLS.find((t) => t.name === 'suiko_apply');
  assert.match(apply?.description ?? '', /built from sources[\s\S]*put the suggested text into the sources and rebuild/);
});

test('an unasked change is undone where it was made; `suiko revert` only restores the built file; no fix leads with it', () => {
  for (const rel of PROTOCOL_TEXTS) {
    const text = read(rel);
    assert.match(text, /undo (?:it|a change|an unasked change|the change)[^\n]{0,80}where you made it|undo it where it was made/i, `${rel}: undo it where it was made`);
    assert.match(text, /suiko revert[^\n]{0,80}restores only/, `${rel}: revert restores only the file it runs on`);
  }
  const revert = TOOLS.find((t) => t.name === 'suiko_revert');
  assert.match(revert?.description ?? '', /only the doc's file: for a doc built from sources, undo the change in the sources and rebuild/);
  // quoted refusals: the fix lines never lead with a revert (the old "fix: suiko revert <doc> --hunk hN or ...")
  for (const rel of [...AGENT_DOCS, 'README.md', 'docs/design.md']) {
    assert.doesNotMatch(read(rel), /fix: `?(?:suiko|specreview) revert/, `${rel}: a quoted fix line leads with revert`);
  }
});

test('the hand-overs point at the tool dock and "select text and press c", never at the b or e keys', () => {
  const handOvers = [
    [SKILL, /^3\. Tell the user: .*$/m],
    ['integrations/claude-code/commands/review-spec.md', /^5\. \*\*Hand over and end the turn\.\*\*.*$/m],
    ['integrations/gemini/commands/suiko-review.toml', /^2\. \*\*Open it\.\*\*.*$/m],
    ['integrations/opencode/commands/suiko-review.md', /^2\. \*\*Open it\.\*\*.*$/m],
  ];
  for (const [rel, re] of handOvers) {
    const line = /** @type {RegExp} */ (re).exec(read(/** @type {string} */ (rel)))?.[0] ?? '';
    assert.ok(line, `${rel}: hand-over found`);
    assert.match(line, /select(?:s|ing)? text and press(?:es|ing)? c\b/, `${rel}: select text and press c`);
    assert.match(line, /bottom of the document/, `${rel}: the tools at the bottom of the document`);
  }
  // a document with its own key handling keeps b and e (and other single keys) for itself: never promise them
  for (const rel of AGENT_TEXT) {
    assert.doesNotMatch(read(rel), /\b[Pp]ress(?:es|ing)? `?[beBE]`?(?![\w-])/, `${rel}: promises a b / e key`);
  }
});

test('the freshness advice passes on the command `open` names instead of naming one', () => {
  for (const rel of AGENT_TEXT) {
    // `suiko install --apply` alone would also configure every other agent it detects
    assert.doesNotMatch(read(rel), /suiko install (?:--project )?--apply\b/, `${rel}: hard-coded install command`);
  }
  assert.match(read(SKILL), /from an earlier version, pass it on to the user as printed: it names the command that updates them/);
  assert.match(read(SNIPPET), /from an earlier version, pass that line on to the user: it names the command that updates them/);
});

test('doc-id examples are what `open` names the file', () => {
  let checked = 0;
  for (const rel of [...AGENT_DOCS, 'README.md', 'docs/design.md']) {
    const text = read(rel);
    for (const m of text.matchAll(/tracking (\S+) as "([^"]+)"/g)) {
      if (m[1] === '…' || m[1] === 'agent') continue;
      assert.equal(m[2], slugify(m[1]), `${rel}: ${m[0]}`);
      checked++;
    }
    for (const m of text.matchAll(/SPECREVIEW FEEDBACK · ([\w-]+) \(([^)\s]+)\)/g)) {
      assert.equal(m[1], slugify(m[2]), `${rel}: ${m[0]}`);
      checked++;
    }
  }
  assert.ok(checked >= 6, `checked ${checked} examples`);
  for (const rel of [REFERENCE, PROTOCOL_DOC]) assert.match(read(rel), /\(HTML: 300 visible words\)/, `${rel}: the HTML size floor`);
});

test('the protocol pieces are documented: planned / APPLY, attachments, use: lines, reading only the cited ranges', () => {
  for (const rel of [SKILL, SNIPPET, PROTOCOL_DOC]) {
    const text = read(rel);
    for (const piece of ['EDITS: batch', '`planned`', 'APPLY', '--attach <file>', '"attachments"', '`use:`', 'cited ranges']) {
      assert.ok(text.includes(piece), `${rel}: ${piece}`);
    }
  }
  assert.match(read(SKILL), /Read with `offset`\/`limit`/);
});

test('examples are neutral: `suiko open <file>`, an HTML report, Markdown not first', () => {
  const skill = read(SKILL);
  assert.ok(skill.includes('suiko open <file>'));
  assert.doesNotMatch(skill, /docs\/specs\//);
  assert.match(skill, /suiko open \S+\.html/);
  for (const rel of ['integrations/claude-code/commands/review-spec.md', 'integrations/agent-skills/suiko-review/SKILL.md', 'integrations/gemini/commands/suiko-review.toml', 'integrations/opencode/commands/suiko-review.md']) {
    const text = read(rel);
    assert.doesNotMatch(text, /Markdown or HTML|\.md`, `\.markdown`, `\.html`/, `${rel}: HTML first`);
  }
  assert.match(read('integrations/claude-code/commands/review-spec.md'), /^argument-hint: <file>$/m);
});

test('the skill sections the commands cite exist', () => {
  const skill = read(SKILL);
  for (const name of fs.readdirSync(path.join(ROOT, 'integrations/claude-code/commands'))) {
    const text = read(`integrations/claude-code/commands/${name}`);
    for (const m of text.matchAll(/spec-review skill(?:,| \()section (\d+)(?: \(([^)]+)\))?/g)) {
      const heading = new RegExp(`^## ${m[1]}\\. ${m[2] ?? ''}`, 'm');
      assert.match(skill, heading, `${name} cites section ${m[1]}`);
    }
  }
});

// ------------------------------------------------------------------------------------------------ real output

/** One sentence per paragraph, long enough that each paragraph is over the deletion threshold. */
const P = {
  intro: 'This report looks at how funding spreads behaved on the trading desk over the last two years, which days put the desk under stress, and what the desk did about it on each of those days.',
  method: 'We read the trading desk feed for two years and kept every session with a complete order book and a settled close, then joined the trades to the quotes of the same session.',
  filter: 'Sessions with fewer than ten trades are dropped, because a thin session says more about the venue than about the cost of funding on that day, and halted sessions are split at the halt.',
  stress: 'Stress days cluster around month ends.',
  region: 'Europe is the widest region in every month of the window.',
  result: 'Funding spreads widened on 12 days, all of them after the March rate decision.',
  size: 'The spread widens on those days by about forty basis points and narrows again within a week, so no single day moves the monthly average of the desk very much at all.',
  caveat: 'The feed has no data for two exchange holidays, and the study treats those days as missing rather than as quiet days, which lowers the counts of the two months a little.',
  next: 'We will extend the window back to the year before once the archived feed is restored, and add the intraday view for every stress day that the desk flags in its own records.',
  appendix1: 'The appendix lists every session we dropped, with the reason, so that the desk can check the filters against its own records of thin sessions and of trading halts.',
  appendix2: 'It also lists the two holidays and the sessions around them, which the desk asked to see before it signs off on the monthly table and the chart that goes with it.',
};

const REPORT = [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8"><title>Funding study</title></head><body>',
  '<h1>Funding study</h1>',
  `<p>${P.intro}</p>`,
  '<h2>1. Method</h2>',
  `<p>${P.method}</p>`,
  `<p>${P.filter}</p>`,
  '<h2>2. Funding stress</h2>',
  `<p>${P.stress}</p>`,
  '<h2>3. Regions</h2>',
  `<p>${P.region}</p>`,
  '<h2>4. Results</h2>',
  `<p>${P.result}</p>`,
  `<p>${P.size}</p>`,
  '<h2>5. Caveats</h2>',
  `<p>${P.caveat}</p>`,
  '<h2>6. Next steps</h2>',
  `<p>${P.next}</p>`,
  '<p>Ask the desk for the raw data.</p>',
  '<h2>7. Appendix</h2>',
  `<p>${P.appendix1}</p>`,
  `<p>${P.appendix2}</p>`,
  '</body></html>',
  '',
].join('\n');

/**
 * A fix line with the ids, line labels and doc ids that vary between examples taken out.
 * @param {string} line
 */
function normFix(line) {
  return line
    .trim()
    .replace(/specreview/g, 'suiko')
    .replace(/\b(?:token-service|funding-study|report)\b/g, 'DOC')
    .replace(/\bh\d+\b/g, 'hN')
    .replace(/\bt\d+\b/g, 'tN')
    .replace(/"L\d+(?:-\d+)?(?:,L\d+(?:-\d+)?)*"/g, '"L…"');
}

/** @param {string} text */
const fixLines = (text) => text.split('\n').filter((l) => /^\s+fix: /.test(l));

test('the docs quote the refusal fix lines and the pre-write hook reason as Suiko prints them', async () => {
  const ws = await makeWorkspace({ files: [] });
  try {
    fs.mkdirSync(ws.file('reports'), { recursive: true });
    ws.write('reports/funding-study.html', REPORT);
    const ctx = await engineCtx(ws.root);
    const { doc } = await ops.openDoc(ctx, { path: 'reports/funding-study.html' });
    assert.equal(doc.id, 'funding-study');
    const v1 = await ctx.render(doc, 1);
    // the reviewer agrees on a sentence, comments and suggests a wording; the agent applies it (v2)
    await ops.addLock(ctx, doc.id, { capture: textCapture(v1, P.region) });
    const c1 = await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'kept every session'), body: 'Say how many.' });
    const s1 = await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'suggestion', capture: textCapture(v1, P.stress), body: 'Plainer.', suggestion: { mode: 'text', new: 'Stress days come in runs around month ends.' } });
    await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', draftIds: [c1.id, s1.id] });
    await ops.feedback(ctx, doc.id, {});
    ws.write('reports/funding-study.html', ws.read('reports/funding-study.html').replace('kept every session', 'kept all 488 sessions'));
    await ops.applySuggestions(ctx, doc.id, ['t2']);
    const v2rec = await ops.revise(ctx, doc.id, { threads: { t1: { status: 'addressed', reply: '488.' }, t2: { status: 'addressed', reply: 'Applied.' } } });
    assert.match(ops.formatReviseReport(v2rec), /recorded v2/);
    const v2 = await ctx.render(await ctx.store.getDoc(doc.id), 2);
    const c3 = await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v2, 'widened on 12 days'), body: 'Count over two years.' });
    await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', draftIds: [c3.id] });
    await ops.feedback(ctx, doc.id, {});

    // the agent rebuilds from sources that never got the suggestion, touches the agreed sentence, changes t3's
    // sentence and the next paragraph, rewrites three paragraphs and drops the appendix
    let work = ws.read('reports/funding-study.html')
      .replace('Stress days come in runs around month ends.', P.stress)
      .replace('widest region', 'broadest region')
      .replace(P.result, 'Over two years, funding spreads widened above 50 bp on 31 days.')
      .replace(P.size, 'Every one of those episodes faded over several sessions while the averages for each month barely moved, which the desk confirmed by looking at the monthly reports.');
    for (const key of /** @type {const} */ (['intro', 'caveat', 'next'])) {
      work = work.replace(P[key], 'Here a different sentence stands, written in other words about other matters entirely, and long enough to count as a rewrite of the whole paragraph it replaced.');
    }
    work = work.replace(`<h2>7. Appendix</h2>\n<p>${P.appendix1}</p>\n<p>${P.appendix2}</p>\n`, '');
    ws.write('reports/funding-study.html', work);
    const dry = await ops.revise(ctx, doc.id, { threads: { t3: { status: 'addressed', reply: 'Two years now.' } }, dryRun: true });
    const report = ops.formatReviseReport(dry);
    for (const code of ['deletion', 'lock', 'rewrite', 'reverted']) assert.match(report, new RegExp(`ERR ${code}: `), `the refusal has a ${code} error:\n${report}`);
    assert.match(report, /only because it overlaps/);
    assert.match(report, /"at":"del:h\d+"/);
    const printed = new Set(fixLines(report).map(normFix));
    for (const rel of [REFERENCE, PROTOCOL_DOC, 'docs/design.md']) {
      const quoted = fixLines(read(rel));
      assert.ok(quoted.length >= 2, `${rel}: quotes a refusal`);
      for (const line of quoted) assert.ok(printed.has(normFix(line)), `${rel}: a fix line Suiko does not print:\n${line.trim()}\nprinted:\n${[...printed].join('\n')}`);
    }

    // a Write that replaces the whole document: the hook asks, with the reason the docs quote
    const content = REPORT.replace(/<p>[^<]*<\/p>/g, '<p>Something else entirely.</p>');
    const out = /** @type {any} */ (preWrite({ tool_name: 'Write', cwd: ws.root, tool_input: { file_path: 'reports/funding-study.html', content } }, { env: { SPECREVIEW_HOME: ws.home }, cwd: ws.root }));
    assert.equal(out?.hookSpecificOutput?.permissionDecision, 'ask');
    const normReason = (/** @type {string} */ s) => s.replace(/\d+%/, 'N%').replace(/under review \([^)]*\)/, 'under review (…)');
    const reason = normReason(out.hookSpecificOutput.permissionDecisionReason);
    for (const rel of [REFERENCE, PROTOCOL_DOC]) {
      const quoted = /Suiko: this Write would replace \d+% of the visible text of [^"]*?--allow-rewrite`\./.exec(read(rel))?.[0] ?? '';
      assert.equal(normReason(quoted), reason, `${rel}: the hook reason as printed`);
    }
  } finally {
    await ws.cleanup();
  }
});

test('the docs quote the packet lines as Suiko prints them: PROTOCOL, NEXT, the JSON next, EDITS, APPLY', async () => {
  const ws = await makeWorkspace({ files: [] });
  try {
    fs.mkdirSync(ws.file('reports'), { recursive: true });
    ws.write('reports/funding-study.html', REPORT);
    const ctx = await engineCtx(ws.root);
    const { doc } = await ops.openDoc(ctx, { path: 'reports/funding-study.html' });
    const v1 = await ctx.render(doc, 1);
    const c1 = await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'comment', capture: textCapture(v1, 'widened on 12 days'), body: 'Count over two years.' });
    await ops.submitReview(ctx, doc.id, { verdict: 'changes_requested', draftIds: [c1.id] });
    const first = await ops.feedback(ctx, doc.id, {});
    const text = ops.formatPacket(first);
    const line = (/** @type {string} */ t, /** @type {string} */ prefix) => t.split('\n').find((l) => l.startsWith(prefix)) ?? '';
    const protocol = line(text, 'PROTOCOL: ');
    assert.match(protocol, /Suggestions: `suiko apply` \(for a doc built from sources: put the text into the sources and rebuild\)\./);
    for (const rel of [REFERENCE, PROTOCOL_DOC]) {
      const quoted = read(rel);
      assert.ok(quoted.includes(`${protocol}\n`), `${rel}: PROTOCOL as printed`);
      assert.ok(quoted.includes(line(text, 'NEXT: ')), `${rel}: NEXT as printed`);
      assert.ok(quoted.includes(`"next":"${first.next}"`), `${rel}: the JSON next as printed`);
    }
    assert.ok(read('docs/design.md').includes(protocol.replace('`suiko apply`', '`specreview apply`')), 'design.md: PROTOCOL as printed (with the v1 command name)');

    // a batched round: the EDITS line and a planned suggestion; then the APPLY line
    await ops.reply(ctx, doc.id, 't1', { body: 'Counted.', status: 'answered' });
    const s2 = await ops.saveDraft(ctx, doc.id, { kind: 'thread', type: 'suggestion', capture: textCapture(v1, P.stress), body: 'Plainer.', suggestion: { mode: 'text', new: 'Stress days come in runs around month ends.' } });
    await ops.submitReview(ctx, doc.id, { verdict: 'comment', draftIds: [s2.id], edits: 'batch' });
    const batch = ops.formatPacket(await ops.feedback(ctx, doc.id, {}));
    const edits = line(batch, 'EDITS: ');
    assert.ok(read(PROTOCOL_DOC).includes(edits), 'agent-protocol.md: the EDITS line as printed');
    assert.ok(read(REFERENCE).includes(edits.slice(0, edits.indexOf('now.') + 4)), 'reference.md: the EDITS line as printed');
    const plan = /suggestion: plan it now; it is applied in the APPLY round/.exec(batch)?.[0];
    assert.ok(plan, batch);
    for (const rel of [REFERENCE, PROTOCOL_DOC]) assert.ok(read(rel).includes(plan), `${rel}: the planned suggestion item`);
    await ops.reply(ctx, doc.id, 't2', { body: 'I will use your wording.', status: 'planned' });
    await ops.submitReview(ctx, doc.id, { verdict: 'comment', draftIds: [], apply: ['t2'], edits: 'batch' });
    const applyLine = line(ops.formatPacket(await ops.feedback(ctx, doc.id, {})), 'APPLY: ');
    assert.ok(applyLine, 'an APPLY packet');
    for (const rel of [REFERENCE, PROTOCOL_DOC]) assert.ok(read(rel).includes(applyLine), `${rel}: the APPLY line as printed`);
  } finally {
    await ws.cleanup();
  }
});
