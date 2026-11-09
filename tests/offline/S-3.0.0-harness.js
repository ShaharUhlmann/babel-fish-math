// Copy of S-2.8.0 for 3.0.0; changes are marked 3.0.0:. Offline harness for math-dir 2.8.0: the source split and the Vim mode toggle.
//   A. vimMode false: no read of CodeMirrorAdapter, no Vim listener or interval;
//      typing, direction and the allowlist still work; core.js runs alone.
//   B. Toggling on and off at once, with the six keymap entries bound to really
//      stock motions while off; toggling back restores everything.
//   C. Vim Motions missing, arriving late, and Obsidian's own Vim API.
//   D. build.mjs: the check fails on planted Vim identifiers; the output is reproducible.
// Usage: node S-2.8.0-harness.js <plugin folder>/main.js
// Run the V, F1, F2, F4 2.8.0 copies and the F4 oracle too.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');
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
const { EditorView } = CMview;

const mainFile = path.resolve(process.argv[2]);
const pluginDir = path.dirname(mainFile);
const buildFile = path.join(pluginDir, 'build.mjs');

let fails = 0, passes = 0;
const check = (ok, name, extra = '') => {
  if (ok) passes++; else fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
};
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  check(a === b, name, a === b ? '' : `got ${a}, want ${b}`);
};

// ---- Spies on the Vim global and the timer ----
let adapter;
let adapterReads = 0;
Object.defineProperty(window, 'CodeMirrorAdapter', {
  configurable: true,
  get() { adapterReads++; return adapter; },
  set(v) { adapter = v; },
});
let liveIntervals = new Set();
let intervalsMade = 0;
const realSet = window.setInterval.bind(window), realClear = window.clearInterval.bind(window);
window.setInterval = (fn, ms) => { const id = realSet(fn, 1e9); liveIntervals.add(id); intervalsMade++; return id; };
window.clearInterval = (id) => { liveIntervals.delete(id); realClear(id); };

// ---- A fake HyperMD (as in F2) so math is seen as math ----
const BEGIN = 'formatting formatting-math formatting-math-begin keyword math';
const END = 'formatting formatting-math formatting-math-end keyword math';
const fakeHyperMD = CMlang.StreamLanguage.define({
  startState: () => ({ display: false, inline: false, fence: false, prevBlank: true, indent: false }),
  copyState: (s) => Object.assign({}, s),
  blankLine: (s) => { s.prevBlank = true; },
  token(stream, s) {
    if (stream.sol()) {
      const line = stream.string;
      if (s.fence) { if (/^```/.test(line)) s.fence = false; stream.skipToEnd(); s.prevBlank = false; return 'comment line-HyperMD-codeblock hmd-codeblock'; }
      if (!s.display && /^```/.test(line)) { s.fence = true; stream.skipToEnd(); s.prevBlank = false; return 'comment hmd-codeblock'; }
      if (!s.display && /^( {4}|\t)/.test(line) && (s.prevBlank || s.indent)) { s.indent = true; stream.skipToEnd(); return 'comment hmd-indented-code'; }
      s.indent = false; s.prevBlank = false;
    }
    if (s.display) {
      if (stream.match('$$')) { s.display = false; return END + ' math-block'; }
      stream.next(); return 'math';
    }
    if (s.inline) {
      if (stream.match('$')) { s.inline = false; return END; }
      stream.next(); return 'math';
    }
    if (stream.match('$$')) { s.display = true; return BEGIN + ' math-block'; }
    if (stream.peek() === '$' && /^\$[^\s$][^$]*[^\s\\]?\$/.test(stream.string.slice(stream.pos))) { stream.next(); s.inline = true; return BEGIN; }
    stream.next();
    return null;
  },
});

// ---- Obsidian mock ----
function makeObsidian(saved) {
  const handlers = {};
  const env = { handlers, notices: [], leaves: [], active: null, saved, settings: [] };
  const app = {
    workspace: {
      on(name, cb) { const ref = { name, cb }; (handlers[name] = handlers[name] || []).push(cb); return ref; },
      offref(ref) { handlers[ref.name] = handlers[ref.name].filter((x) => x !== ref.cb); },
      onLayoutReady(cb) { env.ready = cb; },
      getLeavesOfType(t) { return t === 'markdown' ? env.leaves : []; },
      get activeEditor() { return env.active ? { editor: { cm: env.active } } : null; },
    },
    vault: {},
  };
  env.trigger = (name, ...a) => (handlers[name] || []).slice().forEach((cb) => cb(...a));
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
    registerDomEvent(el, type, cb) { el.addEventListener(type, cb); }
    addCommand() {} addSettingTab(tab) { env.tab = tab; }
    registerEvent() {} registerInterval() {}
    async loadData() { return env.saved; }
    async saveData(d) { env.saved = d; }
  }
  class PluginSettingTab {
    constructor(a, p) { this.app = a; this.plugin = p; this.containerEl = { empty() { env.settings.length = 0; } }; }
    hide() {}
  }
  class Setting {
    constructor() { this.row = {}; env.settings.push(this.row); }
    setName(n) { this.row.name = n; return this; }
    setDesc(d) { this.row.desc = d; return this; }
    addToggle(f) {
      const t = { value: false, setValue(v) { this.value = v; return this; }, getValue() { return this.value; }, onChange(fn) { this.fn = fn; return this; } };
      this.row.toggle = t;
      f(t);
      return this;
    }
    // 3.0.0: the settings tab has a key map dropdown.
    addDropdown(f) {
      f({ addOption() { return this; }, setValue() { return this; }, onChange() { return this; } });
      return this;
    }
    addButton(f) {
      // 3.0.0: the key map buttons use setWarning and setDisabled.
      const b = { setButtonText() { return this; }, onClick(fn) { this.fn = fn; return this; }, setWarning() { return this; }, setCta() { return this; }, setDisabled() { return this; } };
      this.row.button = b;
      f(b);
      return this;
    }
  }
  const obsidian = { Plugin, PluginSettingTab, Setting, Notice: class { constructor(m) { env.notices.push(m); } }, TFile: class {} };
  return { env, obsidian };
}

