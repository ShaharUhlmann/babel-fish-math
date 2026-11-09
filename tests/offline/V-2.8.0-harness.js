// 2.8.0 copy of V-2.7.1-harness.js: the plugin runs with vimMode on; changes marked "2.8.0:".
// Offline harness for math-dir 2.7.1: V1 (h / l at the visual edge of a table
// cell) and V2 (which keys open R1's time window). Unlike F1 and F2, the fake
// view's window here IS attached, so R1's window really is in play.
// Run the F1, F2, F4 harnesses and the F4 oracle too.
// Usage: node V-2.7.1-harness.js <main.js>   (uses this folder's node_modules)
// On 2.7.0 the V1 stuck rows and the V2 arrow / Enter rows must FAIL.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
for (const k of ['navigator', 'Node', 'HTMLElement', 'MutationObserver', 'getComputedStyle',
  'requestAnimationFrame', 'InputEvent', 'KeyboardEvent', 'DOMRect', 'Range', 'Text']) {
  if (!(k in global)) global[k] = dom.window[k];
}
global.window = dom.window;
global.document = dom.window.document;

const CMstate = require('@codemirror/state');
const CMview = require('@codemirror/view');
const CMlang = require('@codemirror/language');
const { EditorState, Text } = CMstate;
const { Direction, EditorView } = CMview;

const obsidian = {
  Plugin: class {
    constructor() { this.ext = []; this.app = { workspace: { on() { return {}; }, onLayoutReady() {} }, vault: {} }; }
    registerEditorExtension(x) { this.ext.push(x); }
    registerMarkdownPostProcessor() {}
    addStatusBarItem() { return { style: {}, setAttr() {}, setText() {} }; }
    registerDomEvent() {} addCommand() {} addSettingTab() {} registerEvent() {} registerInterval() {}
    async loadData() { return { hebrew: true, vimMode: true }; } // 2.8.0: vimMode
    async saveData() {}
  },
  PluginSettingTab: class {}, Setting: class {}, Notice: class {}, TFile: class {},
};

const file = path.resolve(process.argv[2]);
const src = fs.readFileSync(file, 'utf8') +
  '\nmodule.exports.__t = { visualVimMotion, logicalVimMotion, OFF_TEXT: VIM_OFF_TEXT }; // 2.8.0: the Vim wording moved\n';
const m = new Module(file, module);
m.filename = file;
m.paths = module.paths;
const req = m.require.bind(m);
m.require = (id) => (id === 'obsidian' ? obsidian : id === '@codemirror/state' ? CMstate
  : id === '@codemirror/view' ? CMview : id === '@codemirror/language' ? CMlang : req(id));
m._compile(src, file);
const PluginClass = m.exports;
const { visualVimMotion, logicalVimMotion, OFF_TEXT } = PluginClass.__t;

let fails = 0;
let passes = 0;
const check = (ok, name, extra = '') => {
  if (ok) passes++; else fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
};
const eq = (got, want, name) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  check(a === b, name, a === b ? '' : `got ${a}, want ${b}`);
};

// ---------------------------------------------------------------------------
// V1
// ---------------------------------------------------------------------------

class Pos { constructor(line, ch) { this.line = line; this.ch = ch; } }

// The DOM as app.js builds it: a note's .cm-editor holding the table widget, with
// the cell's own .cm-editor mounted in a td (editTableCell).
const host = document.createElement('div');
host.innerHTML = '<div class="cm-editor" id="main"><div class="cm-content"><div class="cm-embed-block cm-table-widget">' +
  '<table><tbody><tr><td><div class="table-cell-wrapper"><div class="markdown-source-view">' +
  '<div class="cm-editor" id="cell"></div></div></div></td></tr></tbody></table></div></div></div>' +
  '<div class="cm-editor" id="renamed-parent-cell"></div>';
document.body.append(host);
const DOMS = {
  cell: host.querySelector('#cell'),
  main: host.querySelector('#main'),
  renamed: host.querySelector('#renamed-parent-cell'),
  throws: { closest() { throw new Error('boom'); } },
  noClosest: {},
  none: undefined,
};

