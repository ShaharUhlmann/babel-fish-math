// 2.8.0 copy of F2-2.7.0-harness.js: the plugin runs with vimMode on; changes marked "2.8.0:".
// Offline harness for math-dir 2.2.0 (F2): probes and degradation, the adapter,
// L4 (indented code), L5–L9, L14, text-parser regions, event-driven Vim sync.
// Run F1's harness too (it covers H1, H2, M3, M4). Usage: node f2-harness.js <main.js>
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
const { EditorState, EditorSelection } = CMstate;
const { EditorView } = CMview;

// ---- Obsidian mock ----
let notices = [];
const handlers = {};
let leaves = [];
let activeView = null;
const files = {};
const app = {
  workspace: {
    on(name, cb) { (handlers[name] = handlers[name] || []).push(cb); return { name, cb }; },
    offref(ref) { handlers[ref.name] = handlers[ref.name].filter((x) => x !== ref.cb); }, // 2.8.0
    onLayoutReady(cb) { this.ready = cb; },
    getLeavesOfType(t) { return t === 'markdown' ? leaves : []; },
    get activeEditor() { return activeView ? { editor: { cm: activeView } } : null; },
  },
  vault: {
    configDir: '.obsidian',
    adapter: { async exists(p) { return p in files; }, async read(p) { return files[p]; } },
  },
};
const trigger = (name, ...a) => (handlers[name] || []).forEach((cb) => cb(...a));
class Plugin {
  constructor() { this.app = app; this.ext = []; this.intervals = 0; }
  registerEditorExtension(x) { this.ext.push(x); }
  registerMarkdownPostProcessor() {}
  addStatusBarItem() {
    const el = document.createElement('div');
    el.setText = (t) => { el.textContent = t; el.writes = (el.writes || 0) + 1; };
    el.setAttr = (k, v) => el.setAttribute(k, v);
    document.body.appendChild(el);
    return el;
  }
  registerDomEvent(el, type, cb) { el.addEventListener(type, cb); }
  addCommand() {} registerEvent() {} addSettingTab() {} registerInterval() { this.intervals++; }
  async loadData() { return { hebrew: true, layoutWarning: true, visualMotions: true, vimMode: true }; } // 2.8.0: vimMode
  async saveData() {}
}
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
const obsidian = { Plugin, PluginSettingTab, Setting: class {}, Notice: class { constructor(m) { notices.push(m); } }, TFile: class {} };

const file = path.resolve(process.argv[2]);
let src = fs.readFileSync(file, 'utf8');
src += '\nmodule.exports.__t = { features, featuresFrom, probeAll, probeTokens, textRegions, regionsFor, docDirection, inMathOrCode, visualStep, walkLines, VIM_LOAD_EVENT };\n';
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

// ---- A fake HyperMD: a StreamLanguage whose node names follow Obsidian's ----
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

