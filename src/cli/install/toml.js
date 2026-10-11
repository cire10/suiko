// @ts-check
// Codex's config.toml, edited without a TOML library: a structure scanner (statements with their line ranges, table
// headers and key paths; values are skipped, not decoded) and the managed-block operations built on it.
//
// Why parse at all: Codex itself rewrites config.toml with toml_edit (project trust on onboarding, `codex mcp add`),
// and toml_edit keeps a trailing comment as document decor, so a table Codex adds lands BEFORE our `# specreview:end`
// line. "Everything between the markers" is therefore not ours. Ours is exactly: the begin marker line, the
// [mcp_servers.specreview] table (and its sub-tables) with its key lines, and the end marker line. Any other table
// found between the markers is kept: install moves it below the block, uninstall leaves it in place.
//
// The scanner follows TOML 1.0 closely enough to know where every statement starts and ends (basic, literal and
// multi-line strings, nested arrays and inline tables, comments). Text it cannot follow (an unterminated string, a
// line that is neither a header, a key/value pair nor a comment) throws TomlScanError, and the installer then refuses
// to touch the file.

/**
 * @typedef {object} TomlStatement
 * @property {'header' | 'array-header' | 'keyval' | 'comment' | 'blank'} kind
 * @property {number} start first line (0-based)
 * @property {number} end last line (inclusive; a multi-line value spans several)
 * @property {string[]} table the path of the table the statement is in (for a header: its own path)
 * @property {string[]} [key] the header's path, or the key path of a key/value pair (relative to `table`)
 * @property {string} [text] a comment's text (the whole line, trimmed)
 */

export class TomlScanError extends Error {
  /**
   * @param {string} message
   * @param {number} line 1-based
   */
  constructor(message, line) {
    super(`line ${line}: ${message}`);
    /** @type {number} */
    this.line = line;
  }
}

const BARE_KEY = /[A-Za-z0-9_-]/;

/**
 * Scans a TOML document into statements.
 * @param {string} text
 * @returns {TomlStatement[]}
 */
