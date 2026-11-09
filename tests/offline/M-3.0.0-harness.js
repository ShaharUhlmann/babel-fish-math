// Offline harness for math-dir 3.0.0: the key map files and the configurable hotkey,
// with a mock vault adapter and a mock of Obsidian's Modal / Scope / keymap that
// follows app.js (the modal goes into activeWindow.document.body).
//   A. The files: first run, embedded = file, validation, prototype keys.
//   B. The active map: typing, f / t / r, Replace; HE_OS stays; fallbacks.
//   C. Slugs, New, Edit, Delete, Reload, Reset, through the settings tab.
//   D. The hotkey: matching, data.json, the command, clear, reset, recording.
//   E. Settings in its own window: modals and recording go to that window.
//   F. The build: inlining and its failures.
// Usage: node M-3.0.0-harness.js <plugin folder>/main.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
for (const k of ['navigator', 'Node', 'HTMLElement', 'MutationObserver', 'getComputedStyle',
  'requestAnimationFrame', 'InputEvent', 'KeyboardEvent', 'DOMRect', 'Range', 'Text', 'Window', 'ShadowRoot', 'Element']) {
  if (!(k in global)) global[k] = dom.window[k];
}
global.window = dom.window;
global.document = dom.window.document;
// CodeMirror measures once timers run; jsdom has no layout.
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });

const CMstate = require('@codemirror/state');
const CMview = require('@codemirror/view');
const CMlang = require('@codemirror/language');
const { EditorView } = CMview;

const mainFile = path.resolve(process.argv[2]);
const pluginDir = path.dirname(mainFile);
const buildFile = path.join(pluginDir, 'build.mjs');
const DIR = '.obsidian/plugins/rtl-math-mix';
const MAPS = DIR + '/maps';

// What 2.8.0 had in EN2HE, written out on purpose: the file must not drift from it.
const EN2HE_280 = {
  q: '/', w: "'", e: 'ק', r: 'ר', t: 'א', y: 'ט', u: 'ו', i: 'ן', o: 'ם', p: 'פ',
  a: 'ש', s: 'ד', d: 'ג', f: 'כ', g: 'ע', h: 'י', j: 'ח', k: 'ל', l: 'ך', ';': 'ף', "'": ',',
  z: 'ז', x: 'ס', c: 'ב', v: 'ה', b: 'נ', n: 'מ', m: 'צ', ',': 'ת', '.': 'ץ', '/': '.',
  '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{',
};

let fails = 0, passes = 0;
const check = (ok, name, extra = '') => {
  if (ok) passes++; else fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
};
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  check(a === b, name, a === b ? '' : `got ${a}, want ${b}`);
};
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

// Obsidian's DOM helpers, on any window's elements.
function patchWindow(win) {
  const P = win.HTMLElement.prototype;
  P.empty = function () { this.textContent = ''; };
  P.setText = function (t) { this.textContent = t; };
  P.setAttr = function (k, v) { this.setAttribute(k, v); };
  P.addClass = function (c) { this.classList.add(c); };
  P.createEl = function (tag, o = {}) {
    const el = this.ownerDocument.createElement(tag);
    if (o.text) el.textContent = o.text;
    if (o.type) el.type = o.type;
    if (o.cls) el.className = o.cls;
    for (const [k, v] of Object.entries(o.attr || {})) el.setAttribute(k, v);
    this.appendChild(el);
    return el;
  };
}
patchWindow(dom.window);

// ---- A fake HyperMD (as in S) so math is seen as math ----
const BEGIN = 'formatting formatting-math formatting-math-begin keyword math';
const END = 'formatting formatting-math formatting-math-end keyword math';
const fakeHyperMD = CMlang.StreamLanguage.define({
  startState: () => ({ inline: false }),
  copyState: (s) => Object.assign({}, s),
  token(stream, s) {
    if (s.inline) {
      if (stream.match('$')) { s.inline = false; return END; }
      stream.next(); return 'math';
    }
    if (stream.peek() === '$' && /^\$[^\s$][^$]*[^\s\\]?\$/.test(stream.string.slice(stream.pos))) { stream.next(); s.inline = true; return BEGIN; }
    stream.next();
    return null;
  },
});

// ---- Mocks ----
class MockAdapter {
  constructor(files = {}) {
    this.files = new Map(Object.entries(files));
    this.dirs = new Set(Object.keys(files).length ? [MAPS] : []);
    this.writes = [];
    this.fail = null;
  }
  async exists(p) { return this.files.has(p) || this.dirs.has(p); }
  async mkdir(p) { this.dirs.add(p); }
  async write(p, t) { if (this.fail) throw new Error(this.fail); this.writes.push(p); this.files.set(p, t); }
  async read(p) { if (!this.files.has(p)) throw new Error('no such file ' + p); return this.files.get(p); }
  async remove(p) { this.files.delete(p); }
  async list(d) {
    if (this.fail) throw new Error(this.fail);
    return { files: [...this.files.keys()].filter((f) => f.startsWith(d + '/')), folders: [] };
  }
}

