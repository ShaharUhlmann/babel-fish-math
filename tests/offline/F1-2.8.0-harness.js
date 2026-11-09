// 2.8.0 copy of F1-2.7.0-harness.js: the plugin runs with vimMode on; changes marked "2.8.0:".
// Offline harness for math-dir 2.1.0: H1 (multi-range insert), H2 (normal-mode
// relabel), M3 (Ex modal), M4 (Ctrl+[ in prompts). Usage: node harness.js <main.js>
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

class Plugin {
  constructor() { this.ext = []; this.app = { plugins: { plugins: {} }, workspace: { on() {}, onLayoutReady() {} } }; }
  registerEditorExtension(x) { this.ext.push(x); }
  registerMarkdownPostProcessor() {}
  addStatusBarItem() { return { style: {}, setText() {}, setAttr() {} }; }
  registerDomEvent() {} addCommand() {} registerEvent() {} addSettingTab() {} registerInterval() {}
  async loadData() { return { hebrew: true, layoutWarning: true, visualMotions: true, vimMode: true }; } // 2.8.0: vimMode
  async saveData() {}
}
let notices = 0;
const obsidian = { Plugin, PluginSettingTab: class {}, Setting: class {}, Notice: class { constructor() { notices++; } }, TFile: class {} };

const file = path.resolve(process.argv[2]);
let src = fs.readFileSync(file, 'utf8');
src += '\nmodule.exports.__t = { usKey, relabel, isExPrompt, followsLayer, vimCommandMode };\n';
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