export function scanToml(text) {
  let i = 0;
  let line = 0;
  const n = text.length;
  /** @type {TomlStatement[]} */
  const out = [];
  /** @type {string[]} */
  let table = [];

  const fail = (/** @type {string} */ msg) => {
    throw new TomlScanError(msg, line + 1);
  };
  const skipSpaces = () => {
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
  };
  /** Spaces, newlines and comments (inside arrays and inline tables). */
  const skipBlank = () => {
    for (;;) {
      skipSpaces();
      if (text[i] === '\r' && text[i + 1] === '\n') i++;
      if (text[i] === '\n') {
        i++;
        line++;
      } else if (text[i] === '#') {
        while (i < n && text[i] !== '\n') i++;
      } else {
        return;
      }
    }
  };
  /** After a statement: spaces, an optional comment, then a newline or the end of the text. */
  const endOfLine = () => {
    skipSpaces();
    if (text[i] === '#') while (i < n && text[i] !== '\n') i++;
    if (text[i] === '\r' && text[i + 1] === '\n') i++;
    if (i >= n) return;
    if (text[i] !== '\n') fail(`unexpected "${text[i]}"`);
  };

  /** A single-line basic ("...") or literal ('...') string; returns its raw content (escapes not decoded). */
  const quoted = () => {
    const q = text[i++];
    const from = i;
    while (i < n && text[i] !== q) {
      if (text[i] === '\n') fail('unterminated string');
      if (q === '"' && text[i] === '\\') i++;
      i++;
    }
    if (i >= n) fail('unterminated string');
    const raw = text.slice(from, i);
    i++;
    return q === '"' ? decodeBasic(raw) : raw;
  };

  /** A dotted key: a.b."c d".'e' */
  const key = () => {
    /** @type {string[]} */
    const parts = [];
    for (;;) {
      skipSpaces();
      const ch = text[i];
      if (ch === '"' || ch === "'") {
        parts.push(quoted());
      } else {
        const from = i;
        while (i < n && BARE_KEY.test(text[i])) i++;
        if (i === from) fail(ch === undefined || ch === '\n' ? 'expected a key' : `unexpected "${ch}" in a key`);
        parts.push(text.slice(from, i));
      }
      skipSpaces();
      if (text[i] !== '.') return parts;
      i++;
    }
  };

  /** Skips one value of any type. */
  const value = () => {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      if (text.startsWith(ch.repeat(3), i)) {
        i += 3;
        for (;;) {
          if (i >= n) fail('unterminated multi-line string');
          if (ch === '"' && text[i] === '\\') {
            if (text[i + 1] === '\n') line++;
            i += 2;
            continue;
          }
          if (text.startsWith(ch.repeat(3), i)) {
            i += 3;
            // Up to two quotes right before the closing delimiter belong to the content.
            if (text[i] === ch) i++;
            if (text[i] === ch) i++;
            return;
          }
          if (text[i] === '\n') line++;
          i++;
        }
      }
      quoted();
      return;
    }
    if (ch === '[') {
      i++;
      for (;;) {
        skipBlank();
        if (i >= n) fail('unterminated array');
        if (text[i] === ']') {
          i++;
          return;
        }
        value();
        skipBlank();
        if (text[i] === ',') i++;
        else if (text[i] !== ']') fail(i >= n ? 'unterminated array' : `unexpected "${text[i]}" in an array`);
      }
    }
    if (ch === '{') {
      i++;
      for (;;) {
        skipBlank();
        if (i >= n) fail('unterminated inline table');
        if (text[i] === '}') {
          i++;
          return;
        }
        key();
        if (text[i] !== '=') fail('expected "=" in an inline table');
        i++;
        skipSpaces();
        value();
        skipBlank();
        if (text[i] === ',') i++;
        else if (text[i] !== '}') fail(i >= n ? 'unterminated inline table' : `unexpected "${text[i]}" in an inline table`);
      }
    }
    // Numbers, booleans, dates and times (a local date-time may contain one space).
    const from = i;
    while (i < n && !/[\n#,\]}]/.test(text[i])) i++;
    while (i > from && /[ \t\r]/.test(text[i - 1])) i--;
    if (i === from) fail('expected a value');
  };

  while (i < n) {
    const start = line;
    skipSpaces();
    if (text[i] === '\r' && text[i + 1] === '\n') i++;
    if (i >= n) {
      out.push({ kind: 'blank', start, end: start, table });
      break;
    }
    const ch = text[i];
    if (ch === '\n') {
      out.push({ kind: 'blank', start, end: start, table });
    } else if (ch === '#') {
      const from = i;
      while (i < n && text[i] !== '\n') i++;
      out.push({ kind: 'comment', start, end: start, table, text: text.slice(from, i).trim() });
    } else if (ch === '[') {
      const array = text[i + 1] === '[';
      i += array ? 2 : 1;
      const k = key();
      if (text[i] !== ']' || (array && text[i + 1] !== ']')) fail(`expected "${array ? ']]' : ']'}" after a table header`);
      i += array ? 2 : 1;
      endOfLine();
      table = k;
      out.push({ kind: array ? 'array-header' : 'header', start, end: start, table: k, key: k });
    } else {
      const k = key();
      if (text[i] !== '=') fail('expected "=" after a key');
      i++;
      skipSpaces();
      value();
      endOfLine();
      out.push({ kind: 'keyval', start, end: line, table, key: k });
    }
    if (text[i] === '\n') {
      i++;
      line++;
    }
  }
  return out;
}

/**
 * Decodes the escapes of a basic string key (enough to compare key names; JSON's escapes are TOML's, minus \\U).
 * @param {string} raw
 * @returns {string}
 */
function decodeBasic(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The managed block.

const BEGIN_RE = /^# specreview:begin\b/;
const END_RE = /^# specreview:end\b/;

/**
 * @param {string[] | undefined} p
 * @param {string[]} prefix
 * @returns {boolean}
 */
const startsWith = (p, prefix) => Boolean(p && p.length >= prefix.length && prefix.every((k, j) => p[j] === k));

/**
 * @typedef {object} TomlBlock
 * @property {TomlStatement[]} statements
 * @property {{ first: number, last: number } | null} region lines from the begin marker to the end marker (or, without
 *   an end marker, to the end of our table), inclusive
 * @property {Set<number>} own lines that are ours inside the region (markers, our table, blank lines, comments)
 * @property {number[]} keepBefore key/value lines inside the region before any header (they belong to the table above)
 * @property {number[]} foreign lines of other tables found inside the region, in order
 * @property {string[]} foreignTables headers of those tables, e.g. '[projects."/a"]'
 * @property {number[]} strayEnds end marker lines outside the region (Codex dropped the begin marker, or a leftover)
 * @property {boolean} ownTable whether the region holds a [mcp_servers.<name>] header
 */

/**
 * Locates our block in a scanned document. More than one begin marker is ambiguous: InstallRefusal-worthy, so this
 * throws a plain Error with a message for the caller to wrap.
 * @param {string} text
 * @param {string[]} ours the table path we own, e.g. ['mcp_servers', 'specreview']
 * @returns {TomlBlock}
 */
export function findTomlBlock(text, ours) {
  const statements = scanToml(text);
  const lines = text.split('\n');
  const comments = statements.filter((s) => s.kind === 'comment');
  const begins = comments.filter((s) => BEGIN_RE.test(/** @type {string} */ (s.text)));
  const ends = comments.filter((s) => END_RE.test(/** @type {string} */ (s.text)));
  /** @type {TomlBlock} */
  const r = { statements, region: null, own: new Set(), keepBefore: [], foreign: [], foreignTables: [], strayEnds: [], ownTable: false };
  if (begins.length > 1) throw new Error(`it has ${begins.length} "# specreview:begin" lines; SpecReview manages one block`);
  if (!begins.length) {
    r.strayEnds = ends.map((s) => s.start);
    return r;
  }
  const b = begins[0];
  const after = statements.filter((s) => s.start > b.start);
  const endStmt = after.find((s) => s.kind === 'comment' && END_RE.test(/** @type {string} */ (s.text)));
  /** @type {'lead' | 'own' | 'foreign'} */
  let seg = 'lead';
  /** @type {Array<{ s: TomlStatement, seg: 'lead' | 'own' | 'foreign' }>} */
  const tagged = [];
  for (const s of after) {
    if (s === endStmt) break;
    if (s.kind === 'header' || s.kind === 'array-header') {
      const mine = s.kind === 'header' && startsWith(s.key, ours);
      if (!mine) {
        // Comments right above a foreign header describe it: they go with it.
        let j = tagged.length;
        while (j > 0 && tagged[j - 1].s.kind === 'comment' && tagged[j - 1].seg !== 'foreign') j--;
        if (!endStmt) {
          // Without an end marker, nothing from here on is claimed.
          tagged.length = j;
          break;
        }
        for (let k = j; k < tagged.length; k++) tagged[k].seg = 'foreign';
        r.foreignTables.push(lines[s.start].trim());
      }
      seg = mine ? 'own' : 'foreign';
      if (mine && s.key?.length === ours.length) r.ownTable = true;
    }
    tagged.push({ s, seg });
  }
  // Without an end marker the region stops at our table's last non-blank line.
  while (!endStmt && tagged.length && tagged[tagged.length - 1].s.kind === 'blank') tagged.pop();
  r.own.add(b.start);
  for (const { s, seg: g } of tagged) {
    for (let l = s.start; l <= s.end; l++) {
      if (g === 'foreign') r.foreign.push(l);
      else if (g === 'lead' && s.kind === 'keyval') r.keepBefore.push(l);
      else r.own.add(l);
    }
  }
  const last = endStmt ? endStmt.end : Math.max(b.start, ...tagged.map((t) => t.s.end));
  if (endStmt) r.own.add(endStmt.start);
  r.region = { first: b.start, last };
  r.strayEnds = ends.filter((s) => s !== endStmt).map((s) => s.start);
  return r;
}

/**
 * Where the document defines something under `ours` outside our block: e.g. a [mcp_servers.specreview] header, a
 * `specreview = {...}` / `specreview.command = ...` key under [mcp_servers], or a root `mcp_servers.specreview...`
 * dotted key. `container` reports a parent that cannot take our table (an inline `mcp_servers = {...}` or an array of
 * tables [[mcp_servers]]).
 * @param {TomlBlock} blk
 * @param {string[]} ours
 * @returns {{ defined: boolean, container: boolean }}
 */
export function definitionsOutside(blk, ours) {
  const parent = ours.slice(0, -1);
  let defined = false;
  let container = false;
  for (const s of blk.statements) {
    if (blk.own.has(s.start)) continue;
    if (s.kind === 'header' && startsWith(s.key, ours)) defined = true;
    if (s.kind === 'array-header' && (startsWith(s.key, ours) || startsWith(parent, /** @type {string[]} */ (s.key)))) {
      if (startsWith(s.key, ours)) defined = true;
      else container = true;
    }
    if (s.kind === 'keyval') {
      const full = [...s.table, ...(s.key ?? [])];
      if (startsWith(full, ours)) defined = true;
      else if (startsWith(parent, full)) container = true; // mcp_servers = { ... } (or a parent of it)
    }
  }
  return { defined, container };
}

/**
 * The text with our block replaced by `block` (or appended), foreign tables moved below it, stray end markers dropped.
 * @param {string} text
 * @param {TomlBlock} blk
 * @param {string} block from its begin line to its end line, no trailing newline
 * @returns {string}
 */
export function upsertTomlBlock(text, blk, block) {
  if (text.trim() === '') return `${block}\n`;
  const lines = text.split('\n');
  const stray = new Set(blk.strayEnds);
  const keep = (/** @type {number} */ l) => !stray.has(l);
  if (!blk.region) {
    const rest = lines.filter((_, l) => keep(l)).join('\n').replace(/\s+$/, '');
    return rest ? `${rest}\n\n${block}\n` : `${block}\n`;
  }
  const { first, last } = blk.region;
  const before = lines.slice(0, first).filter((_, l) => keep(l));
  const after = lines.slice(last + 1).filter((_, j) => keep(last + 1 + j));
  const moved = trimBlank(blk.foreign.map((l) => lines[l]));
  const middle = [...blk.keepBefore.map((l) => lines[l]), ...block.split('\n'), ...(moved.length ? ['', ...moved] : [])];
  return [...before, ...middle, ...after].join('\n');
}

/**
 * The text without our block: the markers and our table go, foreign tables found inside stay where they were.
 * @param {string} text
 * @param {TomlBlock} blk
 * @returns {string | null} null when there is nothing of ours (no block, no stray end marker)
 */
export function removeTomlBlock(text, blk) {
  if (!blk.region && !blk.strayEnds.length) return null;
  const lines = text.split('\n');
  const stray = new Set(blk.strayEnds);
  if (!blk.region) return lines.filter((_, l) => !stray.has(l)).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  const { first, last } = blk.region;
  let before = lines.slice(0, first).filter((_, l) => !stray.has(l)).join('\n').replace(/\s+$/, '');
  // Key lines before any header inside the block belong to the table above: they stay attached to it.
  const keptKeys = blk.keepBefore.map((l) => lines[l]).join('\n');
  if (keptKeys) before = before ? `${before}\n${keptKeys}` : keptKeys;
  const foreign = trimBlank(blk.foreign.map((l) => lines[l])).join('\n');
  const after = lines.slice(last + 1).filter((_, j) => !stray.has(last + 1 + j)).join('\n').trim();
  const out = [before, foreign, after].filter((p) => p !== '').join('\n\n');
  return out ? `${out}\n` : '';
}

/**
 * @param {string[]} lines
 * @returns {string[]} without leading and trailing blank lines
 */
function trimBlank(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === '') a++;
  while (b > a && lines[b - 1].trim() === '') b--;
  return lines.slice(a, b);
}

