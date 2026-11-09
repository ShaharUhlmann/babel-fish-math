// F4 oracle + timings for math-dir 2.4.0 (F3's 2.3.0 oracle + the M6 hold).
// Usage: node F4-math-dir-2.4.0-oracle.js <new main.js> <2.2.0 main.js> [edits=2500] [seed=1]
// After every edit the incremental results are compared with:
//   • a from-scratch computation in the new file (LineScan.full, scanRegions from 0),
//   • 2.2.0 (docDirection(doc.toString()), regionsFor/textRegions with fresh caches),
//   • 2.2.0's MathDirView decorations vs the new MathDirView's (what's drawn).
// The rule (LineScan.direction(), docDirection) is still 2.2.0's. What changed
// in 2.4.0 (M6) is the editor's direction: MathDirView keeps its previous
// direction when the rule's answer changes while the note ends inside an
// unclosed $$ block or fence, unless the frontmatter has a `direction:` key.
// The reference for that (refHold below) is built from 2.2.0's own walkLines
// and docDirection, independently of the new LineScan; 2.2.0's MathDirView is
// then given the reference direction and rebuilt, so the drawn decorations are
// still compared line by line.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
for (const k of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'InputEvent', 'KeyboardEvent', 'DOMRect', 'Range', 'Text']) {
  if (!(k in global)) global[k] = dom.window[k];
}
global.window = dom.window; global.document = dom.window.document;
const CMstate = require('@codemirror/state');
const CMview = require('@codemirror/view');
const CMlang = require('@codemirror/language');
const { EditorState } = CMstate;

const obsidian = { Plugin: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, TFile: class {} };
function load(file, names) {
  file = path.resolve(file);
  let src = fs.readFileSync(file, 'utf8');
  src += `\nmodule.exports.__t = { ${names.join(', ')} };\n`;
  const m = new Module(file + '?' + names.length, module);
  m.filename = file; m.paths = module.paths;
  const orig = m.require.bind(m);
  m.require = (id) => id === 'obsidian' ? obsidian : id === '@codemirror/state' ? CMstate
    : id === '@codemirror/view' ? CMview : id === '@codemirror/language' ? CMlang : orig(id);
  m._compile(src, file);
  return m.exports.__t;
}
const NEW = load(process.argv[2], ['LineScan', 'scanFor', 'noteEdit', 'regionsFor', 'scanRegions', 'textRegions',
  'docDirection', 'perf', 'PERF_ZERO', 'MathDirView', 'features', 'treeDiffPos']);
const OLD = load(process.argv[3], ['docDirection', 'regionsFor', 'textRegions', 'MathDirView', 'features', 'walkLines']);

// ---- the M6 reference, from 2.2.0's functions only ----
// Does the note end inside an unclosed $$ block or fence? (2.2.0's full walk,
// no fast path: a text line's scan says whether it ends in display math; a
// fence line says whether a fence is still open. Fences open only outside
// display math, and indented code only outside it too.)
function refEndsOpen(text) {
  const lines = text.split(/\r?\n/);
  let open = false;
  OLD.walkLines(lines.length, (i) => lines[i], (i, kind, scan, fenceOpenAfter) => {
    open = kind === 'fence' ? fenceOpenAfter : kind === 'text' ? !!(scan && scan.inDisplay) : false;
    return false;
  });
  return open;
}
// Is there a `direction:` key in the frontmatter?
function refOverride(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return false;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') return lines.slice(1, i).some((l) => /^direction\s*:\s*["']?(rtl|ltr)["']?\s*$/i.test(l));
  }
  return false;
}
// The editor's direction after an edit, given the one before. No hold when
// the edit replaced the whole (non-empty) old doc.
function refReplaced(changes, oldLen) {
  let all = false;
  changes.iterChanges((fromA, toA) => { if (fromA === 0 && toA === oldLen) all = true; });
  return all;
}
function refHold(prev, text, replaced) {
  const rule = OLD.docDirection(text);
  if (rule !== prev && !replaced && !refOverride(text) && refEndsOpen(text)) return prev;
  return rule;
}
// 2.2.0's view, drawn with the reference direction.
function redraw(ov, dir, v) {
  if (ov.dir !== dir) { ov.dir = dir; ov.build(v); }
}
const EDITS = +(process.argv[4] || 2500);
let seed = +(process.argv[5] || 1);
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
const ri = (n) => Math.floor(rnd() * n);
const pick = (a) => a[ri(a.length)];