// A fake editor: `text` one line, base direction `rtl`, all at one level unless
// `spans` says otherwise; `where` picks its DOM.
function fakeCm(text, rtl, where, spans) {
  const view = {
    state: { doc: Text.of([text]) },
    dom: DOMS[where],
    textDirectionAt: () => (rtl ? Direction.RTL : Direction.LTR),
    bidiSpans: () => spans || [{ from: 0, to: text.length, level: rtl ? 1 : 0, dir: rtl ? 1 : 0 }],
  };
  return { cm6: view };
}
const LEFT = visualVimMotion(true);
const RIGHT = visualVimMotion(false);
const PLAIN = { vim: {}, is: {} };
const OPER = { vim: {}, is: { operator: 'delete' } };
const VISUAL = { vim: { visualMode: true }, is: {} };
function press(motion, cm, ch, ctx = PLAIN, repeat = 1) {
  const args = { repeat };
  const r = motion(cm, new Pos(0, ch), args, ctx.vim, ctx.is);
  if (!r) return r === undefined ? 'undefined' : null;
  if (Array.isArray(r)) return { from: r[0].ch, to: r[1].ch, inclusive: args.inclusive };
  return r.ch;
}
const clip = (ch, len) => Math.max(0, Math.min(ch, len - 1)); // what Vim does with the result

const HE = 'שלום';
const last = HE.length - 1;
const cellRtl = fakeCm(HE, true, 'cell');
const mainRtl = fakeCm(HE, true, 'main');

// The review's live table, math-dir disabled column (stock, logical).
eq(press(RIGHT, cellRtl, 0), 1, 'V1 cell, RTL: l at ch 0 steps to ch 1, as math-dir disabled');
eq(press(LEFT, cellRtl, last), last - 1, 'V1 cell, RTL: h at the last character steps to last - 1, as math-dir disabled');
// The other two rows never reach the motion (Vim Motions' scope takes them), and it's unchanged.
eq(press(LEFT, cellRtl, 0), 1, 'V1 cell, RTL: h at ch 0 is still the visual step (the scope runs first live)');
eq(press(RIGHT, cellRtl, last), last - 1, 'V1 cell, RTL: l at the last character is still the visual step (scope, as above)');
// Inside the cell, nothing changes.
eq(press(RIGHT, cellRtl, 2), 1, 'V1 cell, RTL: l in the middle goes visually right');
eq(press(LEFT, cellRtl, 1), 2, 'V1 cell, RTL: h in the middle goes visually left');
// Consequence of the decision: the edge step goes inward, the next l comes back.
{
  let ch = 0;
  const seen = [];
  for (let i = 0; i < 3; i++) { ch = clip(press(RIGHT, cellRtl, ch), HE.length); seen.push(ch); }
  eq(seen, [1, 0, 1], 'V1 cell, RTL: l l l goes 1, 0, 1 (the documented limit)');
}
// Counts: logical, like the disabled column, only when the visual step can't move.
eq(press(RIGHT, cellRtl, 0, PLAIN, 3), 3, 'V1 cell, RTL: 3l at ch 0 goes to ch 3');
eq(press(RIGHT, cellRtl, 2, PLAIN, 3), 0, 'V1 cell, RTL: 3l from ch 2 still goes visually right, to the edge');
// Visual mode is a plain motion too (Vim Motions' own hq treats it as stock).
eq(press(RIGHT, cellRtl, 0, VISUAL), 1, 'V1 cell, RTL: visual-mode l at ch 0 steps logically');
eq(press(LEFT, cellRtl, last, VISUAL), last - 1, 'V1 cell, RTL: visual-mode h at the last character steps logically');

