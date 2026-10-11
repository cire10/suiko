// @ts-check
// Markdown pipeline (design 6.2, exact plugin order):
//   remark-parse -> remark-gfm -> remark-frontmatter -> remark-math -> remark-sr-frontmatter -> remark-rehype
//   (allowDangerousHtml) -> rehype-raw -> rehype-sr-prepare -> rehype-katex -> rehype-highlight (detect:false)
//   -> rehype-slug -> rehype-sr-stamp (last) -> rehype-stringify
// and wraps the result in the shell page. All plugins are synchronous, so the processor runs synchronously.
// Positions for raw HTML come from rehype-raw (hast-util-raw re-parses with parse5 at absolute positions).
// Large sources are parsed in chunks (md-chunks.js) to avoid micromark's quadratic container handling, and the
// expensive whole-tree plugins (rehype-raw, rehype-katex, rehype-highlight) are skipped when the parsed document
// has nothing for them (no raw HTML / math / fenced code with a language): their output would be identical.

import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import rehypeSrPrepare from './plugins/rehype-sr-prepare.js';
import rehypeSrStamp from './plugins/rehype-sr-stamp.js';
import remarkSrFrontmatter from './plugins/remark-sr-frontmatter.js';
import { parseChunked } from './md-chunks.js';
import { buildShell } from './shell.js';
import { pickTitle } from './srcmap.js';

/** Languages rendered as plain code without a highlight attempt (avoids "unknown language" noise). */
const PLAIN_LANGS = ['text', 'txt', 'plain', 'plaintext', 'mermaid', 'math', 'ascii', 'none'];

/**
 * Wrap a plugin so it is skipped when file.data.sr[flag] === false (set from a scan of the parsed tree).
 * @param {string} flag
 * @param {any} plugin
 * @param {any} [options]
 */
function when(flag, plugin, options) {
  return /** @this {any} */ function gated() {
    const transform = plugin.call(this, options);
    return (/** @type {any} */ tree, /** @type {any} */ file) => (file?.data?.sr?.[flag] === false ? undefined : transform(tree, file));
  };
}

/**
 * What the parsed document contains, to skip plugins that would be no-ops.
 * @param {any} mdast
 * @returns {{ hasHtml: boolean, hasMath: boolean, hasCode: boolean }}
 */
export function scanMdast(mdast) {
  const flags = { hasHtml: false, hasMath: false, hasCode: false };
  const stack = [mdast];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'html') flags.hasHtml = true;
    else if (node.type === 'math' || node.type === 'inlineMath') flags.hasMath = true;
    else if (node.type === 'code' || node.type === 'yaml' || node.type === 'toml') flags.hasCode = true;
    if (node.children) for (const c of node.children) stack.push(c);
  }
  return flags;
}

/** @type {any} */
let processor = null;

function getProcessor() {
  processor ??= unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .use(remarkMath)
    .use(remarkSrFrontmatter)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(when('hasHtml', rehypeRaw))
    .use(rehypeSrPrepare)
    .use(when('hasMath', rehypeKatex, { strict: 'ignore' }))
    .use(when('hasCode', rehypeHighlight, { detect: false, plainText: PLAIN_LANGS }))
    .use(rehypeSlug)
    .use(rehypeSrStamp)
    .use(rehypeStringify)
    .freeze();
  return processor;
}

/**
 * Title from YAML/TOML front matter (`title: ...` / `title = "..."`), if any.
 * @param {string} source
 * @returns {string|null}
 */
export function frontMatterTitle(source) {
  const m = /^\uFEFF?(---|\+\+\+)\r?\n([\s\S]*?)\r?\n\1[ \t]*(?:\r?\n|$)/.exec(source);
  if (!m) return null;
  const t = /^title\s*[:=]\s*(.*)$/m.exec(m[2]);
  if (!t) return null;
  const v = t[1].trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  return v || null;
}

/**
 * Render Markdown to the shell page plus render data.
 * @param {string} source decoded source
 * @param {{ docPath?: string, stamp?: boolean, chunkSize?: number }} [opts] chunkSize: parse-chunk target (tests)
 */
export function renderMarkdown(source, { docPath, stamp = true, chunkSize } = {}) {
  const proc = getProcessor();
  /** @type {Record<string, any>} */
  const mdast = parseChunked((text) => proc.parse(text), source, { chunkSize });
  const data = { sr: { source, stamp, docPath, ...scanMdast(mdast) } };
  const hast = proc.runSync(mdast, { value: source, data });
  const body = String(proc.stringify(hast));
  const r = data.srResult;
  if (!r) throw new Error('markdown render produced no source map');
  const title = pickTitle(frontMatterTitle(source), r.outline, docPath);
  const shell = buildShell({ title, body, features: r.features });
  return {
    html: shell.html,
    guestInsertAt: shell.guestInsertAt,
    bodyEndAt: shell.bodyEndAt,
    srcmap: r.srcmap,
    text: r.text,
    outline: r.outline,
    assets: r.assets,
    externals: r.externals,
    title,
    features: r.features,
  };
}

/**
 * Render a Markdown fragment to an HTML string with the same pipeline minus stamping/shell (used by
 * fragment.js). `transform` may sanitise the hast tree before stringification.
 * @param {string} source
 * @param {(tree: any) => void} [transform]
 * @returns {string}
 */
export function renderMarkdownBody(source, transform) {
  const p = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .use(remarkMath)
    .use(remarkSrFrontmatter)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSrPrepare)
    .use(rehypeKatex, { strict: 'ignore' })
    .use(rehypeHighlight, { detect: false, plainText: PLAIN_LANGS })
    .use(() => (tree) => {
      if (transform) transform(tree);
    })
    .use(rehypeStringify);
  return String(p.processSync({ value: source, data: { sr: { source, stamp: false } } }).value);
}