// ---- A fake HyperMD (F2's, plus frontmatter and ~~~ fences): a forward
// StreamLanguage with Obsidian's node names ----
const BEGIN = 'formatting formatting-math formatting-math-begin keyword math';
const END = 'formatting formatting-math formatting-math-end keyword math';
const fake = CMlang.StreamLanguage.define({
  startState: () => ({ first: true, fm: false, display: false, inline: false, fence: null, prevBlank: true, indent: false }),
  copyState: (s) => Object.assign({}, s),
  blankLine: (s) => { s.first = false; s.prevBlank = true; },
  token(stream, s) {
    if (stream.sol()) {
      const line = stream.string;
      if (s.first) { s.first = false; if (line === '---') { s.fm = true; stream.skipToEnd(); return 'meta'; } }
      if (s.fm) { if (line === '---') s.fm = false; stream.skipToEnd(); return 'meta'; }
      if (s.fence) { if (new RegExp('^\\s*' + s.fence + '\\s*$').test(line)) s.fence = null; stream.skipToEnd(); s.prevBlank = false; return 'comment line-HyperMD-codeblock hmd-codeblock'; }
      const fm = /^\s*(`{3,}|~{3,})/.exec(line);
      if (!s.display && fm) { s.fence = fm[1][0] === '`' ? '`{' + fm[1].length + ',}' : '~{' + fm[1].length + ',}'; stream.skipToEnd(); s.prevBlank = false; return 'comment hmd-codeblock'; }
      if (!s.display && /^( {4}|\t)/.test(line) && (s.prevBlank || s.indent)) { s.indent = true; stream.skipToEnd(); return 'comment hmd-indented-code'; }
      s.indent = false; s.prevBlank = false;
    }
    if (s.display) { if (stream.match('$$')) { s.display = false; return END + ' math-block'; } stream.next(); return 'math'; }
    if (s.inline) { if (stream.match('$')) { s.inline = false; return END; } stream.next(); return 'math'; }
    if (stream.match('\\')) { stream.next(); return null; }
    if (stream.match('$$')) { s.display = true; return BEGIN + ' math-block'; }
    if (stream.peek() === '$' && /^\$[^\s$][^$]*[^\s\\]?\$/.test(stream.string.slice(stream.pos))) { stream.next(); s.inline = true; return BEGIN; }
    stream.next();
    return null;
  },
});

// ---- notes and edits ----
const POOL = [
  'שלום עולם, זה משפט בעברית.', 'English sentence here.', 'טקסט עם $x^2+y^2$ באמצע', 'a formula $\\alpha$ and $\\beta$',
  '$$', '\\int_0^1 f(x)\\,dx', '$$ a+b $$', 'שלום $$x$$ עולם', '```', '```js', '~~~~', 'code line ש', '    indented ש', '\tcode tab',
  '- list item', '- פריט', '    continuation שלום', '1. item', '', '', '', '---', 'direction: rtl', 'direction: ltr',
  '\\$ not math ש', '`code $x$` שלום', '$5 and $6', '$\\text{שלום}$', '$$ unclosed', 'x $a$ $$', '\\א', '* star',
];
function genNote(lines) {
  const out = [];
  if (rnd() < 0.5) { out.push('---'); if (rnd() < 0.5) out.push(pick(['direction: rtl', 'direction: ltr', 'direction: "RTL"'])); out.push('tags: x'); if (rnd() < 0.9) out.push('---'); }
  if (rnd() < 0.3) for (let i = 0; i < 5; i++) out.push(pick(['English.', '', '$a$ b', '```', 'code']));
  while (out.length < lines) out.push(pick(POOL));
  return out.join('\n');
}
const BITS = ['$', '$$', '`', '```', '~~~', '\n', '\n\n', ' ', '    ', '\t', '-', 'a', 'x', 'ש', 'ל', '\\', '---', '\n---\n', 'direction: rtl', '1. ', '*', '\n$$\n', '\n```\n'];
function pos(doc) {
  const r = rnd();
  if (r < 0.25) return doc.length - ri(Math.min(40, doc.length + 1));
  if (r < 0.45) return ri(Math.min(60, doc.length + 1));
  return ri(doc.length + 1);
}
function randomEdit(doc) {
  const r = rnd();
  const p = pos(doc);
  if (r < 0.40) return { from: p, insert: pick(BITS) };
  if (r < 0.60) return { from: Math.max(0, p - 1 - ri(4)), to: p };
  if (r < 0.70) { const l = doc.lineAt(p); return { from: l.from, to: Math.min(doc.length, l.to + 1) }; }
  if (r < 0.80) { const l = doc.lineAt(p); return { from: l.from, insert: pick(POOL) + '\n' }; }
  if (r < 0.88) { const q = Math.min(doc.length, p + ri(30)); return { from: p, to: q, insert: pick(POOL) + '\n' + pick(POOL) }; }
  if (r < 0.95) { // two changes in one transaction
    const a = ri(doc.length + 1), b = ri(doc.length + 1);
    const [x, y] = a <= b ? [a, b] : [b, a];
    if (x === y) return { from: x, insert: pick(BITS) };
    return [{ from: x, insert: pick(BITS) }, { from: y, to: Math.min(doc.length, y + ri(3)), insert: pick(BITS) }];
  }
  const q = Math.min(doc.length, p + ri(Math.max(1, doc.length / 5)));
  return { from: p, to: q };
}

// ---- comparison ----
let fails = 0, checks = 0, holds = 0;
const failLog = [];
function eq(name, got, want, ctx) {
  checks++;
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) return true;
  fails++;
  if (failLog.length < 10) failLog.push(`${name}\n  got  ${a.slice(0, 400)}\n  want ${b.slice(0, 400)}\n  ctx ${JSON.stringify(ctx).slice(0, 600)}`);
  return false;
}
const codeArr = (R) => [...R.code].sort((x, y) => x - y);
const mathArr = (R) => R.math.map((r) => [r.from, r.to, r.open]);

function checkScan(doc, ctx) {
  const inc = NEW.scanFor(doc);
  const fresh = NEW.LineScan.full(doc);
  eq('direction == 2.2.0', inc.direction(), OLD.docDirection(doc.toString()), ctx);
  fresh.ensure(inc.walked);
  eq('scan fm/override', [inc.fm, inc.override], [fresh.fm, fresh.override], ctx);
  let bad = -1;
  for (let i = 0; i <= inc.walked && bad < 0; i++) if (inc.st[i] !== fresh.st[i]) bad = i;
  for (let i = 0; i < inc.walked && bad < 0; i++) if (inc.fl[i] !== fresh.fl[i]) bad = i;
  eq('scan records == fresh walk', bad, -1, ctx);
}
function checkRegions(doc, tree, upto, ctx) {
  const inc = NEW.regionsFor(doc, tree, upto);
  const full = NEW.scanRegions(doc, tree, inc.limit, 0, null);
  const old = OLD.regionsFor(doc, tree, upto);
  eq('regions limit', inc.limit, old.limit, ctx);
  eq('math == from scratch', mathArr(inc), mathArr(full), ctx);
  eq('code == from scratch', codeArr(inc), codeArr(full), ctx);
  eq('math == 2.2.0', mathArr(inc), mathArr(old), ctx);
  eq('code == 2.2.0', codeArr(inc), codeArr(old), ctx);
}

// A stand-in for EditorView: what MathDirView reads.
function fakeView(state, head, around) {
  const doc = state.doc;
  const l = doc.lineAt(Math.min(head, doc.length)).number;
  const from = doc.line(Math.max(1, l - around)).from;
  const to = doc.line(Math.min(doc.lines, l + around)).to;
  return { state, visibleRanges: [{ from, to }], compositionStarted: false };
}
const decoList = (set) => { const out = []; for (let it = set.iter(); it.value; it.next()) out.push([it.from, it.to, it.value.spec.class]); return out; };

(async () => {
  // ================= randomized oracle =================
  let edits = 0;
  const t0 = Date.now();
  Object.assign(NEW.perf, NEW.PERF_ZERO);
  while (edits < EDITS) {
    let state = EditorState.create({ doc: genNote(20 + ri(120)), extensions: [fake] });
    CMlang.ensureSyntaxTree(state, state.doc.length, 5000);
    let v = fakeView(state, ri(state.doc.length + 1), 15);
    const nv = new NEW.MathDirView(v);
    const ov = new OLD.MathDirView(v);
    let ref = OLD.docDirection(state.doc.toString());
    eq('view dir at open == rule', nv.dir, ref, {});
    for (let k = 0; k < 60 && edits < EDITS; k++, edits++) {
      const spec = randomEdit(state.doc);
      const tr = state.update({ changes: spec });
      const prev = state;
      state = tr.state;
      const doc = state.doc;
      const ctx = { edits, spec, doc: doc.toString().slice(0, 300) };
      // a viewport near the change (or anywhere), sometimes a partial parse
      const head = rnd() < 0.7 ? tr.changes.mapPos(Array.isArray(spec) ? spec[0].from : spec.from) : ri(doc.length + 1);
      v = fakeView(state, head, 5 + ri(30));
      const u = { docChanged: true, viewportChanged: rnd() < 0.2, startState: prev, state, changes: tr.changes, view: v };
      nv.update(u); ov.update(u);
      ref = refHold(ref, doc.toString(), refReplaced(tr.changes, prev.doc.length));
      if (ref !== OLD.docDirection(doc.toString())) holds++;
      eq('view dir == M6 reference', nv.dir, ref, ctx);
      redraw(ov, ref, v);
      eq('view decorations == 2.2.0', decoList(nv.deco), decoList(ov.deco), ctx);
      eq('view isolates == 2.2.0', decoList(nv.marks), decoList(ov.marks), ctx);
      checkScan(doc, ctx);
      const tree = rnd() < 0.3 ? CMlang.syntaxTree(state) : CMlang.ensureSyntaxTree(state, doc.length, 5000) || CMlang.syntaxTree(state);
      checkRegions(doc, tree, rnd() < 0.5 ? v.visibleRanges[0].to : ri(doc.length + 1), ctx);
      if (rnd() < 0.2) { // a parse step: a newer tree for the same doc
        const t2 = CMlang.ensureSyntaxTree(state, doc.length, 5000);
        if (t2) checkRegions(doc, t2, doc.length, ctx);
      }
      if (rnd() < 0.05) { // the text parser (fallback): same as 2.2.0
        eq('textRegions math == 2.2.0', mathArr(NEW.textRegions(doc)), mathArr(OLD.textRegions(doc)), ctx);
        eq('textRegions code == 2.2.0', codeArr(NEW.textRegions(doc)), codeArr(OLD.textRegions(doc)), ctx);
      }
    }
  }
  const p = Object.assign({}, NEW.perf);
  console.log(`random: ${edits} edits, ${checks} checks, ${fails} mismatches, ${holds} edits with the direction held (M6) (${Date.now() - t0} ms)`);
  console.log(`  region scans: full ${p.fullScans}, incremental ${p.incrementalScans}, reused ${p.reusedScans}; line scan: full ${p.dirFull}, incremental ${p.dirIncremental}, deciding line kept ${p.dirKept}, held ${p.dirHeld}`);

  // ================= targeted cases =================
  const T = [];
  const run = (name, doc0, steps, want) => {
    let state = EditorState.create({ doc: doc0, extensions: [fake] });
    CMlang.ensureSyntaxTree(state, state.doc.length, 5000);
    let v = fakeView(state, 0, 1000);
    const nv = new NEW.MathDirView(v); const ov = new OLD.MathDirView(v);
    let ref = nv.dir;
    eq(name + ': dir at open == rule', nv.dir, OLD.docDirection(doc0), {});
    const dirs = [nv.dir];
    for (const spec of steps) {
      const tr = state.update({ changes: typeof spec === 'function' ? spec(state.doc) : spec });
      const prev = state; state = tr.state;
      v = fakeView(state, 0, 1000);
      const u = { docChanged: true, viewportChanged: false, startState: prev, state, changes: tr.changes, view: v };
      nv.update(u); ov.update(u);
      ref = refHold(ref, state.doc.toString(), refReplaced(tr.changes, prev.doc.length));
      eq(name + ': dir == M6 reference', nv.dir, ref, { doc: state.doc.toString() });
      redraw(ov, ref, v);
      eq(name + ': decorations == 2.2.0', decoList(nv.deco), decoList(ov.deco), { doc: state.doc.toString() });
      checkScan(state.doc, { name });
      checkRegions(state.doc, CMlang.ensureSyntaxTree(state, state.doc.length, 5000), state.doc.length, { name });
      dirs.push(nv.dir);
    }
    const ok = eq(name + ': direction sequence', dirs, want, {});
    T.push((ok ? 'PASS ' : 'FAIL ') + name + '  ' + dirs.join(' → '));
  };
  const line = (n) => (d) => d.line(n);
  run('delete the only Hebrew line → ltr', 'English\n\nשלום\nmore English', [(d) => ({ from: line(3)(d).from, to: line(4)(d).from })], ['rtl', 'ltr']);
  run('add Hebrew above → rtl', 'English\nmore', [{ from: 0, insert: 'ש' }], ['ltr', 'rtl']);
  run('frontmatter direction: takes effect', '---\ndirection: ltr\n---\nשלום', [(d) => ({ from: line(2)(d).from + 11, to: line(2)(d).to, insert: 'rtl' }), (d) => ({ from: line(2)(d).from, to: line(2)(d).to })], ['ltr', 'rtl', 'rtl']);
  run('frontmatter override added in place (shift)', '---\ntags: x\n---\nEnglish', [(d) => ({ from: line(2)(d).to, insert: '\ndirection: rtl' })], ['ltr', 'rtl']);
  run('unclosed frontmatter closes later', '---\ndirection: rtl\nEnglish', [(d) => ({ from: line(2)(d).to, insert: '\n---' })], ['ltr', 'rtl']);
  // M6 (2.4.0): held while the note ends inside the unclosed block; once it's closed the rule decides.
  run('M6: $$ typed above all Hebrew holds rtl until closed', 'intro\nשלום\nעוד', [{ from: 6, insert: '$$\n' }, (d) => ({ from: d.length, insert: '\n$$' })], ['rtl', 'rtl', 'ltr']);
  run('M6: fence typed above Hebrew holds rtl until closed', 'intro\nשלום', [{ from: 6, insert: '```\n' }, (d) => ({ from: d.length, insert: '\n```' })], ['rtl', 'rtl', 'ltr']);
  const typed = (s, at = 0) => [...s].map((c, k) => ({ from: at + k, insert: c }));
  run('M6 live test: $$ Enter x Enter $$ Enter typed at the top of a Hebrew note', 'שלום עולם\nעוד שורה', typed('$$\nx\n$$\n'), Array(9).fill('rtl'));
  run('M6 live test: ``` Enter code Enter ``` Enter typed at the top', 'שלום עולם\nעוד שורה', typed('```\ncode\n```\n'), Array(14).fill('rtl'));
  run('M6: $$ at the very start of the only Hebrew line', 'שלום עולם', typed('$$'), ['rtl', 'rtl', 'rtl']);
  run('M6: held both ways (re-pairing exposes Hebrew in an English note)', 'English\n$$\nא\n$$\nmore', [{ from: 0, insert: '$$\n' }, (d) => ({ from: d.length, insert: '\n$$' })], ['ltr', 'ltr', 'rtl']);
  run('M6: a direction: key applies while a block is open', '---\ndirection: rtl\n---\nEnglish', [(d) => ({ from: d.length, insert: '\n$$\n' }), (d) => ({ from: line(2)(d).from + 11, to: line(2)(d).to, insert: 'ltr' })], ['rtl', 'rtl', 'ltr']);
  run('M6: no hold when the whole note is replaced', 'שלום', [(d) => ({ from: 0, to: d.length, insert: 'English\n$$\nx' })], ['rtl', 'ltr']);
  run('M6: first Hebrew while the note ends in an open block is held (ltr)', 'English\n$$\nx', [{ from: 0, insert: 'ש' }, (d) => ({ from: d.length, insert: '\n$$' })], ['ltr', 'ltr', 'rtl']);
  run('open $$ mid-note, then close it', 'שלום\n\nx $a$ y\n\nb\nc\n', [(d) => ({ from: line(4)(d).from, insert: '$$' }), (d) => ({ from: line(6)(d).to, insert: '\n$$' })], ['rtl', 'rtl', 'rtl']);
  run('type in a fence', 'שלום\n```\ncode\n```\n', [(d) => ({ from: line(3)(d).to, insert: 'x' }), (d) => ({ from: line(3)(d).to, insert: '\n\n' })], ['rtl', 'rtl', 'rtl']);
  run('blank run after indented code', 'para\n\n    code\n\n\nnext', [(d) => ({ from: line(6)(d).from, insert: '    ' }), (d) => ({ from: line(6)(d).from, to: line(6)(d).from + 4 })], ['ltr', 'ltr', 'ltr']);
  run('Hebrew only in math → ltr, then outside → rtl', '$\\text{שלום}$\n$$\nש\n$$', [(d) => ({ from: d.length, insert: '\nש' })], ['ltr', 'rtl']);
  run('empty doc', '', [{ from: 0, insert: 'ש' }, { from: 0, to: 1 }], ['ltr', 'rtl', 'ltr']);
  run('typing at the very end', 'שלום\n' + 'English\n'.repeat(50), [(d) => ({ from: d.length, insert: 'x' }), (d) => ({ from: d.length, insert: '$' })], ['rtl', 'rtl', 'rtl']);
  run('escaped Hebrew only', 'a \\ש b', [{ from: 2, to: 3 }], ['ltr', 'rtl']);
  for (const t of T) console.log(t);

  // ================= tree-only updates (background parse steps) =================
  {
    let state = EditorState.create({ doc: genNote(400), extensions: [fake] });
    const t1 = CMlang.ensureSyntaxTree(state, 2000, 5000) || CMlang.syntaxTree(state);
    const r1 = NEW.regionsFor(state.doc, t1, 2000);
    const t2 = CMlang.ensureSyntaxTree(state, state.doc.length, 5000);
    eq('tree diff of a longer parse is past the first tree\'s regions', NEW.treeDiffPos(t1, t2) >= Math.min(r1.limit, t1.length) - 600, true, {});
    const before = NEW.perf.fullScans;
    const r2 = NEW.regionsFor(state.doc, t2, state.doc.length);
    eq('longer parse: incremental, not full', NEW.perf.fullScans, before, {});
    eq('longer parse: == from scratch', mathArr(r2), mathArr(NEW.scanRegions(state.doc, t2, r2.limit, 0, null)), {});
  }

  console.log(fails ? `${fails} MISMATCHES` : `ORACLE PASS (${checks} checks)`);
  for (const f of failLog) console.log('MISMATCH ' + f);

  // ================= timings =================
  const lines = [];
  lines.push('---', 'tags: [lecture]', '---');
  for (let i = 0; lines.length < 3000; i++) {
    const k = i % 12;
    lines.push(k === 0 ? '## פרק ' + i : k === 3 ? '$$' : k === 4 ? '\\sum_{i=1}^n a_i = \\int_0^1 f(x)\\,dx' : k === 5 ? '$$'
      : k === 7 ? 'נגדיר $f(x)=x^2$ ונראה ש־$f\'(x)=2x$ לכל $x\\in\\mathbb{R}$.' : k === 9 ? '' : 'שורה בעברית עם קצת טקסט, ועוד $a_' + i + '$ כאן.');
  }
  const long = lines.join('\n');
  function timeTyping(M, where, n, text = long) {
    let state = EditorState.create({ doc: text, extensions: [fake] });
    CMlang.ensureSyntaxTree(state, state.doc.length, 60000);
    let at = where === 'end' ? state.doc.length : state.doc.line(10).to;
    let v = fakeView(state, at, 40);
    const view = new M.MathDirView(v);
    const times = [];
    for (let i = 0; i < n; i++) {
      const tr = state.update({ changes: { from: at, insert: 'ש' } });
      const prev = state; state = tr.state; at += 1;
      // the editor's parse step for this keystroke (not timed: CodeMirror's work)
      CMlang.ensureSyntaxTree(state, Math.min(state.doc.length, v.visibleRanges[0].to + 2000), 1000);
      v = fakeView(state, at, 40);
      const s = process.hrtime.bigint();
      view.update({ docChanged: true, viewportChanged: false, startState: prev, state, changes: tr.changes, view: v });
      times.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
    times.sort((a, b) => a - b);
    const med = times[times.length >> 1], p90 = times[Math.floor(times.length * 0.9)];
    return { median: +med.toFixed(3), p90: +p90.toFixed(3), max: +times[times.length - 1].toFixed(3) };
  }
  console.log(`\nTimings: ${lines.length}-line note, ${long.length} chars; viewport ±40 lines; 300 keystrokes each; ms per editor update`);
  for (const where of ['end', 'start']) {
    timeTyping(OLD, where, 30); timeTyping(NEW, where, 30); // warm-up
    const o = timeTyping(OLD, where, 300);
    Object.assign(NEW.perf, NEW.PERF_ZERO);
    const n = timeTyping(NEW, where, 300);
    const pc = NEW.perf;
    console.log(`  typing at the ${where}: 2.2.0 ${JSON.stringify(o)}  new ${JSON.stringify(n)}  speed-up (median) ×${(o.median / n.median).toFixed(1)}`);
    console.log(`    new perf: full ${pc.fullScans} incr ${pc.incrementalScans} reused ${pc.reusedScans}; scan full ${pc.dirFull} incr ${pc.dirIncremental} kept ${pc.dirKept} lines walked ${pc.linesWalked}`);
  }
  const english = long.replace(/[א-ת]/g, 'e');
  for (const where of ['end', 'start']) {
    timeTyping(OLD, where, 30, english); timeTyping(NEW, where, 30, english);
    const o = timeTyping(OLD, where, 300, english);
    Object.assign(NEW.perf, NEW.PERF_ZERO);
    const n = timeTyping(NEW, where, 300, english);
    const pc = NEW.perf;
    console.log(`  English-only note (no deciding line), typing at the ${where}: 2.2.0 ${JSON.stringify(o)}  new ${JSON.stringify(n)}  ×${(o.median / n.median).toFixed(1)}`);
    console.log(`    new perf: full ${pc.fullScans} incr ${pc.incrementalScans}; scan full ${pc.dirFull} incr ${pc.dirIncremental} lines walked ${pc.linesWalked}`);
  }
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