// Loads a source file with the mock and the listed top-level names exposed.
function load(file, obsidian, names) {
  const src = fs.readFileSync(file, 'utf8') + `\nmodule.exports.__t = { ${names.join(', ')} };\n`;
  const m = new Module(file + '?' + Math.random(), module);
  m.filename = file;
  m.paths = module.paths;
  const orig = m.require.bind(m);
  m.require = (id) => (id === 'obsidian' ? obsidian : id === '@codemirror/state' ? CMstate
    : id === '@codemirror/view' ? CMview : id === '@codemirror/language' ? CMlang : orig(id));
  m._compile(src, file);
  return m.exports;
}

// ---- A Vim mock, close to the fork ----
class Pos { constructor(line, ch) { this.line = line; this.ch = ch; } }
function makeVim() {
  // The motion table: stock moveByCharacters reads only repeat and forward, plus
  // whichwrap (off here). getMotion binds, as the fork does.
  const Tt = {
    moveByCharacters(cm, head, a) { Tt.stockCalls++; return new Pos(head.line, a.forward ? head.ch + a.repeat : head.ch - a.repeat); },
    stockCalls: 0,
  };
  const V = {
    Tt,
    keymap: [{ keys: 'j', type: 'motion', motion: 'moveByLines' }],
    maps: 0,
    removes: 0,
    fed: [],
    handleKey(cm, k) { this.fed.push(k); return true; },
    defineMotion(name, fn) { Tt[name] = fn; },
    getMotion(name) { const h = Tt[name]; return h && h.bind(Tt); },
    mapCommand(keys, type, name, args, extra) { this.maps++; this.keymap.unshift(Object.assign({ keys, type, [type]: name, [type + 'Args']: args }, extra)); },
    getKeymap() { return this.keymap.map((e) => Object.assign({}, e)); },
    removeMapCommand() { this.removes++; },
  };
  return V;
}
const vimMotionsAdapter = (V) => ({ Vim: V, setKeyInterceptActive() {} });

// What Vim does with a key's command: the motion, then the operator's range.
function runKey(V, keys, cm, ch, repeat = 1) {
  const e = V.keymap.find((x) => x.keys === keys);
  const args = Object.assign({ repeat }, e.motionArgs);
  const inputState = e.operator ? { operator: e.operator } : {};
  const r = V.Tt[e.motion](cm, new Pos(0, ch), args, {}, inputState);
  return { entry: e, result: r };
}

// ---- Helpers ----
const mkEvent = (key, code, target, mods = {}) => ({
  isTrusted: true, isComposing: false, target, key, code, stopped: false, prevented: false,
  ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
  preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...mods,
});
function makeEditor(p, env, doc) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ doc, parent, extensions: [fakeHyperMD, p.ext[0], p.ext[1]] });
  env.leaves.push({ view: { editor: { cm: view } } });
  env.active = view;
  return view;
}
function attachVim(view) {
  const vim = { insertMode: false, visualMode: false, inputState: { keyBuffer: [] } };
  view.cm = { state: { vim }, cm6: view };
  const layer = document.createElement('div');
  layer.className = 'cm-cursorLayer cm-vimCursorLayer';
  view.scrollDOM.appendChild(layer);
  return vim;
}
function type(p, view, text) {
  p.onKeyDown(mkEvent(text, 'KeyA', view.contentDOM));
  const { from, to } = view.state.selection.main;
  const fallback = () => view.state.update({ changes: { from, to, insert: text } });
  for (const h of view.state.facet(EditorView.inputHandler)) if (h(view, from, to, text, fallback)) return true;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  return false;
}
function field(html, selector) {
  const box = document.createElement('div');
  box.innerHTML = html;
  document.body.appendChild(box);
  return box.querySelector(selector);
}
const PANEL_SEARCH = () => field('<div class="cm-vim-panel"><div><span>/<input type="text"></span></div></div>', 'input');
const PANEL_EX = () => field('<div class="cm-vim-panel"><div><span>:<input type="text"></span></div></div>', 'input');
const PICKER = () => field('<input class="vim-motions-picker-input" type="text">', 'input');
const QUICK = () => field('<input class="prompt-input" type="text">', 'input');
const EX_MODAL = () => field('<div class="vim-motions-prompt-modal-container"><input class="prompt-input" type="text" placeholder="Ex command"></div>', 'input');
const setting = (env, name) => env.settings.find((r) => (r.name || '').startsWith(name));
const NAMES = ['features', 'followsLayer', 'isExPrompt', 'visualOrder', 'logicalVimMotion', 'VIM_LOAD_EVENT', 'VIM_COMMANDS'];
const silence = (fn) => {
  const t = console.table, w = console.warn;
  console.table = () => {}; console.warn = () => {};
  try { return fn(); } finally { console.table = t; console.warn = w; }
};