// LTR cell: no change once Vim clips (and the scope takes these keys live).
{
  const cell = fakeCm('abcd', false, 'cell');
  eq(clip(press(RIGHT, cell, 3), 4), 3, 'V1 cell, LTR: l at the end stays after Vim clips');
  eq(clip(press(LEFT, cell, 0), 4), 0, 'V1 cell, LTR: h at ch 0 stays after Vim clips');
  eq(press(RIGHT, cell, 1), 2, 'V1 cell, LTR: l in the middle');
}
// A cell mixing both directions: the visual right edge of `שלום ab` in RTL is ch 0.
{
  const mixed = 'שלום ab';
  const cell = fakeCm(mixed, true, 'cell', [{ from: 0, to: 5, level: 1, dir: 1 }, { from: 5, to: 7, level: 2, dir: 0 }]);
  eq(press(RIGHT, cell, 0), 1, 'V1 cell, mixed: l at the visual right edge steps logically');
  eq(press(LEFT, cell, 5), 4, 'V1 cell, mixed: h at the visual left edge (a) steps logically, to ch 4');
  eq(press(RIGHT, cell, 5), 6, 'V1 cell, mixed: l on the Latin run still moves visually');
}
// Niqqud: the logical step lands inside the cluster, and the next visual step recovers.
{
  const niqqud = 'שָלום'; // ש + qamats + ל ו ם
  const cell = fakeCm(niqqud, true, 'cell');
  eq(press(RIGHT, cell, 0), 1, 'V1 cell, niqqud: l at ch 0 steps one code unit, as math-dir disabled');
  eq(press(LEFT, cell, 1), 2, 'V1 cell, niqqud: h from inside the cluster goes to the next character');
}

// Operators must not change: same results inside and outside a cell, at every ch.
for (const [name, motion] of [['l-ward (dl, x)', RIGHT], ['h-ward (dh, X)', LEFT]]) {
  const inCell = [], outside = [];
  for (let ch = 0; ch <= last; ch++) {
    inCell.push(press(motion, cellRtl, ch, OPER));
    outside.push(press(motion, mainRtl, ch, OPER));
  }
  eq(inCell, outside, `V1 operator ${name}: the cell and the main editor agree at every ch`);
}
eq(press(RIGHT, cellRtl, 0, OPER), { from: 0, to: 1, inclusive: false }, 'V1 operator: x / dl at ch 0 takes ch 0');
eq(press(RIGHT, cellRtl, last, OPER), { from: last, to: last + 1, inclusive: false }, 'V1 operator: x / dl at the last character takes it');
eq(press(LEFT, cellRtl, last, OPER), null, 'V1 operator: dh / X at the visual left edge is still nothing');
eq(press(LEFT, cellRtl, 0, OPER), { from: 1, to: 2, inclusive: false }, 'V1 operator: dh at ch 0 takes the character to its visual left');

// Outside a cell: edge clamping stays.
eq(press(RIGHT, mainRtl, 0), 0, 'V1 main editor, RTL: l at ch 0 clamps (the editor holds a widget, but is not in one)');
eq(press(LEFT, mainRtl, last), last, 'V1 main editor, RTL: h at the last character clamps');
eq(press(RIGHT, mainRtl, 0, VISUAL), 0, 'V1 main editor, RTL: visual-mode l at ch 0 clamps');
eq(press(RIGHT, mainRtl, 2), 1, 'V1 main editor, RTL: l in the middle unchanged');
{
  const row = '| שלום | עולם |'; // a table row as text, as in Source mode
  const src = fakeCm(row, true, 'main');
  eq(press(RIGHT, src, 0), 0, 'V1 Source mode: a table row in the main editor clamps too');
}

// A failed cell test falls back to today's clamp, and doesn't throw.
for (const where of ['renamed', 'throws', 'noClosest', 'none']) {
  const cm = fakeCm(HE, true, where);
  let got;
  try { got = press(RIGHT, cm, 0); } catch (err) { got = 'threw: ' + err.message; }
  eq(got, 0, `V1 cell test can't tell (${where}): l at ch 0 clamps, no exception`);
}

// Logical motion (setting off, unload) is untouched.
eq(logicalVimMotion(false)(cellRtl, new Pos(0, 1), { repeat: 2 }).ch, 3, 'V1 logical motion unchanged');
check(/Replace mode/.test(OFF_TEXT.charArgs), 'V4 OFF_TEXT.charArgs names Replace mode');