(async () => {
  // ================= pure functions =================
  // L4: one rule for code in the direction decision
  eq('L4 Hebrew only in indented code → ltr', T.docDirection('English\n\n    שלום\n'), 'ltr');
  eq('L4 Hebrew in a list continuation → rtl', T.docDirection('English\n- item\n    שלום\n'), 'rtl');
  eq('L4 Hebrew in indented paragraph continuation → rtl', T.docDirection('para\n    שלום\n'), 'rtl');
  eq('L4 Hebrew in fenced code → ltr', T.docDirection('x\n```\nשלום\n```\n'), 'ltr');
  eq('L4 $$ inside indented code does not open math', T.docDirection('x\n\n    $$\nשלום\n'), 'rtl');
  eq('L4 Hebrew in indented line inside $$ is math', T.docDirection('$$\n    שלום\n$$\n'), 'ltr');
  eq('L4 frontmatter override still wins', T.docDirection('---\ndirection: rtl\n---\nhello'), 'rtl');
  eq('docDirection Hebrew text → rtl', T.docDirection('שלום $x$'), 'rtl');

  // text-parser regions
  const sample = 'a $x$ b\n\n$$\ny\n$$\n\n```\nz\n```\n\n    w\n\n    v\nend';
  const d = EditorState.create({ doc: sample }).doc;
  const TR = T.textRegions(d);
  eq('text regions math', TR.math, [{ from: 2, to: 5, open: false }, { from: d.line(3).from, to: d.line(5).to, open: false }]);
  eq('text regions code lines', [...TR.code].sort((a, b) => a - b), [7, 8, 9, 11, 12, 13]);
  const open = EditorState.create({ doc: 'x\n$$\nunclosed' }).doc;
  eq('text regions unclosed $$ runs to end', T.textRegions(open).math, [{ from: 2, to: open.length, open: true }]);

  // tree regions with the fake tokenizer agree with the text parser
  const st = EditorState.create({ doc: sample, extensions: fakeHyperMD });
  const tree = CMlang.ensureSyntaxTree(st, st.doc.length, 1000);
  const RR = T.regionsFor(st.doc, tree, st.doc.length);
  eq('tree regions == text regions (math)', RR.math, TR.math);
  eq('tree regions == text regions (code)', [...RR.code].sort((a, b) => a - b), [...TR.code].sort((a, b) => a - b));

  // token probe
  eq('token probe passes on HyperMD-style names', T.probeTokens({ state: st }).ok, true);
  const otherLang = CMlang.StreamLanguage.define({ token(s) { if (s.match('$')) return 'keyword dollar'; s.next(); return 'keyword'; } });
  eq('token probe fails on other names', T.probeTokens({ state: EditorState.create({ extensions: otherLang }) }).ok, false);
  eq('token probe unknown without a language', T.probeTokens({ state: EditorState.create({}) }).ok, null);

  // visualStep (mock bidiSpans: one RTL run at level 1)
  {
    const s = EditorState.create({ doc: 'שלום עולם' });
    const v = { state: s, bidiSpans: (line) => [{ from: 0, to: line.length, level: 1 }] };
    // J1: cursor on ש of עולם (index 5); visual left = logical forward in RTL
    eq('J1 3h on שלום עולם from ע → ל (index 8)', T.visualStep(v, 1, 5, 3, true, false), { ch: 8 });
    eq('J3 3dl from ע takes ע and 2 to its visual right (logically before)', T.visualStep(v, 1, 5, 3, false, true), { from: 3, to: 6 });
    eq('dh at visual left edge → null', T.visualStep(v, 1, 8, 1, true, true), null);
    eq('no bidiSpans → undefined (logical fallback)', T.visualStep({ state: s }, 1, 5, 1, true, false), undefined);
  }

  // ================= plugin with mock app =================
  const p = new PluginClass();
  // 2.8.0: Vim mode's timer is window.setInterval, stopped by the toggle.
  let intervals = 0;
  const realSetInterval = window.setInterval;
  window.setInterval = (...a) => { intervals++; return realSetInterval.apply(window, a); };
  await p.onload();
  const inputExt = p.ext[1];
  eq('interval registered (safety net)', intervals, 1); // 2.8.0
  eq('load event handler registered', !!handlers[T.VIM_LOAD_EVENT], true);

  // An editor with "Vim Motions" attached.
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ doc: 'hello world\n\n$x$ עולם', parent, extensions: [fakeHyperMD, p.ext[0]] });
  const vim = { insertMode: false, visualMode: false, inputState: { keyBuffer: [] } };
  view.cm = { state: { vim }, cm6: view };
  const layer = document.createElement('div');
  layer.className = 'cm-cursorLayer cm-vimCursorLayer';
  view.scrollDOM.appendChild(layer);
  leaves = [{ view: { editor: { cm: view } } }];
  activeView = view;

  // Vim API mock
  const calls = { define: [], map: [], getKeymap: 0, fed: [] };
  let keymap = [{ keys: 'j', type: 'motion', motion: 'moveByLines' }];
  const makeV = () => ({
    handleKey(cm, k) { calls.fed.push(k); return true; },
    defineMotion(name, fn) { calls.define.push(name); this.motions[name] = fn; },
    mapCommand(keys, type, name, args, extra) { calls.map.push(keys); keymap.unshift(Object.assign({ keys, type, [type]: name }, extra)); },
    getKeymap() { calls.getKeymap++; return keymap.map((e) => Object.assign({}, e)); },
    motions: {},
  });
  files['.obsidian/plugins/vim-motions/manifest.json'] = JSON.stringify({ version: '1.5.1' });
  let V = makeV();
  window.CodeMirrorAdapter = { Vim: V, setKeyInterceptActive() {} }; // 2.8.0: marker

  notices = [];
  app.workspace.ready();
  eq('layout ready: motions defined (visual)', calls.define, ['mathDirVisualLeft', 'mathDirVisualRight']);
  eq('layout ready: 6 commands mapped', calls.map.length, 6);
  eq('layout ready: all features on', Object.values(T.features).every((x) => x === true), true);
  eq('layout ready: no notice', notices, []);

  // L5: cheap path
  calls.getKeymap = 0; calls.map = []; calls.define = [];
  trigger('layout-change');
  p.vim.syncVim();
  eq('L5 cheap sync: no keymap copy, no re-define', [calls.getKeymap, calls.define.length, calls.map.length], [0, 0, 0]);
  p.vim.syncVim(true);
  eq('L5 10 s safety net: one keymap copy, nothing re-mapped', [calls.getKeymap, calls.map.length], [1, 0]);
  keymap = keymap.filter((e) => e.keys !== 'h'); // something dropped our h
  p.vim.syncVim(true);
  eq('safety net re-maps when a command is missing', calls.map.length, 1);
  const sb = p.statusEl;
  const w0 = sb.writes;
  p.updateStatus(); p.updateStatus();
  eq('L5 status not rewritten when unchanged', sb.writes, w0);

  // Phase 3: Vim Motions reload → load event → re-register at once
  calls.define = []; calls.map = [];
  V = makeV(); keymap = [{ keys: 'j', type: 'motion', motion: 'moveByLines' }];
  window.CodeMirrorAdapter = { Vim: V, setKeyInterceptActive() {} }; // 2.8.0: marker
  trigger(T.VIM_LOAD_EVENT);
  eq('J12 load event: new Vim gets motions + 6 commands immediately', [calls.define.length, calls.map.length], [2, 6]);

  // Visual motion through the adapter, operator range shape
  {
    const Pos = function (line, ch) { this.line = line; this.ch = ch; };
    const fnR = V.motions.mathDirVisualRight;
    const r = fnR(view.cm, new Pos(0, 0), { repeat: 3 }, vim, { operator: 'delete' });
    eq('adapter motion: 3dl in LTR → [0,3) exclusive', [r[0].ch, r[1].ch], [0, 3]);
    const mv = fnR(view.cm, new Pos(0, 0), { repeat: 2 }, vim, {});
    eq('adapter motion: 2l in LTR → ch 2', mv.ch, 2);
  }

  // H2 + f/t/r + Ctrl+[ still work with all features on
  const content = view.contentDOM;
  const kd = (key, code, target, mods = {}) => {
    const e = { isTrusted: true, isComposing: false, target, stopped: false, prevented: false,
      ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, key, code, ...mods };
    p.onKeyDown(e);
    return e;
  };
  p.lastWarn = 0;
  eq('H2 relabel on', kd('ץ', 'Period', content).key, '.');
  vim.inputState.keyBuffer = ['f'];
  calls.fed = [];
  kd('a', 'KeyA', content);
  eq('f-arg fed ש', calls.fed, ['ש']);
  vim.inputState.keyBuffer = [];
  calls.fed = [];
  kd(']', 'BracketLeft', content, { ctrlKey: true });
  eq('Ctrl+[ fed <Esc>', calls.fed, ['<Esc>']);

  // ================= simulated probe failures =================
  // 1. handleKey missing
  notices = [];
  const savedHK = V.handleKey;
  delete V.handleKey;
  p.probeNow();
  eq('missing handleKey: charArgs + escape off', [T.features.charArgs, T.features.escape, T.features.usKeys], [false, false, true]);
  eq('missing handleKey: one notice naming both', notices.length === 1 && /f\/t\/r/.test(notices[0]) && /Ctrl\+\[/.test(notices[0]), true);
  p.probeNow();
  eq('same failure again: no second notice', notices.length, 1);
  vim.inputState.keyBuffer = ['f'];
  let e = kd('a', 'KeyA', content);
  eq('degraded f-arg: key passes untouched', [e.stopped, e.key], [false, 'a']);
  vim.inputState.keyBuffer = [];
  e = kd(']', 'BracketLeft', content, { ctrlKey: true });
  eq('degraded Ctrl+[ in note: not handled, no throw', e.stopped, false);
  V.handleKey = savedHK;
  p.probeNow();
  eq('restored handleKey: features back on', [T.features.charArgs, T.features.escape], [true, true]);

  // 2. keyBuffer unreadable
  notices = [];
  const savedIS = vim.inputState;
  vim.inputState = {};
  p.probeNow();
  eq('keyBuffer missing: usKeys + charArgs off', [T.features.usKeys, T.features.charArgs], [false, false]);
  e = kd('ץ', 'Period', content);
  eq('degraded H2: no relabel', e.key, 'ץ');
  vim.inputState = savedIS;
  p.probeNow();

  // 3. back-pointer mismatch → logical motions
  notices = [];
  calls.define = [];
  view.cm.cm6 = null;
  p.probeNow();
  eq('back-pointer missing: visualMotions off, motions redefined', [T.features.visualMotions, calls.define.length], [false, 2]);
  {
    const Pos = function (line, ch) { this.line = line; this.ch = ch; };
    const r = V.motions.mathDirVisualLeft(view.cm, new Pos(0, 5), { repeat: 2 }, vim, {});
    eq('degraded h is logical (5 → 3)', r.ch, 3);
  }
  eq('notice names visual h/l', /visual h\/l/.test(notices[0] || ''), true);
  view.cm.cm6 = view;
  p.probeNow();
  eq('restored: visual motions again', [T.features.visualMotions, p.vim.vimVisual], [true, true]);

  // 4. defineMotion / mapCommand missing: no crash, motions off
  notices = [];
  const savedDM = V.defineMotion;
  delete V.defineMotion;
  let threw = false;
  try { p.probeNow(); p.vim.syncVim(true); } catch (err) { threw = true; }
  eq('missing defineMotion: no throw, motions off', [threw, T.features.motions], [false, false]);
  eq('notice mentions defineMotion', /defineMotion/.test(notices[0] || ''), true);
  V.defineMotion = savedDM;
  p.probeNow();

  // Review fixes ------------------------------------------------------------
  // (a) a new Vim object whose defineMotion is missing at load, restored later:
  //     commands are mapped at once, not after the 10 s safety net
  {
    const V2 = makeV(); keymap = [{ keys: 'j', type: 'motion', motion: 'moveByLines' }];
    const dm = V2.defineMotion; delete V2.defineMotion;
    window.CodeMirrorAdapter = { Vim: V2, setKeyInterceptActive() {} }; // 2.8.0: marker
    calls.map = [];
    trigger(T.VIM_LOAD_EVENT);
    eq('fix: motions off at load, nothing mapped', [T.features.motions, calls.map.length], [false, 0]);
    V2.defineMotion = dm;
    p.probeNow();
    eq('fix: motions back → 6 commands mapped immediately', calls.map.length, 6);
    V = V2;
  }
  // (b) only multiSelectHandleKey: f/t/r and Ctrl+[ stay on and work
  {
    const hk = V.handleKey; delete V.handleKey;
    V.multiSelectHandleKey = function (cm, k) { calls.fed.push('ms:' + k); return true; };
    p.probeNow();
    eq('fix: multiSelect only keeps charArgs/escape on', [T.features.charArgs, T.features.escape], [true, true]);
    calls.fed = [];
    kd(']', 'BracketLeft', content, { ctrlKey: true });
    eq('fix: Ctrl+[ fed through multiSelectHandleKey', calls.fed, ['ms:<Esc>']);
    // (c) neither: key not swallowed, no throw (even with features still unchecked)
    delete V.multiSelectHandleKey;
    for (const k of Object.keys(T.features)) T.features[k] = null;
    let thrown = false, ev;
    try { ev = kd(']', 'BracketLeft', content, { ctrlKey: true }); } catch (err) { thrown = true; }
    eq('fix: no feed method → key not stopped, no throw', [thrown, ev && ev.stopped], [false, false]);
    V.handleKey = hk;
    p.probeNow();
  }
  // (d) a known-failed feature stays off when a later probe can't run
  {
    p.probeOverrides = { tokens: { ok: false, indent: null, detail: 'simulated' } };
    p.probeNow();
    p.probeOverrides = { tokens: { ok: null, indent: null, detail: 'no editor' } };
    p.probeNow();
    eq('fix: tokens stays off after an inconclusive probe', T.features.tokens, false);
    p.probeOverrides = {};
    p.probeNow();
    eq('fix: conclusive pass turns it back on', T.features.tokens, true);
  }
  // (e) the notice doesn't repeat features already reported
  {
    notices = [];
    p.notified.clear();
    p.probeOverrides = { tokens: { ok: false, indent: null, detail: 'x' } };
    p.probeNow();
    p.probeOverrides = { tokens: { ok: false, indent: null, detail: 'x' }, cursorLayer: false };
    p.probeNow();
    p.probeNow();
    eq('fix: second notice only for a new failure, none for repeats', notices.length, 2);
    p.probeOverrides = {};
    p.probeNow();
  }
  // (f) pending probes don't run (no keymap copy) while no editor has Vim
  {
    const savedLeaves = leaves, savedActive = activeView;
    leaves = []; activeView = null;
    p.probeNow();
    calls.getKeymap = 0;
    trigger('layout-change'); trigger('active-leaf-change');
    eq('fix: pending probe waits for an editor with Vim (no keymap copies)', [p.probePending, calls.getKeymap], [true, 0]);
    leaves = savedLeaves; activeView = savedActive;
    trigger('active-leaf-change');
    eq('fix: probe runs once an editor appears', p.probePending, false);
  }
  notices = [];

  // 5. getKeymap missing → map once per Vim object
  const savedGK = V.getKeymap;
  delete V.getKeymap;
  V = Object.assign(makeV(), { getKeymap: undefined });
  delete V.getKeymap;
  window.CodeMirrorAdapter = { Vim: V, setKeyInterceptActive() {} }; // 2.8.0: marker
  calls.map = [];
  trigger(T.VIM_LOAD_EVENT);
  p.vim.syncVim(true); p.vim.syncVim(true);
  eq('no getKeymap: keymapCheck off, mapped exactly once', [T.features.keymapCheck, calls.map.length], [false, 6]);
  void savedGK;

  // 6. tokens fail → text parser (override hook, as the coordinator would)
  p.notified.clear();
  notices = [];
  p.probeOverrides = { tokens: { ok: false, indent: null, detail: 'simulated' } };
  p.probeNow();
  eq('tokens off → text parser', T.features.tokens, false);
  const st2 = EditorState.create({ doc: 'text\n\n    code here\n$x$ y' });
  eq('M7 with text parser: indented code types English', T.inMathOrCode(st2, st2.doc.line(3).from + 2), true);
  eq('text parser: math types English', T.inMathOrCode(st2, st2.doc.line(4).from + 1), true);
  eq('text parser: text types Hebrew', T.inMathOrCode(st2, st2.doc.line(1).from + 2), false);
  eq('notice names the text parser', /text parser/.test(notices[0] || ''), true);
  p.probeOverrides = {};
  p.probeNow();
  eq('override cleared: tokens back on', T.features.tokens, true);

  // 7. cursor layer missing → no cursor class
  layer.remove();
  p.probeNow();
  eq('no cursor layer: class dropped', [T.features.cursorClass, /math-dir-cur-/.test(view.dom.className)], [false, false]);
  view.scrollDOM.appendChild(layer);
  p.probeNow();
  eq('cursor layer back: class back', [T.features.cursorClass, /math-dir-cur-/.test(view.dom.className)], [true, true]);

  // Diagnostics
  {
    const logs = [];
    const ct = console.table; console.table = (rows) => logs.push(rows);
    notices = [];
    const rows = await p.diagnostics();
    console.table = ct;
    eq('diagnostics: table printed', logs.length, 1);
    eq('diagnostics: summary notice', /diagnostics: Vim Motions loaded\. Off: keymapCheck\./.test(notices[notices.length - 1]), true);
  }
  files['.obsidian/plugins/vim-motions/manifest.json'] = JSON.stringify({ version: '1.6.0' });
  {
    const ct = console.table; console.table = () => {};
    const ci = console.info; let info = ''; console.info = (m) => { info = m; };
    const rows = await p.diagnostics();
    console.table = ct; console.info = ci;
  }

  // ================= small items =================
  // L7: a throwing chained handler stops the chain, nothing inserted, reported
  {
    const reported = [];
    const thrower = EditorView.inputHandler.of(() => { throw new Error('boom'); });
    const state = EditorState.create({ doc: 'ab', extensions: [inputExt, thrower, EditorView.exceptionSink.of((err) => reported.push(err.message))], selection: { anchor: 1 } });
    const v = { dom: { ownerDocument: { defaultView: null } }, state, composing: false, dispatched: 0, dispatch() { this.dispatched++; } };
    let handled;
    for (const h of state.facet(EditorView.inputHandler)) { handled = h(v, 1, 1, 'a', null); if (handled) break; }
    eq('L7 throw: chain stopped, nothing dispatched, sink got it', [handled, v.dispatched, reported], [true, 0, ['boom']]);
  }

  // L8: status button
  {
    p.settings.hebrew = false; p.updateStatus();
    eq('L8 aria-label off', sb.getAttribute('aria-label'), 'Hebrew typing: off');
    eq('L8 focusable button', [sb.getAttribute('role'), sb.getAttribute('tabindex')], ['button', '0']);
    let e2 = kd('Enter', 'Enter', sb);
    await Promise.resolve();
    eq('L8 Enter toggles on', [p.settings.hebrew, sb.textContent, sb.getAttribute('aria-label'), e2.prevented], [true, 'עב', 'Hebrew typing: on', true]);
    e2 = kd(' ', 'Space', sb);
    eq('L8 Space toggles off', [p.settings.hebrew, sb.getAttribute('aria-label')], [false, 'Hebrew typing: off']);
    kd('Enter', 'Enter', content);
    eq('Enter elsewhere does not toggle', p.settings.hebrew, false);
    p.settings.hebrew = true; p.updateStatus();
  }

  // L14: settings toggle refreshed
  {
    let val = true;
    p.settingTab.hebrewToggle = { getValue: () => val, setValue: (v) => { val = v; } };
    await p.toggle();
    eq('L14 toggle follows F12 / status', val, false);
    await p.toggle();
    eq('L14 toggle follows back', val, true);
    p.settingTab.hebrewToggle = null;
  }

  // L9: warning only in the note and allowlisted fields
  {
    const plain = document.createElement('input'); plain.type = 'text';
    const modal = document.createElement('div'); modal.className = 'modal'; modal.appendChild(plain);
    document.body.appendChild(modal);
    notices = []; p.lastWarn = 0;
    kd('ש', 'KeyA', plain);
    eq('L9 no warning in a non-allowlisted field', notices.length, 0);
    const pi = document.createElement('input'); pi.type = 'text'; pi.className = 'prompt-input';
    document.body.appendChild(pi);
    kd('ש', 'KeyA', pi);
    eq('L9 warning in the quick switcher', notices.length, 1);
    p.lastWarn = 0;
    kd('ש', 'KeyA', content);
    eq('L9 warning in the note', notices.length, 2);
  }

  // L6: popout windows released on close
  {
    const mk = () => { const l = { k: 0, b: 0 }; const doc = { addEventListener: () => l.b++, removeEventListener: () => l.b-- }; return { l, win: { document: doc, addEventListener: () => l.k++, removeEventListener: () => l.k-- } }; };
    const a = mk();
    trigger('window-open', { win: a.win }, a.win);
    eq('L6 popout attached', [a.l.k, a.l.b], [1, 1]);
    trigger('window-open', { win: a.win }, a.win);
    eq('L6 no double attach', [a.l.k, a.l.b], [1, 1]);
    trigger('window-close', { win: a.win }, a.win);
    eq('L6 popout released on close', [a.l.k, a.l.b, p.windows.has(a.win)], [0, 0, false]);
    const b = mk();
    trigger('window-open', { win: b.win }, b.win);
    p.onunload();
    eq('L6 everything released on unload', [b.l.k, b.l.b, p.windows.size], [0, 0, 0]);
  }

  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(2); });