(async () => {
  const p = new PluginClass();
  await p.onload();
  const inputExt = p.ext[1];
  const { EditorState, EditorSelection } = CMstate;
  const { EditorView } = CMview;

  // ---------- H1 ----------
  function typeInto(doc, ranges, text, extra = [], mainIdx = ranges.length - 1) {
    const state = EditorState.create({
      doc, extensions: [EditorState.allowMultipleSelections.of(true), inputExt, ...extra],
      selection: EditorSelection.create(ranges.map(([a, h]) => EditorSelection.range(a, h)), mainIdx),
    });
    const handlers = state.facet(EditorView.inputHandler);
    const view = { dom: { ownerDocument: { defaultView: null } }, state, composing: false, dispatch(tr) { this.state = tr.state; this.last = tr; } };
    const main = state.selection.main;
    let handled = false;
    for (const h of handlers) {
      if (h(view, main.from, main.to, text, () => state.update({ changes: { from: main.from, to: main.to, insert: text } }))) { handled = true; break; }
    }
    return { handled, doc: view.state.doc.toString(), sel: view.state.selection.ranges.map((r) => [r.anchor, r.head]), ev: view.last && view.last.annotation(CMstate.Transaction.userEvent), scroll: view.last && view.last.scrollIntoView };
  }
  // visual-block style: three cursors at line starts, type a-k-u-o one key at a time
  {
    let doc = 'x\ny\nz', ranges = [[0, 0], [2, 2], [4, 4]];
    for (const ch of 'akuo') {
      const r = typeInto(doc, ranges, ch);
      doc = r.doc; ranges = r.sel;
    }
    eq('H1 3 cursors akuo', doc, 'שלוםx\nשלוםy\nשלוםz');
    eq('H1 3 cursors positions', ranges, [[4, 4], [10, 10], [16, 16]]);
  }
  {
    const r = typeInto('hello', [[2, 2]], 'a');
    eq('H1 single cursor', [r.doc, r.sel, r.ev, r.scroll], ['heשllo', [[3, 3]], 'input.type', true]);
  }
  {
    const r = typeInto('hello world', [[0, 5]], 'k');
    eq('H1 replace selection', [r.doc, r.sel], ['ל world', [[1, 1]]]);
  }
  {
    const r = typeInto('ab\ncd', [[0, 1], [3, 4]], 'k');
    eq('H1 two selections replaced', [r.doc, r.sel], ['לb\nלd', [[1, 1], [4, 4]]]);
  }
  {
    // ) key → ( with closeBrackets: auto-pairs to ()
    const { closeBrackets } = (() => { try { return require('@codemirror/autocomplete'); } catch { return {}; } })();
    if (closeBrackets) {
      const r = typeInto('', [[0, 0]], ')', [closeBrackets()]);
      eq('H1 ) auto-pairs', [r.doc, r.sel], ['()', [[1, 1]]]);
      // closeBrackets only pairs before whitespace / closing chars
      const r2 = typeInto('\n', [[0, 0], [1, 1]], ')', [closeBrackets()]);
      eq('H1 ) auto-pairs at 2 cursors', [r2.doc, r2.sel], ['()\n()', [[1, 1], [4, 4]]]);
    } else console.log('SKIP closeBrackets (no @codemirror/autocomplete)');
  }
  {
    const r = typeInto('$x$', [[2, 2]], 'a');
    eq('H1 math untouched (declines)', r.handled, false);
  }
  {
    // main cursor in text (line 1), second cursor inside $…$ (line 2)
    const r = typeInto('ab\n$cd$', [[1, 1], [5, 5]], 'k', [], 0);
    eq('H1 per-range context (math range keeps k)', [r.doc, r.sel], ['aלb\n$ckd$', [[2, 2], [7, 7]]]);
  }

  // ---------- H2 helpers ----------
  const ev = (key, code, mods = {}) => ({ key, code, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });
  eq('usKey . on Hebrew', T.usKey(ev('ץ', 'Period')), '.');
  eq('usKey , on Hebrew', T.usKey(ev('ת', 'Comma')), ',');
  eq('usKey ; on Hebrew', T.usKey(ev('ף', 'Semicolon')), ';');
  eq('usKey / on Hebrew', T.usKey(ev('.', 'Slash')), '/');
  eq('usKey q on Hebrew', T.usKey(ev('/', 'KeyQ')), 'q');
  eq('usKey w on Hebrew', T.usKey(ev("'", 'KeyW')), 'w');
  eq("usKey ' on Hebrew", T.usKey(ev(',', 'Quote')), "'");
  eq('usKey ` on Hebrew', T.usKey(ev(';', 'Backquote')), '`');
  eq('usKey [ on Hebrew', T.usKey(ev(']', 'BracketLeft')), '[');
  eq('usKey ] on Hebrew', T.usKey(ev('[', 'BracketRight')), ']');
  eq('usKey j letter on Hebrew', T.usKey(ev('ח', 'KeyJ')), 'j');
  eq('usKey English same key', T.usKey(ev('.', 'Period')), null);
  eq('usKey shifted ignored', T.usKey(ev('>', 'Period', { shiftKey: true })), null);
  eq('usKey ctrl ignored', T.usKey(ev(']', 'BracketLeft', { ctrlKey: true })), null);
  eq('usKey QWERTZ letter ignored', T.usKey(ev('z', 'KeyY')), null);
  eq('usKey Escape ignored', T.usKey(ev('Escape', 'Escape')), null);
  eq('usKey QWERTZ punctuation ignored', T.usKey(ev('-', 'Slash')), null);
  eq('usKey QWERTZ ö ignored', T.usKey(ev('ö', 'Semicolon')), null);

  // ---------- H2 / M4 / M3 through onKeyDown ----------
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ doc: 'hello world', parent });
  const vim = { insertMode: false, inputState: { keyBuffer: [] } };
  view.cm = { state: { vim } };
  const fed = [];
  window.CodeMirrorAdapter = { Vim: { handleKey(cm, k) { fed.push(k); return true; } } };
  const kd = (key, code, target, mods = {}) => {
    const e = { isTrusted: true, isComposing: false, target, stopped: false, prevented: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...ev(key, code, mods) };
    p.onKeyDown(e);
    return e;
  };
  const content = view.contentDOM;
  notices = 0;
  let e = kd('ץ', 'Period', content);
  eq('H2 ץ/Period relabelled to .', [e.key, e.stopped], ['.', false]);
  eq('H2 warning shown', notices, 1);
  eq('H2 , ; / q w', ['ת:Comma', 'ף:Semicolon', '.:Slash', '/:KeyQ', "':KeyW"].map((s) => { const [k, c] = s.split(':'); return kd(k, c, content).key; }), [',', ';', '/', 'q', 'w']);
  vim.insertMode = true;
  eq('H2 insert mode untouched', kd('ץ', 'Period', content).key, 'ץ');
  vim.insertMode = false;
  vim.inputState.keyBuffer = ['f'];
  fed.length = 0;
  e = kd('ש', 'KeyA', content);
  eq('H2 f-char untouched (Hebrew OS)', [e.key, e.stopped, fed], ['ש', false, []]);
  e = kd('a', 'KeyA', content);
  eq('f-char layer (English OS) feeds ש', [e.stopped, fed], [true, ['ש']]);
  vim.inputState.keyBuffer = [];
  const label = document.createElement('span');
  label.className = 'vim-motions-easymotion-label';
  label.textContent = 'a';
  document.body.appendChild(label);
  eq('labels: label key relabelled', kd('ש', 'KeyA', content).key, 'a');
  eq('labels: non-label key left alone', kd('ץ', 'Period', content).key, 'ץ');
  label.remove();
  let intercept = true;
  window.CodeMirrorAdapter.getTableDebugState = () => ({ fork: { keyInterceptActive: intercept } });
  eq('flash/easymotion reader active: key left alone', kd('ש', 'KeyA', content).key, 'ש');
  intercept = false;
  eq('reader inactive: relabelled', kd('ש', 'KeyA', content).key, 'a');
  window.CodeMirrorAdapter.getTableDebugState = () => { throw new Error('x'); };
  eq('debug hook throws: relabelled', kd('ש', 'KeyA', content).key, 'a');
  delete window.CodeMirrorAdapter.getTableDebugState;
  // Ctrl+[ in the note: <Esc> fed
  fed.length = 0;
  e = kd(']', 'BracketLeft', content, { ctrlKey: true });
  eq('Ctrl+[ in note feeds <Esc>', [e.stopped, fed], [true, ['<Esc>']]);
  // M4: Ctrl+[ in a / prompt relabels to [ and does not stop the event
  const panel = document.createElement('div');
  panel.className = 'cm-vim-panel';
  panel.innerHTML = '<div><span>/<input type="text"></span></div>';
  document.body.appendChild(panel);
  const searchInput = panel.querySelector('input');
  e = kd(']', 'BracketLeft', searchInput, { ctrlKey: true });
  eq('M4 Ctrl+[ in / prompt → key [ and not stopped', [e.key, e.stopped, e.prevented], ['[', false, false]);
  // M3: Ex modal
  const modal = document.createElement('div');
  modal.className = 'modal vim-motions-prompt-modal-container';
  modal.innerHTML = '<div class="prompt-input-container vim-motions-prompt-modal-input"><input class="prompt-input" type="text" placeholder="Ex command"></div>';
  document.body.appendChild(modal);
  const exInput = modal.querySelector('input');
  eq('M3 Ex modal is an Ex prompt', T.isExPrompt(exInput), true);
  eq('M3 Ex modal does not follow the layer', T.followsLayer(exInput), false);
  const picker = document.createElement('div');
  picker.className = 'modal vim-motions-picker vim-motions-prompt-modal-container';
  picker.innerHTML = '<input class="vim-motions-picker-input" type="text">';
  document.body.appendChild(picker);
  eq('M3 picker still follows the layer', T.followsLayer(picker.querySelector('input')), true);
  const outline = document.createElement('div');
  outline.className = 'modal vim-motions-prompt-modal-container';
  outline.innerHTML = '<input class="prompt-input" type="text" placeholder="Jump to heading…">';
  document.body.appendChild(outline);
  eq('M3 outline modal still follows the layer', T.followsLayer(outline.querySelector('input')), true);
  // Hebrew-OS fallback in the Ex modal: KeyW giving ' inserts w
  let inserted = null;
  p.insertText = (el, t) => { inserted = t; };
  e = kd("'", 'KeyW', exInput);
  eq('M3 Hebrew-OS fallback in Ex modal types w', [inserted, e.prevented], ['w', true]);
  inserted = null;
  e = kd('ש', 'KeyA', exInput);
  eq('M3 Hebrew-OS fallback in Ex modal types a', inserted, 'a');

  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(2); });
