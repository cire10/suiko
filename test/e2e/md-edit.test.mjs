// @ts-check
// Unit tests (node:test) for the Markdown formatting of the comment box (src/ui/md-edit.js). They run without a
// browser:  node --test test/e2e/md-edit.test.mjs
// Texts are written with their selection: `|` is the caret, `[...]` a selection.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { continueList, formatKey, toggleBold, toggleList } from '../../src/ui/md-edit.js';

/** @param {string} marked */
function parse(marked) {
  const caret = marked.indexOf('|');
  if (caret >= 0) return { value: marked.replace('|', ''), start: caret, end: caret };
  const start = marked.indexOf('[');
  const end = marked.indexOf(']') - 1;
  return { value: marked.replace('[', '').replace(']', ''), start, end };
}

/** @param {string} marked @param {(s: import('../../src/ui/md-edit.js').TextState) => import('../../src/ui/md-edit.js').TextEdit|null} edit */
function run(marked, edit) {
  const s = parse(marked);
  const e = edit(s);
  if (!e) return null;
  const v = s.value.slice(0, e.from) + e.text + s.value.slice(e.to);
  return e.start === e.end
    ? `${v.slice(0, e.start)}|${v.slice(e.start)}`
    : `${v.slice(0, e.start)}[${v.slice(e.start, e.end)}]${v.slice(e.end)}`;
}

/** @param {'bullet'|'number'} kind */
const list = (kind) => (/** @type {import('../../src/ui/md-edit.js').TextState} */ s) => toggleList(s, kind);

test('bold: a selection is wrapped, and stays selected without the markers', () => {
  assert.equal(run('say [hello] there', toggleBold), 'say **[hello]** there');
  assert.equal(run('[hello]', toggleBold), '**[hello]**');
});

test('bold: pressed again it comes off, with or without the markers in the selection', () => {
  assert.equal(run('say **[hello]** there', toggleBold), 'say [hello] there');
  assert.equal(run('say [**hello**] there', toggleBold), 'say [hello] there');
});

test('bold: a selection inside bold text takes its markers off, not nesting new ones', () => {
  assert.equal(run('**he[ll]o** x', toggleBold), 'he[ll]o x');
  assert.equal(run('**one** and **t[w]o**', toggleBold), '**one** and t[w]o');
  // Beside bold text, or across it: not inside.
  assert.equal(run('**one** [two]', toggleBold), '**one** **[two]**');
});

test('bold: spaces stay outside the markers (Markdown does not read `**word **` as bold)', () => {
  assert.equal(run('say [hello ]there', toggleBold), 'say **[hello]** there');
  assert.equal(run('say[ hello] there', toggleBold), 'say **[hello]** there');
});

test('bold: markers inside the selection do not nest', () => {
  assert.equal(run('[a **b** c]', toggleBold), '**[a b c]**');
});

test('bold: each selected line on its own, outside its list marker, and back', () => {
  assert.equal(run('[one\n- two\n\n3. three]', toggleBold), '[**one**\n- **two**\n\n3. **three**]');
  assert.equal(run('[**one**\n- **two**\n\n3. **three**]', toggleBold), '[one\n- two\n\n3. three]');
  assert.equal(run('[one\n**two**]', toggleBold), '[**one**\n**two**]');
});

test('bold: a selection of only spaces inserts markers after it', () => {
  assert.equal(run('a[  ]b', toggleBold), 'a  **|**b');
});

test('bold: the caret inside a word makes the word bold', () => {
  assert.equal(run('say he|llo there', toggleBold), 'say **he|llo** there');
  assert.equal(run('naï|ve', toggleBold), '**naï|ve**');
});

test('bold: the caret beside a word or in the open inserts markers for what comes next', () => {
  assert.equal(run('hello|', toggleBold), 'hello**|**');
  assert.equal(run('hello |there', toggleBold), 'hello **|**there');
  assert.equal(run('|', toggleBold), '**|**');
});

test('bold: bold, type, bold, type: the second press steps past the closing marker', () => {
  assert.equal(run('**hello|** world', toggleBold), '**hello**| world');
});

test('bold: empty markers come off', () => {
  assert.equal(run('a **|** b', toggleBold), 'a | b');
  assert.equal(run('**|**', toggleBold), '|');
});

test('bold: the caret touching bold text takes the markers off, and stays with its letter', () => {
  assert.equal(run('**he|llo** x', toggleBold), 'he|llo x');
  assert.equal(run('**|hello** x', toggleBold), '|hello x');
  assert.equal(run('|**hello** x', toggleBold), '|hello x');
  assert.equal(run('**hello**| x', toggleBold), 'hello| x');
  assert.equal(run('**one** and **tw|o**', toggleBold), '**one** and tw|o');
});

test('bold: only the line of the caret counts', () => {
  assert.equal(run('**a\nb|\nc**', toggleBold), '**a\nb**|**\nc**');
});

test('list: the caret on an empty line starts one', () => {
  assert.equal(run('|', list('bullet')), '- |');
  assert.equal(run('|', list('number')), '1. |');
  assert.equal(run('text\n|', list('bullet')), 'text\n- |');
});

