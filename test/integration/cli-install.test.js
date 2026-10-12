// @ts-check
// WP4 installer tests: `install claude` (skill + command copies, hooks merged into settings.json with absolute
// commands, MCP config) and `install agents-md` (idempotent marked block). Dry run by default; --apply writes.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-home-install-'));
process.env.SPECREVIEW_HOME = HOME;

const { runCli, tempDir } = await import('./helpers/cli-harness.js');
const { BIN_PATH, PACKAGE_ROOT } = await import('../../src/cli/daemon-client.js');
const { claudeCommandFiles, hookCommand, insertSnippet, mergeHooks, planGateCommand, PLAN_GATE_TIMEOUT } = await import('../../src/cli/install.js');

/** @type {string} */
let project;
/** @type {string} */
let claudeHome;

before(() => {
  project = tempDir('proj');
  fs.mkdirSync(path.join(project, '.git'));
  fs.mkdirSync(path.join(project, 'src'));
  claudeHome = tempDir('claude');
});
after(() => {
  for (const d of [project, claudeHome, HOME]) fs.rmSync(d, { recursive: true, force: true });
});

const run = (/** @type {string[]} */ argv) => runCli(argv, { cwd: path.join(project, 'src'), claudeHome, env: { SPECREVIEW_HOME: HOME } });
const readJson = (/** @type {string} */ f) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('install claude', () => {
  test('hook commands are absolute: "<node>" "<abs bin>" hook <name>', () => {
    assert.equal(hookCommand('pre-write'), `"${process.execPath}" "${BIN_PATH}" hook pre-write`);
    assert.ok(path.isAbsolute(BIN_PATH));
  });

  test('dry run prints the plan and writes nothing', async () => {
    const r = await run(['install', 'claude', '--project', '--with-hooks']);
    assert.equal(r.code, 0, r.stderr);
    const skill = path.join(project, '.claude', 'skills', 'spec-review', 'SKILL.md');
    assert.match(r.stdout, new RegExp(`would create ${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(r.stdout, /would create .*\.claude\/commands\/review-spec\.md/);
    assert.match(r.stdout, /would create .*\.claude\/settings\.json {2}\(hooks: /);
    assert.ok(r.stdout.includes(JSON.stringify(hookCommand('pre-write')).slice(1, -1)), 'settings content is printed');
    assert.match(r.stdout, /dry run: nothing written/);
    assert.equal(fs.existsSync(path.join(project, '.claude')), false);
  });

  test('--apply copies the skill + command and merges hooks, keeping other settings; idempotent', async () => {
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.claude', 'settings.json'),
      JSON.stringify({
        model: 'opus',
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] },
            { matcher: 'Write', hooks: [{ type: 'command', command: 'suiko hook pre-write', timeout: 5 }] },
          ],
          Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
        },
      }),
    );
    // A `suiko` executable on PATH: the skill is copied verbatim (see the 'not on PATH' suite for the other case).
    const binDir = tempDir('sr-fakebin-');
    fs.writeFileSync(path.join(binDir, 'suiko'), '#!/bin/sh\n', { mode: 0o755 });
    const r = await runCli(['install', 'claude', '--project', '--with-hooks', '--apply'], {
      cwd: path.join(project, 'src'), claudeHome, env: { SPECREVIEW_HOME: HOME, PATH: binDir },
    });
    assert.equal(r.code, 0, r.stderr);
    const base = path.join(project, '.claude');
    for (const rel of ['SKILL.md', 'reference.md']) {
      assert.equal(
        fs.readFileSync(path.join(base, 'skills', 'spec-review', rel), 'utf8'),
        fs.readFileSync(path.join(PACKAGE_ROOT, 'integrations', 'claude-code', 'skills', 'spec-review', rel), 'utf8'),
      );
    }
    assert.ok(fs.existsSync(path.join(base, 'commands', 'review-spec.md')));
    const s = readJson(path.join(base, 'settings.json'));
    assert.equal(s.model, 'opus');
    assert.deepEqual(s.hooks.Stop, [{ hooks: [{ type: 'command', command: 'say done' }] }]);
    assert.deepEqual(s.hooks.PreToolUse, [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] },
      { matcher: 'Write', hooks: [{ type: 'command', command: hookCommand('pre-write'), timeout: 5 }] },
    ]);
    assert.deepEqual(s.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: hookCommand('prompt'), timeout: 5 }] }]);
    assert.equal(s.hooks.PermissionRequest, undefined, '--with-hooks alone does not add the plan gate');
    const again = await runCli(['install', 'claude', '--project', '--with-hooks', '--apply', '--json'], {
      cwd: path.join(project, 'src'), claudeHome, env: { SPECREVIEW_HOME: HOME, PATH: binDir },
    });
    const j = JSON.parse(again.stdout);
    assert.ok(j.files.every((/** @type {any} */ f) => f.action === 'unchanged'), JSON.stringify(j.files));
    assert.deepEqual(j.written, []);
  });

  test('--user installs into the Claude config dir; --with-mcp prints the claude mcp add command', async () => {
    const r = await run(['install', 'claude', '--with-mcp', '--apply']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(claudeHome, 'skills', 'spec-review', 'SKILL.md')));
    assert.match(r.stdout, new RegExp(`claude mcp add --scope user suiko -- "${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" ".*bin/suiko\\.js" "mcp"`));
  });

  test('--project --with-mcp merges .mcp.json', async () => {
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    const r = await run(['install', 'claude', '--project', '--with-mcp', '--apply']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readJson(path.join(project, '.mcp.json')).mcpServers, {
      other: { command: 'x' },
      suiko: { command: process.execPath, args: [BIN_PATH, 'mcp'] },
    });
  });

  test('an invalid settings.json is never overwritten', async () => {
    const dir = tempDir('badsettings');
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{ broken');
    const r = await runCli(['install', 'claude', '--project', '--with-hooks', '--apply'], { cwd: dir, env: { SPECREVIEW_HOME: HOME } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /settings\.json is not valid JSON/);
    assert.equal(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'), '{ broken');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the user scope is <HOME>/.claude of the environment it is given, never the OS home; no HOME is refused', async () => {
    const home = tempDir('user-home');
    try {
      const r = await runCli(['install', 'claude', '--with-plan-gate', '--apply'], { cwd: path.join(project, 'src'), env: { SPECREVIEW_HOME: HOME, HOME: home } });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'spec-review', 'SKILL.md')));
      assert.ok(readJson(path.join(home, '.claude', 'settings.json')).hooks.PermissionRequest);
      const viaDir = tempDir('claude-config-dir');
      try {
        const c = await runCli(['install', 'claude', '--json'], { cwd: path.join(project, 'src'), env: { SPECREVIEW_HOME: HOME, HOME: home, CLAUDE_CONFIG_DIR: viaDir } });
        assert.ok(JSON.parse(c.stdout).files.every((/** @type {any} */ f) => f.path.startsWith(viaDir)), '$CLAUDE_CONFIG_DIR still wins');
      } finally {
        fs.rmSync(viaDir, { recursive: true, force: true });
      }
      const none = await runCli(['install', 'claude', '--apply'], { cwd: path.join(project, 'src'), env: { SPECREVIEW_HOME: HOME } });
      assert.equal(none.code, 1);
      assert.match(none.stderr, /cannot tell your home directory: HOME is not set/);
      const proj = await runCli(['install', 'claude', '--project'], { cwd: path.join(project, 'src'), env: { SPECREVIEW_HOME: HOME } });
      assert.equal(proj.code, 0, '--project needs no HOME');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('re-running `install claude` without hook flags re-points the Suiko hooks already there (none added)', async () => {
    const home = tempDir('claude-repoint');
    try {
      const stale = (/** @type {string} */ what) => `"/old/node" "/old/checkout/bin/suiko.js" ${what}`;
      const settings = {
        hooks: {
          PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: stale('hook pre-write'), timeout: 5 }] }],
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: stale('hook prompt'), timeout: 5 }] }],
          PermissionRequest: [{ matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: stale('plan-gate'), timeout: PLAN_GATE_TIMEOUT }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
        },
      };
      fs.writeFileSync(path.join(home, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
      const opts = { cwd: path.join(project, 'src'), claudeHome: home, env: { SPECREVIEW_HOME: HOME } };
      const dry = await runCli(['install', 'claude'], opts);
      assert.match(dry.stdout, /settings\.json {2}\(hooks: .*plan-gate \(other settings kept; updates the Suiko hooks already there\)\)/);
      assert.equal((await runCli(['install', 'claude', '--apply'], opts)).code, 0);
      const s = readJson(path.join(home, 'settings.json'));
      assert.deepEqual(s.hooks.PreToolUse, [{ matcher: 'Write', hooks: [{ type: 'command', command: hookCommand('pre-write'), timeout: 5 }] }]);
      assert.deepEqual(s.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: hookCommand('prompt'), timeout: 5 }] }]);
      assert.deepEqual(s.hooks.PermissionRequest, [{ matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: planGateCommand(), timeout: PLAN_GATE_TIMEOUT }] }]);
      assert.deepEqual(s.hooks.Stop, settings.hooks.Stop);

      // Only the gate there: only the gate is re-pointed, no other hook is added, and the plugin warning is not printed.
      fs.writeFileSync(path.join(home, 'settings.json'), `${JSON.stringify({ hooks: { PermissionRequest: settings.hooks.PermissionRequest } }, null, 2)}\n`);
      const gateOnly = await runCli(['install', 'claude', '--apply'], opts);
      assert.doesNotMatch(gateOnly.stdout, /Claude Code plugin/);
      assert.deepEqual(Object.keys(readJson(path.join(home, 'settings.json')).hooks), ['PermissionRequest']);
      assert.equal(readJson(path.join(home, 'settings.json')).hooks.PermissionRequest[0].hooks[0].command, planGateCommand());

      // No Suiko hooks: settings.json is not touched.
      const none = tempDir('claude-nohooks');
      try {
        fs.writeFileSync(path.join(none, 'settings.json'), '{"model": "opus"}\n');
        const r = await runCli(['install', 'claude', '--apply'], { ...opts, claudeHome: none });
        assert.equal(r.code, 0, r.stderr);
        assert.equal(fs.readFileSync(path.join(none, 'settings.json'), 'utf8'), '{"model": "opus"}\n');
        assert.doesNotMatch(r.stdout, /settings\.json|Claude Code plugin/);
      } finally {
        fs.rmSync(none, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('--with-plan-gate registers the plan-mode gate; every command file is copied', async () => {
    const dir = tempDir('plangate');
    fs.mkdirSync(path.join(dir, '.git'));
    const r = await runCli(['install', 'claude', '--project', '--with-plan-gate', '--apply'], { cwd: dir, env: { SPECREVIEW_HOME: HOME } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readJson(path.join(dir, '.claude', 'settings.json')), {
      hooks: { PermissionRequest: [{ matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: planGateCommand(), timeout: PLAN_GATE_TIMEOUT }] }] },
    });
    assert.equal(planGateCommand(), `"${process.execPath}" "${BIN_PATH}" plan-gate`);
    assert.equal(PLAN_GATE_TIMEOUT, 345600);
    assert.ok(claudeCommandFiles().includes('review-spec.md'));
    for (const name of claudeCommandFiles()) assert.ok(fs.existsSync(path.join(dir, '.claude', 'commands', name)), name);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('usage errors', async () => {
    assert.equal((await run(['install', 'vim'])).code, 1);
    assert.equal((await run(['install', '--with-hooks'])).code, 1, '--with-hooks belongs to `install claude`');
    assert.equal((await run(['install', 'claude', '--only', 'codex'])).code, 1);
    assert.equal((await run(['install', 'agents-md', '--file', 'X.md', '--with-plan-gate'])).code, 1);
    assert.equal((await run(['install', 'claude', '--user', '--project'])).code, 1);
    assert.equal((await run(['install', 'agents-md', '--with-hooks'])).code, 1);
  });

  test('mergeHooks drops emptied groups and replaces earlier absolute suiko hooks', () => {
    const old = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: '"/old/node" "/old/bin/suiko.js" hook prompt' }] }] } };
    const merged = mergeHooks(old, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'NEW' }] }] });
    assert.deepEqual(merged.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: 'NEW' }] }]);
  });
});

describe('install agents-md', () => {
  const snippetPath = path.join(PACKAGE_ROOT, 'integrations', 'agents-md', 'AGENTS.snippet.md');

  test('dry run, apply (append), idempotent re-run, replace an outdated block', async () => {
    const target = path.join(project, 'AGENTS.md');
    fs.writeFileSync(target, '# Project rules\n\nBe nice.\n');
    const dry = await run(['install', 'agents-md']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /would update .*AGENTS\.md {2}\(appends the Suiko protocol block\)/);
    assert.equal(fs.readFileSync(target, 'utf8'), '# Project rules\n\nBe nice.\n');

    const r = await run(['install', 'agents-md', '--apply']);
    assert.equal(r.code, 0, r.stderr);
    const snippet = fs.readFileSync(snippetPath, 'utf8').trimEnd();
    assert.equal(fs.readFileSync(target, 'utf8'), `# Project rules\n\nBe nice.\n\n${snippet}\n`);

    const again = await run(['install', 'agents-md', '--apply', '--json']);
    assert.equal(JSON.parse(again.stdout).files[0].action, 'unchanged');

    fs.writeFileSync(target, `# Project rules\n\n<!-- specreview:begin old -->\nold text\n<!-- specreview:end -->\n\nTrailer.\n`);
    await run(['install', 'agents-md', '--apply']);
    assert.equal(fs.readFileSync(target, 'utf8'), `# Project rules\n\n${snippet}\n\nTrailer.\n`);
  });

  test('--file targets another file; a new file gets just the block', async () => {
    const r = await run(['install', 'agents-md', '--file', '../GEMINI.md', '--apply']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(project, 'GEMINI.md'), 'utf8'), `${fs.readFileSync(snippetPath, 'utf8').trimEnd()}\n`);
  });

  test('insertSnippet', () => {
    const s = '<!-- specreview:begin x -->\nA\n<!-- specreview:end -->';
    assert.equal(insertSnippet(null, s), `${s}\n`);
    assert.equal(insertSnippet('top\n', s), `top\n\n${s}\n`);
    assert.equal(insertSnippet(`top\n${s}\nbottom\n`, s.replace('A', 'B')), `top\n${s.replace('A', 'B')}\nbottom\n`);
  });
});

describe('install claude: CLI not on PATH', () => {
  test('the installed SKILL.md and /review-spec carry the absolute invocation; reference.md is copied verbatim', async () => {
    const { planClaude } = await import('../../src/cli/install.js');
    const base = tempDir('sr-claude-nopath-');
    const plan = planClaude({ scope: 'user', cwd: base, claudeHome: base, execPath: '/opt/node', binPath: '/x/bin/suiko.js', cliOnPath: false });
    const skill = plan.files.find((f) => f.path.endsWith(path.join('spec-review', 'SKILL.md')));
    const ref = plan.files.find((f) => f.path.endsWith(path.join('spec-review', 'reference.md')));
    const cmd = plan.files.find((f) => f.path.endsWith('review-spec.md'));
    assert.ok(skill && ref && cmd);
    assert.match(skill.content, /^---\n[\s\S]*?\n---\n\n> \*\*On this machine `suiko` is not on PATH\.\*\*/);
    assert.ok(skill.content.includes('`"/opt/node" "/x/bin/suiko.js" wait <doc>`'));
    assert.ok(cmd.content.startsWith('---\n'), 'front matter stays first');
    assert.ok(cmd.content.includes('"/opt/node" "/x/bin/suiko.js"'));
    assert.ok(!ref.content.includes('not on PATH'));
    assert.ok(plan.notes.some((n) => n.includes('npm link')));
  });

  test('nothing is rewritten when suiko is on PATH', async () => {
    const { planClaude } = await import('../../src/cli/install.js');
    const base = tempDir('sr-claude-onpath-');
    const plan = planClaude({ scope: 'user', cwd: base, claudeHome: base, cliOnPath: true });
    assert.ok(plan.files.every((f) => !f.content.includes('not on PATH')));
    assert.ok(!plan.notes.some((n) => n.includes('npm link')));
  });

  test('isOnPath finds executables only', async () => {
    const { isOnPath } = await import('../../src/cli/install.js');
    const dir = tempDir('sr-path-');
    fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'plain'), 'x', { mode: 0o644 });
    assert.equal(isOnPath('tool', `/nonexistent${path.delimiter}${dir}`), true);
    assert.equal(isOnPath('plain', dir), false);
    assert.equal(isOnPath('missing', dir), false);
  });
});