(async () => {
  // =========================================================================
  // A. vimMode false
  // =========================================================================
  {
    const { env, obsidian } = makeObsidian({ hebrew: true, layoutWarning: true, visualMotions: true });
    const PluginClass = load(mainFile, obsidian, NAMES);
    const T = PluginClass.__t;
    const V = makeVim();
    window.CodeMirrorAdapter = vimMotionsAdapter(V); // Vim Motions is there; we must not look
    adapterReads = 0; intervalsMade = 0; liveIntervals.clear();

    const p = new PluginClass();
    await p.onload();
    eq('A vimMode defaults to false (data.json has no such key)', p.settings.vimMode, false);
    eq('A no Vim integration object', p.vim === null, true);
    env.ready();
    const view = makeEditor(p, env, 'hello');
    env.trigger('layout-change');
    env.trigger('active-leaf-change');
    eq('A no interval', [intervalsMade, liveIntervals.size], [0, 0]);
    eq('A no Vim load event handler', (env.handlers[T.VIM_LOAD_EVENT] || []).length, 0);
    eq('A only the core\'s workspace events', Object.keys(env.handlers).sort(), ['active-leaf-change', 'layout-change', 'window-close', 'window-open']);
    eq('A features: only tokens', Object.keys(T.features), ['tokens']);
    eq('A api has no visualOrder', 'visualOrder' in p.api, false);
    eq('A no motions, no commands', [V.maps, Object.keys(V.Tt).filter((k) => k.startsWith('mathDir'))], [0, []]);

    // Typing and direction.
    p.settings.hebrew = true;
    eq('A editor: LTR note, class without cursor direction', [view.dom.getAttribute('dir'), /math-dir-cur-/.test(view.dom.className), /math-dir-ltr/.test(view.dom.className)], ['ltr', false, true]);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    type(p, view, 'a');
    eq('A typing: Hebrew arrives', view.state.doc.toString(), 'helloש');
    eq('A direction: the note turned RTL', view.dom.getAttribute('dir'), 'rtl');
    const mathView = makeEditor(p, env, 'x $yz$ w');
    mathView.dispatch({ selection: { anchor: 4 } });
    type(p, mathView, 'a');
    eq('A typing in math stays English', mathView.state.doc.toString(), 'x $yaz$ w');
    p.settings.hebrew = false;
    mathView.dispatch({ selection: { anchor: 0 } });
    type(p, mathView, 'a');
    eq('A layer off: English', mathView.state.doc.toString(), 'ax $yaz$ w');
    p.settings.hebrew = true;

    // The allowlist.
    eq('A allowlist: quick switcher follows', T.followsLayer(QUICK()), true);
    eq('A allowlist: / prompt doesn\'t', T.followsLayer(PANEL_SEARCH()), false);
    eq('A allowlist: picker doesn\'t', T.followsLayer(PICKER()), false);
    eq('A allowlist: the Ex modal is a plain prompt-input (documented)', T.followsLayer(EX_MODAL()), true);
    const title = field('<div class="inline-title" contenteditable="true">x</div>', 'div');
    title.isContentEditable = true;
    eq('A allowlist: a note title follows', T.followsLayer(title), true);
    {
      const q = QUICK();
      let inserted = null;
      const realInsert = p.insertText;
      p.insertText = (el, t) => { inserted = t; };
      const e = { inputType: 'insertText', data: 'a', isComposing: false, target: q, preventDefault() { this.prevented = true; } };
      p.onBeforeInput(e);
      eq('A hook 3: a field that follows gets Hebrew', [inserted, e.prevented], ['ש', true]);
      p.insertText = realInsert;
    }

    // Keys: only the core's.
    env.notices.length = 0; p.lastWarn = 0;
    let e = mkEvent('ץ', 'Period', view.contentDOM);
    p.onKeyDown(e);
    eq('A Hebrew-OS key: not relabelled, warning still shown', [e.key, e.stopped, env.notices.length], ['ץ', false, 1]);
    e = mkEvent(']', 'BracketLeft', view.contentDOM, { ctrlKey: true });
    p.onKeyDown(e);
    eq('A Ctrl+[: left alone', [e.stopped, V.fed], [false, []]);
    {
      const label = field('<span class="vim-motions-easymotion-label">a</span>', 'span');
      e = mkEvent('ש', 'KeyA', view.contentDOM);
      p.onKeyDown(e);
      eq('A jump labels: left alone', e.key, 'ש');
      label.remove();
    }
    e = mkEvent('Enter', 'Enter', p.statusEl);
    p.onKeyDown(e);
    eq('A status button still toggles', [e.prevented, p.settings.hebrew], [true, false]);
    await p.setHebrew(true);

    // Diagnostics and settings.
    env.notices.length = 0;
    const rows = silence(() => p.diagnostics());
    eq('A Diagnostics: only the token check', rows.map((r) => r.check), ['editor open', 'tokenizer: math + fences', 'feature tokens']);
    check(/Vim mode off\. All features on\./.test(env.notices[0] || ''), 'A Diagnostics: the notice says Vim mode is off', env.notices[0]);
    env.tab.display();
    const vm = setting(env, 'Vim mode');
    eq('A setting: label and default', [vm.name, vm.toggle.value], ['Vim mode (experimental, might be unstable)', false]);
    check(/Vim Motions plugin/.test(vm.desc), 'A setting: the description says it needs Vim Motions');
    eq('A setting: Visual h / l hidden', setting(env, 'Visual h / l'), undefined);
    check(!/Vim Motions/.test(setting(env, 'Diagnostics').desc), 'A setting: Diagnostics text names only the parser');
    eq('A not one read of CodeMirrorAdapter in all of that', adapterReads, 0);

    // Token check waiting for an editor, with no Vim at all.
    p.onunload();
    const q = makeObsidian({});
    const PC2 = load(mainFile, q.obsidian, NAMES);
    const p2 = new PC2();
    adapterReads = 0;
    await p2.onload();
    q.env.ready();
    eq('A no editor: the token check waits', [p2.probePending, p2.probe.tokens.ok], [true, null]);
    makeEditor(p2, q.env, 'x');
    q.env.trigger('layout-change');
    eq('A editor open: the token check runs', [p2.probePending, adapterReads], [false, 0]);
    p2.onunload();
  }

  // core.js by itself, with vim.js nowhere in scope.
  {
    const { env, obsidian } = makeObsidian({ hebrew: true });
    const PC = load(path.join(pluginDir, 'src', 'core.js'), obsidian, ['features', 'followsLayer']);
    const p = new PC();
    await p.onload();
    env.ready();
    const view = makeEditor(p, env, 'x');
    view.dispatch({ selection: { anchor: 1 } });
    type(p, view, 'a');
    eq('A core.js alone: loads, types Hebrew, sets the direction', [view.state.doc.toString(), view.dom.getAttribute('dir')], ['xש', 'rtl']);
    const rows = silence(() => p.diagnostics());
    eq('A core.js alone: Diagnostics runs', rows.length, 3);
    p.onunload();
  }

  // =========================================================================
  // B. Toggling
  // =========================================================================
  {
    const { env, obsidian } = makeObsidian({ hebrew: true, layoutWarning: true, visualMotions: true, vimMode: true });
    const PC = load(mainFile, obsidian, NAMES);
    const T = PC.__t;
    const V = makeVim();
    window.CodeMirrorAdapter = vimMotionsAdapter(V);
    intervalsMade = 0; liveIntervals.clear();
    const p = new PC();
    await p.onload();
    const view = makeEditor(p, env, 'שלום');
    const vim = attachVim(view);
    env.ready();
    const panel = PANEL_SEARCH(), picker = PICKER(), ex = EX_MODAL();

    const ON = () => {
      check(!!p.vim, 'on: the integration exists');
      eq('on: one interval, one load-event handler', [liveIntervals.size, (env.handlers[T.VIM_LOAD_EVENT] || []).length], [1, 1]);
      eq('on: features as in 2.7.1, in its order', Object.keys(T.features), ['motions', 'visualMotions', 'charArgs', 'usKeys', 'escape', 'keymapCheck', 'tokens', 'cursorClass']);
      eq('on: all features pass', Object.values(T.features).every((x) => x === true), true);
      check(/math-dir-cur-rtl/.test(view.dom.className), 'on: cursor class on the editor', view.dom.className);
      eq('on: allowlist has the / prompt and the picker, not the Ex modal', [T.followsLayer(panel), T.followsLayer(picker), T.followsLayer(ex)], [true, true, false]);
      eq('on: api.visualOrder is there', typeof p.api.visualOrder, 'function');
      let e = mkEvent('ץ', 'Period', view.contentDOM);
      p.lastWarn = Date.now();
      p.onKeyDown(e);
      eq('on: Hebrew-OS key relabelled', e.key, '.');
      vim.inputState.keyBuffer = ['f'];
      V.fed.length = 0;
      e = mkEvent('a', 'KeyA', view.contentDOM);
      p.onKeyDown(e);
      eq('on: f + a feeds ש', [e.stopped, V.fed], [true, ['ש']]);
      vim.inputState.keyBuffer = [];
      eq('on: h is the visual motion', V.Tt.mathDirVisualLeft(view.cm, new Pos(0, 1), { repeat: 1 }, {}, {}).ch, 2);
      const before = V.Tt.stockCalls;
      V.Tt.mathDirVisualRight(view.cm, new Pos(0, 1), { repeat: 1 }, {}, {});
      eq('on: the visual motion doesn\'t call stock', V.Tt.stockCalls, before);
    };
    console.log('--- on, from load');
    ON();
    eq('on: 6 commands mapped once', V.maps, 6);

    // The settings toggle, as the user flips it.
    env.tab.display();
    check(setting(env, 'Visual h / l'), 'on: Visual h / l is shown');
    eq('on: Vim mode toggle reads on', setting(env, 'Vim mode').toggle.value, true);
    check(!/isn't loaded/.test(setting(env, 'Vim mode').desc), 'on: no "not loaded" note with Vim Motions there');
    const rowsOn = silence(() => p.diagnostics());
    check(rowsOn.some((r) => r.check === 'Vim API loaded') && rowsOn.some((r) => r.check === 'feature motions'), 'on: Diagnostics has the Vim rows');
    eq('on: Diagnostics row order ends with the tokenizer, then features', rowsOn[rowsOn.length - 9].check, 'tokenizer: math + fences');

    console.log('--- off');
    await setting(env, 'Vim mode').toggle.fn(false);
    eq('off: saved', env.saved.vimMode, false);
    eq('off: no integration', p.vim === null, true);
    eq('off: no interval, no load-event handler', [liveIntervals.size, (env.handlers[T.VIM_LOAD_EVENT] || []).length], [0, 0]);
    eq('off: only the core\'s layout listeners stay', [env.handlers['layout-change'].length, env.handlers['active-leaf-change'].length], [1, 1]);
    eq('off: only tokens', Object.keys(T.features), ['tokens']);
    check(!/math-dir-cur-/.test(view.dom.className), 'off: cursor class gone', view.dom.className);
    check(/math-dir-rtl/.test(view.dom.className), 'off: the direction class stays');
    eq('off: allowlist shrinks', [T.followsLayer(panel), T.followsLayer(picker), T.followsLayer(QUICK())], [false, false, true]);
    eq('off: api.visualOrder is gone', 'visualOrder' in p.api, false);
    eq('off: Visual h / l hidden again', setting(env, 'Visual h / l'), undefined);

    adapterReads = 0;
    let e = mkEvent('ץ', 'Period', view.contentDOM);
    p.lastWarn = Date.now();
    p.onKeyDown(e);
    env.trigger('layout-change');
    env.trigger('active-leaf-change');
    env.trigger(T.VIM_LOAD_EVENT);
    const offRows = silence(() => p.diagnostics());
    env.tab.display();
    eq('off: keys, events, Diagnostics and settings read no Vim', [adapterReads, e.key], [0, 'ץ']);
    eq('off: Diagnostics has no Vim rows', offRows.map((r) => r.check), ['editor open', 'tokenizer: math + fences', 'feature tokens']);

    // The six entries stay, on really stock motions.
    eq('off: no entry removed', [V.removes, V.keymap.filter((x) => x.motion && x.motion.startsWith('mathDir')).length], [0, 6]);
    {
      const cm = view.cm;
      V.Tt.stockCalls = 0;
      eq('stock: h steps back', runKey(V, 'h', cm, 2).result.ch, 1);
      eq('stock: l steps forward', runKey(V, 'l', cm, 2).result.ch, 3);
      eq('stock: <Left> / <Right>', [runKey(V, '<Left>', cm, 2).result.ch, runKey(V, '<Right>', cm, 2).result.ch], [1, 3]);
      eq('stock: 3l keeps the count', runKey(V, 'l', cm, 0, 3).result.ch, 3);
      eq('stock: all reached moveByCharacters', V.Tt.stockCalls, 5);
      // x and X as delete operators: the entry gives the operator, the motion the range.
      const x = runKey(V, 'x', cm, 1);
      eq('stock: x is a delete of the next character', [x.entry.type, x.entry.operator, x.result.ch], ['operatorMotion', 'delete', 2]);
      const X = runKey(V, 'X', cm, 1);
      eq('stock: X is a delete of the previous character', [X.entry.type, X.entry.operator, X.result.ch], ['operatorMotion', 'delete', 0]);
      eq('stock: x and X stay normal-mode', [x.entry.context, X.entry.context], ['normal', 'normal']);
      // Late binding: Vim Motions swaps moveByCharacters while a table scope is up.
      const original = V.Tt.moveByCharacters;
      V.defineMotion('moveByCharacters', function (c, head, a) { return { crossed: true, self: this === V.Tt }; });
      eq('stock: late bound, a swapped moveByCharacters (cell crossing) is used, with its table as this', runKey(V, 'l', cm, 2).result, { crossed: true, self: true });
      V.defineMotion('moveByCharacters', original);
      eq('stock: and it comes back', runKey(V, 'l', cm, 2).result.ch, 3);
      // No recursion: the stock motion is never ours, even when wrapped by name.
      let depth = 0;
      const ours = V.Tt.mathDirVisualRight;
      V.Tt.mathDirVisualRight = (...a) => { depth++; return ours(...a); };
      runKey(V, 'l', cm, 0);
      eq('stock: no recursion through our names', depth, 1);
      V.Tt.mathDirVisualRight = ours;
      // getMotion missing: the logical motion.
      const gm = V.getMotion;
      delete V.getMotion;
      eq('stock: no getMotion, falls back to logical', runKey(V, 'l', cm, 2, 2).result.ch, 4);
      V.getMotion = gm;
    }

    console.log('--- on again');
    const mapsBefore = V.maps;
    env.tab.display();
    await setting(env, 'Vim mode').toggle.fn(true);
    eq('on again: saved', env.saved.vimMode, true);
    eq('on again: nothing stacked in the keymap', V.maps, mapsBefore);
    ON();
    check(setting(env, 'Visual h / l'), 'on again: Visual h / l shown');

    console.log('--- Visual h / l off');
    p.settings.visualMotions = false;
    p.vim.syncVim();
    V.Tt.stockCalls = 0;
    eq('visual off: stock too', [runKey(V, 'h', view.cm, 2).result.ch, V.Tt.stockCalls], [1, 1]);
    p.settings.visualMotions = true;
    p.vim.syncVim();
    eq('visual on again: the visual motion', V.Tt.mathDirVisualLeft(view.cm, new Pos(0, 1), { repeat: 1 }, {}, {}).ch, 2);

    // A failed back-pointer probe is the same case.
    p.probeOverrides = { backPointer: false };
    silence(() => p.probeNow());
    V.Tt.stockCalls = 0;
    eq('failed probe: stock too', [runKey(V, 'l', view.cm, 2).result.ch, V.Tt.stockCalls], [3, 1]);
    p.probeOverrides = {};
    silence(() => p.probeNow());
    eq('probe passes again: visual', p.vim.vimVisual, true);

    console.log('--- off and on while Vim Motions reloaded in between');
    await setting(env, 'Vim mode').toggle.fn(false);
    const V2 = makeVim();
    window.CodeMirrorAdapter = vimMotionsAdapter(V2);
    env.trigger(T.VIM_LOAD_EVENT);
    eq('off: a new Vim object isn\'t touched', V2.maps, 0);
    env.tab.display();
    await setting(env, 'Vim mode').toggle.fn(true);
    eq('on: the new Vim object gets its 6 commands', V2.maps, 6);

    console.log('--- unload');
    const liveV = V2;
    p.onunload();
    eq('unload: no integration, no interval, no load-event handler', [p.vim === null, liveIntervals.size, (env.handlers[T.VIM_LOAD_EVENT] || []).length], [true, 0, 0]);
    liveV.Tt.stockCalls = 0;
    eq('unload: the entries stay on stock motions', [runKey(liveV, 'l', view.cm, 1).result.ch, liveV.Tt.stockCalls], [2, 1]);
    eq('unload: followsLayer no longer asks Vim', T.followsLayer(PANEL_SEARCH()), false);
  }

  // =========================================================================
  // C. Vim Motions missing, late, or only Obsidian's own Vim API
  // =========================================================================
  {
    const { env, obsidian } = makeObsidian({ hebrew: true, vimMode: true });
    const PC = load(mainFile, obsidian, NAMES);
    const T = PC.__t;
    window.CodeMirrorAdapter = undefined;
    const p = new PC();
    const errors = [];
    const ce = console.error;
    console.error = (...a) => errors.push(a);
    await p.onload();
    const view = makeEditor(p, env, 'hello');
    env.ready();
    env.trigger('layout-change');
    let rows = silence(() => p.diagnostics());
    check(/Vim Motions not loaded\./.test(env.notices[env.notices.length - 1]), 'C nothing there: Diagnostics says Vim Motions isn\'t loaded', env.notices[env.notices.length - 1]);
    eq('C nothing there: its row', rows.find((r) => r.check === 'Vim Motions plugin').result, 'FAIL');
    env.tab.display();
    check(/isn't loaded/.test(setting(env, 'Vim mode').desc), 'C nothing there: the description says so');
    const e = mkEvent('ץ', 'Period', view.contentDOM);
    p.lastWarn = Date.now();
    p.onKeyDown(e);
    eq('C nothing there: keys pass, no throw', [e.key, e.stopped], ['ץ', false]);

    // Arrives later: registers as a load does.
    const V = makeVim();
    window.CodeMirrorAdapter = vimMotionsAdapter(V);
    env.trigger(T.VIM_LOAD_EVENT);
    eq('C arrives later: motions and commands at once', [V.maps, typeof V.Tt.mathDirVisualLeft], [6, 'function']);
    env.tab.display();
    check(!/isn't loaded/.test(setting(env, 'Vim mode').desc), 'C arrives later: the note is gone');

    // Gone again, then toggled off and on with nothing there: no errors.
    window.CodeMirrorAdapter = undefined;
    env.trigger('layout-change');
    await setting(env, 'Vim mode').toggle.fn(false);
    env.tab.display();
    await setting(env, 'Vim mode').toggle.fn(true);
    eq('C toggling with nothing there: no errors', errors, []);
    console.error = ce;

    // Obsidian's own Vim API: there at startup, no marker, no getMotion / getKeymap.
    const B = makeVim();
    delete B.getMotion;
    delete B.getKeymap;
    window.CodeMirrorAdapter = { Vim: B };
    env.notices.length = 0;
    env.trigger('layout-change');
    silence(() => p.diagnostics());
    check(/Vim Motions not loaded \(Obsidian's own Vim API found\)/.test(env.notices[env.notices.length - 1]), 'C built-in API: Diagnostics isn\'t fooled', env.notices[env.notices.length - 1]);
    env.tab.display();
    check(/isn't loaded/.test(setting(env, 'Vim mode').desc), 'C built-in API: nor is the description');
    eq('C built-in API: commands mapped once, keymap check off', [B.maps, T.features.keymapCheck], [6, false]);
    eq('C built-in API: no "self-check failed" notice for what it never had', env.notices.filter((m) => /self-check failed/.test(m)), []);
    check(/Off: keymapCheck/.test(env.notices[env.notices.length - 1]), 'C built-in API: Diagnostics still lists keymapCheck as off');
    check(/Works best with the Vim Motions plugin/.test(setting(env, 'Vim mode').desc), 'C the description says "works best with"');

    // Obsidian's Vim setting off: the API is there, but no view.cm. Nothing may fire.
    {
      const errs = [];
      const ce2 = console.error;
      console.error = (...a) => errs.push(a);
      B.fed.length = 0;
      p.lastWarn = Date.now();
      const keys = [['ץ', 'Period', {}], ['a', 'KeyA', {}], [']', 'BracketLeft', { ctrlKey: true }]];
      const seen = keys.map(([k, c, m]) => { const ev = mkEvent(k, c, view.contentDOM, m); p.onKeyDown(ev); return [ev.key, ev.stopped]; });
      eq('C built-in, its setting off: keys pass untouched', seen, [['ץ', false], ['a', false], [']', false]]);
      eq('C built-in, its setting off: nothing fed, no errors', [B.fed, errs], [[], []]);
      console.error = ce2;
    }

    // Obsidian's Vim setting on: view.cm is there. Model of its handler: handleKey
    // says "not handled" in Replace mode, and the handler itself overwrites.
    {
      const vim = attachVim(view);
      const written = [];
      view.cm.overWriteSelection = (t) => written.push(t);
      B.multiSelectHandleKey = function (cm, k) { this.fed.push(k); return !vim.insertMode || k === '<Esc>'; };
      silence(() => p.probeNow());
      eq('C built-in on an editor: only keymapCheck is off', Object.keys(T.features).filter((k) => T.features[k] === false), ['keymapCheck']);
      eq('C built-in on an editor: still no failure notice', env.notices.filter((m) => /self-check failed/.test(m)), []);
      check(/math-dir-cur-/.test(view.dom.className), 'C built-in: the cursor class is on', view.dom.className);

      const press = (k, c, target = view.contentDOM, m = {}) => { const ev = mkEvent(k, c, target, m); p.lastWarn = Date.now(); p.onKeyDown(ev); return ev; };
      // f / t / r
      vim.inputState.keyBuffer = ['f'];
      B.fed.length = 0;
      eq('C built-in: f + a feeds ש', [press('a', 'KeyA').stopped, B.fed], [true, ['ש']]);
      vim.inputState.keyBuffer = ['r'];
      B.fed.length = 0;
      eq('C built-in: r + a feeds ש', [press('a', 'KeyA').stopped, B.fed], [true, ['ש']]);
      vim.inputState.keyBuffer = [];
      // Replace mode: written once, with the layer's letter or the OS's.
      vim.insertMode = true;
      view.cm.state.overwrite = true;
      eq('C built-in: Replace mode, English OS: the Hebrew letter is written, not lost', [press('a', 'KeyA').stopped, written], [true, ['ש']]);
      written.length = 0;
      eq('C built-in: Replace mode, Hebrew OS: written too', [press('ל', 'KeyK').stopped, written], [true, ['ל']]);
      written.length = 0;
      // The fork: handled inside handleKey, so no second write.
      const ms = B.multiSelectHandleKey;
      B.multiSelectHandleKey = () => true;
      press('a', 'KeyA');
      eq('C the fork: Replace mode handled inside handleKey is not written twice', written, []);
      B.multiSelectHandleKey = ms;
      view.cm.state.overwrite = false;
      vim.insertMode = false;
      // Ctrl+[ in the note and in the prompts.
      B.fed.length = 0;
      eq('C built-in: Ctrl+[ in the note feeds <Esc>', [press(']', 'BracketLeft', view.contentDOM, { ctrlKey: true }).stopped, B.fed], [true, ['<Esc>']]);
      const search = PANEL_SEARCH(), exPrompt = PANEL_EX();
      eq('C built-in: Ctrl+[ in a prompt relabels and lets its handler cancel', (() => { const ev = press(']', 'BracketLeft', search, { ctrlKey: true }); return [ev.key, ev.stopped]; })(), ['[', false]);
      eq('C built-in: / follows the layer, : doesn\'t', [T.followsLayer(search), T.followsLayer(exPrompt)], [true, false]);
      // Hebrew-OS keys.
      eq('C built-in: Hebrew-OS normal-mode key relabelled', press('ץ', 'Period').key, '.');
      // Jump labels: none exist, and the missing debug hook counts as "no reader".
      eq('C built-in: no labels, no reader, letters relabel as normal-mode keys', press('ש', 'KeyA').key, 'a');
      // The safety net with no load event: a pointer check, and no keymap work.
      const mapsBefore = B.maps;
      p.vim.syncVim(true);
      p.vim.syncVim(true);
      eq('C built-in: the 10 s net does nothing and maps nothing', B.maps, mapsBefore);
      // Motions.
      const vis = B.Tt.mathDirVisualRight(view.cm, new Pos(0, 1), { repeat: 1 }, vim, {});
      eq('C built-in: visual l moves', vis.ch, 2);
      delete view.cm;
      silence(() => p.probeNow());
    }

    // Toggling doesn't stack commands where the keymap can't be read.
    env.tab.display();
    await setting(env, 'Vim mode').toggle.fn(false);
    eq('C built-in API: off gives the logical motion (no getMotion)', B.Tt.mathDirVisualRight(null, new Pos(0, 1), { repeat: 2, forward: true }).ch, 3);
    env.tab.display();
    await setting(env, 'Vim mode').toggle.fn(true);
    eq('C built-in API: toggling on again doesn\'t stack commands', B.maps, 6);
    p.onunload();
    {
      const q = makeObsidian({ hebrew: true, vimMode: true });
      const PC2 = load(mainFile, q.obsidian, NAMES);
      const p2 = new PC2();
      await p2.onload();
      q.env.ready();
      eq('C built-in API: nor does reloading the plugin', B.maps, 6);
      p2.onunload();
    }
  }

  // =========================================================================
  // D. build.mjs
  // =========================================================================
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'math-dir-build-'));
    const build = (...args) => spawnSync(process.execPath, [buildFile, ...args], { encoding: 'utf8' });
    const realSrc = path.join(pluginDir, 'src');
    const copySrc = (name) => {
      const d = path.join(tmp, name);
      fs.mkdirSync(d);
      for (const f of fs.readdirSync(realSrc)) fs.copyFileSync(path.join(realSrc, f), path.join(d, f));
      return d;
    };

    const r0 = build('--check');
    eq('D main.js is what the build produces', [r0.status, r0.stderr], [0, '']);
    const o1 = path.join(tmp, 'o1.js'), o2 = path.join(tmp, 'o2.js');
    build('--out', o1); build('--out', o2);
    check(fs.readFileSync(o1).equals(fs.readFileSync(o2)), 'D two builds are byte-identical');
    check(fs.readFileSync(o1).equals(fs.readFileSync(mainFile)), 'D and equal to main.js');
    check(/^\/\/ GENERATED .*edit: change src\//i.test(fs.readFileSync(mainFile, 'utf8').split('\n')[0]) || /^\/\/ GENERATED/.test(fs.readFileSync(mainFile, 'utf8')), 'D the first line says generated, edit src/', fs.readFileSync(mainFile, 'utf8').split('\n')[0]);
    {
      const crlf = copySrc('crlf');
      for (const f of fs.readdirSync(crlf)) fs.writeFileSync(path.join(crlf, f), fs.readFileSync(path.join(crlf, f), 'utf8').replace(/\n/g, '\r\n'));
      const o3 = path.join(tmp, 'o3.js');
      build('--src', crlf, '--out', o3);
      check(fs.readFileSync(o3).equals(fs.readFileSync(mainFile)), 'D CRLF sources give the same bytes');
    }
    {
      const stale = path.join(tmp, 'stale.js');
      fs.writeFileSync(stale, 'x');
      eq('D --check fails on a stale file', build('--check', '--out', stale).status === 0, false);
    }

    let n = 0;
    const planted = [
      ['CodeMirrorAdapter', 'const a = window.CodeMirrorAdapter;'],
      ['.cm6', 'const a = x.cm6;'],
      ['view.cm', 'const a = view.cm;'],
      ['view && view.cm', 'const a = view && view.cm;'],
      ['target.cm', 'const a = target.cm;'],
      ['state.vim', 'const a = cm.state.vim;'],
      ['cm-vim', "const a = '.cm-vim-panel';"],
      ['vim-motions', "const a = 'vim-motions:picker-ready';"],
      ['getKeymap', 'V.getKeymap();'],
      ['defineMotion', 'V.defineMotion();'],
      ['getMotion', 'V.getMotion();'],
      ['mapCommand', 'V.mapCommand();'],
      ['multiSelectHandleKey', 'V.multiSelectHandleKey();'],
      ['in a comment', '// window.CodeMirrorAdapter'],
      ['a vim.js function', 'function f() { return feedKey(); }'],
      ['a vim.js constant', 'const a = () => VIM_TEXT_FIELDS;'],
    ];
    for (const [name, line] of planted) {
      const d = copySrc('p' + n++);
      fs.appendFileSync(path.join(d, 'core.js'), '\n' + line + '\n');
      const out = path.join(tmp, 'never-' + n + '.js');
      const r = build('--src', d, '--out', out);
      check(r.status !== 0 && !fs.existsSync(out) && /build failed/.test(r.stderr), `D the check fails on ${name} in core, and writes nothing`, r.status === 0 ? 'built' : '');
    }
    for (const [name, line] of [['editor.cm', 'const a = leaf.view.editor.cm;'], ['.cm-content', "const a = '.cm-content';"], ['a word in a comment', '// feedKey is mentioned here']]) {
      const d = copySrc('p' + n++);
      fs.appendFileSync(path.join(d, 'core.js'), '\n' + line + '\n');
      const out = path.join(tmp, 'ok-' + n + '.js');
      const r = build('--src', d, '--out', out);
      eq(`D the check allows ${name} in core`, r.status, 0);
    }
    {
      const d = copySrc('p' + n++);
      fs.appendFileSync(path.join(d, 'vim.js'), '\nconst EN2HE = 1;\n');
      const out = path.join(tmp, 'dup.js');
      const r = build('--src', d, '--out', out);
      check(r.status !== 0 && !fs.existsSync(out), 'D a name declared twice across the files fails the build');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    eq('D manifest says 0.9.0', JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8')).version, '0.9.0'); // 0.9.0: the version
  }

  console.log(`\n${passes} passed, ${fails} failed`);
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(2); });
