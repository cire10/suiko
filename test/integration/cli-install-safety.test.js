// @ts-check
// Safety cases of the multi-agent installer (`suiko install` / `uninstall` / `doctor`), each against a temp HOME
// (HOME, PATH and SPECREVIEW_HOME are passed explicitly; nothing reads or writes the real home directory):
//   - Codex config.toml: tables Codex adds inside Suiko's markers survive reinstall and uninstall; a suiko
//     server defined under [mcp_servers] (inline table, dotted key) or re-serialised without the begin marker is left
//     alone; unparseable TOML is refused; every result parses with Python's tomllib when it is available;
//   - Markdown markers that are not one well-formed pair are refused (no second block, no lost text);
//   - symlinked config files are written through (the link stays) and never deleted;
//   - a copy the user edited is backed up on every replacement, and the report names only backups made in that run;
//   - uninstall keeps a config file that existed before install (`{}`, `{"mcpServers": {}}`);
//   - a project with only CLAUDE.md gets no AGENTS.md from any agent;
//   - a write error does not abort the run: the other files are written, reported and recorded;
//   - doctor does not count the shared skill as another agent's configuration;
//   - the Claude Code plugin: scope-aware detection, leftover settings hooks reported;
//   - Gemini settings.json with comments; --project keeps machine-specific paths out of committed files;
//   - the node path written is the PATH entry (Homebrew's stable symlink), not the resolved versioned path.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SR_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-home-install-safety-')));
process.env.SPECREVIEW_HOME = SR_HOME;

const { runCli, tempDir } = await import('./helpers/cli-harness.js');
const { BIN_PATH } = await import('../../src/cli/daemon-client.js');

