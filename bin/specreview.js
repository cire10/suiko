#!/usr/bin/env node
// @ts-check
// specreview CLI entry point.
// `specreview hook <name>` is dispatched first, importing only src/cli/hooks.js (node:* builtins only), so the
// Claude Code hooks start fast and can never fail: they always exit 0 and print nothing on error
// (BUILD_AMENDMENTS 5). Every other command goes through src/cli/main.js.

const argv = process.argv.slice(2);

if (argv[0] === 'hook') {
  try {
    const { runHook } = await import('../src/cli/hooks.js');
    await runHook(argv[1] ?? '');
  } catch {
    // never fail a hook
  }
  process.exitCode = 0;
} else {
  const { main } = await import('../src/cli/main.js');
  process.exitCode = await main(argv);
}