// ---------------------------------------------------------------------------
// V2
// ---------------------------------------------------------------------------

(async () => {
  const P = new PluginClass();
  await P.onload();
  const ext = P.ext[1];
  const win = global.window;
  check(P.windows.has(win), 'V2 harness: the view\'s window is attached, so the time window applies');

  // A suggestion (or typed text) replacing `teh`, through the input handlers.
  // Returns the note's text, or 'untouched' when every handler declined and
  // CodeMirror would insert `text` as it is.
  const arrive = (text, opts = {}) => {
    const doc = opts.doc || 'teh wrod ';
    const anchor = opts.from ?? 0, head = opts.to ?? 3;
    const state = EditorState.create({ doc, extensions: [ext], selection: { anchor, head } });
    const view = {
      dom: { ownerDocument: { defaultView: opts.win || win } },
      state, composing: !!opts.composing,
      dispatch(tr) { this.state = tr.state; },
    };
    for (const h of state.facet(EditorView.inputHandler)) {
      if (h(view, anchor, head, text, () => state.update({ changes: { from: anchor, to: head, insert: text } }))) return view.state.doc.toString();
    }
    return 'untouched';
  };
  const key = (k, code, mods = {}) => P.onKeyDown({
    isTrusted: true, isComposing: false, key: k, code, target: null,
    ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods,
  });
  const reset = (age = 100000) => { P.lastKeyAt = Date.now() - age; };
  const HE_THE = 'איק wrod '; // "the" through the layer: `teh` becomes this on the bug

  // The bug: a keyboard pick in Obsidian's context menu.
  reset();
  eq(arrive('the'), 'untouched', 'V2 no key at all: a suggestion stays as it is');
  reset(); key('ArrowDown', 'ArrowDown'); key('Enter', 'Enter');
  eq(arrive('the'), 'untouched', 'V2 ArrowDown + Enter (menu pick): the suggestion stays as it is');
  reset(); key('ArrowDown', 'ArrowDown');
  eq(arrive('the'), 'untouched', 'V2 ArrowDown alone doesn\'t arm');
  reset(); key('Enter', 'Enter');
  eq(arrive('the'), 'untouched', 'V2 Enter alone doesn\'t arm');
  for (const [k, code] of [['ArrowUp', 'ArrowUp'], ['ArrowLeft', 'ArrowLeft'], ['ArrowRight', 'ArrowRight'],
    ['Escape', 'Escape'], ['Tab', 'Tab'], ['Backspace', 'Backspace'], ['Delete', 'Delete'], ['Home', 'Home'],
    ['F5', 'F5'], ['Shift', 'ShiftLeft'], ['Control', 'ControlLeft'], ['Alt', 'AltLeft'], ['AltGraph', 'AltRight'],
    ['Meta', 'MetaLeft'], ['CapsLock', 'CapsLock'], ['ContextMenu', 'ContextMenu']]) {
    reset(); key(k, code);
    eq(arrive('the'), 'untouched', `V2 ${k} doesn't arm`);
  }
  reset(); key('c', 'KeyC', { ctrlKey: true });
  eq(arrive('the'), 'untouched', 'V2 Ctrl+C doesn\'t arm');
  reset(); key('c', 'KeyC', { metaKey: true });
  eq(arrive('the'), 'untouched', 'V2 Meta+C doesn\'t arm');
  reset(); P.onKeyDown({ isTrusted: true, isComposing: false, key: undefined, code: '', target: null, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
  eq(arrive('the'), 'untouched', 'V2 a keydown with no key (autofill) doesn\'t arm, and doesn\'t throw');
  reset(); P.onKeyDown({ isTrusted: false, isComposing: false, key: 'a', code: 'KeyA', target: null, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
  eq(arrive('the'), 'untouched', 'V2 an untrusted key doesn\'t arm');
  reset(); P.onKeyDown({ isTrusted: true, isComposing: true, key: 'a', code: 'KeyA', target: null, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
  eq(arrive('the'), 'untouched', 'V2 a key inside a composition doesn\'t arm');

  // Every way a key legitimately types text arms it.
  const armers = [
    ['a typed letter', 'a', 'KeyA'],
    ['Shift + a letter', 'A', 'KeyA', { shiftKey: true }],
    ['a digit', '1', 'Digit1'],
    ['punctuation', ';', 'Semicolon'],
    ['Space', ' ', 'Space'],
    ['a numpad key', '.', 'NumpadDecimal'],
    ['Unidentified', 'Unidentified', ''],
    ['a dead key', 'Dead', 'Quote'],
    ['a key an IME holds (Process)', 'Process', 'KeyA'],
    ['AltGr, reported as Ctrl+Alt', '[', 'Digit8', { ctrlKey: true, altKey: true }],
    ['AltGr, reported with no modifier', '[', 'Digit8'],
    ['Alt + numpad', '0', 'Numpad0', { altKey: true }],
    ['a Hebrew-OS key', 'ש', 'KeyA'],
  ];
  for (const [name, k, code, mods] of armers) {
    reset(); key(k, code, mods);
    eq(arrive('the'), HE_THE, `V2 ${name} arms: text within the window is translated`);
  }
  // A dead key's own text: dead + dead, or dead + Space, gives `'`, which is mapped.
  reset(); key('Dead', 'Quote'); key('Dead', 'Quote');
  eq(arrive("'", { from: 0, to: 0, doc: 'x' }), ',x', 'V2 dead key twice: its text is translated');
  reset(); key('Dead', 'Quote'); key(' ', 'Space');
  eq(arrive("'", { from: 0, to: 0, doc: 'x' }), ',x', 'V2 dead key + Space: its text is translated');

  // The window itself.
  reset(501);
  eq(arrive('the'), 'untouched', 'V2 501 ms after a key: stays as it is');
  reset(400);
  eq(arrive('the'), HE_THE, 'V2 400 ms after a key: translated');
  // A typed key, then an arrow + Enter later: the arrow must not renew an old key.
  reset(600); key('ArrowDown', 'ArrowDown'); key('Enter', 'Enter');
  eq(arrive('the'), 'untouched', 'V2 an old typed key isn\'t renewed by arrow + Enter');
  // A real typing run, with an arrow in between: the last typed key still counts.
  reset(); key('a', 'KeyA'); key('ArrowLeft', 'ArrowLeft');
  eq(arrive('a', { from: 0, to: 0, doc: 'x' }), 'שx', 'V2 a recent typed key still counts after an arrow');

  // The translated and untranslated cases, with the window open.
  reset(); key('a', 'KeyA');
  eq(arrive('a', { from: 0, to: 0, doc: 'x' }), 'שx', 'V2 armed, in text: translated');
  reset(); key('a', 'KeyA');
  eq(arrive('a', { from: 2, to: 2, doc: '$x' }), 'untouched', 'V2 armed, in math: stays English');
  reset(); key('Enter', 'Enter');
  eq(arrive('\n', { from: 0, to: 0, doc: 'x' }), 'untouched', 'V2 Enter\'s \\n isn\'t mapped: untouched either way');
  reset(); key('a', 'KeyA');
  eq(arrive('\n', { from: 0, to: 0, doc: 'x' }), 'untouched', 'V2 armed, \\n: still untouched');
  reset(); key('a', 'KeyA');
  eq(arrive('a', { from: 0, to: 0, doc: 'x', composing: true }), 'untouched', 'V2 armed, composing: left to the composition');
  P.settings.hebrew = false;
  reset(); key('a', 'KeyA');
  eq(arrive('a', { from: 0, to: 0, doc: 'x' }), 'untouched', 'V2 armed, layer off: untouched');
  P.settings.hebrew = true;

  // A popout that was open at load has no hook 2: it translates as before.
  reset();
  eq(arrive('a', { from: 0, to: 0, doc: 'x', win: {} }), 'שx', 'V2 a window with no hook 2: translates with no key');

  console.log(`\n${passes} passed, ${fails} failed`);
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(2); });