/** @type {string[]} */
const cleanup = [SR_HOME];
after(() => {
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * A temp HOME (+ project dir with .git, + PATH dir) with the given directories and files.
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
   * @param {{ env?: Record<string, string>, cwd?: string, deps?: Record<string, any> }} [x]
   */
  const run = (argv, x = {}) => runCli(argv, { cwd: x.cwd ?? project, env: { ...env, ...(x.env ?? {}) }, ...(x.deps ?? {}) });
  /** @param {string[]} argv @param {any} [x] */
  const json = async (argv, x) => {
    const r = await run([...argv, '--json'], x);
    return { ...r, j: JSON.parse(r.stdout) };
  };
  return { home, project, bin, srHome, env, run, json, p: (/** @type {string} */ rel) => path.join(home, rel) };
}

const read = (/** @type {string} */ f) => fs.readFileSync(f, 'utf8');
const readJson = (/** @type {string} */ f) => JSON.parse(read(f));
const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const doctorDeps = { deps: { daemonStatus: async () => ({ running: false }) } };

/** Python's tomllib, when available, as an independent TOML validator. */
const hasTomllib = spawnSync('python3', ['-I', '-c', 'import tomllib'], { encoding: 'utf8' }).status === 0;
/**
 * @param {string} text
 * @returns {any} the parsed document (null when no validator is available)
 */
function tomlParse(text) {
  if (!hasTomllib) return null;
  const r = spawnSync('python3', ['-I', '-c', 'import sys, json, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: text, encoding: 'utf8' });
  assert.equal(r.status, 0, `not valid TOML:\n${text}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

/**
 * What toml_edit does when Codex adds a table to a config.toml that ends with a comment: the comment is the
 * document's trailing decor, so the new table is written before it (inside our markers).
 * @param {string} text
 * @param {string} table e.g. '[projects."/home/me/a"]\ntrust_level = "trusted"'
 */
function codexAddsTable(text, table) {
  const at = text.lastIndexOf('# specreview:end');
  return `${text.slice(0, at)}${table}\n${text.slice(at)}`;
}

describe('Codex config.toml', () => {
  test('tables Codex writes inside the markers (project trust, codex mcp add) survive reinstall and uninstall', async () => {
    const h = makeHome({ files: { '.codex/config.toml': 'model = "o3"\n' } });
    assert.equal((await h.run(['install', '--only', 'codex', '--apply'])).code, 0);
    const toml = h.p('.codex/config.toml');
    let text = codexAddsTable(read(toml), '\n[projects."/home/me/a"]\ntrust_level = "trusted"');
    text = codexAddsTable(text, '\n[projects."/home/me/b"]\ntrust_level = "trusted"');
    text = codexAddsTable(text, '\n[mcp_servers.foo]\ncommand = "foo"');
    fs.writeFileSync(toml, text);
    tomlParse(text);

    const r = await h.run(['install', '--only', 'codex', '--apply'], { deps: { execPath: '/new/node' } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /moves \[projects\."\/home\/me\/a"\], \[projects\."\/home\/me\/b"\], \[mcp_servers\.foo\] \(found inside the markers, not Suiko's\) below them/);
    const after1 = read(toml);
    const doc = tomlParse(after1);
    if (doc) {
      assert.deepEqual(doc.projects, { '/home/me/a': { trust_level: 'trusted' }, '/home/me/b': { trust_level: 'trusted' } });
      assert.equal(doc.mcp_servers.foo.command, 'foo');
      assert.equal(doc.mcp_servers.suiko.command, '/new/node');
      assert.equal(doc.model, 'o3');
    }
    assert.match(after1, /# specreview:end\n\n\[projects\."\/home\/me\/a"\]\ntrust_level = "trusted"\n/, 'Codex\'s tables now follow the block');
    assert.match(after1, /tool_timeout_sec = 660\n# specreview:end\n/, 'the block holds only our table');
    // Stable: a second run changes nothing.
    assert.deepEqual((await h.json(['install', '--only', 'codex', '--apply'], { deps: { execPath: '/new/node' } })).j.written, []);

    // Codex adds yet another table (inside the markers again), then uninstall: only our part goes.
    fs.writeFileSync(toml, codexAddsTable(read(toml), '[projects."/home/me/c"]\ntrust_level = "untrusted"'));
    const un = await h.run(['uninstall', '--only', 'codex', '--apply']);
    assert.equal(un.code, 0, un.stderr);
    const left = read(toml);
    assert.doesNotMatch(left, /suiko/);
    const doc2 = tomlParse(left);
    if (doc2) {
      assert.deepEqual(Object.keys(doc2.projects).sort(), ['/home/me/a', '/home/me/b', '/home/me/c']);
      assert.deepEqual(doc2.mcp_servers, { foo: { command: 'foo' } });
    }
    assert.ok(left.startsWith('model = "o3"\n\n'), left);
    // The one-time backup still holds the original.
    assert.equal(read(`${toml}.specreview-backup`), 'model = "o3"\n');
  });

  test('without the end marker, only our table is replaced or removed; what follows it is kept', async () => {
    const h = makeHome({ files: { '.codex/config.toml': 'a = 1\n\n# specreview:begin\n[mcp_servers.suiko]\ncommand = "old"\n\n# trusted\n[projects."/x"]\ntrust_level = "trusted"\n' } });
    const r = await h.run(['install', '--only', 'codex', '--apply']);
    assert.equal(r.code, 0, r.stderr);
    const text = read(h.p('.codex/config.toml'));
    assert.match(text, /^a = 1\n\n# specreview:begin \(managed[^\n]*\n\[mcp_servers\.suiko\]\ncommand = "[^"]+"\nargs = [^\n]+\ntool_timeout_sec = 660\n# specreview:end\n\n# trusted\n\[projects\."\/x"\]\ntrust_level = "trusted"\n$/);
    tomlParse(text);
  });

  test('a suiko server under [mcp_servers] (inline table, dotted key, quoted key) is left alone, file unchanged', async () => {
    for (const body of [
      '[mcp_servers]\nsuiko = { command = "suiko", args = ["mcp"] }\n',
      '[mcp_servers]\nsuiko.command = "x"\nsuiko.args = ["mcp"]\n',
      '[mcp_servers]\n"suiko" = { command = "x" }\n',
      'mcp_servers.suiko.command = "x"\n',
      '[mcp_servers.suiko.env]\nA = "1"\n',
    ]) {
      const h = makeHome({ files: { '.codex/config.toml': body } });
      const r = await h.run(['install', '--only', 'codex', '--apply']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /already defines the suiko MCP server outside Suiko's managed block; left as is/, body);
      assert.equal(read(h.p('.codex/config.toml')), body);
      tomlParse(body);
    }
    const inline = makeHome({ files: { '.codex/config.toml': 'mcp_servers = { other = { command = "x" } }\n' } });
    const r = await inline.run(['install', '--only', 'codex', '--apply']);
    assert.match(r.stdout, /defines mcp_servers inline/);
    assert.equal(read(inline.p('.codex/config.toml')), 'mcp_servers = { other = { command = "x" } }\n');
  });

  test('our table re-serialised by Codex without the begin marker: install leaves it, uninstall reports it and drops the stray end line', async () => {
    const h = makeHome({ files: { '.codex/config.toml': 'model = "o3"\n' } });
    await h.run(['install', '--only', 'codex', '--apply']);
    const toml = h.p('.codex/config.toml');
    // `codex mcp add foo` (replace_mcp_servers) rebuilds [mcp_servers]: the begin comment (our table's decor) is lost.
    const rewritten = read(toml).replace(/^# specreview:begin[^\n]*\n/m, '[mcp_servers.foo]\ncommand = "foo"\n\n');
    fs.writeFileSync(toml, rewritten);
    const r = await h.run(['install', '--only', 'codex', '--apply']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /already defines the suiko MCP server outside Suiko's managed block; left as is\. \(A leftover "# specreview:end" line suggests Codex rewrote \[mcp_servers\]/);
    assert.equal(read(toml), rewritten);
    const un = await h.run(['uninstall', '--only', 'codex', '--apply']);
    assert.equal(un.code, 0, un.stderr);
    assert.match(un.stdout, /defines the suiko MCP server outside Suiko's markers .* so it is not removed; run `codex mcp remove suiko`/);
    const left = read(toml);
    assert.doesNotMatch(left, /# specreview:end/);
    assert.match(left, /\[mcp_servers\.suiko\]/, 'not ours any more: kept');
    tomlParse(left);
  });

  test('config.toml that cannot be parsed is refused and left as is', async () => {
    const h = makeHome({ files: { '.codex/config.toml': 'model = "o3\n' } });
    const r = await h.run(['install', '--only', 'codex', '--apply']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /REFUSED .*config\.toml: .*could not be parsed as TOML \(line 1: unterminated string\)/);
    assert.equal(read(h.p('.codex/config.toml')), 'model = "o3\n');
    assert.ok(fs.existsSync(h.p('.codex/AGENTS.md')), 'the other Codex files are still written');
  });
});

describe('Markdown markers', () => {
  test('a begin marker without its end marker, or two begin markers, is refused: no second block, no text lost', async () => {
    const h = makeHome({ dirs: ['.codex/sessions'] });
    await h.run(['install', '--only', 'codex', '--apply']);
    const md = h.p('.codex/AGENTS.md');
    const broken = `# My global rules\nAlways use tabs.\n\n${read(md).replace('<!-- specreview:end -->', '')}\n## My important notes\nNever push to main.\n`;
    fs.writeFileSync(md, broken);
    const r = await h.run(['install', '--only', 'codex', '--apply']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /REFUSED .*AGENTS\.md: .*its "<!-- specreview:begin" line has no "<!-- specreview:end -->" line after it/);
    assert.match(r.stdout, /fix: repair the markers by hand/);
    assert.equal(read(md), broken);
    const un = await h.run(['uninstall', '--only', 'codex', '--apply']);
    assert.equal(un.code, 1);
    assert.equal(read(md), broken, 'uninstall does not guess either');
    fs.writeFileSync(md, `${broken}\n<!-- specreview:begin x -->\nmore\n<!-- specreview:end -->\n`);
    const r2 = await h.run(['install', '--only', 'codex']);
    assert.match(r2.stdout, /it has 2 "<!-- specreview:begin" lines/);
    fs.writeFileSync(md, '# Mine\n<!-- specreview:end -->\n');
    assert.match((await h.run(['install', '--only', 'codex'])).stdout, /has a "<!-- specreview:end -->" line but no "<!-- specreview:begin" line/);
  });

  test('install agents-md refuses them too, and backs up the file it changes', async () => {
    const h = makeHome();
    const md = path.join(h.project, 'AGENTS.md');
    const broken = '# Team rules\n\n<!-- specreview:begin -->\nold text\n\n## Our build rules\nnpm test before push\n';
    fs.writeFileSync(md, broken);
    for (let i = 0; i < 2; i++) {
      const r = await h.run(['install', 'agents-md', '--apply']);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /its "<!-- specreview:begin" line has no "<!-- specreview:end -->" line after it/);
      assert.equal(read(md), broken, 'no second block, no text lost');
    }
    fs.writeFileSync(md, '# Team rules\n\nKeep this.\n');
    assert.equal((await h.run(['install', 'agents-md', '--apply'])).code, 0);
    assert.match(read(md), /Keep this\.[\s\S]*<!-- specreview:begin/);
    assert.equal(read(`${md}.specreview-backup`), '# Team rules\n\nKeep this.\n');
  });
});

