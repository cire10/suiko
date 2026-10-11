// @ts-check
// Full-page shell around rendered Markdown (design 6.2 "Shell"). Asset URLs use the literal placeholder
// __SR_ASSET_BASE__, which finalizeHtml() replaces with the content origin's /__sr/<RENDERER_VERSION> base.
// Light/dark stylesheets are selected by media queries and tagged data-sr-theme so the guest can force a theme.
// guestInsertAt is the offset just after <head>.

export const ASSET_BASE_PLACEHOLDER = '__SR_ASSET_BASE__';

/** Vendored mermaid + our init script (appended to HTML docs too; see finalizeHtml). */
export const MERMAID_SCRIPTS =
  `<script src="${ASSET_BASE_PLACEHOLDER}/vendor/mermaid/mermaid.min.js"></script>` +
  `<script src="${ASSET_BASE_PLACEHOLDER}/static/mermaid-init.js"></script>`;

/** @param {string} s */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/**
 * @param {{ title: string, body: string, features: { mermaid: boolean, math: boolean, code: boolean }, lang?: string }} p
 * @returns {{ html: string, guestInsertAt: number, bodyEndAt: number }}
 */
export function buildShell({ title, body, features, lang = 'en' }) {
  const A = ASSET_BASE_PLACEHOLDER;
  const headOpen = `<!doctype html><html lang="${escapeHtml(lang)}"><head>`;
  const head =
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    `<title>${escapeHtml(title)}</title>\n` +
    `<link rel="stylesheet" href="${A}/vendor/github-markdown-css/github-markdown-light.css" media="(prefers-color-scheme: light)" data-sr-theme="light">\n` +
    `<link rel="stylesheet" href="${A}/vendor/github-markdown-css/github-markdown-dark.css" media="(prefers-color-scheme: dark)" data-sr-theme="dark">\n` +
    `<link rel="stylesheet" href="${A}/vendor/highlight.js/styles/github.css" media="(prefers-color-scheme: light)" data-sr-theme="light">\n` +
    `<link rel="stylesheet" href="${A}/vendor/highlight.js/styles/github-dark.css" media="(prefers-color-scheme: dark)" data-sr-theme="dark">\n` +
    (features.math ? `<link rel="stylesheet" href="${A}/vendor/katex/katex.min.css">\n` : '') +
    `<link rel="stylesheet" href="${A}/static/shell.css">\n` +
    '</head><body><article class="markdown-body">\n';
  const tail = '\n</article>\n' + (features.mermaid ? MERMAID_SCRIPTS + '\n' : '');
  const pre = headOpen + head + body + tail;
  return { html: pre + '</body></html>\n', guestInsertAt: headOpen.length, bodyEndAt: pre.length };
}
