// 2.8.0 copy of F4-math-dir-2.4.0-harness.js: the plugin runs with vimMode on; changes marked "2.8.0:".
// Offline harness for math-dir 2.4.0 (F4): M6 (direction hold), M8 (f/t/r
// character fallback), M9 (Reading-view fallback), L10 (grapheme clusters),
// L11 (soft-wrapped rows). Run F1's and F2's harnesses and the F4 oracle too.
// Usage: node F4-math-dir-2.4.0-harness.js <main.js>   (needs the jsdom +
// @codemirror node_modules that F1/F2 use, next to this file)
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
for (const k of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'InputEvent', 'KeyboardEvent', 'DOMRect', 'Range', 'Text']) {
  if (!(k in global)) global[k] = dom.window[k];
}
global.window = dom.window;
global.document = dom.window.document;

const CMstate = require('@codemirror/state');
const CMview = require('@codemirror/view');
const CMlang = require('@codemirror/language');
const { EditorState } = CMstate;
const { EditorView, Direction } = CMview;

// ---- Obsidian mock ----
class TFile { constructor(p) { this.path = p; this.extension = p.split('.').pop(); } }
const files = {};
let readFails = false;
let activeEditor = null;
let leaves = [];
const app = {
  workspace: {
    on() { return {}; }, onLayoutReady() {},
    getLeavesOfType(t) { return t === 'markdown' ? leaves : []; },
    get activeEditor() { return activeEditor; },
  },
  vault: {
    configDir: '.obsidian',
    getAbstractFileByPath(p) { return files[p] ? files[p].file : null; },
    async cachedRead(f) { if (readFails) throw new Error('read failed'); return files[f.path].saved; },
    adapter: { async exists() { return false; }, async read() { return ''; } },
  },
};
class Plugin {
  constructor() { this.app = app; this.ext = []; }
  registerEditorExtension(x) { this.ext.push(x); }
  registerMarkdownPostProcessor() {}
  addStatusBarItem() {
    const el = document.createElement('div');
    el.setText = (t) => { el.textContent = t; };
    el.setAttr = (k, v) => el.setAttribute(k, v);
    return el;
  }
  registerDomEvent() {} addCommand() {} registerEvent() {} addSettingTab() {} registerInterval() {}
  async loadData() { return { hebrew: true, layoutWarning: true, visualMotions: true, vimMode: true }; } // 2.8.0: vimMode
  async saveData() {}
}
class PluginSettingTab { constructor(a, p) { this.app = a; this.plugin = p; } }
const obsidian = { Plugin, PluginSettingTab, Setting: class {}, Notice: class {}, TFile };

const file = path.resolve(process.argv[2]);
let src = fs.readFileSync(file, 'utf8');
src += '\nmodule.exports.__t = { visualStep, visualOrder, lineLevels, clusterStarts, rowOrder, charArgFor, pendingCharArg, scanFor, MathDirView, perf };\n';
const m = new Module(file, module);
m.filename = file;
m.paths = module.paths;
const origReq = m.require.bind(m);
m.require = (id) => id === 'obsidian' ? obsidian
  : id === '@codemirror/state' ? CMstate : id === '@codemirror/view' ? CMview
  : id === '@codemirror/language' ? CMlang : origReq(id);
m._compile(src, file);
const PluginClass = m.exports;
const T = PluginClass.__t;

