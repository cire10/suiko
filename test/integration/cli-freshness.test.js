// @ts-check
// Integration freshness (install/freshness.js): every instruction file `suiko install` writes carries the Suiko version
// that wrote it, and `suiko open` (one stderr line) and `suiko doctor` (per agent) say when an installed Claude Code
// skill or a protocol block is older than the CLI: a copy marked with an older version, or one without a mark that
// differs from what install writes now. Current copies, copies the user edited without changing the version, and
// machines with no install say nothing. The line names the command that updates exactly the stale files: `suiko
// install --only <agents> --apply` (`--project` for the project's files; a shared file goes to the agent in use that
// writes the least besides it), `suiko install agents-md --apply` for an AGENTS.md block that command wrote; never a
// bare `suiko install --apply`, which configures every agent it detects. A temp HOME and project for every test;
// never the real home.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SR_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-home-freshness-')));
process.env.SPECREVIEW_HOME = SR_HOME;

const { runCli, tempDir } = await import('./helpers/cli-harness.js');
const { packageVersion } = await import('../../src/cli/daemon-client.js');
const { freshnessLine, installCommands, olderThan } = await import('../../src/cli/install/freshness.js');
const { installedVersion, stripInstallMarks } = await import('../../src/cli/install/files.js');

/** @type {string[]} */
const cleanup = [SR_HOME];
after(() => {
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
});

const VERSION = packageVersion();

/** A temp HOME, an empty PATH dir, a project (git) holding docs/report.html. */
function makeHome() {
  const home = tempDir('home');
  const project = tempDir('proj');
  const bin = tempDir('bin');
  const srHome = tempDir('srhome');
  cleanup.push(home, project, bin, srHome);
  fs.mkdirSync(path.join(project, '.git'));
  fs.mkdirSync(path.join(project, 'docs'));
  fs.writeFileSync(path.join(project, 'docs', 'report.html'), '<!doctype html><title>R</title><h1>Report</h1><p>Short answers.</p>\n');
  fs.mkdirSync(path.join(home, '.claude'));
  /** @type {Record<string, string>} */
  const env = { HOME: home, PATH: bin, SPECREVIEW_HOME: srHome, SPECREVIEW_BROWSER: 'none' };
  /** @param {string[]} argv @param {Record<string, any>} [deps] */
  const run = (argv, deps = {}) => runCli(argv, { cwd: project, env, ...deps });
  const open = () => run(['open', 'docs/report.html', '--browser', 'none']);
  return { home, project, env, run, open, p: (/** @type {string} */ rel) => path.join(home, rel) };
}

const read = (/** @type {string} */ f) => fs.readFileSync(f, 'utf8');
/** @param {string} text @param {string} version */
const remark = (text, version) => text.replace(/<!-- installed by suiko \S+ -->/, `<!-- installed by suiko ${version} -->`);

describe('install marks', () => {
  test('every instruction file says which Suiko wrote it; the mark is not part of what makes a copy ours', async () => {
    const h = makeHome();
    fs.mkdirSync(h.p('.codex/sessions'), { recursive: true });
    fs.mkdirSync(h.p('.gemini'), { recursive: true });
    fs.writeFileSync(h.p('.gemini/settings.json'), '{}');
    const r = await h.run(['install', '--apply', '--only', 'claude,codex,gemini']);
    assert.equal(r.code, 0, r.stderr);
    for (const f of ['.claude/skills/spec-review/SKILL.md', '.claude/skills/spec-review/reference.md', '.claude/commands/review-spec.md', '.codex/AGENTS.md', '.agents/skills/suiko-review/SKILL.md', '.gemini/GEMINI.md', '.gemini/commands/suiko-review.toml']) {
      assert.equal(installedVersion(read(h.p(f))), VERSION, f);
    }
    assert.match(read(h.p('.gemini/commands/suiko-review.toml')), new RegExp(`\\n# installed by suiko ${VERSION.replace(/\./g, '\\.')}\\n$`), 'a TOML comment');
    // a copy an older Suiko marked is ours: replaced in place, without a backup, and uninstall removes it
    const skill = h.p('.claude/skills/spec-review/SKILL.md');
    fs.writeFileSync(skill, remark(read(skill), '0.0.1'));
    assert.equal(stripInstallMarks(read(skill)), stripInstallMarks(remark(read(skill), VERSION)));
    const again = await h.run(['install', '--apply', '--only', 'claude']);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(installedVersion(read(skill)), VERSION);
    assert.equal(fs.existsSync(`${skill}.specreview-backup`), false);
    const un = await h.run(['uninstall', '--apply', '--only', 'claude']);
    assert.equal(un.code, 0, un.stderr);
    assert.equal(fs.existsSync(skill), false);
  });
});