function makeObsidian(saved, adapter) {
  const handlers = {};
  const env = { handlers, notices: [], leaves: [], active: null, saved, modals: [], commands: [], rows: [], scopes: [] };
  const keymap = {
    pushScope(s) { s.win = window.activeWindow; env.scopes.push(s); },
    popScope(s) { env.scopes = env.scopes.filter((x) => x !== s); },
  };
  const app = {
    keymap,
    workspace: {
      on(name, cb) { const ref = { name, cb }; (handlers[name] = handlers[name] || []).push(cb); return ref; },
      offref(ref) { handlers[ref.name] = handlers[ref.name].filter((x) => x !== ref.cb); },
      onLayoutReady(cb) { env.ready = cb; },
      getLeavesOfType(t) { return t === 'markdown' ? env.leaves : []; },
      get activeEditor() { return env.active ? { editor: { cm: env.active } } : null; },
    },
    vault: { adapter },
  };
  class Plugin {
    constructor() { this.app = app; this.manifest = { dir: DIR }; this.ext = []; }
    registerEditorExtension(x) { this.ext.push(x); }
    registerMarkdownPostProcessor() {}
    addStatusBarItem() {
      const el = document.createElement('div');
      return el;
    }
    registerDomEvent(el, type, cb) { el.addEventListener(type, cb); }
    addCommand(c) { env.commands.push(c); }
    addSettingTab(tab) { env.tab = tab; }
    registerEvent() {} registerInterval() {}
    async loadData() { return env.saved; }
    async saveData(d) { env.saved = JSON.parse(JSON.stringify(d)); }
  }
  class PluginSettingTab {
    constructor(a, p) { this.app = a; this.plugin = p; this.containerEl = document.createElement('div'); document.body.appendChild(this.containerEl); }
    hide() {}
  }
  class Setting {
    constructor(el) { this.el = el; this.row = { el }; env.rows.push(this.row); }
    setName(n) { this.row.name = n; return this; }
    setDesc(d) { this.row.desc = d; return this; }
    addToggle(f) {
      f({ setValue() { return this; }, getValue() { return false; }, onChange() { return this; } });
      return this;
    }
    addDropdown(f) {
      const sel = this.el.ownerDocument.createElement('select');
      this.el.appendChild(sel);
      this.row.select = sel;
      f({
        addOption(v, t) { const o = sel.ownerDocument.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); return this; },
        setValue(v) { sel.value = v; return this; },
        onChange(fn) { sel.addEventListener('change', () => fn(sel.value)); return this; },
      });
      return this;
    }
    addButton(f) {
      const btn = this.el.ownerDocument.createElement('button');
      this.el.appendChild(btn);
      f({
        buttonEl: btn,
        setButtonText(t) { btn.textContent = t; return this; },
        setCta() { return this; },
        setWarning() { return this; },
        setDisabled(d) { btn.disabled = !!d; return this; },
        onClick(fn) { btn.addEventListener('click', fn); return this; },
      });
      return this;
    }
  }
  // As in app.js: the modal goes into activeWindow.document.body, its scope on that window.
  class Modal {
    constructor(a) {
      this.app = a;
      this.containerEl = document.createElement('div');
      this.containerEl.className = 'modal-container';
      this.modalEl = this.containerEl.createEl('div', { cls: 'modal' });
      this.titleEl = this.modalEl.createEl('div', { cls: 'modal-title' });
      this.contentEl = this.modalEl.createEl('div', { cls: 'modal-content' });
      this.isOpen = false;
    }
    open() {
      this.isOpen = true;
      this.win = window.activeWindow || window;
      this.win.document.body.appendChild(this.containerEl);
      env.modals.push(this);
    }
    close() {
      if (!this.isOpen) return;
      this.isOpen = false;
      this.containerEl.remove();
      this.onClose();
    }
    onClose() {}
  }
  class Scope {
    constructor() { this.keys = []; }
    register(mods, key, fn) { this.keys.push({ mods, key, fn }); }
    handleKey(e) { for (const k of this.keys) if (k.key === null || k.key === e.key) return k.fn(e); return undefined; }
  }
  const obsidian = {
    Plugin, PluginSettingTab, Setting, Modal, Scope,
    Notice: class { constructor(m) { env.notices.push(m); } },
    TFile: class {},
  };
  return { env, obsidian };
}

const NAMES = ['HE_OS', 'usKey', 'charArgFor', 'followsLayer', 'mapSlug', 'parseMap', 'hotkeyRefusal', 'hotkeyMatches',
  'hotkeyLabel', 'mappedKey', 'originalKey', 'translate', 'hasMapped', 'DEFAULT_MAP', 'DEFAULT_MAP_TEXT', 'useWindowOf'];
function load(obsidian) {
  const src = fs.readFileSync(mainFile, 'utf8') + `\nmodule.exports.__t = { ${NAMES.join(', ')} };\n`;
  const m = new Module(mainFile + '?' + Math.random(), module);
  m.filename = mainFile;
  m.paths = module.paths;
  const orig = m.require.bind(m);
  m.require = (id) => (id === 'obsidian' ? obsidian : id === '@codemirror/state' ? CMstate
    : id === '@codemirror/view' ? CMview : id === '@codemirror/language' ? CMlang : orig(id));
  m._compile(src, mainFile);
  return m.exports;
}
async function start(saved, files) {
  const adapter = new MockAdapter(files);
  const { env, obsidian } = makeObsidian(saved, adapter);
  const PluginClass = load(obsidian);
  const p = new PluginClass();
  await p.onload();
  return { p, env, adapter, T: PluginClass.__t };
}

// ---- Helpers ----
const mkEvent = (key, code, target = document.body, mods = {}) => ({
  isTrusted: true, isComposing: false, repeat: false, target, key, code, stopped: false, prevented: false,
  ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
  preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...mods,
});
function makeEditor(p, env, doc) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ doc, parent, extensions: [fakeHyperMD, ...p.ext] });
  env.leaves.push({ view: { editor: { cm: view } } });
  env.active = view;
  return view;
}
function type(p, view, text) {
  p.onKeyDown(mkEvent(text, 'KeyA', view.contentDOM));
  const { from, to } = view.state.selection.main;
  const fallback = () => view.state.update({ changes: { from, to, insert: text } });
  for (const h of view.state.facet(EditorView.inputHandler)) if (h(view, from, to, text, fallback)) return true;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  return false;
}
const mapFile = (keys, name = 'Test map') => JSON.stringify({ name, keys });
const pathOf = (id) => `${MAPS}/${id}.json`;
const lastModal = (env) => env.modals[env.modals.length - 1];
const buttonIn = (el, text) => [...el.querySelectorAll('button')].find((b) => b.textContent === text);
const openTab = (env) => { env.rows.length = 0; env.tab.display(); };
const tabButton = (env, text) => buttonIn(env.tab.containerEl, text);
const tabRow = (env, name) => env.rows.slice().reverse().find((r) => r.name === name); // the latest drawing
const clickModal = async (env, text) => { buttonIn(lastModal(env).containerEl, text).click(); await flush(); };

