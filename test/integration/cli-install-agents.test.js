// @ts-check
// The multi-agent installer: `specreview install` (no target) and `specreview uninstall`, against a temp HOME with
// fake config dirs for each agent (never the real home: HOME, PATH and SPECREVIEW_HOME are passed explicitly, and
// CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_CONFIG_HOME are only set where a test points them at temp dirs).
// Covers: detection (nothing installed, config dirs, binaries on PATH), the dry run, --apply, idempotency, merging
// with unrelated JSON/TOML/Markdown config, invalid JSON refused, uninstall restoring only our parts, --only/--skip,
// --project, env overrides, the Claude plugin double-install refusal, shared files, and `doctor`'s integrations list.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SR_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-home-install-agents-')));
process.env.SPECREVIEW_HOME = SR_HOME;

const { runCli, tempDir } = await import('./helpers/cli-harness.js');
const { BIN_PATH, PACKAGE_ROOT } = await import('../../src/cli/daemon-client.js');
const { hookCommand, planGateCommand, PLAN_GATE_TIMEOUT, claudeCommandFiles } = await import('../../src/cli/install.js');

const SNIPPET = fs.readFileSync(path.join(PACKAGE_ROOT, 'integrations', 'agents-md', 'AGENTS.snippet.md'), 'utf8').trimEnd();
const SKILL_SRC = path.join(PACKAGE_ROOT, 'integrations', 'claude-code', 'skills', 'spec-review');
/** @type {string[]} */
const cleanup = [SR_HOME];
after(() => {
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * A temp HOME (+ project dir with .git, + empty PATH dir) with the given directories and files.
 * @param {{ dirs?: string[], files?: Record<string, string>, bins?: string[] }} [o]
 */
function makeHome(o = {}) {
  const home = tempDir('home');
  const project = tempDir('proj');
  const bin = tempDir('bin');
  const srHome = tempDir('srhome');
  cleanup.push(home, project, bin, srHome);
  fs.mkdirSync(path.join(project, '.git'));
  for (const d of o.dirs ?? []) fs.mkdirSync(path.join(home, d), { recursive: true });
  for (const [rel, text] of Object.entries(o.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text);
  }
  for (const b of o.bins ?? []) fs.writeFileSync(path.join(bin, b), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  /** @type {Record<string, string>} */
  const env = { HOME: home, PATH: bin, SPECREVIEW_HOME: srHome };
  /**
   * @param {string[]} argv
   * @param {{ env?: Record<string, string>, platform?: string, cwd?: string, deps?: Record<string, any> }} [x]
   */
  const run = (argv, x = {}) =>
    runCli(argv, { cwd: x.cwd ?? project, env: { ...env, ...(x.env ?? {}) }, ...(x.platform ? { platform: x.platform } : {}), ...(x.deps ?? {}) });
  /** @param {string[]} argv @param {any} [x] */
  const json = async (argv, x) => {
    const r = await run([...argv, '--json'], x);
    return { ...r, j: JSON.parse(r.stdout) };
  };
  return { home, project, bin, srHome, env, run, json, p: (/** @type {string} */ rel) => path.join(home, rel) };
}

/**
 * Every file under a directory with its content (for "nothing written" / "restored" checks).
 * @param {string} dir
 * @returns {Record<string, string>}
 */
function snapshot(dir) {
  /** @type {Record<string, string>} */
  const out = {};
  const walk = (/** @type {string} */ rel) => {
    for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(r);
      else out[r] = fs.readFileSync(path.join(dir, r), 'utf8');
    }
  };
  walk('');
  return out;
}

const readJson = (/** @type {string} */ f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const read = (/** @type {string} */ f) => fs.readFileSync(f, 'utf8');
const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ALL_DIRS = ['.claude', '.codex/sessions', '.cursor', '.config/opencode', 'Library/Application Support/Claude'];
const ALL_FILES = { '.gemini/settings.json': '{}\n' };

describe('specreview install: detection and dry run', () => {
  test('nothing installed: says so, lists the unverified agents, writes nothing', async () => {
    const h = makeHome();
    const r = await h.run(['install']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^SpecReview install: dry run \(user scope\)\. Nothing is written without --apply\./);
    for (const name of ['Claude Code', 'Codex CLI', 'Gemini CLI', 'Cursor', 'OpenCode', 'Claude Desktop']) assert.match(r.stdout, new RegExp(`^${name}: not detected$`, 'm'));
    assert.match(r.stdout, /No supported agent detected\. Name one with --only/);
    assert.match(r.stdout, /Not configured \(unverified integration surface\):\n {2}Google Antigravity: .*\n {2}Devin Desktop \(Windsurf\): /);
    assert.deepEqual(snapshot(h.home), {});
    assert.deepEqual(fs.readdirSync(h.srHome), []);
    const { j } = await h.json(['install']);
    assert.ok(j.agents.every((/** @type {any} */ a) => a.status === 'not-detected' && !a.selected));
    assert.deepEqual(j.unverified.map((/** @type {any} */ u) => u.id), ['antigravity', 'devin']);
  });

  test('detects agents by config dir or binary on PATH; ~/.gemini alone (Antigravity) is not Gemini CLI', async () => {
    const h = makeHome({ dirs: ['.gemini', '.kiro'], bins: ['codex', 'cursor-agent', 'opencode'] });
    const { j } = await h.json(['install']);
    const byId = Object.fromEntries(j.agents.map((/** @type {any} */ a) => [a.id, a]));
    assert.deepEqual(byId.codex.evidence, ['codex on PATH']);
    assert.deepEqual(byId.cursor.evidence, ['cursor-agent on PATH']);
    assert.deepEqual(byId.opencode.evidence, ['opencode on PATH']);
    assert.deepEqual(byId.kiro.evidence, ['~/.kiro']);
    assert.equal(byId.gemini.detected, false);
    assert.equal(byId.claude.detected, false);
    assert.equal(j.agents.filter((/** @type {any} */ a) => a.selected).length, 4);
    // A ~/.codex that holds only skills another tool put there is not Codex; one Codex has used is.
    const h2 = makeHome({ dirs: ['.codex/skills/x'] });
    assert.equal((await h2.json(['install'])).j.agents.find((/** @type {any} */ a) => a.id === 'codex').detected, false);
    fs.writeFileSync(h2.p('.codex/config.toml'), '');
    assert.deepEqual((await h2.json(['install'])).j.agents.find((/** @type {any} */ a) => a.id === 'codex').evidence, ['~/.codex']);
  });

  test('dry run prints, per agent, the files, entries and blocks it would write, and writes nothing', async () => {
    const h = makeHome({ dirs: ALL_DIRS, files: ALL_FILES });
    const before = snapshot(h.home);
    const r = await h.run(['install'], { platform: 'darwin' });
    assert.equal(r.code, 0, r.stderr);
    const out = r.stdout;
    // Claude Code: skill, every command file, hooks with the plan gate (absolute node + script)
    assert.match(out, new RegExp(`would create ${esc(h.p('.claude/skills/spec-review/SKILL.md'))} {2}\\(copy of integrations/claude-code/skills/spec-review/SKILL\\.md`));
    for (const name of claudeCommandFiles()) assert.match(out, new RegExp(`would create ${esc(h.p(`.claude/commands/${name}`))}`));
    assert.match(out, new RegExp(`would create ${esc(h.p('.claude/settings.json'))} {2}\\(hooks: PreToolUse\\(Write\\) -> hook pre-write, UserPromptSubmit -> hook prompt, PermissionRequest\\(ExitPlanMode\\) -> plan-gate; other settings kept\\)`));
    assert.ok(out.includes(JSON.stringify(planGateCommand()).slice(1, -1)), 'the plan-gate command is printed');
    assert.match(out, /"timeout": 345600/);
    // Codex: AGENTS.md block, shared skill, config.toml block printed in full
    assert.match(out, new RegExp(`would create ${esc(h.p('.codex/AGENTS.md'))} {2}\\(new file with the SpecReview protocol block from integrations/agents-md/AGENTS\\.snippet\\.md`));
    assert.match(out, new RegExp(`would create ${esc(h.p('.agents/skills/specreview-review/SKILL.md'))} .*\\[shared with Cursor\\]`));
    assert.match(out, /\| \[mcp_servers\.specreview\]\n {6}\| command = ".+"\n {6}\| args = \[".+specreview\.js", "mcp"\]\n {6}\| tool_timeout_sec = 660/);
    // Gemini, Cursor, OpenCode, Claude Desktop
    assert.match(out, new RegExp(`would create ${esc(h.p('.gemini/GEMINI.md'))}`));
    assert.match(out, new RegExp(`would create ${esc(h.p('.gemini/commands/specreview-review.toml'))}`));
    assert.match(out, new RegExp(`would create ${esc(h.p('.cursor/mcp.json'))} {2}\\(mcpServers\\.specreview`));
    assert.match(out, /\| {7}"type": "stdio",/);
    assert.match(out, new RegExp(`would create ${esc(h.p('.config/opencode/AGENTS.md'))}`));
    assert.match(out, new RegExp(`would create ${esc(h.p('.config/opencode/commands/specreview-review.md'))}`));
    assert.match(out, new RegExp(`would create ${esc(h.p('.config/opencode/opencode.json'))} {2}\\(mcp\\.specreview`));
    assert.match(out, new RegExp(`would create ${esc(h.p('Library/Application Support/Claude/claude_desktop_config.json'))}`));
    assert.match(out, /`specreview` is not on PATH, so the installed instructions tell agents to run ".+" ".+specreview\.js" instead/);
    assert.match(out, /\nRun with --apply to write these changes\.\n$/);
    assert.deepEqual(snapshot(h.home), before, 'nothing written');
    assert.deepEqual(fs.readdirSync(h.srHome), [], 'no manifest in a dry run');
  });
});

describe('specreview install --apply', () => {
  test('writes the right files and entries for each agent; a second apply changes nothing', async () => {
    const h = makeHome({ dirs: ALL_DIRS, files: ALL_FILES });
    const r = await h.run(['install', '--apply'], { platform: 'darwin' });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^SpecReview install: applied \(user scope\)/);
    assert.match(r.stdout, /\nDone: \d+ files written\.\n$/);

    // Claude Code
    const skill = read(h.p('.claude/skills/spec-review/SKILL.md'));
    assert.match(skill, /^---\n[\s\S]*?\n---\n\n> \*\*On this machine `specreview` is not on PATH\.\*\*/, 'not-on-PATH note after the front matter');
    assert.equal(read(h.p('.claude/skills/spec-review/reference.md')), read(path.join(SKILL_SRC, 'reference.md')));
    assert.ok(claudeCommandFiles().length >= 1);
    for (const name of claudeCommandFiles()) assert.ok(fs.existsSync(h.p(`.claude/commands/${name}`)), name);
    const settings = readJson(h.p('.claude/settings.json'));
    assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Write', hooks: [{ type: 'command', command: hookCommand('pre-write'), timeout: 5 }] }]);
    assert.deepEqual(settings.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: hookCommand('prompt'), timeout: 5 }] }]);
    assert.deepEqual(settings.hooks.PermissionRequest, [{ matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: planGateCommand(), timeout: PLAN_GATE_TIMEOUT }] }]);
    assert.equal(PLAN_GATE_TIMEOUT, 345600);
    assert.equal(planGateCommand(), `"${process.execPath}" "${BIN_PATH}" plan-gate`);

    // Codex
    const agentsMd = read(h.p('.codex/AGENTS.md'));
    assert.ok(agentsMd.startsWith('<!-- specreview:begin'));
    assert.ok(agentsMd.trimEnd().endsWith('<!-- specreview:end -->'));
    assert.match(agentsMd, /^> \*\*On this machine `specreview` is not on PATH\.\*\*/m);
    const toml = read(h.p('.codex/config.toml'));
    assert.equal(
      toml,
      [
        '# specreview:begin (managed by `specreview install`; edits inside this block are replaced on reinstall)',
        '[mcp_servers.specreview]',
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify(BIN_PATH)}, "mcp"]`,
        'tool_timeout_sec = 660',
        '# specreview:end',
        '',
      ].join('\n'),
    );
    const agentSkill = read(h.p('.agents/skills/specreview-review/SKILL.md'));
    assert.match(agentSkill, /^---\nname: specreview-review\ndescription: /);
    assert.ok(agentSkill.includes('## Spec reviews (SpecReview)'), 'the protocol is inlined');
    assert.ok(!agentSkill.includes('<!-- specreview:protocol'), 'the placeholder is replaced');
    assert.ok(!agentSkill.includes('<!-- specreview:begin'), 'no marker lines in a file we own');

    // Gemini
    assert.match(read(h.p('.gemini/GEMINI.md')), /^<!-- specreview:begin/);
    const gcmd = read(h.p('.gemini/commands/specreview-review.toml'));
    assert.match(gcmd, /^description = "/m);
    assert.match(gcmd, /^prompt = '''\n> \*\*On this machine/m);
    assert.ok(gcmd.includes('{{args}}'));

    // Cursor
    assert.deepEqual(readJson(h.p('.cursor/mcp.json')), { mcpServers: { specreview: { type: 'stdio', command: process.execPath, args: [BIN_PATH, 'mcp'] } } });

    // OpenCode
    assert.match(read(h.p('.config/opencode/AGENTS.md')), /^<!-- specreview:begin/);
    assert.match(read(h.p('.config/opencode/commands/specreview-review.md')), /^---\ndescription: [\s\S]*\$ARGUMENTS/);
    assert.deepEqual(readJson(h.p('.config/opencode/opencode.json')), { mcp: { specreview: { type: 'local', command: [process.execPath, BIN_PATH, 'mcp'] } } });

    // Claude Desktop
    assert.deepEqual(readJson(h.p('Library/Application Support/Claude/claude_desktop_config.json')), { mcpServers: { specreview: { command: process.execPath, args: [BIN_PATH, 'mcp'] } } });

    // No backups for files that did not exist; the manifest records the copies
    assert.deepEqual(Object.keys(snapshot(h.home)).filter((f) => f.endsWith('.specreview-backup')), []);
    const manifest = readJson(path.join(h.srHome, 'install-manifest.json'));
    assert.ok(manifest.files[h.p('.claude/skills/spec-review/SKILL.md')].sha256.length === 1);

    // Idempotent
    const before = snapshot(h.home);
    const again = await h.json(['install', '--apply'], { platform: 'darwin' });
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(again.j.written, []);
    for (const a of again.j.agents.filter((/** @type {any} */ x) => x.selected)) {
      assert.equal(a.status, 'up-to-date', a.id);
      assert.ok(a.files.every((/** @type {any} */ f) => f.action === 'unchanged'), JSON.stringify(a.files));
    }
    assert.deepEqual(snapshot(h.home), before);
    const dry = await h.run(['install'], { platform: 'darwin' });
    assert.match(dry.stdout, /\nEverything is already installed; nothing to write\.\n$/);
  });

  test('specreview on PATH: instructions and copies carry no invocation note', async () => {
    const h = makeHome({ dirs: ['.claude', '.codex/sessions'], bins: ['specreview'] });
    const r = await h.run(['install', '--apply']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(read(h.p('.claude/skills/spec-review/SKILL.md')), read(path.join(SKILL_SRC, 'SKILL.md')));
    assert.equal(read(h.p('.codex/AGENTS.md')), `${SNIPPET}\n`);
    assert.ok(!read(h.p('.agents/skills/specreview-review/SKILL.md')).includes('not on PATH'));
    assert.doesNotMatch(r.stdout, /is not on PATH/);
  });

  test('updates in place when our content changed (an older block, an older copy recorded in the manifest)', async () => {
    const h = makeHome({ dirs: ['.codex/sessions'], files: { '.codex/AGENTS.md': '# Mine\n\n<!-- specreview:begin old -->\nold protocol\n<!-- specreview:end -->\n\nTrailer.\n' } });
    await h.run(['install', '--apply', '--only', 'codex']);
    const text = read(h.p('.codex/AGENTS.md'));
    assert.ok(text.startsWith('# Mine\n\n<!-- specreview:begin (managed'));
    assert.ok(text.endsWith('<!-- specreview:end -->\n\nTrailer.\n'));
    assert.equal(text.match(/specreview:begin/g)?.length, 1, 'replaced, not duplicated');
    // A copy we wrote earlier (recorded in the manifest) is replaced without a backup.
    const skill = h.p('.agents/skills/specreview-review/SKILL.md');
    const manifestFile = path.join(h.srHome, 'install-manifest.json');
    const old = 'old version of our skill\n';
    fs.writeFileSync(skill, old);
    const m = readJson(manifestFile);
    m.files[skill].sha256.push((await import('node:crypto')).createHash('sha256').update(old).digest('hex'));
    fs.writeFileSync(manifestFile, JSON.stringify(m));
    const r = await h.json(['install', '--apply', '--only', 'codex']);
    assert.deepEqual(r.j.written, [skill]);
    assert.equal(fs.existsSync(`${skill}.specreview-backup`), false);
    // A file at that path that SpecReview did not write is backed up once before it is replaced.
    fs.writeFileSync(skill, 'my own skill\n');
    const r2 = await h.run(['install', '--apply', '--only', 'codex']);
    assert.match(r2.stdout, /replaces a file SpecReview did not write \(backed up to SKILL\.md\.specreview-backup\)/);
    assert.equal(read(`${skill}.specreview-backup`), 'my own skill\n');
  });
});

describe('merging with existing config, and uninstall', () => {
  const settings = {
    model: 'opus',
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] },
        { matcher: 'Write', hooks: [{ type: 'command', command: 'specreview hook pre-write', timeout: 5 }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    },
  };
  const settingsText = `${JSON.stringify(settings, null, 2)}\n`;
  const cursorText = `${JSON.stringify({ mcpServers: { other: { command: 'x', args: ['--y'] } } }, null, 4)}\n`;
  const opencodeText = `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { other: { type: 'local', command: ['o'] } }, theme: 'dark' }, null, 2)}\n`;
  const tomlText = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\nargs = ["y"]\n';
  const mdText = '# My rules\n\nBe nice.\n';
  const files = {
    '.claude/settings.json': settingsText,
    '.cursor/mcp.json': cursorText,
    '.config/opencode/opencode.json': opencodeText,
    '.config/opencode/AGENTS.md': mdText,
    '.codex/config.toml': tomlText,
    '.codex/AGENTS.md': mdText,
    '.gemini/settings.json': '{"theme": "x"}\n',
    '.gemini/GEMINI.md': mdText,
  };

  test('JSON, TOML and Markdown: only our entry/block is added, the rest kept; backups made once; uninstall restores', async () => {
    const h = makeHome({ files });
    const before = snapshot(h.home);
    const r = await h.run(['install', '--apply']);
    assert.equal(r.code, 0, r.stderr);

    const s = readJson(h.p('.claude/settings.json'));
    assert.equal(s.model, 'opus');
    assert.deepEqual(s.permissions, settings.permissions);
    assert.deepEqual(s.hooks.Stop, settings.hooks.Stop);
    assert.deepEqual(s.hooks.PreToolUse, [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] },
      { matcher: 'Write', hooks: [{ type: 'command', command: hookCommand('pre-write'), timeout: 5 }] },
    ], 'the old PATH-relative specreview hook is replaced, not duplicated');
    assert.equal(s.hooks.PermissionRequest[0].matcher, 'ExitPlanMode');

    const cursor = read(h.p('.cursor/mcp.json'));
    assert.match(cursor, /^\{\n {4}"mcpServers": \{\n {8}"other"/, '4-space indentation kept');
    assert.deepEqual(readJson(h.p('.cursor/mcp.json')).mcpServers.other, { command: 'x', args: ['--y'] });

    const oc = readJson(h.p('.config/opencode/opencode.json'));
    assert.equal(oc.theme, 'dark');
    assert.deepEqual(Object.keys(oc.mcp), ['other', 'specreview']);

    const toml = read(h.p('.codex/config.toml'));
    assert.ok(toml.startsWith(`${tomlText}\n# specreview:begin`), 'TOML: the original text is untouched, our block appended');
    for (const f of ['.codex/AGENTS.md', '.config/opencode/AGENTS.md', '.gemini/GEMINI.md']) {
      assert.ok(read(h.p(f)).startsWith(`${mdText}\n<!-- specreview:begin`), f);
    }

    for (const rel of Object.keys(files).filter((f) => f !== '.gemini/settings.json')) {
      assert.equal(read(`${h.p(rel)}.specreview-backup`), files[/** @type {keyof typeof files} */ (rel)], `backup of ${rel}`);
    }
    // A second apply does not touch the backups (one-time) and changes nothing.
    const again = await h.json(['install', '--apply']);
    assert.deepEqual(again.j.written, []);

    // Uninstall: dry run first, then apply.
    const dry = await h.run(['uninstall']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /^SpecReview uninstall: dry run/);
    assert.match(dry.stdout, new RegExp(`would update ${esc(h.p('.codex/config.toml'))} {2}\\(removes the \\[mcp_servers\\.specreview\\] table`));
    assert.match(dry.stdout, new RegExp(`would delete ${esc(h.p('.claude/skills/spec-review/SKILL.md'))}`));
    assert.match(dry.stdout, /\nRun with --apply to remove these\.\n$/);
    const un = await h.run(['uninstall', '--apply']);
    assert.equal(un.code, 0, un.stderr);
    assert.match(un.stdout, /\nDone: \d+ files updated, \d+ removed\.\n$/);
    const afterUn = snapshot(h.home);
    // settings.json loses the PATH-relative `specreview hook pre-write` hook too (it runs specreview, so it is ours);
    // every other file is restored byte for byte.
    const expected = { ...before, '.claude/settings.json': `${JSON.stringify({ ...settings, hooks: { PreToolUse: [settings.hooks.PreToolUse[0]], Stop: settings.hooks.Stop } }, null, 2)}\n` };
    for (const [rel, text] of Object.entries(expected)) assert.equal(afterUn[rel], text, `${rel} restored`);
    const extra = Object.keys(afterUn).filter((f) => !(f in before) && !f.endsWith('.specreview-backup'));
    assert.deepEqual(extra, [], 'every file install created is gone');
    assert.equal(fs.existsSync(h.p('.claude/skills/spec-review')), false, 'the emptied skill dir is removed');
    const again2 = await h.run(['uninstall', '--apply']);
    assert.match(again2.stdout, /Nothing to remove\./);
  });

  test('an invalid JSON file is refused (never rewritten); the other agents are still configured', async () => {
    const h = makeHome({ dirs: ['.codex/sessions', '.config/opencode'], files: { '.cursor/mcp.json': '{ "mcpServers": { broken', '.config/opencode/opencode.json': '{\n  // comment\n  "theme": "x"\n}\n' } });
    const r = await h.run(['install', '--apply']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, new RegExp(`REFUSED ${esc(h.p('.cursor/mcp.json'))}: .*is not valid JSON`));
    assert.match(r.stdout, /fix: add "specreview": \{"type":"stdio".*\} under "mcpServers" by hand/);
    assert.match(r.stdout, new RegExp(`REFUSED ${esc(h.p('.config/opencode/opencode.json'))}: `));
    assert.match(r.stdout, /2 files were refused/);
    assert.match(r.stderr, /refused .*mcp\.json/);
    assert.equal(read(h.p('.cursor/mcp.json')), '{ "mcpServers": { broken');
    assert.equal(fs.existsSync(h.p('.cursor/mcp.json.specreview-backup')), false);
    assert.ok(fs.existsSync(h.p('.agents/skills/specreview-review/SKILL.md')), 'Cursor\'s other file is still written');
    assert.ok(fs.existsSync(h.p('.codex/AGENTS.md')), 'Codex is configured');
    assert.ok(fs.existsSync(h.p('.config/opencode/commands/specreview-review.md')));
    const un = await h.run(['uninstall', '--apply']);
    assert.equal(un.code, 1, 'uninstall refuses the invalid file too');
    assert.equal(read(h.p('.cursor/mcp.json')), '{ "mcpServers": { broken');
  });

  test('uninstall keeps a copy edited after install, and removes only our hooks', async () => {
    const h = makeHome({ dirs: ['.claude'] });
    await h.run(['install', '--apply']);
    const cmd = h.p('.claude/commands/review-spec.md');
    fs.appendFileSync(cmd, '\nmy own addition\n');
    const s = readJson(h.p('.claude/settings.json'));
    s.hooks.PreToolUse.push({ matcher: 'Edit', hooks: [{ type: 'command', command: 'my-linter' }] });
    fs.writeFileSync(h.p('.claude/settings.json'), JSON.stringify(s, null, 2));
    const r = await h.json(['uninstall', '--apply']);
    assert.equal(r.code, 0, r.stderr);
    const claude = r.j.agents.find((/** @type {any} */ a) => a.id === 'claude');
    assert.ok(claude.files.some((/** @type {any} */ f) => f.path === cmd && f.action === 'kept'), JSON.stringify(claude.files));
    assert.ok(fs.existsSync(cmd));
    assert.deepEqual(readJson(h.p('.claude/settings.json')), { hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'my-linter' }] }] } });
    assert.equal(fs.existsSync(h.p('.claude/skills/spec-review/SKILL.md')), false);
  });
});