describe('suiko open says when the installed instructions are older than the CLI', () => {
  test('nothing installed, or everything current: no line', async () => {
    const h = makeHome();
    let r = await h.open();
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /Your Suiko/);
    await h.run(['install', '--apply', '--only', 'claude']);
    r = await h.open();
    assert.doesNotMatch(r.stderr, /Your Suiko/);
  });

  test('a skill marked with an older version names it; one without a mark is from an earlier version', async () => {
    const h = makeHome();
    await h.run(['install', '--apply', '--only', 'claude']);
    const skill = h.p('.claude/skills/spec-review/SKILL.md');
    fs.writeFileSync(skill, remark(read(skill), '0.0.1'));
    let r = await h.open();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr.trim(), 'Your Suiko skill for Claude Code is from 0.0.1; run `suiko install --only claude --apply` to update it.');
    // the line is on stderr: --json output stays clean
    const j = await h.run(['open', 'docs/report.html', '--json']);
    assert.equal(JSON.parse(j.stdout).doc, 'report');
    assert.match(j.stderr, /from 0\.0\.1/);
    // written before marks existed (an old copy, never refreshed by npm): an earlier version
    fs.writeFileSync(h.p('.claude/commands/review-spec.md'), '---\ndescription: Open an existing spec\n---\n\nWrite the spec once.\n');
    r = await h.open();
    assert.equal(r.stderr.trim(), 'Your Suiko skill for Claude Code is from an earlier Suiko version; run `suiko install --only claude --apply` to update it.');
    await h.run(['install', '--apply', '--only', 'claude']);
    assert.doesNotMatch((await h.open()).stderr, /Your Suiko/);
  });

  test('a copy edited by the user under the current version is left alone', async () => {
    const h = makeHome();
    await h.run(['install', '--apply', '--only', 'claude']);
    const skill = h.p('.claude/skills/spec-review/SKILL.md');
    fs.writeFileSync(skill, read(skill).replace('# Suiko', '# Suiko (my notes)'));
    assert.doesNotMatch((await h.open()).stderr, /Your Suiko/);
  });

  test('only Claude Code installed, other agents detected: the line updates Claude Code only', async () => {
    const h = makeHome();
    // Codex, Gemini CLI and OpenCode are on this machine, but Suiko was installed for Claude Code alone
    fs.mkdirSync(h.p('.codex/sessions'), { recursive: true });
    fs.mkdirSync(h.p('.gemini'), { recursive: true });
    fs.writeFileSync(h.p('.gemini/settings.json'), '{}');
    fs.mkdirSync(h.p('.config/opencode'), { recursive: true });
    await h.run(['install', '--apply', '--only', 'claude']);
    const skill = h.p('.claude/skills/spec-review/SKILL.md');
    fs.writeFileSync(skill, remark(read(skill), '0.0.1'));
    const r = await h.open();
    assert.equal(r.stderr.trim(), 'Your Suiko skill for Claude Code is from 0.0.1; run `suiko install --only claude --apply` to update it.');
    // the command it names touches nothing of the other agents
    const fix = await h.run(['install', '--only', 'claude', '--apply']);
    assert.equal(fix.code, 0, fix.stderr);
    for (const f of ['.codex/AGENTS.md', '.gemini/GEMINI.md', '.config/opencode/AGENTS.md', '.agents/skills/suiko-review/SKILL.md']) assert.equal(fs.existsSync(h.p(f)), false, f);
    assert.doesNotMatch((await h.open()).stderr, /Your Suiko/);
  });

  test('a shared skill names the agent in use that writes least besides it', async () => {
    const h = makeHome();
    // Factory Droid reads only ~/.agents/skills; Codex is on this machine too but has no Suiko install
    fs.mkdirSync(h.p('.factory'), { recursive: true });
    fs.mkdirSync(h.p('.codex/sessions'), { recursive: true });
    await h.run(['install', '--apply', '--only', 'droid']);
    const shared = h.p('.agents/skills/suiko-review/SKILL.md');
    fs.writeFileSync(shared, remark(read(shared), '0.0.3'));
    let r = await h.open();
    assert.equal(r.stderr.trim(), 'Your Suiko instructions (~/.agents/skills) are from 0.0.3; run `suiko install --only droid --apply` to update them.');
    // Cursor installed too: either agent's install rewrites only the skill, and Cursor has a Suiko file of its own
    // here (its mcp.json entry), so it is named
    fs.mkdirSync(h.p('.cursor'), { recursive: true });
    await h.run(['install', '--apply', '--only', 'cursor']);
    fs.writeFileSync(shared, remark(read(shared), '0.0.3'));
    r = await h.open();
    assert.equal(r.stderr.trim(), 'Your Suiko instructions (~/.agents/skills) are from 0.0.3; run `suiko install --only cursor --apply` to update them.');
    // with the Codex instructions stale as well, Codex's install updates both
    await h.run(['install', '--apply', '--only', 'codex']);
    fs.writeFileSync(shared, remark(read(shared), '0.0.3'));
    const agents = h.p('.codex/AGENTS.md');
    fs.writeFileSync(agents, remark(read(agents), '0.0.2'));
    r = await h.open();
    assert.equal(r.stderr.trim(), 'Your Suiko instructions (Codex CLI, ~/.agents/skills) are from 0.0.2; run `suiko install --only codex --apply` to update them.');
    await h.run(['install', '--only', 'codex', '--apply']);
    assert.doesNotMatch((await h.open()).stderr, /Your Suiko/);
  });

  test("project installs: an old block in the project's AGENTS.md asks for `suiko install --project --only <agent> --apply`", async () => {
    const h = makeHome();
    const agentsMd = path.join(h.project, 'AGENTS.md');
    fs.writeFileSync(agentsMd, '# Rules\n\nUse tabs.\n');
    const inst = await h.run(['install', '--project', '--apply', '--only', 'codex']);
    assert.equal(inst.code, 0, inst.stderr);
    fs.writeFileSync(agentsMd, remark(read(agentsMd), '0.0.4'));
    const r = await h.open();
    assert.equal(r.stderr.trim(), 'Your Suiko instructions (AGENTS.md) are from 0.0.4; run `suiko install --project --only codex --apply` to update them.');
    await h.run(['install', '--project', '--only', 'codex', '--apply']);
    assert.doesNotMatch((await h.open()).stderr, /Your Suiko/);
    assert.match(read(agentsMd), /^# Rules\n\nUse tabs\.\n\n<!-- specreview:begin/, 'the rest of the file is kept');
  });

  test('an AGENTS.md block `suiko install agents-md` wrote asks for `suiko install agents-md --apply`, agents on PATH or not', async () => {
    const h = makeHome();
    const agentsMd = path.join(h.project, 'AGENTS.md');
    // written before install marks existed (the base snippet of an older Suiko)
    fs.writeFileSync(agentsMd, '# Rules\n\n<!-- specreview:begin (managed) -->\n## Spec reviews (Suiko)\n\n1. Write the spec once.\n<!-- specreview:end -->\n');
    let r = await h.open();
    assert.equal(r.stderr.trim(), 'Your Suiko instructions (AGENTS.md) are from an earlier Suiko version; run `suiko install agents-md --apply` to update them.');
    // agent CLIs on PATH change nothing: `suiko install --project` would configure every one of them
    for (const name of ['codex', 'gemini', 'opencode', 'claude']) {
      fs.writeFileSync(path.join(h.env.PATH, name), '#!/bin/sh\nexit 0\n');
      fs.chmodSync(path.join(h.env.PATH, name), 0o755);
    }
    r = await h.open();
    assert.equal(r.stderr.trim(), 'Your Suiko instructions (AGENTS.md) are from an earlier Suiko version; run `suiko install agents-md --apply` to update them.');
    const fix = await h.run(['install', 'agents-md', '--apply']);
    assert.equal(fix.code, 0, fix.stderr);
    assert.doesNotMatch((await h.open()).stderr, /Your Suiko/);
    assert.match(read(agentsMd), /^# Rules\n\n<!-- specreview:begin/, 'the rest of the file is kept');
    assert.equal(fs.existsSync(path.join(h.project, '.agents')), false, 'no other project file was written');
    // a later release: the block `install agents-md` marked is older than the CLI, and the same command updates it
    fs.writeFileSync(agentsMd, remark(read(agentsMd), '0.0.5'));
    r = await h.open();
    assert.equal(r.stderr.trim(), 'Your Suiko instructions (AGENTS.md) are from 0.0.5; run `suiko install agents-md --apply` to update them.');
  });

  test('no known home directory: no check', async () => {
    const h = makeHome();
    await h.run(['install', '--apply', '--only', 'claude']);
    const skill = h.p('.claude/skills/spec-review/SKILL.md');
    fs.writeFileSync(skill, remark(read(skill), '0.0.1'));
    const r = await runCli(['open', 'docs/report.html', '--browser', 'none'], { cwd: h.project, env: { SPECREVIEW_HOME: h.env.SPECREVIEW_HOME } });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /Your Suiko/);
  });
});