(async () => {
  // =========================================================================
  // A. The files
  // =========================================================================
  {
    const { p, env, adapter, T } = await start({ hebrew: true });
    eq('A first run: folder created', adapter.dirs.has(MAPS), true);
    eq('A first run: writes only qwerty.json', adapter.writes, [pathOf('qwerty')]);
    const onDisk = JSON.parse(adapter.files.get(pathOf('qwerty')));
    const source = JSON.parse(fs.readFileSync(path.join(pluginDir, 'src', 'default-map.json'), 'utf8'));
    eq('A the file agrees with the embedded copy', onDisk, T.DEFAULT_MAP);
    eq('A the file agrees with src/default-map.json', onDisk, source);
    eq('A the content is 2.8.0\'s EN2HE, order included', onDisk.keys, EN2HE_280);
    eq('A the name', onDisk.name, 'QWERTY → Hebrew (SI-1452)');
    eq('A mirrored brackets stay', [T.mappedKey('('), T.mappedKey(')'), T.mappedKey('['), T.mappedKey('}')], [')', '(', ']', '{']);
    eq('A activeMap defaults to qwerty', p.settings.activeMap, 'qwerty');
    eq('A no notice on a clean first run', env.notices, []);
    eq('A the file is read as the active map', p.keyMaps.active().name, onDisk.name);
    p.onunload();
  }
  {
    const edited = mapFile({ a: 'x' }, 'Mine');
    const { p, adapter, T } = await start({}, { [pathOf('qwerty')]: edited });
    eq('A a later run leaves an edited qwerty.json alone', [adapter.files.get(pathOf('qwerty')), adapter.writes], [edited, []]);
    eq('A and uses it', T.translate('ab'), 'xb');
    p.onunload();
  }
  {
    const { p, T } = await start({}, { [pathOf('qwerty')]: '\uFEFF' + mapFile({ a: 'x', '😀': '😎' }) });
    eq('A a BOM is fine, one astral code point is one character', [T.translate('a😀'), p.keyMaps.invalid.size], ['x😎', 0]);
    p.onunload();
  }

  // Each validation failure: the file is skipped, named with its reason, and untouched.
  const BAD = {
    'not-json': ['{ not json', /not valid JSON/],
    'an-array': ['[1, 2]', /must be an object/],
    'null-doc': ['null', /must be an object/],
    'a-string': ['"x"', /must be an object/],
    'no-name': ['{"keys": {}}', /"name"/],
    'empty-name': ['{"name": "  ", "keys": {}}', /"name"/],
    'num-name': ['{"name": 3, "keys": {}}', /"name"/],
    'no-keys': ['{"name": "x"}', /"keys"/],
    'null-keys': ['{"name": "x", "keys": null}', /"keys"/],
    'array-keys': ['{"name": "x", "keys": ["a"]}', /"keys"/],
    'long-key': ['{"name": "x", "keys": {"ab": "c"}}', /key "ab"/],
    'empty-key': ['{"name": "x", "keys": {"": "c"}}', /key ""/],
    'long-value': ['{"name": "x", "keys": {"a": "bc"}}', /value of key "a"/],
    'empty-value': ['{"name": "x", "keys": {"a": ""}}', /value of key "a"/],
    'num-value': ['{"name": "x", "keys": {"a": 1}}', /value of key "a"/],
    'proto-key': ['{"name": "x", "keys": {"__proto__": "a"}}', /key "__proto__"/],
    'ctor-key': ['{"name": "x", "keys": {"constructor": "a"}}', /key "constructor"/],
    'proto-top': ['{"__proto__": {"name": "x", "keys": {}}}', /"name"/],
  };
  {
    const files = { [pathOf('qwerty')]: mapFile(EN2HE_280, 'Default') };
    for (const [id, [text]] of Object.entries(BAD)) files[pathOf(id)] = text;
    const { p, env, adapter } = await start({}, files);
    eq('A one notice for all the invalid files', env.notices.length, 1);
    for (const [id, [text, why]] of Object.entries(BAD)) {
      const entry = p.keyMaps.invalid.get(id);
      check(!!entry && why.test(entry.reason), `A ${id}: invalid, for the right reason`, entry ? entry.reason : 'not listed');
      check(env.notices[0].includes(id + '.json'), `A ${id}: the notice names it`);
      eq(`A ${id}: not overwritten`, adapter.files.get(pathOf(id)), text);
    }
    eq('A only the valid map is valid', [...p.keyMaps.valid.keys()], ['qwerty']);
    eq('A nothing was written', adapter.writes, []);
    p.onunload();
  }
  {
    const { p, T } = await start({ hebrew: true });
    eq('A inherited names don\'t look up', [T.mappedKey('constructor'), T.mappedKey('__proto__'), T.mappedKey('toString')], [undefined, undefined, undefined]);
    eq('A a word is not a key', T.hasMapped('$$$'), false);
    eq('A translate leaves what isn\'t mapped', T.translate('A1 '), 'A1 ');
    p.onunload();
  }

  // =========================================================================
  // B. The active map
  // =========================================================================
  {
    const files = {
      [pathOf('qwerty')]: mapFile(EN2HE_280, 'Default'),
      [pathOf('other')]: mapFile({ a: 'ж', r: 'щ' }, 'Other'),
    };
    const { p, env, T } = await start({ hebrew: true, vimMode: true }, files);
    const HE_OS_BEFORE = JSON.stringify(T.HE_OS);
    const view = makeEditor(p, env, '');
    type(p, view, 'a');
    eq('B typing with the default map', view.state.doc.toString(), 'ש');

    await p.keyMaps.setActive('other');
    eq('B switching is saved', env.saved.activeMap, 'other');
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    type(p, view, 'a');
    eq('B switching applies at once', view.state.doc.toString(), 'שж');
    type(p, view, 's');
    eq('B a key the map lacks stays as typed', view.state.doc.toString(), 'שжs');
    eq('B translate follows', T.translate('a'), 'ж');
    eq('B HE_OS doesn\'t move', JSON.stringify(T.HE_OS), HE_OS_BEFORE);
    eq('B HE_OS is the Windows layout', [T.HE_OS.KeyA, T.HE_OS.KeyR, T.HE_OS.Backquote], ['ש', 'ר', ';']);
    eq('B the OS-layout key still works', T.usKey(mkEvent('ש', 'KeyA')), 'a');
    eq('B the map\'s character isn\'t an OS-layout key', T.usKey(mkEvent('ж', 'KeyA')), null);
    eq('B originalKey is the original', T.originalKey('a'), 'ש');

    // charArgFor reads the active map.
    const lineView = makeEditor(p, env, 'щ x ש');
    const arg = (cmd, pos = 0) => ({ cmd, count: 1, pos });
    eq('B r takes the active map', T.charArgFor(lineView.state, arg('r'), 'r'), 'щ');
    const fdoc = makeEditor(p, env, ' жa ש');
    eq('B f takes the active map', T.charArgFor(fdoc.state, arg('f'), 'a'), 'ж');
    await p.keyMaps.setActive('qwerty');
    const fdoc2 = makeEditor(p, env, ' жa ש');
    eq('B f back on the default', T.charArgFor(fdoc2.state, arg('f'), 'a'), 'ש');

    // The whole path through hook 2, with a Vim mock.
    const fed = [];
    const V = { handleKey(cm, k) { fed.push(k); return true; }, defineMotion() {}, mapCommand() {}, getKeymap() { return [{ keys: 'j', motion: 'moveByLines' }]; } };
    window.CodeMirrorAdapter = { Vim: V, setKeyInterceptActive() {} };
    const vimView = makeEditor(p, env, 'hello ש ж');
    const vim = { insertMode: false, visualMode: false, inputState: { keyBuffer: ['f'] } };
    vimView.cm = { state: { vim }, cm6: vimView };
    let e = mkEvent('a', 'KeyA', vimView.contentDOM);
    p.onKeyDown(e);
    eq('B hook 2: f takes the default map', [fed.pop(), e.stopped], ['ש', true]);
    await p.keyMaps.setActive('other');
    e = mkEvent('a', 'KeyA', vimView.contentDOM);
    p.onKeyDown(e);
    eq('B hook 2: f takes the switched map', [fed.pop(), e.stopped], ['ж', true]);
    vim.inputState.keyBuffer = ['r'];
    e = mkEvent('s', 'KeyS', vimView.contentDOM);
    p.onKeyDown(e);
    eq('B hook 2: a key the map lacks goes to Vim as typed', [fed.length, e.stopped], [0, false]);
    e = mkEvent('r', 'KeyR', vimView.contentDOM);
    p.onKeyDown(e);
    eq('B hook 2: r takes the switched map', fed.pop(), 'щ');
    vim.inputState.keyBuffer = [];
    vim.insertMode = true;
    vimView.cm.state.overwrite = true;
    e = mkEvent('a', 'KeyA', vimView.contentDOM);
    p.onKeyDown(e);
    eq('B hook 2: Replace mode takes the switched map', fed.pop(), 'ж');
    e = mkEvent('constructor', 'KeyA', vimView.contentDOM);
    p.onKeyDown(e);
    eq('B hook 2: a key named like an inherited property isn\'t mapped', [fed.length, e.stopped], [0, false]);
    p.onunload();
    delete window.CodeMirrorAdapter;
  }
  {
    // Missing or invalid active map: the original in memory, with the setting kept.
    const { p, env, adapter, T } = await start({ hebrew: true, activeMap: 'gone' }, { [pathOf('qwerty')]: mapFile({ a: 'x' }) });
    eq('B a missing active map: the embedded original', T.translate('a'), 'ש');
    eq('B the setting is kept, so it comes back', p.settings.activeMap, 'gone');
    check(env.notices.length === 1 && env.notices[0].includes('gone'), 'B and one notice says so', env.notices.join('|'));
    eq('B nothing written', adapter.writes, []);
    adapter.files.set(pathOf('gone'), mapFile({ a: 'y' }));
    await p.keyMaps.load();
    eq('B Reload brings it back', T.translate('a'), 'y');
    p.onunload();
  }
  {
    const broken = '{ broken';
    const { p, env, adapter, T } = await start({ hebrew: true }, { [pathOf('qwerty')]: broken });
    eq('B an invalid active map: the embedded original', T.translate('a'), 'ש');
    eq('B the file stays as it is', [adapter.files.get(pathOf('qwerty')), adapter.writes], [broken, []]);
    eq('B one notice, naming it and the fallback', [env.notices.length, env.notices[0].includes('qwerty.json'), env.notices[0].includes('built-in')], [1, true, true]);
    openTab(env);
    const opts = [...tabRow(env, 'Key map').select.options].map((o) => o.value);
    eq('B the dropdown still shows what\'s in use', [opts, tabRow(env, 'Key map').select.value], [['qwerty'], 'qwerty']);
    p.onunload();
  }
  {
    // A vault adapter that fails: still works, on the original.
    const adapter = new MockAdapter();
    adapter.fail = 'disk full';
    const { env, obsidian } = makeObsidian({ hebrew: true }, adapter);
    const PluginClass = load(obsidian);
    const p = new PluginClass();
    await p.onload();
    eq('B a failing adapter: the original, and one notice', [PluginClass.__t.translate('a'), env.notices.length, env.notices[0].includes('disk full')], ['ש', 1, true]);
    p.onunload();
  }
  {
    // A mock with no adapter or dir (the older harnesses): silently the original.
    const { env, obsidian } = makeObsidian({ hebrew: true }, undefined);
    const PluginClass = load(obsidian);
    const p = new PluginClass();
    await p.onload();
    eq('B no adapter: the original, no notice', [PluginClass.__t.translate('a'), env.notices], ['ש', []]);
    p.onunload();
  }

  // =========================================================================
  // C. Slugs and the buttons
  // =========================================================================
  {
    const { p, T } = await start({});
    const slug = (name, ...taken) => T.mapSlug(name, taken);
    eq('C plain', slug('Dvorak'), 'dvorak');
    eq('C spaces and symbols', slug('My  Map! v2'), 'my-map-v2');
    eq('C Hebrew has no slug characters: map', slug('מפה שלי'), 'map');
    eq('C and a unique fallback', slug('מפה', 'map'), 'map-2');
    eq('C and the next', slug('מפה', 'map', 'map-2'), 'map-3');
    eq('C a taken name', slug('qwerty', 'qwerty'), 'qwerty-2');
    eq('C case doesn\'t make it free', slug('foo', 'FOO'), 'foo-2');
    eq('C can\'t escape maps/', slug('../../evil'), 'evil');
    eq('C slashes and dots', slug('a/b\\c.json'), 'a-b-c-json');
    eq('C only dots', slug('...'), 'map');
    eq('C __proto__ is safe', slug('__proto__'), 'proto');
    eq('C Windows names', [slug('con'), slug('NUL'), slug('com1')], ['map-con', 'map-nul', 'map-com1']);
    check(slug('x'.repeat(200)).length <= 40, 'C a long name is cut');
    for (const n of ['../a', 'C:\\x', 'א/ב', '  ', '%2e%2e', 'a b']) check(/^[a-z0-9-]+$/.test(slug(n)), 'C only [a-z0-9-]: ' + n, slug(n));
    p.onunload();
  }
  {
    const { p, env, adapter, T } = await start({ hebrew: true });
    openTab(env);
    // New.
    tabButton(env, 'New').click();
    await flush();
    let modal = lastModal(env);
    check(modal.containerEl.isConnected, 'C New: asks for a name');
    let input = modal.containerEl.querySelector('input');
    eq('C the name field isn\'t on the layer', T.followsLayer(input), false);
    await clickModal(env, 'Create');
    eq('C an empty name does nothing', [modal.isOpen, adapter.writes.length], [true, 1]);
    input.value = 'מפה שלי';
    await clickModal(env, 'Create');
    eq('C the file', adapter.writes[1], pathOf('map'));
    const made = JSON.parse(adapter.files.get(pathOf('map')));
    eq('C a copy of the active map, with the name typed', [made.name, made.keys], ['מפה שלי', EN2HE_280]);
    eq('C it becomes the active map', [p.settings.activeMap, env.saved.activeMap], ['map', 'map']);
    eq('C the modal is gone', modal.isOpen, false);
    eq('C the dropdown lists it', [...tabRow(env, 'Key map').select.options].map((o) => o.textContent), ['QWERTY → Hebrew (SI-1452)', 'מפה שלי']);

    // A second one with no slug, copying the active map: never overwrites.
    await p.keyMaps.saveText('map', mapFile({ a: 'q' }, 'Edited'));
    tabButton(env, 'New').click();
    await flush();
    lastModal(env).containerEl.querySelector('input').value = 'עוד';
    await clickModal(env, 'Create');
    eq('C a unique name, and the first is untouched', [p.settings.activeMap, JSON.parse(adapter.files.get(pathOf('map'))).name], ['map-2', 'Edited']);
    eq('C it copied the active map', JSON.parse(adapter.files.get(pathOf('map-2'))).keys, { a: 'q' });

    // A file that appeared since the last read isn't overwritten either.
    adapter.files.set(pathOf('late'), 'external');
    await p.keyMaps.create('late');
    eq('C a file made outside isn\'t overwritten', [p.settings.activeMap, adapter.files.get(pathOf('late'))], ['late-2', 'external']);

    // Cancel.
    const before = adapter.files.size;
    tabButton(env, 'New').click();
    await flush();
    await clickModal(env, 'Cancel');
    eq('C Cancel makes nothing', adapter.files.size, before);

    // Switching through the dropdown.
    const sel = tabRow(env, 'Key map').select;
    sel.value = 'map';
    sel.dispatchEvent(new window.Event('change'));
    await flush();
    eq('C the dropdown switches, saves and applies', [p.settings.activeMap, env.saved.activeMap, T.translate('a')], ['map', 'map', 'q']);

    // Edit.
    tabButton(env, 'Edit').click();
    await flush();
    modal = lastModal(env);
    const area = modal.containerEl.querySelector('textarea');
    eq('C Edit shows the file', area.value, adapter.files.get(pathOf('map')));
    eq('C the textarea doesn\'t follow the layer', T.followsLayer(area), false);
    eq('C it stays LTR and without spell check', [area.getAttribute('dir'), area.getAttribute('spellcheck')], ['ltr', 'false']);
    const kept = adapter.files.get(pathOf('map'));
    area.value = '{ nope';
    await clickModal(env, 'Save');
    eq('C invalid JSON is refused: open, file unchanged', [modal.isOpen, adapter.files.get(pathOf('map'))], [true, kept]);
    check(/Not saved: not valid JSON/.test(modal.containerEl.querySelector('.math-dir-map-error').textContent), 'C and the reason is shown', modal.containerEl.querySelector('.math-dir-map-error').textContent);
    area.value = '{"name": "x", "keys": {"ab": "c"}}';
    await clickModal(env, 'Save');
    check(/key "ab"/.test(modal.containerEl.querySelector('.math-dir-map-error').textContent), 'C a bad key is refused with its reason');
    eq('C and the map in use hasn\'t changed', T.translate('a'), 'q');
    const good = '{\n  "name": "Good",\n  "keys": { "a": "ג" }\n}\n';
    area.value = good;
    await clickModal(env, 'Save');
    eq('C a valid edit is saved as typed and applies at once', [modal.isOpen, adapter.files.get(pathOf('map')), T.translate('a')], [false, good, 'ג']);
    eq('C the dropdown has the new name', [...tabRow(env, 'Key map').select.options].find((o) => o.value === 'map').textContent, 'Good');

    // Edit the default map.
    await p.keyMaps.setActive('qwerty');
    openTab(env);
    tabButton(env, 'Edit').click();
    await flush();
    modal = lastModal(env);
    modal.containerEl.querySelector('textarea').value = mapFile({ a: 'z' }, 'Changed default');
    await clickModal(env, 'Save');
    eq('C Edit works on the default map', [JSON.parse(adapter.files.get(pathOf('qwerty'))).name, T.translate('a')], ['Changed default', 'z']);

    // Reset.
    openTab(env);
    tabButton(env, 'Reset default map').click();
    await flush();
    modal = lastModal(env);
    check(modal.isOpen && /lost/.test(modal.contentEl.textContent), 'C Reset asks first');
    await clickModal(env, 'Cancel');
    eq('C Cancel keeps the edits', JSON.parse(adapter.files.get(pathOf('qwerty'))).name, 'Changed default');
    tabButton(env, 'Reset default map').click();
    await flush();
    await clickModal(env, 'Reset');
    eq('C Reset restores the file', adapter.files.get(pathOf('qwerty')), T.DEFAULT_MAP_TEXT);
    eq('C and the map in use', T.translate('a'), 'ש');

    // Delete.
    openTab(env);
    eq('C Delete is off for the default map', tabButton(env, 'Delete').disabled, true);
    tabButton(env, 'Delete').click();
    await flush();
    await p.keyMaps.remove('qwerty');
    check(adapter.files.has(pathOf('qwerty')), 'C the default map can\'t be deleted');
    await p.keyMaps.setActive('map');
    openTab(env);
    tabButton(env, 'Delete').click();
    await flush();
    modal = lastModal(env);
    check(modal.isOpen && modal.contentEl.textContent.includes('map.json'), 'C Delete asks first, naming the file');
    await clickModal(env, 'Cancel');
    eq('C Cancel keeps it', [adapter.files.has(pathOf('map')), p.settings.activeMap], [true, 'map']);
    tabButton(env, 'Delete').click();
    await flush();
    await clickModal(env, 'Delete');
    eq('C Delete removes it and switches to the default', [adapter.files.has(pathOf('map')), p.settings.activeMap, env.saved.activeMap, T.translate('a')], [false, 'qwerty', 'qwerty', 'ש']);
    await p.keyMaps.remove('map-2');
    eq('C deleting a map that isn\'t active keeps the active one', [adapter.files.has(pathOf('map-2')), p.settings.activeMap], [false, 'qwerty']);

    // Reload: an edit, a new file, a broken one, made outside Obsidian.
    adapter.files.set(pathOf('qwerty'), mapFile({ a: 'k' }));
    adapter.files.set(pathOf('fresh'), mapFile({ a: 'n' }, 'Fresh'));
    env.notices.length = 0;
    openTab(env);
    tabButton(env, 'Reload').click();
    await flush();
    eq('C Reload picks up an outside edit', T.translate('a'), 'k');
    check([...tabRow(env, 'Key map').select.options].some((o) => o.value === 'fresh'), 'C and a new file');
    eq('C and says so', env.notices.length, 1);
    adapter.files.set(pathOf('fresh'), '{ broken');
    env.notices.length = 0;
    tabButton(env, 'Reload').click();
    await flush();
    eq('C a file broken outside: one notice, gone from the list', [env.notices.length, env.notices[0].includes('fresh.json'), [...tabRow(env, 'Key map').select.options].some((o) => o.value === 'fresh')], [1, true, false]);

    // A failing write is reported and changes nothing.
    adapter.fail = 'denied';
    env.notices.length = 0;
    tabButton(env, 'New').click();
    await flush();
    lastModal(env).containerEl.querySelector('input').value = 'nope';
    await clickModal(env, 'Create');
    check(env.notices.some((n) => n.includes('denied')), 'C a failed New is reported', env.notices.join('|'));
    eq('C and the active map stays', p.settings.activeMap, 'qwerty');
    adapter.fail = null;
    p.onunload();
  }

  // =========================================================================
  // D. The hotkey
  // =========================================================================
  {
    const { p, env, T } = await start({ hebrew: false });
    const cmd = env.commands.find((c) => c.id === 'toggle-hebrew-typing');
    check(!!cmd, 'D the command exists');
    eq('D it has no hotkeys field', 'hotkeys' in cmd, false);
    await cmd.callback();
    eq('D it still toggles', p.settings.hebrew, true);
    await p.setHebrew(false);

    eq('D default: F12', p.settings.toggleHotkey, { code: 'F12', ctrl: false, alt: false, shift: false, meta: false });
    let e = mkEvent('F12', 'F12');
    p.onKeyDown(e);
    await flush();
    eq('D F12 toggles and is consumed', [p.settings.hebrew, e.stopped, e.prevented], [true, true, true]);
    eq('D and it\'s saved', env.saved.hebrew, true);
    e = mkEvent('F12', 'F12', document.body, { repeat: true });
    p.onKeyDown(e);
    await flush();
    eq('D holding it toggles once, still consumed', [p.settings.hebrew, e.stopped], [true, true]);
    await p.setHebrew(false);
    for (const [mod, name] of [[{ ctrlKey: true }, 'Ctrl'], [{ shiftKey: true }, 'Shift'], [{ altKey: true }, 'Alt'], [{ metaKey: true }, 'Meta']]) {
      e = mkEvent('F12', 'F12', document.body, mod);
      p.onKeyDown(e);
      eq(`D ${name}+F12 isn't the hotkey`, [p.settings.hebrew, e.stopped], [false, false]);
    }
    e = mkEvent('F11', 'F11');
    p.onKeyDown(e);
    eq('D another key isn\'t', [p.settings.hebrew, e.stopped], [false, false]);
    e = mkEvent('F12', 'F12', document.body, { isTrusted: false });
    p.onKeyDown(e);
    eq('D an untrusted event (a relayed copy) isn\'t', [p.settings.hebrew, e.stopped], [false, false]);
    e = mkEvent('F12', 'F12', document.body, { isComposing: true });
    p.onKeyDown(e);
    eq('D nor one during composition', [p.settings.hebrew, e.stopped], [false, false]);

    // Before the other keydown logic, and by physical key.
    await p.setHotkey({ code: 'KeyJ', ctrl: true, alt: false, shift: false, meta: false });
    eq('D saved', env.saved.toggleHotkey.code, 'KeyJ');
    p.lastKeyAt = 0;
    e = mkEvent('ח', 'KeyJ', document.body, { ctrlKey: true });
    p.onKeyDown(e);
    await flush();
    eq('D it matches e.code: the Hebrew layout gives the same key', [p.settings.hebrew, e.stopped], [true, true]);
    await p.setHebrew(false);
    e = mkEvent('j', 'KeyJ', document.body);
    p.onKeyDown(e);
    eq('D without its modifier it\'s plain typing', [p.settings.hebrew, e.stopped], [false, false]);
    eq('D F12 is free now', (() => { const x = mkEvent('F12', 'F12'); p.onKeyDown(x); return x.stopped; })(), false);
    p.statusEl.focus();
    await p.setHotkey({ code: 'Enter', ctrl: false, alt: false, shift: false, meta: false });
    e = mkEvent('Enter', 'Enter', p.statusEl);
    p.onKeyDown(e);
    await flush();
    eq('D it comes before the status button: toggles once', p.settings.hebrew, true);
    await p.setHebrew(false);

    // Clear and reset, through the tab.
    openTab(env);
    tabButton(env, 'Clear').click();
    await flush();
    eq('D Clear: no plugin hotkey, saved', [p.settings.toggleHotkey, env.saved.toggleHotkey], [null, null]);
    check(/Current: none/.test(tabRow(env, 'Toggle hotkey').desc), 'D the tab says so', tabRow(env, 'Toggle hotkey').desc);
    e = mkEvent('F12', 'F12');
    p.onKeyDown(e);
    eq('D F12 does nothing, and passes', [p.settings.hebrew, e.stopped], [false, false]);
    await cmd.callback();
    eq('D the command remains', p.settings.hebrew, true);
    await p.setHebrew(false);
    tabButton(env, 'Reset to F12').click();
    await flush();
    eq('D Reset to F12', env.saved.toggleHotkey, { code: 'F12', ctrl: false, alt: false, shift: false, meta: false });
    check(/Current: F12/.test(tabRow(env, 'Toggle hotkey').desc), 'D the tab says so');
    e = mkEvent('F12', 'F12');
    p.onKeyDown(e);
    await flush();
    eq('D F12 works again', p.settings.hebrew, true);
    eq('D labels', [
      T.hotkeyLabel(null), T.hotkeyLabel({ code: 'F12' }), T.hotkeyLabel({ code: 'KeyJ', ctrl: true, shift: true }),
      T.hotkeyLabel({ code: 'Digit1', alt: true }), T.hotkeyLabel({ code: 'BracketLeft', meta: true }),
    ], ['none', 'F12', 'Ctrl+Shift+J', 'Alt+1', 'Meta+BracketLeft']);
    p.onunload();
  }
  for (const [data, want, name] of [
    [{}, 'F12', 'a data.json from 2.8.0 gets F12'],
    [{ toggleHotkey: null }, null, 'a cleared hotkey stays cleared'],
    [{ toggleHotkey: 'F5' }, 'F12', 'an unreadable value gets F12'],
    [{ toggleHotkey: { code: 5 } }, 'F12', 'a bad code gets F12'],
    [{ toggleHotkey: { code: 'KeyK', ctrl: 1 } }, 'KeyK', 'a stored one is kept'],
  ]) {
    const { p } = await start(data);
    const h = p.settings.toggleHotkey;
    eq('D load: ' + name, h && h.code, want);
    p.onunload();
  }
  {
    // Refusal rules.
    const { p, T } = await start({});
    const why = (key, code, mods) => T.hotkeyRefusal(mkEvent(key, code, document.body, mods));
    for (const [key, code] of [['Control', 'ControlLeft'], ['Alt', 'AltLeft'], ['AltGraph', 'AltRight'], ['Shift', 'ShiftRight'], ['Meta', 'MetaLeft']]) {
      check(/modifier alone/.test(why(key, code) || ''), `D refused: ${key} alone`);
    }
    for (const [key, code, mods] of [
      ['a', 'KeyA'], ['A', 'KeyA', { shiftKey: true }], ['ש', 'KeyA'], ['1', 'Digit1'], [';', 'Semicolon'], [' ', 'Space'],
      ['Enter', 'Enter'], ['Tab', 'Tab'], ['Backspace', 'Backspace'], ['ArrowLeft', 'ArrowLeft'], ['Home', 'Home'], ['Delete', 'Delete'],
    ]) check(/needed for typing/.test(why(key, code, mods) || ''), `D refused: ${code}${mods ? ' with Shift' : ''}`);
    check(!!why('Unidentified', ''), 'D refused: a key with no code');
    for (const [key, code, mods, label] of [
      ['F1', 'F1'], ['F12', 'F12'], ['F24', 'F24'], ['F5', 'F5', { shiftKey: true }, 'Shift+F5'], ['Insert', 'Insert'], ['Pause', 'Pause'],
      ['j', 'KeyJ', { ctrlKey: true }, 'Ctrl+J'], ['j', 'KeyJ', { altKey: true }, 'Alt+J'], ['j', 'KeyJ', { metaKey: true }, 'Meta+J'],
      ['J', 'KeyJ', { ctrlKey: true, shiftKey: true }, 'Ctrl+Shift+J'], ['ח', 'KeyJ', { ctrlKey: true }, 'Ctrl+J on Hebrew'],
    ]) eq(`D allowed: ${label || code}`, why(key, code, mods), null);
    p.onunload();
  }

  // ---- Recording, in the window the settings are in ----
  // Captures the listeners, so trusted events can be sent straight to them.
  function spyWindow(win) {
    const live = [];
    const add = win.addEventListener, rem = win.removeEventListener;
    win.addEventListener = function (t, fn, o) { live.push({ t, fn }); return add.call(win, t, fn, o); };
    win.removeEventListener = function (t, fn, o) { const i = live.findIndex((x) => x.t === t && x.fn === fn); if (i >= 0) live.splice(i, 1); return rem.call(win, t, fn, o); };
    return {
      live,
      fire: (t, e) => live.filter((x) => x.t === t).slice().forEach((x) => x.fn(e)),
      restore() { win.addEventListener = add; win.removeEventListener = rem; },
    };
  }
  {
    const { p, env } = await start({ hebrew: false });
    openTab(env);
    const spy = spyWindow(window);
    let done = 0;
    p.recordHotkey(env.tab.containerEl, () => { done++; });
    eq('D recording: listens on the window, with a scope pushed', [spy.live.map((x) => x.t).sort(), env.scopes.length], [['blur', 'keydown', 'keyup'], 1]);
    eq('D the scope catches every key, Esc included', [env.scopes[0].handleKey({ key: 'Escape' }), env.scopes[0].handleKey({ key: 'p' })], [false, false]);

    // The current hotkey must not toggle while recording.
    let e = mkEvent('F12', 'F12');
    p.onKeyDown(e);
    await flush();
    eq('D hook 2 stays out while recording', [p.settings.hebrew, e.stopped], [false, false]);

    // Refused presses stay in recording.
    e = mkEvent('a', 'KeyA');
    spy.fire('keydown', e);
    eq('D a typing key: refused with a notice, consumed, still recording', [e.stopped, env.notices.length, /needed for typing/.test(env.notices[0]), !!p.recording], [true, 1, true, true]);
    env.notices.length = 0;
    e = mkEvent('Control', 'ControlLeft', document.body, { ctrlKey: true });
    spy.fire('keydown', e);
    eq('D Ctrl going down: no notice yet, consumed', [e.stopped, env.notices.length, !!p.recording], [true, 0, true]);
    e = mkEvent('Control', 'ControlLeft');
    spy.fire('keyup', e);
    eq('D Ctrl released alone: the notice, still recording', [e.stopped, env.notices.length, /modifier alone/.test(env.notices[0]), !!p.recording], [true, 1, true, true]);
    env.notices.length = 0;
    spy.fire('keyup', mkEvent('Control', 'ControlLeft'));
    eq('D only once', env.notices.length, 0);

    // A real combination, modifier first.
    spy.fire('keydown', mkEvent('Control', 'ControlLeft', document.body, { ctrlKey: true }));
    spy.fire('keydown', mkEvent('Shift', 'ShiftLeft', document.body, { ctrlKey: true, shiftKey: true }));
    e = mkEvent('K', 'KeyK', document.body, { ctrlKey: true, shiftKey: true });
    spy.fire('keydown', e);
    await flush();
    eq('D Ctrl+Shift+K is taken and saved', [e.stopped, env.saved.toggleHotkey], [true, { code: 'KeyK', ctrl: true, alt: false, shift: true, meta: false }]);
    eq('D recording is over: no listeners, no scope, done called, no toggle', [spy.live.length, env.scopes.length, done, p.recording, p.settings.hebrew], [0, 0, 1, null, false]);
    eq('D and no notice about the modifiers', env.notices.length, 0);

    // Esc, blur, closing the tab, unload.
    p.recordHotkey(env.tab.containerEl, () => { done++; });
    const before = JSON.stringify(env.saved.toggleHotkey);
    e = mkEvent('Escape', 'Escape');
    spy.fire('keydown', e);
    await flush();
    eq('D Esc cancels: nothing changes, consumed, all released', [JSON.stringify(env.saved.toggleHotkey), e.stopped, spy.live.length, env.scopes.length, done], [before, true, 0, 0, 2]);
    p.recordHotkey(env.tab.containerEl, () => { done++; });
    spy.fire('blur', {});
    eq('D leaving the window cancels', [spy.live.length, env.scopes.length, done], [0, 0, 3]);
    p.recordHotkey(env.tab.containerEl, () => { done++; });
    env.tab.hide();
    eq('D closing the tab cancels', [spy.live.length, env.scopes.length, p.recording], [0, 0, null]);
    p.recordHotkey(env.tab.containerEl, () => { done++; });
    p.recordHotkey(env.tab.containerEl, () => { done++; });
    eq('D a second Change replaces the first', [spy.live.length, env.scopes.length], [3, 1]);
    e = mkEvent('F5', 'F5', document.body, { isTrusted: false });
    spy.fire('keydown', e);
    eq('D an untrusted key isn\'t recorded', [e.stopped, !!p.recording], [false, true]);
    e = mkEvent('a', 'KeyA', document.body, { repeat: true });
    env.notices.length = 0;
    spy.fire('keydown', e);
    eq('D a repeat is swallowed with no notice', [e.stopped, env.notices.length], [true, 0]);
    p.onunload();
    eq('D unload cancels', [spy.live.filter((x) => x.t === 'blur').length, env.scopes.length, p.recording], [0, 0, null]);
    spy.restore();
  }
  {
    // The Change button itself.
    const { p, env } = await start({});
    openTab(env);
    tabButton(env, 'Change').click();
    check(!!p.recording, 'D Change starts recording');
    check(!!tabButton(env, 'Press a key (Esc cancels)'), 'D and the button says what to do');
    p.onunload();
  }

  // =========================================================================
  // E. Settings in its own window
  // =========================================================================
  {
    const pop = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
    patchWindow(pop.window);
    const { p, env, adapter } = await start({ hebrew: false });
    env.tab.containerEl = pop.window.document.body.createEl('div');
    openTab(env);

    // activeWindow out of date on purpose.
    window.activeWindow = window;
    window.activeDocument = document;
    tabButton(env, 'New').click();
    await flush();
    let modal = lastModal(env);
    eq('E New opens in the Settings window', modal.containerEl.ownerDocument === pop.window.document, true);
    eq('E and is connected there', modal.containerEl.isConnected, true);
    eq('E activeWindow follows, like Obsidian does', [window.activeWindow === pop.window, window.activeDocument === pop.window.document], [true, true]);
    eq('E not in the main window', document.querySelectorAll('.modal-container').length, 0);
    modal.containerEl.querySelector('input').value = 'Popout map';
    await clickModal(env, 'Create');
    eq('E it works there', p.settings.activeMap, 'popout-map');

    window.activeWindow = window;
    tabButton(env, 'Edit').click();
    await flush();
    modal = lastModal(env);
    eq('E Edit too', modal.containerEl.ownerDocument === pop.window.document, true);
    await clickModal(env, 'Cancel');

    window.activeWindow = window;
    tabButton(env, 'Delete').click();
    await flush();
    modal = lastModal(env);
    eq('E the confirmation too', modal.containerEl.ownerDocument === pop.window.document, true);
    await clickModal(env, 'Delete');
    eq('E and it deletes', [adapter.files.has(pathOf('popout-map')), p.settings.activeMap], [false, 'qwerty']);

    // Recording goes to that window, not the main one.
    window.activeWindow = window;
    const spyMain = spyWindow(window);
    const spyPop = spyWindow(pop.window);
    let done = 0;
    p.recordHotkey(env.tab.containerEl, () => { done++; });
    eq('E recording listens only in the Settings window', [spyMain.live.length, spyPop.live.length], [0, 3]);
    eq('E the scope goes on that window', env.scopes[0].win === pop.window, true);
    const e = mkEvent('F9', 'F9', pop.window.document.body);
    spyPop.fire('keydown', e);
    await flush();
    eq('E the key from there is taken', [env.saved.toggleHotkey.code, e.stopped, done, spyPop.live.length, env.scopes.length], ['F9', true, 1, 0, 0]);
    spyMain.restore();
    spyPop.restore();
    window.activeWindow = window;
    window.activeDocument = document;
    p.onunload();
  }

  // =========================================================================
  // F. The build, and the split
  // =========================================================================
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'math-dir-build3-'));
    const build = (...args) => spawnSync(process.execPath, [buildFile, ...args], { encoding: 'utf8' });
    const realSrc = path.join(pluginDir, 'src');
    let n = 0;
    const copySrc = () => {
      const d = path.join(tmp, 's' + n++);
      fs.mkdirSync(d);
      for (const f of fs.readdirSync(realSrc)) fs.copyFileSync(path.join(realSrc, f), path.join(d, f));
      return d;
    };
    const main = fs.readFileSync(mainFile, 'utf8');
    eq('F main.js is up to date', build('--check').status, 0);
    eq('F no runtime require of the map', main.includes('default-map.json\');'), false);
    check(main.includes('"QWERTY → Hebrew (SI-1452)"'), 'F the map is inlined');
    check(fs.readFileSync(path.join(realSrc, 'core.js'), 'utf8').includes("const DEFAULT_MAP = require('./default-map.json');"), 'F core.js keeps the require line, so it runs on its own');
    {
      const d = copySrc();
      fs.writeFileSync(path.join(d, 'default-map.json'), '{ broken');
      const out = path.join(tmp, 'bad.js');
      const r = build('--src', d, '--out', out);
      check(r.status !== 0 && !fs.existsSync(out) && /build failed/.test(r.stderr), 'F a broken default map fails the build');
    }
    {
      const d = copySrc();
      const core = fs.readFileSync(path.join(d, 'core.js'), 'utf8');
      fs.writeFileSync(path.join(d, 'core.js'), core.replace("require('./default-map.json')", '{}'));
      const out = path.join(tmp, 'noline.js');
      const r = build('--src', d, '--out', out);
      check(r.status !== 0 && !fs.existsSync(out), 'F a missing require line fails the build');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    const vim = fs.readFileSync(path.join(realSrc, 'vim.js'), 'utf8');
    eq('F vim.js doesn\'t touch EN2HE', /\bEN2HE\b/.test(vim), false);
    check(/\bmappedKey\(/.test(vim) && /\boriginalKey\(/.test(vim), 'F it reads the map through the core\'s functions');
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
    eq('F manifest says 0.9.0', manifest.version, '0.9.0');
    check(/v0\.9\.0/.test(fs.readFileSync(path.join(realSrc, 'core.js'), 'utf8').split('\n')[0]), 'F the core\'s header says 0.9.0');
  }

  console.log(`\n${passes} passed, ${fails} failed`);
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(2); });