describe('symlinked config files', () => {
  test('are written through (the link stays, its target changes) and never deleted by uninstall', async () => {
    const h = makeHome({ dirs: ['.claude', '.codex/sessions', 'dotfiles'] });
    fs.writeFileSync(h.p('dotfiles/settings.json'), '{\n  "model": "opus"\n}\n');
    fs.writeFileSync(h.p('dotfiles/config.toml'), 'model = "o3"\n');
    fs.writeFileSync(h.p('dotfiles/AGENTS.md'), '# Rules\n');
    fs.symlinkSync(h.p('dotfiles/settings.json'), h.p('.claude/settings.json'));
    fs.symlinkSync('../dotfiles/config.toml', h.p('.codex/config.toml'));
    fs.symlinkSync(h.p('dotfiles/AGENTS.md'), h.p('.codex/AGENTS.md'));
    const r = await h.run(['install', '--only', 'claude,codex', '--apply']);
    assert.equal(r.code, 0, r.stderr);
    for (const link of ['.claude/settings.json', '.codex/config.toml', '.codex/AGENTS.md']) {
      assert.ok(fs.lstatSync(h.p(link)).isSymbolicLink(), `${link} is still a symlink`);
      assert.ok(fs.lstatSync(`${h.p(link)}.specreview-backup`).isFile(), `${link} backup is a plain copy`);
    }
    assert.ok(readJson(h.p('dotfiles/settings.json')).hooks.PreToolUse, 'the target got the hooks');
    assert.match(read(h.p('dotfiles/config.toml')), /\[mcp_servers\.suiko\]/);
    assert.match(read(h.p('dotfiles/AGENTS.md')), /^# Rules\n\n<!-- specreview:begin/);
    const un = await h.run(['uninstall', '--only', 'claude,codex', '--apply']);
    assert.equal(un.code, 0, un.stderr);
    for (const link of ['.claude/settings.json', '.codex/config.toml', '.codex/AGENTS.md']) assert.ok(fs.lstatSync(h.p(link)).isSymbolicLink(), `${link} kept`);
    assert.deepEqual(readJson(h.p('dotfiles/settings.json')), { model: 'opus' });
    assert.equal(read(h.p('dotfiles/config.toml')), 'model = "o3"\n');
    assert.equal(read(h.p('dotfiles/AGENTS.md')), '# Rules\n');
  });

  test('a symlinked settings.json holding only our hooks is emptied, not deleted', async () => {
    const h = makeHome({ dirs: ['.claude', 'dotfiles'] });
    fs.writeFileSync(h.p('dotfiles/settings.json'), '{}\n');
    fs.symlinkSync(h.p('dotfiles/settings.json'), h.p('.claude/settings.json'));
    await h.run(['install', '--only', 'claude', '--apply']);
    await h.run(['uninstall', '--only', 'claude', '--apply']);
    assert.ok(fs.lstatSync(h.p('.claude/settings.json')).isSymbolicLink());
    assert.deepEqual(readJson(h.p('dotfiles/settings.json')), {});
  });
});

describe('backups and pre-existing files', () => {
  test('a copy the user edited is backed up on every replacement; the report names only backups made in that run', async () => {
    const h = makeHome({ dirs: ['.claude'], files: { '.codex/config.toml': 'model = "o3"\n' } });
    await h.run(['install', '--only', 'claude,codex', '--apply']);
    const cmd = h.p('.claude/commands/review-spec.md');
    fs.appendFileSync(cmd, 'MY EDIT 1\n');
    const r1 = await h.run(['install', '--only', 'claude,codex', '--apply']);
    assert.match(r1.stdout, /replaces an older or edited copy \(backed up to review-spec\.md\.specreview-backup\)/);
    assert.match(r1.stdout, new RegExp(`\\n {6}backup: ${esc(cmd)}\\.specreview-backup\\n`));
    assert.equal(r1.stdout.match(/ backup: /g)?.length, 1, 'config.toml was backed up by the first install, not now');
    fs.appendFileSync(cmd, 'MY EDIT 2\n');
    const dry = await h.run(['install', '--only', 'claude,codex']);
    assert.match(dry.stdout, /\(backed up to review-spec\.md\.specreview-backup-\d{8}T\d{6}Z\)/);
    // A change to config.toml in the same run: updated, but its one-time backup exists, so no backup line for it.
    fs.writeFileSync(h.p('.codex/config.toml'), `${read(h.p('.codex/config.toml'))}\n[tui]\nx = 1\n`.replace('tool_timeout_sec = 660', 'tool_timeout_sec = 1'));
    const r2 = await h.json(['install', '--only', 'claude,codex', '--apply']);
    const files = r2.j.agents.flatMap((/** @type {any} */ a) => a.files);
    const stamped = files.find((/** @type {any} */ f) => f.path === cmd).backup;
    assert.match(stamped, /review-spec\.md\.specreview-backup-\d{8}T\d{6}Z$/);
    assert.match(read(stamped), /\nMY EDIT 2\n$/, 'the second edit is kept');
    assert.doesNotMatch(read(stamped), /MY EDIT 1/);
    assert.match(read(`${cmd}.specreview-backup`), /MY EDIT 1\n$/, 'the first backup is untouched');
    assert.equal(files.find((/** @type {any} */ f) => f.path.endsWith('config.toml')).backup, undefined);
    assert.ok(r2.j.written.some((/** @type {string} */ f) => f.endsWith('config.toml')));
    const again = await h.run(['install', '--only', 'claude,codex', '--apply']);
    assert.doesNotMatch(again.stdout, / backup: /);
  });

  test('uninstall puts back a file of the user\'s that install replaced, instead of deleting it', async () => {
    const h = makeHome({ files: { '.claude/commands/review-spec.md': '# my own /review-spec\n' } });
    const cmd = h.p('.claude/commands/review-spec.md');
    assert.match((await h.run(['install', '--only', 'claude', '--apply'])).stdout, /backed up to review-spec\.md\.specreview-backup/);
    assert.notEqual(read(cmd), '# my own /review-spec\n');
    const un = await h.run(['uninstall', '--only', 'claude', '--apply']);
    assert.equal(un.code, 0, un.stdout);
    assert.match(un.stdout, /restores the file install replaced \(from review-spec\.md\.specreview-backup\)/);
    assert.equal(read(cmd), '# my own /review-spec\n');
  });

  test('uninstall keeps a config file that existed before install, with its empty containers', async () => {
    const h = makeHome({ dirs: ['.claude'], files: { '.claude/settings.json': '{}\n', '.cursor/mcp.json': '{"mcpServers": {}}\n', '.config/opencode/opencode.json': '{\n  "mcp": {},\n  "theme": "x"\n}\n' } });
    assert.equal((await h.run(['install', '--only', 'claude,cursor,opencode', '--apply'])).code, 0);
    const dry = await h.run(['uninstall', '--only', 'claude,cursor,opencode']);
    assert.doesNotMatch(dry.stdout, /would delete .*(settings|mcp|opencode)\.json/);
    const un = await h.run(['uninstall', '--only', 'claude,cursor,opencode', '--apply']);
    assert.equal(un.code, 0, un.stderr);
    assert.equal(read(h.p('.claude/settings.json')), '{}\n');
    assert.deepEqual(readJson(h.p('.cursor/mcp.json')), { mcpServers: {} });
    assert.equal(read(h.p('.config/opencode/opencode.json')), '{\n  "mcp": {},\n  "theme": "x"\n}\n');
    // Files install created are still deleted.
    assert.equal(fs.existsSync(h.p('.config/opencode/AGENTS.md')), false);
  });
});

describe('project scope', () => {
  test('a project with only CLAUDE.md gets no AGENTS.md from any agent, and one note says why', async () => {
    const h = makeHome({ dirs: ['.codex/sessions', '.config/opencode', '.config/amp'] });
    fs.writeFileSync(path.join(h.project, 'CLAUDE.md'), '# Team rules\n');
    const r = await h.run(['install', '--project', '--only', 'codex,opencode,amp', '--apply']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.existsSync(path.join(h.project, 'AGENTS.md')), false);
    assert.equal(r.stdout.match(/This project has CLAUDE\.md and no AGENTS\.md\. OpenCode and Amp read CLAUDE\.md only while AGENTS\.md does not exist/g)?.length, 1);
    assert.equal(r.stdout.match(/Did not create .*AGENTS\.md: this project has only CLAUDE\.md/g)?.length, 3);
    assert.ok(fs.existsSync(path.join(h.project, '.agents/skills/suiko-review/SKILL.md')), 'the skill still carries the protocol');
    // Once the team has an AGENTS.md, the block goes in.
    fs.writeFileSync(path.join(h.project, 'AGENTS.md'), '# Team rules\n');
    await h.run(['install', '--project', '--only', 'codex,opencode,amp', '--apply']);
    assert.match(read(path.join(h.project, 'AGENTS.md')), /^# Team rules\n\n<!-- specreview:begin/);
  });

  test('Claude Code hooks go to .claude/settings.local.json; a note lists the files with machine-specific paths', async () => {
    const h = makeHome({ dirs: ['.claude', '.cursor'] });
    const r = await h.run(['install', '--project', '--only', 'claude,cursor', '--apply']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(readJson(path.join(h.project, '.claude/settings.local.json')).hooks.PreToolUse);
    assert.equal(fs.existsSync(path.join(h.project, '.claude/settings.json')), false);
    assert.match(r.stdout, /These project files hold paths that exist only on this machine \(.+\): .*\.claude\/settings\.local\.json.*\.cursor\/mcp\.json.*\. Keep them out of version control/);
    // uninstall --project also cleans hooks that `install claude --project --with-hooks` put in settings.json.
    const legacy = await h.run(['install', 'claude', '--project', '--with-hooks', '--apply']);
    assert.equal(legacy.code, 0, legacy.stderr);
    assert.ok(fs.existsSync(path.join(h.project, '.claude/settings.json')));
    const un = await h.run(['uninstall', '--project', '--only', 'claude,cursor', '--apply']);
    assert.equal(un.code, 0, un.stderr);
    assert.equal(fs.existsSync(path.join(h.project, '.claude/settings.json')), false);
    assert.equal(fs.existsSync(path.join(h.project, '.claude/settings.local.json')), false);
  });
});

describe('write failures', () => {
  test('a file that cannot be written is reported; the others are written, reported and recorded', async () => {
    const h = makeHome({ dirs: ['.claude', '.codex/sessions', '.config/opencode'] });
    fs.writeFileSync(h.p('.config/opencode/commands'), 'a file where a directory should be\n');
    const r = await h.run(['install', '--apply']);
    assert.equal(r.code, 1);
    const cmd = h.p('.config/opencode/commands/suiko-review.md');
    assert.match(r.stdout, new RegExp(`NOT written: ${esc(cmd)}`));
    assert.match(r.stdout, new RegExp(`FAILED ${esc(cmd)}: could not write it: `));
    assert.match(r.stdout, /1 file could not be written \(see FAILED above\); the others were\./);
    assert.match(r.stdout, /Done: \d+ files written\./);
    for (const f of ['.claude/settings.json', '.codex/AGENTS.md', '.codex/config.toml', '.config/opencode/AGENTS.md', '.config/opencode/opencode.json']) assert.ok(fs.existsSync(h.p(f)), f);
    const manifest = readJson(path.join(h.srHome, 'install-manifest.json'));
    assert.ok(manifest.created.includes(h.p('.codex/config.toml')));
    assert.ok(manifest.files[h.p('.claude/skills/spec-review/SKILL.md')]);
    const { j } = await h.json(['install']);
    assert.equal(j.agents.find((/** @type {any} */ a) => a.id === 'codex').status, 'up-to-date');
  });

  test('a file that exists but cannot be read is refused, never replaced (suiko install and install claude)', { skip: process.getuid?.() === 0 && 'root reads any file' }, async () => {
    const h = makeHome({ files: { '.cursor/mcp.json': '{"mcpServers": {"github": {"command": "npx"}}}\n', '.claude/settings.json': '{"permissions": {"allow": ["Bash(ls)"]}}\n' } });
    for (const f of ['.cursor/mcp.json', '.claude/settings.json']) fs.chmodSync(h.p(f), 0o000);
    try {
      const r = await h.run(['install', '--only', 'cursor', '--apply']);
      assert.equal(r.code, 1);
      assert.match(r.stdout, /REFUSED .*mcp\.json: .*exists but cannot be read \(EACCES\); the file is left as is/);
      const one = await h.run(['install', 'claude', '--user', '--with-hooks', '--apply']);
      assert.equal(one.code, 1);
      assert.match(one.stderr, /settings\.json exists but cannot be read/);
    } finally {
      for (const f of ['.cursor/mcp.json', '.claude/settings.json']) fs.chmodSync(h.p(f), 0o600);
    }
    assert.match(read(h.p('.cursor/mcp.json')), /github/);
    assert.match(read(h.p('.claude/settings.json')), /Bash\(ls\)/);
  });

  test('a dangling symlink is not replaced', async () => {
    const h = makeHome({ dirs: ['.cursor'] });
    fs.symlinkSync(h.p('nowhere/mcp.json'), h.p('.cursor/mcp.json'));
    const r = await h.run(['install', '--only', 'cursor', '--apply']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /FAILED .*mcp\.json: could not write it: .* is a symlink to a missing file/);
    assert.ok(fs.lstatSync(h.p('.cursor/mcp.json')).isSymbolicLink());
  });
});

describe('doctor and the Claude Code plugin', () => {
  test('the shared skill does not make undetected agents look configured', async () => {
    const h = makeHome({ dirs: ['.codex/sessions', '.cursor'] });
    await h.run(['install', '--apply']);
    const r = await h.run(['doctor'], doctorDeps);
    assert.match(r.stdout, /^ok {4}Codex CLI: Suiko configured$/m);
    assert.match(r.stdout, /^ok {4}Cursor: Suiko configured$/m);
    assert.doesNotMatch(r.stdout, /Copilot|Amp|Droid/);
    // Droid, detected, is configured by the shared skill alone.
    fs.mkdirSync(h.p('.factory'));
    assert.match((await h.run(['doctor'], doctorDeps)).stdout, /^ok {4}Factory Droid: Suiko configured$/m);
  });

  test('plugin installed next to an earlier settings install: install and doctor warn that the hooks run twice', async () => {
    const h = makeHome({ dirs: ['.claude'] });
    await h.run(['install', '--only', 'claude', '--apply']);
    fs.mkdirSync(h.p('.claude/plugins'));
    fs.writeFileSync(h.p('.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'suiko@local': [{ scope: 'user', installPath: '/x' }] } }));
    const { j } = await h.json(['install', '--only', 'claude']);
    const claude = j.agents.find((/** @type {any} */ a) => a.id === 'claude');
    assert.equal(claude.status, 'skipped');
    assert.match(claude.reason, /WARNING: ~\/\.claude\/settings\.json also has 2 Suiko hooks from an earlier `suiko install`, so they run twice next to the plugin's \(suiko@local\)\. Remove the settings install with `suiko uninstall --only claude --apply`/);
    const doc = await h.run(['doctor'], doctorDeps);
    assert.match(doc.stdout, /^WARN {2}Claude Code: Suiko plugin installed \(suiko@local\), and ~\/\.claude\/settings\.json also has 2 Suiko hooks/m);
    const un = await h.run(['uninstall', '--only', 'claude', '--apply']);
    assert.equal(un.code, 0, un.stderr);
    assert.match(un.stdout, /The Suiko plugin is still installed \(suiko@local\)/);
    assert.match((await h.run(['doctor'], doctorDeps)).stdout, /^ok {4}Claude Code: Suiko plugin installed \(suiko@local\)$/m);
  });

  test('a plan gate in settings.json next to the plugin is not a double install: the plugin has no gate', async () => {
    const h = makeHome({ dirs: ['.claude'] });
    assert.equal((await h.run(['install', 'claude', '--with-plan-gate', '--apply'])).code, 0);
    fs.mkdirSync(h.p('.claude/plugins'));
    fs.writeFileSync(h.p('.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'suiko@local': [{ scope: 'user', installPath: '/x' }] } }));
    const { j } = await h.json(['install', '--only', 'claude']);
    assert.doesNotMatch(j.agents.find((/** @type {any} */ a) => a.id === 'claude').reason, /WARNING/);
    assert.match((await h.run(['doctor'], doctorDeps)).stdout, /^ok {4}Claude Code: Suiko plugin installed \(suiko@local\)$/m);
  });

  test('a plugin installed for another project does not block the install; one for this project does, with --scope', async () => {
    const h = makeHome({ dirs: ['.claude'] });
    const write = (/** @type {any[]} */ entries) => {
      fs.mkdirSync(h.p('.claude/plugins'), { recursive: true });
      fs.writeFileSync(h.p('.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'suiko@suiko': entries } }));
    };
    write([{ scope: 'project', projectPath: '/somewhere/else/repo-a', installPath: '/x' }]);
    assert.equal((await h.json(['install', '--only', 'claude'])).j.agents[0].status, 'planned');
    write([{ scope: 'project', projectPath: h.project, installPath: '/x' }]);
    const sub = path.join(h.project, 'src');
    fs.mkdirSync(sub);
    const { j } = await h.json(['install', '--only', 'claude'], { cwd: sub });
    assert.equal(j.agents[0].status, 'skipped');
    assert.match(j.agents[0].reason, /run `claude plugin uninstall suiko@suiko --scope project`/);
    write([{ scope: 'local', projectPath: h.project, installPath: '/x' }]);
    assert.match((await h.json(['install', '--only', 'claude'])).j.agents[0].reason, /--scope local`/);
  });
});

describe('agent config details', () => {
  test('Gemini: a settings.json with comments still sets the context file; an unparseable one is noted', async () => {
    const h = makeHome({ files: { '.gemini/settings.json': '// my settings\n{\n  /* context */ "context": {"fileName": "AGENTS.md"}, // trailing\n  "theme": "a // not a comment"\n}\n' } });
    const r = await h.run(['install', '--only', 'gemini', '--apply']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(h.p('.gemini/AGENTS.md')));
    assert.equal(fs.existsSync(h.p('.gemini/GEMINI.md')), false);
    await h.run(['uninstall', '--only', 'gemini', '--apply']);
    assert.equal(fs.existsSync(h.p('.gemini/AGENTS.md')), false);
    const bad = makeHome({ files: { '.gemini/settings.json': '{ "context": ' } });
    assert.match((await bad.run(['install', '--only', 'gemini'])).stdout, /settings\.json could not be parsed, so the protocol goes to GEMINI\.md/);
  });

  test('the node written is the PATH entry that resolves to this node (Homebrew\'s stable symlink), or SPECREVIEW_NODE', async () => {
    const h = makeHome({ dirs: ['.claude', '.cursor'] });
    const stable = path.join(h.bin, 'node');
    fs.symlinkSync(process.execPath, stable);
    const r = await h.run(['install', '--only', 'claude,cursor', '--apply']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readJson(h.p('.cursor/mcp.json')).mcpServers.suiko, { type: 'stdio', command: stable, args: [BIN_PATH, 'mcp'] });
    assert.equal(readJson(h.p('.claude/settings.json')).hooks.PreToolUse[0].hooks[0].command, `"${stable}" "${BIN_PATH}" hook pre-write`);
    // A `node` on PATH that is another node is not used; SPECREVIEW_NODE (install.sh) is, when it is this node.
    const other = makeHome({ dirs: ['.cursor'], bins: ['node'] });
    await other.run(['install', '--only', 'cursor', '--apply']);
    assert.equal(readJson(other.p('.cursor/mcp.json')).mcpServers.suiko.command, process.execPath);
    const viaEnv = makeHome({ dirs: ['.cursor'] });
    const link = path.join(tempDir('nodelink'), 'node');
    cleanup.push(path.dirname(link));
    fs.symlinkSync(process.execPath, link);
    await viaEnv.run(['install', '--only', 'cursor', '--apply'], { env: { SPECREVIEW_NODE: link } });
    assert.equal(readJson(viaEnv.p('.cursor/mcp.json')).mcpServers.suiko.command, link);
  });

  test('install claude writes the same node as suiko install, so neither sees the other\'s hooks as outdated', async () => {
    const h = makeHome({ dirs: ['.claude'] });
    const stable = path.join(h.bin, 'node');
    fs.symlinkSync(process.execPath, stable);
    assert.equal((await h.run(['install', 'claude', '--user', '--with-hooks', '--apply'])).code, 0);
    assert.equal(readJson(h.p('.claude/settings.json')).hooks.PreToolUse[0].hooks[0].command, `"${stable}" "${BIN_PATH}" hook pre-write`);
    const { j } = await h.json(['install', '--only', 'claude']);
    assert.equal(j.agents.find((/** @type {any} */ a) => a.id === 'claude').status, 'up-to-date');
  });
});