describe('suiko doctor', () => {
  test('names the version an agent\'s instructions came from', async () => {
    const h = makeHome();
    fs.mkdirSync(h.p('.codex/sessions'), { recursive: true });
    await h.run(['install', '--apply', '--only', 'claude,codex']);
    const agents = h.p('.codex/AGENTS.md');
    fs.writeFileSync(agents, remark(read(agents), '0.0.2'));
    const r = await h.run(['doctor'], { daemonStatus: async () => ({ running: false }) });
    assert.match(r.stdout, /^WARN {2}Codex CLI: Your Suiko instructions \(Codex CLI\) are from 0\.0\.2; run `suiko install --only codex --apply` to update them\.$/m);
    assert.match(r.stdout, /^ok {4}Claude Code: Suiko configured$/m);
  });

  test('says when a Suiko hook runs a script that is gone; the install it names points the hooks at this CLI', async () => {
    const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const h = makeHome();
    await h.run(['install', '--apply', '--only', 'claude']);
    const settings = h.p('.claude/settings.json');
    // hooks an install from a clone that has since been deleted wrote: the same node, a script that no longer exists
    const gone = path.join(h.home, 'dev', 'suiko', 'bin', 'suiko.js');
    const s = JSON.parse(read(settings));
    for (const groups of Object.values(s.hooks)) for (const g of groups) for (const hk of g.hooks) hk.command = hk.command.replace(/"[^"]*suiko\.js"/, JSON.stringify(gone));
    fs.writeFileSync(settings, JSON.stringify(s, null, 2));
    // ... while the skill is also older than the CLI: both are said
    const skill = h.p('.claude/skills/spec-review/SKILL.md');
    fs.writeFileSync(skill, remark(read(skill), '0.0.3'));
    const deps = { daemonStatus: async () => ({ running: false }) };
    let r = await h.run(['doctor'], deps);
    assert.match(r.stdout, new RegExp(`^ERR {3}Claude Code: 2 Suiko hooks in ~/\\.claude/settings\\.json cannot run: they run ${esc(gone)}, which is missing\\. Claude Code reports a hook error each time one runs until you run \`suiko install --only claude --apply\`, which points them at this CLI\\.$`, 'm'));
    assert.match(r.stdout, /^WARN {2}Claude Code: Your Suiko skill for Claude Code is from 0\.0\.3; /m);
    assert.doesNotMatch(r.stdout, /incomplete or outdated/);
    assert.equal(r.code, 1, 'an ERR');
    const dry = await h.run(['install', '--only', 'claude']);
    assert.match(dry.stdout, new RegExp(`hooks: .*; replaces the Suiko hooks already there \\(they run ${esc(gone)}, which is missing\\); other settings kept`));
    await h.run(['install', '--apply', '--only', 'claude']);
    r = await h.run(['doctor'], deps);
    assert.match(r.stdout, /^ok {4}Claude Code: Suiko configured$/m);
    assert.doesNotMatch(r.stdout, /cannot run/);
    // a hook from before the rename, run by name: `specreview` is not on PATH
    const t = JSON.parse(read(settings));
    t.hooks.UserPromptSubmit[0].hooks[0].command = 'specreview hook prompt';
    fs.writeFileSync(settings, JSON.stringify(t, null, 2));
    r = await h.run(['doctor'], deps);
    assert.match(r.stdout, /^ERR {3}Claude Code: a Suiko hook in ~\/\.claude\/settings\.json cannot run: it runs `specreview`, which is not on PATH here\. Claude Code reports a hook error each time it runs until /m);
  });

  test('next to the plugin, a broken plan-mode gate is re-pointed (the plugin has none), never uninstalled', async () => {
    const h = makeHome();
    const gone = path.join(h.home, 'dev', 'suiko', 'bin', 'suiko.js');
    const gate = { type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(gone)} plan-gate`, timeout: 345600 };
    const prompt = { type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(gone)} hook prompt`, timeout: 5 };
    fs.mkdirSync(h.p('.claude/plugins'), { recursive: true });
    fs.writeFileSync(h.p('.claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'suiko@local': [{ scope: 'user', installPath: '/x' }] } }));
    const settings = h.p('.claude/settings.json');
    fs.writeFileSync(settings, JSON.stringify({ hooks: { PermissionRequest: [{ matcher: 'ExitPlanMode', hooks: [gate] }] } }, null, 2));
    const deps = { daemonStatus: async () => ({ running: false }) };
    let r = await h.run(['doctor'], deps);
    assert.match(r.stdout, /^ERR {3}Claude Code: a Suiko hook in ~\/\.claude\/settings\.json cannot run: it runs .*suiko\.js, which is missing\. Claude Code reports a hook error each time it runs until you replace the gate's command with `".*" ".*bin\/suiko\.js" plan-gate` \(the plugin has no plan-mode gate\), or remove the gate\.$/m);
    assert.doesNotMatch(r.stdout, /suiko uninstall/);
    // a broken regular hook too: uninstalling stays the fix, and it says it takes the gate with it
    fs.writeFileSync(settings, JSON.stringify({ hooks: { PermissionRequest: [{ matcher: 'ExitPlanMode', hooks: [gate] }], UserPromptSubmit: [{ hooks: [prompt] }] } }, null, 2));
    r = await h.run(['doctor'], deps);
    assert.match(r.stdout, /^ERR {3}Claude Code: 2 Suiko hooks in ~\/\.claude\/settings\.json cannot run: .* until you run `suiko uninstall --only claude --apply` \(the plugin has its own hooks; this also removes the plan-mode gate, which the plugin does not have: see "Plan-mode gate" in the README to add it back\)\.$/m);
  });
});

describe('versions and the line', () => {
  test('olderThan compares semantic versions; a prerelease is older than its release', () => {
    assert.equal(olderThan('0.3.1', '0.4.0'), true);
    assert.equal(olderThan('0.10.0', '0.9.9'), false);
    assert.equal(olderThan('0.3.9', '0.3.10'), true);
    assert.equal(olderThan('1.0.0-rc.1', '1.0.0'), true);
    assert.equal(olderThan('1.0.0', '1.0.0-rc.1'), false);
    assert.equal(olderThan('1.0.0', '1.0.0'), false);
    assert.equal(olderThan('garbage', '1.0.0'), false);
  });

  test('prereleases compare per identifier, as SemVer orders them', () => {
    // numeric identifiers numerically
    assert.equal(olderThan('0.4.0-beta.9', '0.4.0-beta.10'), true);
    assert.equal(olderThan('0.4.0-beta.10', '0.4.0-beta.9'), false);
    assert.equal(olderThan('0.4.0-alpha.2', '0.4.0-alpha.10'), true);
    assert.equal(olderThan('1.0.0-rc.99999999999999999999', '1.0.0-rc.100000000000000000000'), true, 'beyond Number precision');
    assert.equal(olderThan('1.0.0-beta.2', '1.0.0-beta.2'), false);
    // the SemVer 2.0.0 example chain: each one is older than every later one, never the other way round
    const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let i = 0; i < chain.length; i++) {
      for (let j = 0; j < chain.length; j++) assert.equal(olderThan(chain[i], chain[j]), i < j, `${chain[i]} < ${chain[j]}`);
    }
    // a numeric identifier ranks below an alphanumeric one; build metadata is ignored
    assert.equal(olderThan('1.0.0-1', '1.0.0-a'), true);
    assert.equal(olderThan('1.0.0-a', '1.0.0-1'), false);
    assert.equal(olderThan('1.0.0-beta.2+build.9', '1.0.0-beta.10+build.1'), true);
  });

  test('several stale places: one line, the oldest version, the command of each scope', () => {
    const line = freshnessLine([
      { agent: 'codex', label: 'Codex CLI', scope: 'user', file: 'b', version: '0.1.5' },
      { agent: 'claude', label: 'Claude Code skill', scope: 'user', file: 'a', version: '0.2.0' },
      { agent: 'cursor', label: 'AGENTS.md', scope: 'project', file: 'c', version: '0.3.0' },
    ]);
    assert.equal(
      line,
      'Your Suiko instructions (Codex CLI, Claude Code skill, AGENTS.md) are from 0.1.5; run `suiko install --only claude,codex --apply` and `suiko install --project --only cursor --apply` to update them.',
    );
    assert.equal(
      freshnessLine([
        { agent: 'claude', label: 'Claude Code skill', scope: 'project', file: 'a', version: '0.2.0' },
        { agent: 'codex', label: 'AGENTS.md', scope: 'project', file: 'b', version: null, via: 'agents-md' },
      ]),
      'Your Suiko instructions (Claude Code skill, AGENTS.md) are from an earlier Suiko version; run `suiko install --project --only claude --apply` and `suiko install agents-md --apply` to update them.',
    );
    assert.equal(freshnessLine([]), null);
  });

  test('only the Claude Code skill is stale: the line names `--only claude`, never a bare `suiko install --apply`', () => {
    const line = freshnessLine([{ agent: 'claude', label: 'Claude Code skill', scope: 'user', file: '/h/.claude/skills/spec-review/SKILL.md', version: '0.3.0' }]);
    assert.equal(line, 'Your Suiko skill for Claude Code is from 0.3.0; run `suiko install --only claude --apply` to update it.');
    assert.deepEqual(installCommands([{ agent: 'claude', label: 'Claude Code skill', scope: 'project', file: 'x', version: null }]), ['suiko install --project --only claude --apply']);
  });
});