let fails = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const p = new PluginClass();
  await p.onload();

  // ================= M6 =================
  {
    const st = (doc) => EditorState.create({ doc });
    eq('M6 endsOpen: unclosed $$ at the end', T.scanFor(st('שלום\n$$\nx').doc).endsOpen(), true);
    eq('M6 endsOpen: unclosed fence', T.scanFor(st('```\nשלום').doc).endsOpen(), true);
    eq('M6 endsOpen: closed blocks', T.scanFor(st('$$\nx\n$$\n```\ny\n```').doc).endsOpen(), false);
    eq('M6 endsOpen: inline $$ closed on its line', T.scanFor(st('a $$x$$ b').doc).endsOpen(), false);
    eq('M6 endsOpen: frontmatter only', T.scanFor(st('---\na: b\n---').doc).endsOpen(), false);
    // The view: type "$$" at the top of a Hebrew note, then close it below.
    let state = st('שלום עולם');
    const fv = (s) => ({ state: s, visibleRanges: [{ from: 0, to: s.doc.length }], compositionStarted: false });
    const v = new T.MathDirView(fv(state));
    const dirs = [v.dir];
    const step = (spec) => {
      const tr = state.update({ changes: spec });
      const prev = state;
      state = tr.state;
      v.update({ docChanged: true, viewportChanged: false, startState: prev, state, changes: tr.changes, view: fv(state) });
      dirs.push(v.dir);
    };
    T.perf.dirHeld = 0;
    step({ from: 0, insert: '$' });
    step({ from: 1, insert: '$' });
    step({ from: 2, insert: '\n' });
    step({ from: state.doc.length, insert: '\n$$' });
    eq('M6 view: rtl held while $$ is open; closing it puts the Hebrew in math → ltr', dirs, ['rtl', 'rtl', 'rtl', 'rtl', 'ltr']);
    eq('M6 perf.dirHeld counts the held edits', T.perf.dirHeld, 2);
    step({ from: 0, to: state.doc.length, insert: 'English\n```\nשלום' });
    eq('M6 no hold when the whole note is replaced (another note loaded)', v.dir, 'ltr');
  }

  // ================= M8 =================
  {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ doc: '', parent });
    const vim = { insertMode: false, visualMode: false, inputState: { keyBuffer: [], prefixRepeat: [] } };
    view.cm = { state: { vim } };
    const fed = [];
    window.CodeMirrorAdapter = { Vim: { handleKey(cm, k) { fed.push(k); return true; } } };
    const kd = (key, code) => {
      const e = { isTrusted: true, isComposing: false, target: view.contentDOM, stopped: false, prevented: false,
        key, code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
        preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
      p.onKeyDown(e);
      return e;
    };
    // set the doc and cursor, then the pending command; returns [stopped, fed]
    const run = (doc, cursor, buf, key, code, extra = {}) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, selection: { anchor: cursor } });
      vim.inputState.keyBuffer = buf.split('');
      vim.inputState.prefixRepeat = extra.prefix || [];
      vim.visualMode = !!extra.visual;
      vim.sel = extra.visual ? { head: extra.visual } : undefined;
      fed.length = 0;
      const e = kd(key, code);
      return [e.stopped, fed.slice()];
    };
    eq('M8 pendingCharArg "3f" with prefix 2 → count 6',
      (() => { run('abc', 0, '', 'Escape', 'Escape'); vim.inputState.keyBuffer = ['3', 'f']; vim.inputState.prefixRepeat = ['2']; return T.pendingCharArg(view); })(),
      { cmd: 'f', count: 6, pos: 0 });
    eq('M8 from Hebrew text, fx with no ס but an x in $…$ → Latin x (key passes)', run('שלום $x+1$ עוד', 0, 'f', 'x', 'KeyX'), [false, []]);
    eq('M8 from Hebrew text, fa with a ש ahead → ש (fed)', run('שלום ושלום $a$', 0, 'f', 'a', 'KeyA'), [true, ['ש']]);
    eq('M8 neither found → first choice ש (as before)', run('hello world', 0, 'f', 'a', 'KeyA'), [true, ['ש']]);
    eq('M8 from inside math, fa with no a but a ש → ש (fed)', run('$x + y$ שלום', 2, 'f', 'a', 'KeyA'), [true, ['ש']]);
    eq('M8 from inside math, fb with a b → b (key passes)', run('$a + b$ שלום', 1, 'f', 'b', 'KeyB'), [false, []]);
    eq('M8 F (backward) from text: no ס before, an x before → x', run('$x$ שלום', 6, 'F', 'x', 'KeyX'), [false, []]);
    eq('M8 F only looks before the cursor (a ס after doesn\'t count)', run('x שלום ס', 2, 'F', 'x', 'KeyX'), [false, []]);
    eq('M8 t forward, as f', run('שלום $x$', 0, 't', 'x', 'KeyX'), [false, []]);
    eq('M8 t: a ס right after the cursor doesn\'t count (no move) → x in the formula', run('שס $x$', 0, 't', 'x', 'KeyX'), [false, []]);
    eq('M8 f: a ס right after the cursor does count', run('שס $x$', 0, 'f', 'x', 'KeyX'), [true, ['ס']]);
    eq('M8 T: the character right before the cursor doesn\'t count', run('$x$ סש', 5, 'T', 'x', 'KeyX'), [false, []]);
    eq('M8 count: 2fa, one ש but two a → a', run('xשaa', 0, '2f', 'a', 'KeyA'), [false, []]);
    eq('M8 count: 2fa, two ש → ש', run('xששaa', 0, '2f', 'a', 'KeyA'), [true, ['ש']]);
    eq('M8 operator count 2d + fa (prefixRepeat), one ש, two a → a', run('xשaa', 0, 'f', 'a', 'KeyA', { prefix: ['2'] }), [false, []]);
    eq('M8 operator dfx (keyBuffer f after d) → x', run('שלום $x$', 0, 'f', 'x', 'KeyX', { prefix: [] }), [false, []]);
    eq('M8 r has no fallback: ra in text → ש', run('abc', 0, 'r', 'a', 'KeyA'), [true, ['ש']]);
    eq('M8 r in math → a (key passes)', run('$abc$', 2, 'r', 'a', 'KeyA'), [false, []]);
    eq('M8 visual mode searches from vim.sel.head', run('x ש a', 0, 'f', 'a', 'KeyA', { visual: { line: 0, ch: 3 } }), [false, []]);
    eq('M8 punctuation: f, with no ת but a , → ,', run('שלום, עולם', 0, 'f', ',', 'Comma'), [false, []]);
    eq('M8 charArgFor direct', T.charArgFor(EditorState.create({ doc: 'שלום $x$' }),{ cmd: 'f', count: 1, pos: 0 }, 'x'), 'x');
    view.destroy();
    delete window.CodeMirrorAdapter;
  }

  // ================= L10 =================
  {
    const rtlView = (doc) => ({ state: EditorState.create({ doc }), bidiSpans: (line) => [{ from: 0, to: line.length, level: 1 }] });
    const ltrView = (doc) => ({ state: EditorState.create({ doc }), bidiSpans: (line) => [{ from: 0, to: line.length, level: 0 }] });
    const shalom = 'שָׁלוֹם'; // ש ָ ׁ ל ו ֹ ם: clusters start at 0, 3, 4, 6
    eq('L10 clusterStarts on plain text → null (cheap path)', T.clusterStarts('שלום abc'), null);
    const v = rtlView(shalom);
    eq('L10 visual order of שָׁלוֹם: ם ו ל ש (cluster starts only)', T.visualOrder(v, v.state.doc.line(1)), [6, 4, 3, 0]);
    eq('L10 h from ש → ל (one letter, not a mark)', T.visualStep(v, 1, 0, 1, true, false), { ch: 3 });
    eq('L10 2h from ש → ו', T.visualStep(v, 1, 0, 2, true, false), { ch: 4 });
    eq('L10 l from ל → ש', T.visualStep(v, 1, 3, 1, false, false), { ch: 0 });
    eq('L10 cursor inside a cluster (ch 1) counts as its letter', T.visualStep(v, 1, 1, 1, true, false), { ch: 3 });
    eq('L10 x on ש deletes the whole cluster [0,3)', T.visualStep(v, 1, 0, 1, false, true), { from: 0, to: 3 });
    eq('L10 x on ו deletes ו + holam [4,6)', T.visualStep(v, 1, 4, 1, false, true), { from: 4, to: 6 });
    const fam = 'a\u{1F468}‍\u{1F469}‍\u{1F467}b'; // a, family emoji (8 code units), b
    const lv = ltrView(fam);
    eq('L10 ZWJ emoji is one step: l from a → the emoji', T.visualStep(lv, 1, 0, 1, false, false), { ch: 1 });
    eq('L10 2l from a → b', T.visualStep(lv, 1, 0, 2, false, false), { ch: 9 });
    eq('L10 x on the emoji deletes all 8 code units', T.visualStep(lv, 1, 1, 1, false, true), { from: 1, to: 9 });
    eq('L10 plain RTL line unchanged (J1: 3h from ע → ם)', T.visualStep(rtlView('שלום עולם'), 1, 5, 3, true, false), { ch: 8 });
  }

  // ================= L11 =================
  {
    // RTL paragraph "אבג abcd דהו", wrapped after "b" (index 5): row 1 = 0..5, row 2 = 6..11.
    const text = 'אבג abcd דהו';
    const levels = [...text].map((c) => /[a-d]/.test(c) ? 2 : 1);
    const spans = (line) => levels.map((l, i) => ({ from: i, to: i + 1, level: l }));
    const mk = (opts = {}) => ({
      state: EditorState.create({ doc: text }),
      bidiSpans: spans,
      lineWrapping: opts.wrap !== false,
      textDirectionAt: () => Direction.RTL,
      coordsAtPos: (pos) => {
        const row = opts.oneRow ? 0 : pos < 6 ? 0 : 1;
        return { top: row * 20, bottom: row * 20 + 16, left: 0, right: 0 };
      },
    });
    const line = (v) => v.state.doc.line(1);
    const flat = mk({ wrap: false });
    eq('L11 whole-line order (no wrapping)', T.visualOrder(flat, line(flat)), [11, 10, 9, 8, 4, 5, 6, 7, 3, 2, 1, 0]);
    const w = mk();
    const lv = (v) => T.lineLevels(v, line(v));
    const chars = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    eq('L11 rows: row 2 (ו ה ד ␠ c d) then row 1 (a b ␠ ג ב א), RTL joins rows right to left',
      T.rowOrder(w, line(w), chars, lv(w)), [11, 10, 9, 8, 6, 7, 4, 5, 3, 2, 1, 0]);
    eq('L11 l from b (end of the formula\'s first part) → the space on the same row, not c on the next row', T.visualStep(w, 1, 5, 1, false, false), { ch: 3 });
    eq('L11 same step without wrapping → c (whole-line order)', T.visualStep(flat, 1, 5, 1, false, false), { ch: 6 });
    eq('L11 h from a (row 1\'s left edge) → d, row 2\'s right edge (reading order)', T.visualStep(w, 1, 4, 1, true, false), { ch: 7 });
    eq('L11 dl on b takes b only', T.visualStep(w, 1, 5, 1, false, true), { from: 5, to: 6 });
    eq('L11 l at א (row 1\'s right edge, the line\'s start) stays', T.visualStep(w, 1, 0, 1, false, false), { ch: 0 });
    eq('L11 wrapping on but one row → whole-line order', T.rowOrder(mk({ oneRow: true }), line(w), chars, lv(w)), [11, 10, 9, 8, 4, 5, 6, 7, 3, 2, 1, 0]);
    const ltr = Object.assign(mk(), { textDirectionAt: () => Direction.LTR, bidiSpans: (l) => [{ from: 0, to: l.length, level: 0 }] });
    eq('L11 LTR line: rows joined left to right', T.rowOrder(ltr, line(ltr), chars, lv(ltr)), chars);
    // L1: wrapped after "ab " inside the LTR run: the row's trailing space goes to the paragraph level.
    // "אב ab cd גד": א0 ב1 ␠2 a3 b4 ␠5 | c6 d7 ␠8 ג9 ד10
    const t2 = 'אב ab cd גד';
    const lv2 = [1, 1, 1, 2, 2, 2, 2, 2, 1, 1, 1];
    const w2 = {
      state: EditorState.create({ doc: t2 }), lineWrapping: true, textDirectionAt: () => Direction.RTL,
      bidiSpans: () => lv2.map((l, i) => ({ from: i, to: i + 1, level: l })),
      coordsAtPos: (pos) => { const row = pos < 6 ? 0 : 1; return { top: row * 20, bottom: row * 20 + 16, left: 0, right: 0 }; },
    };
    eq('L11 L1: row 1 = ␠(5) a b ␠ ב א, row 2 = ד ג ␠ c d', T.rowOrder(w2, w2.state.doc.line(1), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], lv2), [10, 9, 8, 6, 7, 5, 3, 4, 2, 1, 0]);
    eq('L11 L1: h from a → the trailing space at row 1\'s left edge', T.visualStep(w2, 1, 3, 1, true, false), { ch: 5 });
    const zeroFirst = Object.assign(mk(), { coordsAtPos: (pos) => pos === 0 ? { top: 0, bottom: 0, left: 0, right: 0 } : { top: pos < 6 ? 0 : 20, bottom: pos < 6 ? 16 : 36, left: 0, right: 0 } });
    eq('L11 a zero-height first box doesn\'t turn rows off', T.visualStep(zeroFirst, 1, 5, 1, false, false), { ch: 3 });
    const unmeasured = Object.assign(mk(), { coordsAtPos: () => null });
    eq('L11 line not drawn (coordsAtPos null) → whole-line order', T.visualStep(unmeasured, 1, 5, 1, false, false), { ch: 6 });
    // A real EditorView in jsdom (no layout): the row code must stay out of the way.
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const real = new EditorView({ doc: 'שלום עולם', parent, extensions: [EditorView.lineWrapping] });
    let r = T.visualStep(real, 1, 5, 3, true, false);
    eq('L11 coordsAtPos throws (jsdom without Window) → whole-line order, no exception', r, { ch: 8 });
    global.Window = dom.window.Window; // now coordsAtPos runs (no layout: zero boxes)
    r = T.visualStep(real, 1, 5, 3, true, false);
    eq('L11 real view in jsdom with zero-size boxes → whole-line order', r, { ch: 8 });
    const throwing = Object.assign(mk(), { coordsAtPos: () => { throw new Error('x'); } });
    eq('L11 coordsAtPos throws → whole-line order', T.visualStep(throwing, 1, 5, 1, false, false), { ch: 6 });
    real.destroy();
  }

  // ================= M9 =================
  {
    const f = new TFile('Notes/heb.md');
    files['Notes/heb.md'] = { file: f, saved: 'English only' };
    const ctx = (p2) => ({ sourcePath: p2, getSectionInfo: () => null });
    const sizer = document.createElement('div');
    sizer.className = 'markdown-preview-sizer markdown-preview-section';
    document.body.appendChild(sizer);
    const sec = () => { const el = document.createElement('div'); sizer.appendChild(el); return el; };

    // active editor holds unsaved Hebrew → synchronous rtl
    activeEditor = { file: f, editor: { getValue: () => 'שלום (unsaved)' } };
    let el = sec();
    p.postProcess(el, ctx('Notes/heb.md'));
    eq('M9 active editor buffer wins over the saved file, synchronously', el.getAttribute('dir'), 'rtl');

    // another leaf showing the file (not active)
    activeEditor = null;
    leaves = [{ view: { file: f, getViewData: () => 'עברית in a split' } }];
    el = sec();
    p.postProcess(el, ctx('Notes/heb.md'));
    eq('M9 any open Markdown leaf of the file (getViewData)', el.getAttribute('dir'), 'rtl');

    // not open: the saved file, async
    leaves = [];
    files['Notes/heb.md'].saved = 'שלום saved';
    el = sec();
    p.postProcess(el, ctx('Notes/heb.md'));
    eq('M9 not open: nothing yet (async read)', el.getAttribute('dir'), null);
    await sleep(5);
    eq('M9 not open: the saved file decides', el.getAttribute('dir'), 'rtl');

    // a failed read is caught
    readFails = true;
    const warns = [];
    const ow = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);
    el = sec();
    p.postProcess(el, ctx('Notes/heb.md'));
    await sleep(20);
    console.warn = ow;
    process.off('unhandledRejection', onUnhandled);
    readFails = false;
    eq('M9 failed read: caught (a warning, no unhandled rejection)', [warns.some((w) => w.includes('rtl-math-mix')), unhandled], [true, 0]);

    // sweep: only section containers
    const widget = document.createElement('div');
    widget.className = 'callout-content';
    document.body.appendChild(widget);
    const marked = document.createElement('p');
    marked.className = 'math-dir-ltr';
    widget.appendChild(marked);
    const wel = document.createElement('div');
    widget.appendChild(wel);
    p.applySection(wel, 'rtl');
    await sleep(40); // let the earlier cases' sweeps run
    sizer.dataset.mathDir = 'ltr'; // the note was ltr; now it flips to rtl
    const old = sec();
    old.className = 'math-dir-ltr';
    const fresh = sec();
    p.applySection(fresh, 'rtl');
    await sleep(60);
    eq('M9 sweep skips a non-section parent (Live Preview widget DOM)', [marked.className, widget.dataset.mathDir], ['math-dir-ltr', undefined]);
    eq('M9 sweep updates siblings in .markdown-preview-sizer', [old.classList.contains('math-dir-rtl'), sizer.dataset.mathDir], [true, 'rtl']);

    // not a markdown file: nothing
    files['img.png'] = { file: new TFile('img.png'), saved: '' };
    el = sec();
    p.postProcess(el, ctx('img.png'));
    eq('M9 non-Markdown source: untouched', el.getAttribute('dir'), null);
  }

  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