test('list: the caret in a line lists that line and stays with its letter', () => {
  assert.equal(run('hello| world', list('bullet')), '- hello| world');
  assert.equal(run('hello| world', list('number')), '1. hello| world');
  assert.equal(run('  a|', list('bullet')), '  - a|');
  assert.equal(run('**a** b|', list('bullet')), '- **a** b|');
});

test('list: pressed again it comes off', () => {
  assert.equal(run('- hello| world', list('bullet')), 'hello| world');
  assert.equal(run('1. hello| world', list('number')), 'hello| world');
  assert.equal(run('1) hello|', list('number')), 'hello|');
  assert.equal(run('- |', list('bullet')), '|');
  assert.equal(run('-| a', list('bullet')), '|a');
});

test('list: the other kind converts', () => {
  assert.equal(run('1. hel|lo', list('bullet')), '- hel|lo');
  assert.equal(run('* hel|lo', list('number')), '1. hel|lo');
});

test('list: numbers go on from a numbered item right above', () => {
  assert.equal(run('1. a\n2. b\n|', list('number')), '1. a\n2. b\n3. |');
  assert.equal(run('7. a\nb|', list('number')), '7. a\n8. b|');
  assert.equal(run('- a\n|', list('number')), '- a\n1. |');
  assert.equal(run('  1. a\n|', list('number')), '  1. a\n1. |');
});

test('list: every selected line, the blank ones stay blank, and the block stays selected', () => {
  assert.equal(run('[one\ntwo\n\nthree]', list('number')), '[1. one\n2. two\n\n3. three]');
  assert.equal(run('[one\ntwo\n\nthree]', list('bullet')), '[- one\n- two\n\n- three]');
  assert.equal(run('a\nb[c\nd]e\nf', list('bullet')), 'a\n[- bc\n- de]\nf');
});

test('list: a selection of items comes off only when all are that kind', () => {
  assert.equal(run('[- a\n- b]', list('bullet')), '[a\nb]');
  assert.equal(run('[- a\nb]', list('bullet')), '[- a\n- b]');
  assert.equal(run('[- a\n1. b]', list('number')), '[1. a\n2. b]');
});

test('list: a selection ending right after a line break leaves the next line alone', () => {
  assert.equal(run('[one\n]two', list('bullet')), '[- one]\ntwo');
});

test('Enter: the next item, with the same indent and marker', () => {
  assert.equal(run('- a|', continueList), '- a\n- |');
  assert.equal(run('* a|', continueList), '* a\n* |');
  assert.equal(run('  - a|', continueList), '  - a\n  - |');
  assert.equal(run('3. a|', continueList), '3. a\n4. |');
  assert.equal(run('9) a|', continueList), '9) a\n10) |');
});

test('Enter: in the middle of an item splits it', () => {
  assert.equal(run('- ab|cd', continueList), '- ab\n- |cd');
});

test('Enter: on an empty item ends the list, with a blank line so the next text is not part of the last item', () => {
  assert.equal(run('- a\n- |', continueList), '- a\n\n|');
  assert.equal(run('1. a\n2. |', continueList), '1. a\n\n|');
  assert.equal(run('- a\n- |\nmore', continueList), '- a\n\n|\nmore');
  assert.equal(run('text\n- |', continueList), 'text\n|');
  assert.equal(run('- |', continueList), '|');
});

test('Enter: does what it always does outside a list, before the marker and with a selection', () => {
  assert.equal(run('hello|', continueList), null);
  assert.equal(run('-a|', continueList), null);
  assert.equal(run('**a**|', continueList), null);
  assert.equal(run('|- a', continueList), null);
  assert.equal(run('-| a', continueList), null);
  assert.equal(run('- [a]', continueList), null);
});

test('formatKey: Cmd on a Mac, Ctrl elsewhere, the digits by physical key', () => {
  assert.equal(formatKey({ key: 'b', metaKey: true }, true), 'bold');
  assert.equal(formatKey({ key: 'B', metaKey: true }, true), 'bold');
  assert.equal(formatKey({ key: 'b', ctrlKey: true }, false), 'bold');
  // Ctrl+B moves the caret back in a Mac text field.
  assert.equal(formatKey({ key: 'b', ctrlKey: true }, true), null);
  assert.equal(formatKey({ key: '*', code: 'Digit8', metaKey: true, shiftKey: true }, true), 'bullet');
  assert.equal(formatKey({ key: '&', code: 'Digit7', ctrlKey: true, shiftKey: true }, false), 'number');
  assert.equal(formatKey({ key: 'b' }, true), null);
  assert.equal(formatKey({ key: 'b', metaKey: true, shiftKey: true, code: 'KeyB' }, true), null);
  assert.equal(formatKey({ key: 'b', metaKey: true, altKey: true }, true), null);
  assert.equal(formatKey({ key: '8', code: 'Digit8', metaKey: true }, true), null);
  // A keydown without a key (some autofill events).
  assert.equal(formatKey({ metaKey: true }, true), null);
});