describe('selection, scope and environment', () => {
  test('--only configures the named agents (even when not detected); --skip leaves agents out', async () => {
    const h = makeHome({ dirs: ['.claude', '.codex/sessions'] });
    const only = await h.json(['install', '--only', 'codex']);
    assert.deepEqual(only.j.agents.filter((/** @type {any} */ a) => a.selected).map((/** @type {any} */ a) => a.id), ['codex']);
    const cur = await h.json(['install', '--only', 'cursor,codex', '--apply']);
    assert.deepEqual(cur.j.agents.filter((/** @type {any} */ a) => a.selected).map((/** @type {any} */ a) => a.id), ['codex', 'cursor']);
    assert.ok(cur.j.agents.find((/** @type {any} */ a) => a.id === 'cursor').notes[0].includes('was not detected; configuring it because --only names it'));
    assert.ok(fs.existsSync(h.p('.cursor/mcp.json')));
    assert.equal(fs.existsSync(h.p('.claude/settings.json')), false, 'claude was not selected');
    const skip = await h.run(['install', '--skip', 'claude']);
    assert.match(skip.stdout, /^Claude Code: detected \(~\/\.claude\); skipped: skipped with --skip$/m);
    const alias = await h.json(['install', '--only', 'claude-code', '--only', 'codex-cli']);
    assert.deepEqual(alias.j.agents.filter((/** @type {any} */ a) => a.selected).map((/** @type {any} */ a) => a.id), ['claude', 'codex']);
  });

  test('usage errors: unknown or unverified agents, flags that belong to the single-target installers', async () => {
    const h = makeHome();
    const bad = await h.run(['install', '--only', 'vim']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--only: unknown agent "vim" \(agents: claude, codex, gemini, cursor, opencode, copilot, amp, droid, kiro, claude-desktop\)/);
    const unv = await h.run(['install', '--only', 'windsurf']);
    assert.equal(unv.code, 1);
    assert.match(unv.stderr, /Devin Desktop \(Windsurf\) is not supported yet/);
    assert.equal((await h.run(['install', '--with-hooks'])).code, 1);
    assert.equal((await h.run(['install', 'claude', '--only', 'codex'])).code, 1);
    assert.equal((await h.run(['install', 'codex'])).code, 1);
    assert.equal((await h.run(['install', '--user', '--project'])).code, 1);
    assert.equal((await h.run(['uninstall', 'codex'])).code, 1);
  });

  test('honours CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME, GEMINI_CLI_HOME and COPILOT_HOME', async () => {
    const h = makeHome();
    const alt = tempDir('alt');
    cleanup.push(alt);
    const env = {
      CLAUDE_CONFIG_DIR: path.join(alt, 'claude'),
      CODEX_HOME: path.join(alt, 'codex'),
      XDG_CONFIG_HOME: path.join(alt, 'xdg'),
      GEMINI_CLI_HOME: path.join(alt, 'ghome'),
      COPILOT_HOME: path.join(alt, 'copilot'),
    };
    for (const d of ['claude', 'codex/sessions', 'xdg/opencode', 'copilot']) fs.mkdirSync(path.join(alt, d), { recursive: true });
    fs.mkdirSync(path.join(alt, 'ghome', '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(alt, 'ghome', '.gemini', 'settings.json'), '{}');
    const r = await h.run(['install', '--apply'], { env });
    assert.equal(r.code, 0, r.stderr);
    for (const f of ['claude/settings.json', 'claude/skills/spec-review/SKILL.md', 'codex/AGENTS.md', 'codex/config.toml', 'xdg/opencode/AGENTS.md',
      'xdg/opencode/opencode.json', 'ghome/.gemini/GEMINI.md', 'ghome/.gemini/commands/specreview-review.toml', 'copilot/copilot-instructions.md']) {
      assert.ok(fs.existsSync(path.join(alt, f)), f);
    }
    assert.deepEqual(Object.keys(snapshot(h.home)).sort(), ['.agents/skills/specreview-review/SKILL.md'], 'only the shared skill goes under HOME');
  });

  test('--project writes the project-level files; a project AGENTS.md is shared; Claude Desktop has no project config', async () => {
    const h = makeHome({ dirs: ['.claude', '.codex/sessions', '.cursor', '.config/opencode', 'Library/Application Support/Claude'] });
    const r = await h.json(['install', '--project', '--apply'], { platform: 'darwin' });
    assert.equal(r.code, 0, r.stderr);
    const root = h.project;
    for (const f of ['.claude/settings.json', '.claude/skills/spec-review/SKILL.md', 'AGENTS.md', '.agents/skills/specreview-review/SKILL.md', '.codex/config.toml',
      '.cursor/mcp.json', '.opencode/commands/specreview-review.md', 'opencode.json']) {
      assert.ok(fs.existsSync(path.join(root, f)), f);
    }
    assert.equal(read(path.join(root, 'AGENTS.md')).match(/specreview:begin/g)?.length, 1);
    const desktop = r.j.agents.find((/** @type {any} */ a) => a.id === 'claude-desktop');
    assert.equal(desktop.status, 'skipped');
    assert.match(desktop.reason, /no project-level configuration/);
    assert.deepEqual(snapshot(h.home), {}, 'nothing under HOME');
    const codex = r.j.agents.find((/** @type {any} */ a) => a.id === 'codex');
    assert.deepEqual(codex.files.find((/** @type {any} */ f) => f.path.endsWith('AGENTS.md')).sharedWith, ['cursor', 'opencode']);
    // uninstall --project restores the project
    const un = await h.run(['uninstall', '--project', '--apply']);
    assert.equal(un.code, 0, un.stderr);
    assert.deepEqual(Object.keys(snapshot(root)).filter((f) => !f.startsWith('.git')), []);
  });

  test('Codex: AGENTS.override.md in use gets the block; an existing [mcp_servers.specreview] is left alone', async () => {
    const h = makeHome({ files: { '.codex/AGENTS.override.md': '# Override\n', '.codex/config.toml': '[mcp_servers.specreview]\ncommand = "specreview"\nargs = ["mcp"]\n' } });
    const r = await h.run(['install', '--apply', '--only', 'codex']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(read(h.p('.codex/AGENTS.override.md')), /^# Override\n\n<!-- specreview:begin/);
    assert.equal(fs.existsSync(h.p('.codex/AGENTS.md')), false);
    assert.match(r.stdout, /note: ~\/\.codex\/config\.toml already defines the specreview MCP server outside SpecReview's managed block; left as is\./);
    assert.equal(read(h.p('.codex/config.toml')), '[mcp_servers.specreview]\ncommand = "specreview"\nargs = ["mcp"]\n');
    await h.run(['uninstall', '--apply', '--only', 'codex']);
    assert.equal(read(h.p('.codex/AGENTS.override.md')), '# Override\n');
    assert.equal(read(h.p('.codex/config.toml')), '[mcp_servers.specreview]\ncommand = "specreview"\nargs = ["mcp"]\n', 'a server we did not add is not removed');
  });

  test('Gemini: the block goes to the configured context file; OpenCode: no AGENTS.md while it falls back to ~/.claude/CLAUDE.md', async () => {
    const h = makeHome({ dirs: ['.config/opencode'], files: { '.gemini/settings.json': '{"context": {"fileName": ["AGENTS.md"]}}', '.claude/CLAUDE.md': '# Claude rules\n' } });
    const r = await h.run(['install', '--apply', '--only', 'gemini,opencode']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(h.p('.gemini/AGENTS.md')));
    assert.equal(fs.existsSync(h.p('.gemini/GEMINI.md')), false);
    assert.equal(fs.existsSync(h.p('.config/opencode/AGENTS.md')), false);
    assert.match(r.stdout, /Skipped the SpecReview protocol block: OpenCode reads ~\/\.claude\/CLAUDE\.md as its rules only while ~\/\.config\/opencode\/AGENTS\.md does not exist/);
    assert.ok(fs.existsSync(h.p('.config/opencode/commands/specreview-review.md')));
  });
});

describe('Claude Code plugin and shared files', () => {
  test('an installed SpecReview plugin: Claude Code is skipped with an explanation (hooks would run twice)', async () => {
    const plugins = JSON.stringify({ version: 2, plugins: { 'specreview@specreview': [{ scope: 'user', installPath: '/x', version: '0.1.0' }] } });
    const h = makeHome({ dirs: ['.codex/sessions'], files: { '.claude/plugins/installed_plugins.json': plugins } });
    const r = await h.json(['install', '--apply']);
    assert.equal(r.code, 0, r.stderr);
    const claude = r.j.agents.find((/** @type {any} */ a) => a.id === 'claude');
    assert.equal(claude.status, 'skipped');
    assert.match(claude.reason, /the SpecReview Claude Code plugin is installed \(specreview@specreview, ~\/\.claude\/plugins\/installed_plugins\.json\)/);
    assert.match(claude.reason, /would run every hook twice/);
    assert.match(claude.reason, /claude plugin uninstall specreview@specreview/);
    assert.equal(fs.existsSync(h.p('.claude/settings.json')), false);
    assert.equal(fs.existsSync(h.p('.claude/skills')), false);
    assert.ok(fs.existsSync(h.p('.codex/AGENTS.md')), 'other agents are configured');
    const text = await h.run(['install', '--only', 'claude']);
    assert.match(text.stdout, /^Claude Code: detected \(~\/\.claude\); skipped: the SpecReview Claude Code plugin is installed/m);
    // A plugin disabled in settings does not count; one enabled only in the project's settings does.
    const h2 = makeHome({ files: { '.claude/plugins/installed_plugins.json': plugins, '.claude/settings.json': '{"enabledPlugins": {"specreview@specreview": false}}' } });
    assert.equal((await h2.json(['install'])).j.agents[0].status, 'planned');
    fs.mkdirSync(path.join(h2.project, '.claude'));
    fs.writeFileSync(path.join(h2.project, '.claude', 'settings.json'), '{"enabledPlugins": {"specreview@local": true}}');
    assert.equal((await h2.json(['install'])).j.agents[0].status, 'skipped');
  });

  test('the shared skill stays while an agent left out of the uninstall still uses it', async () => {
    const h = makeHome({ dirs: ['.codex/sessions', '.cursor'] });
    await h.run(['install', '--apply']);
    const skill = h.p('.agents/skills/specreview-review/SKILL.md');
    const r = await h.run(['uninstall', '--only', 'codex', '--apply']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`kept ${esc(skill)} {2}\\(kept: still used by Cursor\\)`));
    assert.ok(fs.existsSync(skill));
    assert.equal(fs.existsSync(h.p('.codex/AGENTS.md')), false);
    await h.run(['uninstall', '--only', 'cursor', '--apply']);
    assert.equal(fs.existsSync(skill), false, 'Codex (detected, but no longer configured) does not keep it');
    assert.equal(fs.existsSync(path.dirname(skill)), false);
    // Factory Droid's whole configuration is the shared skill: while Droid is detected, the skill stays.
    const d = makeHome({ dirs: ['.codex/sessions', '.factory'] });
    await d.run(['install', '--only', 'codex', '--apply']);
    const r2 = await d.run(['uninstall', '--only', 'codex', '--apply']);
    assert.match(r2.stdout, /\(kept: still used by Factory Droid\)/);
    assert.ok(fs.existsSync(d.p('.agents/skills/specreview-review/SKILL.md')));
  });
});

describe('doctor lists the agent integrations', () => {
  test('configured, outdated, detected-but-not-configured', async () => {
    const h = makeHome({ dirs: ['.codex/sessions', '.cursor', '.claude'] });
    await h.run(['install', '--apply', '--only', 'codex,cursor']);
    fs.rmSync(h.p('.cursor/mcp.json'));
    const r = await h.run(['doctor'], { deps: { daemonStatus: async () => ({ running: false }) } });
    assert.match(r.stdout, /^ok {4}Codex CLI: SpecReview configured$/m);
    assert.match(r.stdout, /^WARN {2}Cursor: SpecReview configuration is incomplete or outdated \(run `specreview install --only cursor --apply`\)$/m);
    assert.match(r.stdout, /^ok {4}Claude Code: detected, SpecReview not configured/m);
    assert.doesNotMatch(r.stdout, /Gemini CLI/);
    const none = makeHome();
    const r2 = await none.run(['doctor'], { deps: { daemonStatus: async () => ({ running: false }) } });
    assert.match(r2.stdout, /^ok {4}agents: none detected/m);
  });
});
