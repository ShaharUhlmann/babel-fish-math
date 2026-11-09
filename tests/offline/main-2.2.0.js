// Hebrew Vim + Math Direction — a tiny standalone Obsidian plugin (no build step). v2.2.0
//
// One plugin for writing Hebrew with math in Obsidian with Vim Motions. It merged
// hebrew-vim 3.0.0 into math-dir 1.1.1 in 2.0 (backups in Snippets/_backups/).
//
// A. Text direction (the only thing in the vault that sets it in the editor;
//    obsidian-rtl / content-rtl are off, and Settings → Editor → "Right-to-left"
//    is off):
//   • Document: a note is RTL if it has a Hebrew letter outside frontmatter, math
//     and code (fenced or indented). `direction: rtl` or `direction: ltr` in the
//     frontmatter overrides that. Everything else is LTR.
//   • Inline math $…$ (delimiters included): an LTR, bidi-isolated span, so the
//     formula reads left to right inside a Hebrew line and arrows move visually.
//   • Display math $$…$$: every line of the block is LTR, including the delimiter
//     lines and blank lines inside. A $$…$$ that shares its line with text is
//     treated like inline math.
//   • Fenced / indented code and frontmatter lines: LTR.
//   • Reading view: each rendered section gets the note's direction. Rendered math
//     is isolated by .obsidian/snippets/math-ltr-fix.css.
//   • Vim Motions' block cursor layer gets the direction of the text under it.
//
// B. LyX-style Hebrew typing: keep the OS keyboard on English all the time, and
//    turn typed letters into Hebrew when the "Hebrew layer" is on.
//   • Toggle with the command "Toggle Hebrew typing" (default hotkey F12), the
//     EN / עב button in the status bar (click, or Enter / Space when focused), or
//     the settings tab.
//   • In the note, the layer only touches text you *type*, so:
//       – Vim normal/visual commands stay English (they never insert text),
//       – math ($…$, $$…$$) and code blocks stay English,
//       – Ctrl/Alt combos and Shift+letter (Latin capitals, as on the Windows
//         Hebrew layout) are untouched.
//   • Outside the note, only an allowlist of fields follows the layer: the Vim
//     / and ? prompts, the quick switcher and command palette, search panes,
//     Vim Motions' picker and prompts, the inline title and file renames.
//     Settings never does, and the Vim ":" command line (in the note, and Vim
//     Motions' "Ex command" modal outside it) always stays English.
//   • The layer inserts into every selection range, like CodeMirror's own
//     insert, so visual-block insert (<C-v>jjI) and multiple cursors work.
//   • The character argument of f / F / t / T / r (with or without a count)
//     follows the layer too, outside math and code.
//   • Fallbacks for when the OS layout *is* Hebrew: Ctrl+[ still acts as Escape
//     (and cancels the / ? : prompts properly), the ":" command lines still type
//     English, and normal / visual mode keys in the note act as their US keys
//     (. , ; / q w ' ` [ ], unshifted). Typing a Hebrew letter in the note or an
//     allowlisted field, or one of those keys in normal mode, shows a notice to
//     switch back (at most once every few seconds).
//
// C. Visual h / l / <Left> / <Right> / x / X for Vim Motions: each step goes to
//    the visually adjacent character, using CodeMirror's own bidi order.
//
// One source for "is this math or code?": regionsFor() below. The direction
// decorations, the cursor-layer class, the Hebrew input translation and f/t/r
// all ask it, and the motions read the bidi order those decorations produce.
//
// Layout of this file: sections 1–7 and 9 use public Obsidian / CodeMirror API
// only. Everything that relies on private or undocumented details of Vim Motions,
// its codemirror-vim fork or Obsidian's Markdown tokenizer is in section 8, the
// ADAPTER, which the rest calls through a few functions. Section 8 also runs the
// self-checks (probes): a failed probe turns off only the feature that needs it,
// with one notice. Settings → "Diagnostics" prints the probe table.

const { Plugin, PluginSettingTab, Setting, Notice, TFile } = require('obsidian');
const { ViewPlugin, Decoration, EditorView, Direction, logException } = require('@codemirror/view');
const { Prec, EditorSelection, EditorState } = require('@codemirror/state');
const { syntaxTree, ensureSyntaxTree, language } = require('@codemirror/language');

const DEFAULT_SETTINGS = { hebrew: false, layoutWarning: true, visualMotions: true };

const HEBREW = /[א-ת]/;
const DIRECTION_KEY = /^direction\s*:\s*["']?(rtl|ltr)["']?\s*$/i;
const WARN_EVERY_MS = 5000;
// Per typed key while the parse is behind (just after a big paste or opening a
// long note); the text fallbacks in inMathOrCode cover what it doesn't reach.
const PARSE_BUDGET_MS = 8;
// Safety-net re-check of the Vim registration. Vim Motions loading or reloading
// is caught at once through its load event (see VIM_LOAD_EVENT).
const VIM_CHECK_MS = 10000;
const isHebrewLetter = (key) => key.length === 1 && key >= 'א' && key <= 'ת';

// Which features are on. Set by the probes in section 8: true = checked and
// working, false = a probe failed (the feature is off), null = not checked yet
// (counts as on, which is how 2.1.0 behaved).
const features = {
  motions: null,       // define / map Vim motions at all
  visualMotions: null, // visual (not logical) h / l / x / X
  charArgs: null,      // Hebrew f / t / r character arguments
  usKeys: null,        // US keys in normal mode on a Hebrew OS layout
  escape: null,        // Ctrl+[ → Escape in the note on a Hebrew OS layout
  keymapCheck: null,   // "are our commands still mapped?" via the keymap
  tokens: null,        // math / code from Obsidian's tokenizer (else the text parser)
  cursorClass: null,   // direction class for Vim Motions' block cursor layer
};
const on = (name) => features[name] !== false;
// The features that depend on the current Vim object.
const VIM_FEATURES = ['motions', 'visualMotions', 'charArgs', 'usKeys', 'escape', 'keymapCheck', 'cursorClass'];
// Bumped when a feature that changes the decorations flips, so every editor
// rebuilds them on its next update.
let featureEpoch = 0;

// ===========================================================================
// 1. Plain-text block structure (shared by the document rule and the code
//    regions)
// ===========================================================================

// Index of the closing '---' of the frontmatter, or -1. Same rule as Obsidian:
// the first line is exactly '---' and a later line is exactly '---'.
function frontmatterEndAt(count, get) {
  if (!count || get(0) !== '---') return -1;
  for (let i = 1; i < count; i++) if (get(i) === '---') return i;
  return -1;
}
const frontmatterEnd = (lines) => frontmatterEndAt(lines.length, (i) => lines[i]);

function fenceMarker(line) {
  const m = /^\s*(`{3,}|~{3,})/.exec(line);
  return m ? m[1] : null;
}

function closesFence(line, fence) {
  const m = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  return !!m && m[1][0] === fence[0] && m[1].length >= fence.length;
}

// Indented code (the one rule for "code" besides fences; see walkLines):
const INDENTED = /^( {4}|\t)/;
const LIST_ITEM = /^\s*([-+*]|\d+[.)])(\s|$)/;

// Index of the closing $ of inline math opened at `i`, or -1. Same test as
// Obsidian's tokenizer: a non-space, non-$ character right after the $, and the
// first "X$" after it (X not a backslash) must have a non-space X and no digit
// right after its $.
function inlineClose(line, i) {
  const next = line[i + 1];
  if (next === undefined || next === '$' || /\s/.test(next)) return -1;
  const m = /[^\\]\$(.|$)/.exec(line.slice(i + 1));
  if (!m || !/^[^\s\\]\$([^0-9]|$)/.test(m[0])) return -1;
  return i + 1 + m.index + 1;
}

// Index just past the backtick run that closes an inline code span opened at
// `i`, or -1 when it isn't closed on this line. Also returns the run length.
function codeSpanEnd(line, i) {
  let n = 0;
  while (line[i + n] === '`') n++;
  const run = '`'.repeat(n);
  for (let j = i + n; ;) {
    const k = line.indexOf(run, j);
    if (k < 0) return { end: -1, n };
    let e = k;
    while (line[e] === '`') e++;
    if (e - k === n) return { end: e, n };
    j = e;
  }
}

// Walks one line the way Obsidian's tokenizer opens and closes math.
// Returns whether the line ends inside a $$ block and whether it has Hebrew
// outside math. `sink` (optional) is told about math on this line:
// sink('inline', from, to), sink('open', at), sink('close', to), with offsets
// in the line.
function scanLine(line, inDisplay, sink) {
  let hebrew = false;
  for (let i = 0; i < line.length; ) {
    const c = line[i];
    if (inDisplay) {
      if (c === '\\') i += 2;
      else if (c === '$' && line[i + 1] === '$') {
        inDisplay = false;
        i += 2;
        if (sink) sink('close', i);
      } else i++;
    } else if (c === '\\') {
      i += 2;
    } else if (c === '`') {
      const { end, n } = codeSpanEnd(line, i);
      if (end < 0) i += n;
      else { if (HEBREW.test(line.slice(i, end))) hebrew = true; i = end; }
    } else if (c === '$' && line[i + 1] === '$') {
      if (sink) sink('open', i);
      inDisplay = true;
      i += 2;
    } else if (c === '$') {
      const close = inlineClose(line, i);
      if (close >= 0 && sink) sink('inline', i, close + 1);
      i = close < 0 ? i + 1 : close + 1;
    } else {
      if (HEBREW.test(c)) hebrew = true;
      i++;
    }
  }
  return { inDisplay, hebrew };
}

// Walks a note's lines (0-based, `get(i)` returns line i) through frontmatter,
// fenced code (a fence only opens outside display math), indented code and $$
// display math.
// visit(i, kind, scan, fenceOpenAfter) — kind is 'fm' | 'fence' | 'indent' |
// 'text', `scan` is scanLine's result for 'text' lines (null when `fast`
// skipped it), and fenceOpenAfter says whether a fence is still open after line
// i. Return true from visit to stop. `fast`: skip scanLine on lines without '$'
// (they can't change the $$ state); only for callers that don't need
// `scan.hebrew` or `sink`. `sink(i, event, a, b)`: scanLine's math events.
//
// Indented code, the same rule the editor's regions use (CommonMark, as far
// as a line walk can tell): a non-blank line indented by 4 spaces or a tab,
// outside display math, that follows a blank line (or the start of the body)
// or continues an indented block, and isn't inside a list (a list item's
// indented lines are its continuation). Blank lines inside the block are
// 'text' (they carry nothing). Indented code is never scanned for math.
function walkLines(count, get, visit, fast, sink) {
  const fm = frontmatterEndAt(count, get);
  let inDisplay = false;
  let fence = null;
  let indentCode = false;
  let prevBlank = true;
  let listCtx = false;
  for (let i = 0; i < count; i++) {
    const line = get(i);
    if (i <= fm) {
      if (visit(i, 'fm', null, false)) return;
      continue;
    }
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      if (visit(i, 'fence', null, !!fence)) return;
      continue;
    }
    if (!inDisplay) {
      const f = fenceMarker(line);
      if (f) {
        fence = f;
        indentCode = listCtx = prevBlank = false;
        if (visit(i, 'fence', null, true)) return;
        continue;
      }
      const blank = !line.trim();
      if (!blank && INDENTED.test(line) && (indentCode || (prevBlank && !listCtx))) {
        indentCode = true;
        prevBlank = false;
        if (visit(i, 'indent', null, false)) return;
        continue;
      }
      if (blank) {
        prevBlank = true;
      } else {
        indentCode = false;
        prevBlank = false;
        // An indented line in a list continues it; anything else decides anew.
        if (!INDENTED.test(line)) listCtx = LIST_ITEM.test(line);
      }
    } else {
      prevBlank = false;
    }
    let r = null;
    if (!fast || line.includes('$')) {
      r = scanLine(line, inDisplay, sink && ((ev, a, b) => sink(i, ev, a, b)));
      inDisplay = r.inDisplay;
    }
    if (visit(i, 'text', r, false)) return;
  }
}

// ===========================================================================
// 2. Document direction (one rule, for the editor and Reading view)
// ===========================================================================

// 'rtl' or 'ltr' for a whole note.
function docDirection(text) {
  let lines = null;
  if (text.startsWith('---')) {
    lines = text.split(/\r?\n/);
    const fm = frontmatterEnd(lines);
    for (let i = 1; i < fm; i++) {
      const m = DIRECTION_KEY.exec(lines[i]);
      if (m) return m[1].toLowerCase();
    }
  }
  if (!HEBREW.test(text)) return 'ltr';
  if (!lines) lines = text.split(/\r?\n/);
  let dir = 'ltr';
  walkLines(lines.length, (i) => lines[i], (i, kind, r) => {
    if (kind === 'text' && r.hebrew) { dir = 'rtl'; return true; }
    return false;
  });
  return dir;
}

// ===========================================================================
// 3. Math / code regions — the one source everything asks
// ===========================================================================
//
// Two detectors with the same result shape:
//   • tokenizer (default): the adapter reads Obsidian's syntax tree
//     (tokenRegions in section 8). Exact from the opening $ to the closing $,
//     knows indented code inside lists, and yields whole ranges.
//   • text parser (fallback, when the tokenizer self-check fails): the line
//     walk of section 1 over the whole note.
// Both mark fenced and indented code as code; the document rule in section 2
// uses the same two kinds.
// Strengths kept from hebrew-vim's old detector:
//   • blank lines inside, or at the open end of, a fenced block are code
//     (decided by the plain-text fence walk, not by "blank between two code
//     lines", which wrongly filled the gap between two adjacent blocks);
//   • a $$ block that isn't closed yet runs to the end of the parsed text;
//   • for typing: an unclosed `$x` and parse lag are caught by text fallbacks
//     (inlineDollarOpen / displayDollarOpen in inMathOrCode).

// Cached per syntax tree (each edit or parse step makes a new one) and doc.
const regionCache = new WeakMap();
// Text-parser results, cached per doc.
const textRegionCache = new WeakMap();

// Code lines from a map line number → 'fence' | 'indent', plus the blank lines
// that belong to them. Blank lines carry no tokens. A blank run right after a
// code line is code when a fence is still open after that line (inside a
// block, or at the end of one that isn't closed yet), or, for indented code,
// when the next non-blank line is indented code too. The run is followed past
// `limit` if needed (blank lines only), so the answer doesn't depend on how
// far the scan went; past `limit` "indented code" is read from the text.
function codeLines(doc, codeKind, limit) {
  const code = new Set(codeKind.keys());
  const lastLine = doc.lineAt(limit).number;
  const runs = [];
  for (const [n, kind] of codeKind) {
    let m = n + 1;
    while (m <= doc.lines && !codeKind.has(m) && !doc.line(m).text.trim()) m++;
    if (m > n + 1 && n < lastLine) runs.push({ n, kind, end: m }); // blank lines n+1 … end-1
  }
  const indentAfter = (m) => m <= lastLine
    ? codeKind.get(m) === 'indent'
    : m <= doc.lines && INDENTED.test(doc.line(m).text);
  const fenceLines = runs.filter((r) => r.kind === 'fence').map((r) => r.n);
  let openAfter = null;
  if (fenceLines.length) {
    const want = new Set(fenceLines);
    const max = Math.max(...fenceLines);
    openAfter = new Set();
    walkLines(max, (i) => doc.line(i + 1).text, (i, kind, r, isOpen) => {
      if (isOpen && want.has(i + 1)) openAfter.add(i + 1);
      return false;
    }, true);
  }
  for (const { n, kind, end } of runs) {
    const fill = kind === 'fence' ? openAfter.has(n) : indentAfter(end);
    if (fill) for (let k = n + 1; k < end && k <= lastLine; k++) code.add(k);
  }
  return code;
}

// {
//   limit: how far the regions are known (min(upto, parsed length)),
//   math:  [{ from, to, open }] sorted; `open` for a $$ not closed before limit,
//   code:  Set of 1-based line numbers that are code,
// }
function regionsFor(doc, tree, upto) {
  if (!on('tokens')) return textRegions(doc);
  const limit = Math.min(upto, tree.length, doc.length);
  const hit = regionCache.get(tree);
  if (hit && hit.doc === doc && hit.limit >= limit) return hit;
  const { math, codeKind } = tokenRegions(doc, tree, limit);
  const result = { doc, limit, math, code: codeLines(doc, codeKind, limit) };
  regionCache.set(tree, result);
  return result;
}

// The same result from the text parser, for the whole doc.
function textRegions(doc) {
  const hit = textRegionCache.get(doc);
  if (hit) return hit;
  const math = [];
  const codeKind = new Map();
  let openFrom = -1;
  walkLines(doc.lines, (i) => doc.line(i + 1).text, (i, kind) => {
    if (kind === 'fence' || kind === 'indent') codeKind.set(i + 1, kind);
    return false;
  }, false, (i, ev, a, b) => {
    const base = doc.line(i + 1).from;
    if (ev === 'inline') math.push({ from: base + a, to: base + b, open: false });
    else if (ev === 'open') openFrom = base + a;
    else if (openFrom >= 0) { math.push({ from: openFrom, to: base + a, open: false }); openFrom = -1; }
  });
  if (openFrom >= 0) math.push({ from: openFrom, to: doc.length, open: true });
  const result = { doc, limit: doc.length, math, code: codeLines(doc, codeKind, doc.length) };
  textRegionCache.set(doc, result);
  return result;
}

// Is `pos` (a position between characters) inside a math region? Right before
// the opening $ and right after the closing $ count as outside.
function inMathRegion(R, pos) {
  for (const r of R.math) {
    if (r.from >= pos) break;
    if (pos < r.to || (r.open && pos <= r.to)) return true;
  }
  return false;
}

// 'math', 'code', 'text', or null when the parse hasn't reached `pos`.
function contextAt(state, pos) {
  let R;
  if (on('tokens')) {
    const tree = (ensureSyntaxTree && ensureSyntaxTree(state, pos, PARSE_BUDGET_MS)) || syntaxTree(state);
    if (tree.length < pos) return null;
    R = regionsFor(state.doc, tree, pos);
  } else {
    R = textRegions(state.doc);
  }
  if (R.code.has(state.doc.lineAt(pos).number)) return 'code';
  return inMathRegion(R, pos) ? 'math' : 'text';
}

// Text fallback for inline math the parser doesn't see as math yet: an unclosed
// `$x` (the tokenizer needs the closing $ first) and `$ $`. An odd number of
// unescaped single $ before the cursor on its line means an inline formula is
// open. `$$` is skipped here: the parser always treats `$$` as display math.
function inlineDollarOpen(state, pos) {
  const line = state.doc.lineAt(pos);
  const text = line.text.slice(0, pos - line.from)
    .replace(/\\./g, '  ')                            // \$ and other escapes
    .replace(/`[^`]*`/g, (s) => ' '.repeat(s.length)); // inline code
  let open = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '$') continue;
    if (text[i + 1] === '$') { i++; continue; }
    open = !open;
  }
  return open;
}

// Text fallback for display math when the parse lags behind `pos` (huge paste):
// an odd number of unescaped `$$` before the cursor.
function displayDollarOpen(state, pos) {
  const text = state.doc.sliceString(0, pos).replace(/\\./g, '  ');
  return ((text.match(/\$\$/g) || []).length % 2) === 1;
}

// For typing: should text inserted at `pos` stay English?
function inMathOrCode(state, pos) {
  const ctx = contextAt(state, pos);
  if (ctx === 'math' || ctx === 'code') return true;
  if (ctx === null && displayDollarOpen(state, pos)) return true;
  return inlineDollarOpen(state, pos);
}

// ===========================================================================
// 4. Direction decorations (editor)
// ===========================================================================
//
//   • Every visible line gets a line decoration with dir + a class. They are
//     provided through EditorView.outerDecorations, which CodeMirror applies after
//     all regular decorations, so they win over Obsidian's own per-line `dir`
//     (first-strong-character) decorations.
//   • The math marks also go through EditorView.outerDecorations, so they wrap
//     every other span in the formula (syntax tokens, LaTeX Suite conceal and
//     bracket colours) instead of being split by them, and through
//     EditorView.bidiIsolatedRanges, so CodeMirror's cursor motion treats each
//     formula as one LTR isolate. This is how @codemirror/language's own
//     bidiIsolates() extension does it.
//   • The editor (.cm-editor) gets dir + class math-dir-rtl / math-dir-ltr and
//     math-dir-cur-ltr / math-dir-cur-rtl via EditorView.editorAttributes.

const LINE = {
  rtl: Decoration.line({ attributes: { dir: 'rtl' }, class: 'math-dir-line-rtl' }),
  ltr: Decoration.line({ attributes: { dir: 'ltr' }, class: 'math-dir-line-ltr' }),
};
const MATH = Decoration.mark({
  class: 'math-dir-iso',
  attributes: { dir: 'ltr' },
  bidiIsolate: Direction.LTR,
});

// 1-based line number of the frontmatter's closing '---', or 0.
function frontmatterEndLine(doc) {
  return frontmatterEndAt(doc.lines, (i) => doc.line(i + 1).text) + 1;
}

class MathDirView {
  constructor(view) {
    this.dir = docDirection(view.state.doc.toString());
    this.tree = syntaxTree(view.state);
    this.epoch = featureEpoch;
    this.build(view);
    this.cursorDir = this.dirAt(view.state, view.state.selection.main.head);
  }

  update(u) {
    if (u.docChanged) this.dir = docDirection(u.state.doc.toString());
    const tree = syntaxTree(u.state);
    if (u.docChanged || u.viewportChanged || tree !== this.tree || this.epoch !== featureEpoch) {
      this.tree = tree;
      if (u.view.compositionStarted && this.epoch === featureEpoch) {
        // Don't redraw around an IME composition; just keep positions in step.
        this.deco = this.deco.map(u.changes);
        this.marks = this.marks.map(u.changes);
      } else {
        this.epoch = featureEpoch;
        this.build(u.view);
      }
    }
    this.cursorDir = this.dirAt(u.state, u.state.selection.main.head);
  }

  // Direction of the text at `pos` (the character under Vim's block cursor).
  // Vim Motions draws that character again in its own cursor layer (inside
  // .cm-editor), which would otherwise inherit the note's direction and mirror
  // < > ( ) [ ] { } inside math.
  dirAt(state, pos) {
    if (this.dir === 'ltr') return 'ltr';
    let inMath = false;
    this.marks.between(pos, pos + 1, (from, to) => {
      if (from <= pos && pos < to) { inMath = true; return false; }
    });
    if (inMath) return 'ltr';
    const lineFrom = state.doc.lineAt(pos).from;
    let dir = this.dir;
    this.deco.between(lineFrom, lineFrom, (from, to, value) => {
      if (value === LINE.ltr) dir = 'ltr';
      else if (value === LINE.rtl) dir = 'rtl';
    });
    return dir;
  }

  build(view) {
    const doc = view.state.doc;
    const visible = view.visibleRanges;
    if (!visible.length) {
      this.deco = this.marks = Decoration.none;
      return;
    }
    const R = regionsFor(doc, this.tree, visible[visible.length - 1].to);
    const math = R.math;
    const code = R.code;

    const fmLine = frontmatterEndLine(doc);
    const deco = [];
    const marks = [];
    let mi = 0;
    for (const { from, to } of visible) {
      for (let pos = from; pos <= to; ) {
        const line = doc.lineAt(pos);
        let dir = this.dir;
        if (line.number <= fmLine || code.has(line.number)) {
          dir = 'ltr';
        } else {
          while (mi < math.length && math[mi].to < line.from) mi++;
          const parts = [];
          let outside = '';
          let last = line.from;
          for (let k = mi; k < math.length && math[k].from <= line.to; k++) {
            const a = Math.max(math[k].from, line.from);
            const b = Math.min(math[k].to, line.to);
            parts.push([a, b]);
            if (a > last) outside += doc.sliceString(last, a);
            last = Math.max(last, b);
          }
          if (parts.length) {
            if (last < line.to) outside += doc.sliceString(last, line.to);
            if (!outside.trim()) {
              dir = 'ltr'; // a display-math line (or a line that is only math)
            } else {
              for (const [a, b] of parts) if (b > a) marks.push(MATH.range(a, b));
            }
          }
        }
        deco.push(LINE[dir].range(line.from));
        pos = line.to + 1;
      }
    }
    this.marks = Decoration.set(marks, true);
    this.deco = Decoration.set(deco.concat(marks), true);
  }
}

const mathDirPlugin = ViewPlugin.fromClass(MathDirView, {
  provide: (plugin) => [
    EditorView.outerDecorations.of((view) => view.plugin(plugin)?.deco ?? Decoration.none),
    EditorView.bidiIsolatedRanges.of((view) => view.plugin(plugin)?.marks ?? Decoration.none),
    EditorView.editorAttributes.of((view) => {
      const p = view.plugin(plugin);
      if (!p) return null;
      const cls = 'math-dir-' + p.dir + (on('cursorClass') ? ' math-dir-cur-' + p.cursorDir : '');
      return { dir: p.dir, class: cls };
    }),
  ],
});

// ===========================================================================
// 5. Hebrew layer: key map and DOM helpers
// ===========================================================================

// Standard Hebrew layout (SI-1452), unshifted: English key → Hebrew character.
const EN2HE = {
  q: '/', w: "'", e: 'ק', r: 'ר', t: 'א', y: 'ט', u: 'ו', i: 'ן', o: 'ם', p: 'פ',
  a: 'ש', s: 'ד', d: 'ג', f: 'כ', g: 'ע', h: 'י', j: 'ח', k: 'ל', l: 'ך', ';': 'ף', "'": ',',
  z: 'ז', x: 'ס', c: 'ב', v: 'ה', b: 'נ', n: 'מ', m: 'צ', ',': 'ת', '.': 'ץ', '/': '.',
  // Bracket pairs are mirrored, as on the Windows Hebrew layout (outside math):
  '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{',
};
const translate = (text) => [...text].map((ch) => EN2HE[ch] || ch).join('');
const hasMapped = (text) => [...text].some((ch) => EN2HE[ch]);

// What each physical key (e.code) types on a US-English layout, without Shift.
// Used by every Hebrew-OS-layout fallback: the ":" prompts (onKeyDown), jump
// labels (labelKey), and normal / visual mode keys in the note (HE_OS / usKey).
const US = {
  KeyQ: 'q', KeyW: 'w', KeyE: 'e', KeyR: 'r', KeyT: 't', KeyY: 'y', KeyU: 'u',
  KeyI: 'i', KeyO: 'o', KeyP: 'p', KeyA: 'a', KeyS: 's', KeyD: 'd', KeyF: 'f',
  KeyG: 'g', KeyH: 'h', KeyJ: 'j', KeyK: 'k', KeyL: 'l', KeyZ: 'z', KeyX: 'x',
  KeyC: 'c', KeyV: 'v', KeyB: 'b', KeyN: 'n', KeyM: 'm',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  BracketLeft: '[', BracketRight: ']', Backquote: '`',
};

// The US key a normal / visual-mode key stands for when the OS layout is
// Hebrew, or null. Vim Motions turns a non-ASCII key into the last letter of
// e.code (Period → "d", Comma → "a", Semicolon → "n"), and ASCII keys pass as
// they are ("/" sends ".", q sends "/", w sends "'", ' sends ",", ` sends ";",
// [ and ] are swapped). Only when e.key is exactly what the Hebrew layout types
// on that key (HE_OS), so other layouts are never touched. Unshifted keys only:
// what the Hebrew layout gives with Shift isn't in this table, so shifted keys
// pass unchanged (Shift+letter is a Latin capital there anyway).
const HE_OS = {};
for (const code of Object.keys(US)) {
  const he = code === 'Backquote' ? ';' : EN2HE[US[code]];
  if (he) HE_OS[code] = he;
}
function usKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return null;
  return HE_OS[e.code] && e.key === HE_OS[e.code] ? US[e.code] : null;
}

// Cross-window safe: popouts have their own HTMLElement globals.
const isElement = (x) => !!x && x.nodeType === 1;
const isTextInput = (el) =>
  el.tagName === 'TEXTAREA' ||
  (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'search' || el.type === ''));

// Never follow the layer here, even if a selector below would match.
const BLOCKED = '.modal.mod-settings, .vertical-tab-content, .cm-content';

// Text fields that follow the layer (checked against Obsidian 1.15 app.js), plus
// the Vim prompt and Vim Motions fields from the adapter (VIM_TEXT_FIELDS).
const TEXT_FIELDS = [
  'input.prompt-input',                            // quick switcher, command palette, other suggest modals
  '.workspace-leaf .search-input-container input', // search pane, in-note search (Settings search is a modal, not a leaf)
].join(', ');

// Contenteditable note titles: inline title, tab-header title, file-explorer rename.
const TITLE_FIELDS = [
  '.inline-title',
  '.view-header-title',
  '.nav-file-title-content',
  '.nav-folder-title-content',
].join(', ');

function followsLayer(el) {
  if (el.closest(BLOCKED)) return false;
  if (isTextInput(el)) return (el.matches(TEXT_FIELDS) || el.matches(VIM_TEXT_FIELDS)) && !isExPrompt(el);
  return el.isContentEditable && !!el.closest(TITLE_FIELDS);
}

// Fallback insertion when execCommand refuses (it keeps undo, so it goes first).
function insertTextDirect(el, text) {
  const doc = el.ownerDocument;
  if (isTextInput(el)) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.setRangeText(text, start, end, 'end');
  } else {
    const sel = doc.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = doc.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  const InputEventCtor = (doc.defaultView && doc.defaultView.InputEvent) || InputEvent;
  el.dispatchEvent(new InputEventCtor('input', { bubbles: true, inputType: 'insertText', data: text }));
}

// ===========================================================================
// 6. Visual order and the visual h / l step (public CodeMirror API)
// ===========================================================================
//
// The order comes from CodeMirror itself: view.bidiSpans(line) gives each
// character's bidi level for that line, with this plugin's isolates and
// per-line direction, i.e. what is drawn. Reordering those levels (Unicode bidi
// rule L2) gives the characters from left to right. The adapter (section 8)
// turns visualStep into Vim motions.

// Line-relative offsets of the characters of `line` (a CodeMirror Line), in
// visual order from left to right.
function visualOrder(view, line) {
  const text = line.text;
  if (!text.length) return [];
  const level = new Array(text.length).fill(0);
  for (const s of view.bidiSpans(line)) {
    for (let i = s.from; i < s.to && i < text.length; i++) level[i] = s.level;
  }
  const seq = [];
  let max = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (i > 0 && c >= 0xDC00 && c <= 0xDFFF) continue; // second half of a pair
    seq.push(i);
    if (level[i] > max) max = level[i];
  }
  for (let lvl = max; lvl >= 1; lvl--) {
    for (let x = 0; x < seq.length; ) {
      if (level[seq[x]] < lvl) { x++; continue; }
      let y = x;
      while (y + 1 < seq.length && level[seq[y + 1]] >= lvl) y++;
      for (let a = x, b = y; a < b; a++, b--) [seq[a], seq[b]] = [seq[b], seq[a]];
      x = y + 1;
    }
  }
  return seq;
}

function charEnd(text, i) {
  const c = text.charCodeAt(i);
  return c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length ? i + 2 : i + 1;
}

// n steps to the visual left / right from character `ch` of line `lineNo`
// (1-based). Returns:
//   • undefined: can't tell (no bidiSpans, empty line, a surrogate half); the
//     caller falls back to a logical step;
//   • { ch }: moving (normal / visual mode): the character n steps away in
//     visual order, stopping at the line's visual edge;
//   • { from, to } (exclusive): after an operator, Vim's own shapes,
//     mirrored: dl / 3dl take the cursor character and the next n-1 to its
//     visual right; dh / 3dh the n characters to its visual left. In LTR text
//     that is exactly stock dl/dh. Across a direction boundary the picked
//     characters can be logically apart; the range then covers everything
//     between them;
//   • null: nothing (dh at the visual left edge).
function visualStep(view, lineNo, ch0, n, left, operator) {
  if (!view || typeof view.bidiSpans !== 'function') return undefined;
  const line = view.state.doc.line(lineNo);
  const seq = visualOrder(view, line);
  if (!seq.length) return undefined;
  const ch = Math.min(ch0, line.length - 1);
  const p = seq.indexOf(ch);
  if (p < 0) return undefined;
  if (!operator) {
    let q = left ? p - n : p + n;
    if (q < 0) q = 0;
    if (q > seq.length - 1) q = seq.length - 1;
    return { ch: seq[q] };
  }
  const picked = left
    ? seq.slice(Math.max(0, p - n), p)
    : seq.slice(p, Math.min(seq.length, p + n));
  if (!picked.length) return null;
  let from = Infinity;
  let last = -1;
  for (const i of picked) { if (i < from) from = i; if (i > last) last = i; }
  return { from, to: charEnd(line.text, last) };
}

// ===========================================================================
// 7. Reading view
// ===========================================================================

function setSectionDir(el, dir) {
  el.classList.toggle('math-dir-rtl', dir === 'rtl');
  el.classList.toggle('math-dir-ltr', dir === 'ltr');
  el.setAttribute('dir', dir);
}

// ===========================================================================
// 8. ADAPTER — every private or undocumented dependency, and the probes
// ===========================================================================
//
// ---- BEGIN ADAPTER ----
//
// Nothing outside this section touches Vim Motions' globals or editor fields,
// codemirror-vim's state, Vim Motions' or codemirror-vim's DOM classes, or
// Obsidian's syntax-node names. Facts below were checked against Vim Motions
// 1.5.1 (main.js) and Obsidian 1.15 (app.js). Re-check this section after an
// update; the probes say what changed.
//
// Interface used by the rest of the file:
//   Vim:     vimApi(), viewForTarget(el), canFeedKeys(), feedKey(view, key), vimCommandMode(view),
//            awaitingChar(view), vimKeyReaderActive(), defineVimMotions(V, visual),
//            vimCommandsPresent(V), mapVimCommands(V), VIM_LOAD_EVENT
//   DOM:     isVimPanelInput(el), isExPrompt(el), VIM_TEXT_FIELDS,
//            labelsVisible(doc), labelKey(e, doc), relabel(e, key)
//   Syntax:  tokenRegions(doc, tree, limit)
//   Probes:  activeEditorView(app), editorViews(app), editorWithVim(app), vimMotionsVersion(app),
//            probeAll(view), TESTED_VIM_MOTIONS

const TESTED_VIM_MOTIONS = ['1.5.1'];
const VIM_MOTIONS_ID = 'vim-motions';
// Vim Motions triggers this workspace event at the end of its onload, after it
// has installed window.CodeMirrorAdapter.Vim (main.js: Yw() early in onload,
// then this.app.workspace.trigger("vim-motions:picker-ready")). It is its only
// load signal; there is none for unload or for a Lua config reload.
const VIM_LOAD_EVENT = 'vim-motions:picker-ready';

// --- Vim API -----------------------------------------------------------------
//
// Vim Motions exposes its codemirror-vim fork as window.CodeMirrorAdapter.Vim, a
// configurable getter (Object.defineProperty(e.CodeMirrorAdapter,"Vim",{get(){return
// ei}})), deleted when it unloads; a new object after it reloads. Read fresh
// on every use.

function vimApi() {
  try {
    const a = window.CodeMirrorAdapter;
    const V = a && a.Vim;
    return V && typeof V === 'object' ? V : null;
  } catch (err) {
    return null;
  }
}

// The note's EditorView, when `target` is inside the note text and Vim Motions
// is attached to it (it sets view.cm, its CM5-style adapter).
function viewForTarget(target) {
  const content = target.closest('.cm-content');
  if (!content) return null;
  const view = EditorView.findFromDOM(content);
  return view && view.cm ? view : null;
}

// Feed one key to Vim the way Vim Motions' own key handler does, including the
// "vim-keypress" signal its which-key popup and yank ring listen to.
// multiSelectHandleKey (a fork export) like the fork's handler, so visual block
// and multiple cursors behave as if the key had been typed; handleKey if it's
// missing. (Unlike the fork's handler, the showcmd status isn't updated.)
function canFeedKeys() {
  const V = vimApi();
  return !!V && (typeof V.multiSelectHandleKey === 'function' || typeof V.handleKey === 'function');
}

function feedKey(view, key) {
  const V = vimApi();
  const cm = view && view.cm;
  if (!V || !cm || !canFeedKeys()) return false;
  const handled = typeof V.multiSelectHandleKey === 'function'
    ? V.multiSelectHandleKey(cm, key, 'user')
    : V.handleKey(cm, key, 'user');
  const signal = cm.constructor && cm.constructor.signal;
  if (handled && typeof signal === 'function') {
    try { signal(cm, 'vim-keypress', key); } catch (err) { console.error('math-dir: signal failed', err); }
  }
  return true;
}

function vimState(view) {
  const cm = view && view.cm;
  return (cm && cm.state && cm.state.vim) || null;
}

// Is Vim in normal / visual / operator-pending mode in this editor?
function vimCommandMode(view) {
  const vim = vimState(view);
  return !!vim && !vim.insertMode;
}

// Is Vim waiting for the character argument of f / F / t / T / r (with a count)?
// codemirror-vim keeps the pending keys in vim.inputState.keyBuffer (an array
// in the fork; a string in older upstream versions).
function awaitingChar(view) {
  const vim = vimState(view);
  if (!vim || vim.insertMode) return false;
  const buf = vim.inputState && vim.inputState.keyBuffer;
  const keys = Array.isArray(buf) ? buf.join('') : (buf || '');
  return /^\d*[fFtTr]$/.test(keys);
}

// Is one of Vim Motions' own key readers (flash search, easymotion, hint mode;
// kl() in its main.js) collecting keys? They set a flag (ln(true)) that Vim
// Motions exposes only through its debug hook
// CodeMirrorAdapter.getTableDebugState().fork.keyInterceptActive. Those keys
// (a flash-search pattern, say) must reach it as typed, so Hebrew can be
// searched with the OS layout. Unknown (hook missing) counts as "no".
function vimKeyReaderActive() {
  try {
    const f = window.CodeMirrorAdapter && window.CodeMirrorAdapter.getTableDebugState;
    const s = typeof f === 'function' ? f() : null;
    return !!(s && s.fork && s.fork.keyInterceptActive);
  } catch (err) {
    return false;
  }
}

// --- Visual h / l as Vim motions --------------------------------------------
//
// From Vim Motions' main.js:
//   • defineMotion(name, fn) stores fn (function Fa(d,h){Tt[d]=h}); evalInput
//     calls it as fn(cm, head, motionArgs, vim, inputState) and treats an
//     array result as [anchor, head], a falsy one as "nothing". For an
//     operator the range is exclusive unless motionArgs.inclusive is set
//     (Oe=!E.inclusive||he). motionArgs is a fresh copy per command (xg), so
//     setting it here is safe. `head` is a Pos; head.constructor builds more.
//   • cm.cm6 is the adapter's back-pointer to its EditorView.
//   • mapCommand(keys, type, name, args, extra) builds {keys, type, [type]:
//     name, [type+'Args']: args, ...extra} and unshifts it into the keymap
//     (function Mg(d){…r.unshift(d)…}). The matcher takes the first full match
//     (x=E.full[0]), so these win over the defaults, which stay in place. A
//     command without a context matches in normal, visual and operator-
//     pending mode.
//   • <Left> / <Right> must be mapped too: the defaults are keyToKey maps to
//     h / l, but a keyToKey without noremap:false is fed in noremap mode
//     (function Be: Et=_.noremap!=!1), and then the matcher only searches the
//     built-in defaults (XT: C=Et&&…?h.length-l:0), i.e. stock logical h / l.
//   • Never call removeMapCommand('h') etc.: it removes every non-keyToKey
//     entry with those keys, Vim's defaults included.
//   • getKeymap(ctx) returns copies with keys, type, context and motion.
//     resetKeymap() (Vim Motions' Lua reload) keeps non-default entries, ours
//     included; mapclear() drops them.

const MOTION_LEFT = 'mathDirVisualLeft';
const MOTION_RIGHT = 'mathDirVisualRight';

// Stock h / l: logical steps (Vim clips the result to the line).
function logicalVimMotion(left) {
  return (cm, head, motionArgs) => {
    const n = Math.max(1, motionArgs.repeat || 1);
    return new head.constructor(head.line, left ? head.ch - n : head.ch + n);
  };
}

function visualVimMotion(left) {
  const fallback = logicalVimMotion(left);
  return (cm, head, motionArgs, vim, inputState) => {
    const n = Math.max(1, motionArgs.repeat || 1);
    const operator = !!(inputState && inputState.operator) && !(vim && vim.visualMode);
    const r = visualStep(cm && cm.cm6, head.line + 1, head.ch, n, left, operator);
    if (r === undefined) return fallback(cm, head, motionArgs);
    if (r === null) return null;
    const Pos = head.constructor;
    if ('ch' in r) return new Pos(head.line, r.ch);
    motionArgs.inclusive = false;
    return [new Pos(head.line, r.from), new Pos(head.line, r.to)];
  };
}

const VIM_COMMANDS = [
  ['h', 'motion', MOTION_LEFT, { forward: false, foldopen: 'hor' }],
  ['l', 'motion', MOTION_RIGHT, { forward: true, foldopen: 'hor' }],
  ['<Left>', 'motion', MOTION_LEFT, { forward: false, foldopen: 'hor' }],
  ['<Right>', 'motion', MOTION_RIGHT, { forward: true, foldopen: 'hor' }],
  // Same as the defaults (operatorMotion delete + moveByCharacters), with the
  // visual motions; normal mode only, so visual-mode x / X stay stock.
  ['x', 'operatorMotion', undefined, { visualLine: false },
    { operator: 'delete', motion: MOTION_RIGHT, motionArgs: { forward: true }, context: 'normal' }],
  ['X', 'operatorMotion', undefined, { visualLine: true },
    { operator: 'delete', motion: MOTION_LEFT, motionArgs: { forward: false }, context: 'normal' }],
];

// visual = false defines the same names as stock logical h / l (setting off, a
// failed probe, and on unload: the commands can't be removed safely).
function defineVimMotions(V, visual) {
  V.defineMotion(MOTION_LEFT, visual ? visualVimMotion(true) : logicalVimMotion(true));
  V.defineMotion(MOTION_RIGHT, visual ? visualVimMotion(false) : logicalVimMotion(false));
}

function mapVimCommands(V) {
  for (const [keys, type, name, args, extra] of VIM_COMMANDS) V.mapCommand(keys, type, name, args, extra);
}

// Are all our commands still in the keymap? (Only re-add missing ones, so a
// user map placed in front of them wins instead of starting a re-add loop,
// and toggling this plugin doesn't stack duplicates.) Copies the whole keymap:
// called on a Vim (re)load and by the 10 s safety net only.
function vimCommandsPresent(V) {
  const km = V.getKeymap('normal');
  return VIM_COMMANDS.every(([keys, , name, , extra]) => {
    const motion = extra ? extra.motion : name;
    return km.some((e) => e.keys === keys && e.motion === motion);
  });
}

// --- Vim / Vim Motions DOM ---------------------------------------------------

// codemirror-vim's prompt panel (/ ? :). It builds the ":" prompt as
//   div.cm-vim-panel > div > span(":" , input) [, span(desc)]
// so the input's parent text (which excludes the input's value) starts with ":".
const VIM_PANEL = '.cm-vim-panel';
const isVimPanelInput = (el) => el.tagName === 'INPUT' && !!el.closest(VIM_PANEL);

// Vim Motions' own Ex modal: outside the editor (file explorer and other views)
// its ":" opens a SuggestModal (jq in its main.js) with the placeholder
// "Ex command" on its input.prompt-input. Its modalEl has the class
// .vim-motions-prompt-modal-container, but so do the picker, outline, actions
// and search-results modals (which follow the layer), so the check is exact.
const EX_MODAL = '.vim-motions-prompt-modal-container';
function isExPrompt(el) {
  if (el.tagName !== 'INPUT') return false;
  if (el.placeholder === 'Ex command' && el.closest(EX_MODAL)) return true;
  if (!el.closest(VIM_PANEL)) return false;
  const label = ((el.parentElement && el.parentElement.textContent) || '').trimStart();
  return label.startsWith(':');
}

// Fields of Vim and Vim Motions that follow the layer. (The ":" prompts are
// excluded by isExPrompt. Vim Motions' prompt and outline modals use
// input.prompt-input, which TEXT_FIELDS already lists; the class
// vim-motions-prompt-modal-input is on a container div, not an input.)
const VIM_TEXT_FIELDS = [
  VIM_PANEL + ' input',               // Vim / and ? prompts
  'input.vim-motions-picker-input',
  'input.vim-motions-input-modal-input',
].join(', ');

// Vim Motions' jump labels: flash (f/F/t/T with several matches), easymotion,
// flash search and hint mode. All of them read the label key through one helper
// (kl in its main.js): a keydown listener on activeDocument, capture phase, that
// reads e.key (no isTrusted check). On the Windows Hebrew layout e.key is a
// Hebrew letter, so no label matches.
const LABELS = '.vim-motions-easymotion-label, .vim-motions-hint-label';
const labelsVisible = (doc) => !!doc.querySelector(LABELS);

// The Latin key a label key stands for, or null when this key isn't one: labels
// are on screen, the key types a non-Latin character, its physical key is a
// Latin one, and that letter is in some visible label (so a key that is meant
// as more of a flash-search pattern is left alone). The first-match query
// gates the full one, so with no labels up it costs one selector match.
function labelKey(e, doc) {
  const en = US[e.code];
  if (!en || e.key === en || e.key.length !== 1) return null;
  if (!labelsVisible(doc)) return null;
  for (const el of doc.querySelectorAll(LABELS)) if ((el.textContent || '').includes(en)) return en;
  return null;
}

// Relabel a trusted keydown: an own `key` property shadows
// KeyboardEvent.prototype.key, so every later listener (Vim Motions' editor
// handler, its prompt handlers, its label reader kl()) sees `key`, nothing is
// re-dispatched and isTrusted stays true. Works because those listeners run
// after our window-capture listener and read e.key from the same event.
// Returns false if that failed.
function relabel(e, key) {
  try {
    Object.defineProperty(e, 'key', { value: key, configurable: true });
    return e.key === key;
  } catch (err) {
    console.error('math-dir: could not relabel the key', err);
    return false;
  }
}

// --- Obsidian's Markdown tokenizer (syntax-node names) ---------------------
//
// Obsidian's Markdown parser (HyperMD as a CodeMirror StreamLanguage) gives a
// flat list of tokens under `Document`, named after their classes joined with
// "_", e.g.
//   $ / $$ open:  formatting_formatting-math_formatting-math-begin_keyword_math[_math-block]
//   math content: math_…            close: formatting_formatting-math_formatting-math-end_…
//   fenced code:  …_hmd-codeblock   indented code: …_hmd-indented-code
// Line classes (line-HyperMD-math, line-HyperMD-codeblock …) are emitted as one
// extra node per line, named after those classes (e.g. `HyperMD-math`), that
// wraps the line's tokens. The closing `$$` line carries `HyperMD-math` too, so
// these wrappers are never read as math or code.
const isLineNode = (node) => node.type.name.split('_').every((p) => p.startsWith('HyperMD-'));

// Math ranges and code lines from the tree, up to `limit`. The begin / end
// delimiter tokens are read as pairs, so a region is exact from its opening $
// to its closing $; a $$ still open at `limit` runs to `limit`.
// Returns { math: [{from,to,open}], codeKind: Map(line number → 'fence' | 'indent') }.
function tokenRegions(doc, tree, limit) {
  const math = [];
  const codeKind = new Map();
  let open = -1;
  tree.iterate({
    from: 0,
    to: limit,
    enter: (node) => {
      if (!node.type.name || isLineNode(node)) return; // Document, wrappers: look inside
      const name = node.type.name;
      if (name.includes('formatting-math-begin')) {
        if (open < 0) open = node.from;
      } else if (name.includes('formatting-math-end')) {
        if (open >= 0) math.push({ from: open, to: node.to, open: false });
        open = -1;
      } else if (name.includes('hmd-codeblock') || name.includes('hmd-indented-code')) {
        const n = doc.lineAt(node.from).number;
        if (!codeKind.has(n)) codeKind.set(n, name.includes('hmd-indented-code') ? 'indent' : 'fence');
      }
    },
  });
  if (open >= 0) math.push({ from: open, to: limit, open: true });
  return { math, codeKind };
}

// --- Probes ------------------------------------------------------------------

// The open editors' EditorViews. MarkdownView.editor.cm is Obsidian's (private)
// handle on the CodeMirror 6 view.
function editorViews(app) {
  const out = [];
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    const v = leaf.view && leaf.view.editor && leaf.view.editor.cm;
    if (v && v.state && v.dom) out.push(v);
  }
  return out;
}

// The editor to probe: the active one if Vim Motions is on it, else any that
// has Vim Motions, else the active one or any.
// Is some open editor one Vim Motions is attached to? (No keymap copy.)
function editorWithVim(app) {
  const v = activeEditorView(app);
  return !!(v && v.cm);
}

function activeEditorView(app) {
  const ed = app.workspace.activeEditor && app.workspace.activeEditor.editor;
  const active = ed && ed.cm && ed.cm.state && ed.cm.dom ? ed.cm : null;
  if (active && active.cm) return active;
  const views = editorViews(app);
  return views.find((x) => x.cm) || active || views[0] || null;
}

// Vim Motions' version from its manifest (public vault adapter), or null.
async function vimMotionsVersion(app) {
  try {
    const path = app.vault.configDir + '/plugins/' + VIM_MOTIONS_ID + '/manifest.json';
    if (!(await app.vault.adapter.exists(path))) return null;
    const m = JSON.parse(await app.vault.adapter.read(path));
    return typeof m.version === 'string' ? m.version : null;
  } catch (err) {
    return null;
  }
}

// Tokenizer self-test: parse a known string with the editor's own language in a
// throwaway state (public API: the `language` facet, Language.extension,
// ensureSyntaxTree), then check that tokenRegions finds what the text says.
// ok: true = names as expected; false = the tokenizer parsed it but the names
// don't match (an Obsidian parser change: use the text parser); null = can't
// tell (no language, or the throwaway parse produced nothing).
const PROBE_DOC = 'a $x$ b\n\n$$\ny\n$$\n\n```\nz\n```\n\n    w\n';
const tokenProbeCache = new WeakMap();
function probeTokens(view) {
  const lang = view && view.state.facet(language);
  if (!lang) return { ok: null, indent: null, detail: 'no language on the editor' };
  const hit = tokenProbeCache.get(lang);
  if (hit) return hit;
  let res;
  try {
    const state = EditorState.create({ doc: PROBE_DOC, extensions: lang.extension });
    const d = state.doc;
    const tree = ensureSyntaxTree(state, d.length, 200);
    let named = 0;
    if (tree) tree.iterate({ enter: (n) => { if (n.type.name && n.type.name !== 'Document' && !n.type.isTop) named++; } });
    if (!tree || tree.length < d.length || !named) {
      res = { ok: null, indent: null, detail: 'the throwaway parse produced no tokens' };
    } else {
      const { math, codeKind } = tokenRegions(d, tree, d.length);
      const ok = math.length === 2 &&
        math[0].from === 2 && math[0].to === 5 &&
        math[1].from === d.line(3).from && math[1].to === d.line(5).to &&
        codeKind.get(8) === 'fence';
      res = {
        ok,
        indent: codeKind.get(11) === 'indent', // line 11: '    w'
        detail: ok ? 'math and fence tokens as expected'
          : 'unexpected tokens: ' + JSON.stringify({ math, code: [...codeKind] }),
      };
    }
  } catch (err) {
    res = { ok: null, indent: null, detail: 'probe failed: ' + (err && err.message) };
  }
  tokenProbeCache.set(lang, res);
  return res;
}

const VIM_METHODS = ['handleKey', 'defineMotion', 'mapCommand', 'getKeymap'];

// All probes. `view`: an editor to probe (may be null). Cheap: no keymap copy
// beyond one getKeymap call, a 40-character throwaway parse (cached per
// language), and a few property reads.
function probeAll(view) {
  const V = vimApi();
  const cm = view && view.cm;
  const r = {
    vimLoaded: !!V,
    methods: {},
    multiSelect: null,
    keymapShape: null,
    editor: !!view,
    vimOnEditor: !!cm,
    keyBuffer: null,
    backPointer: null,
    cursorLayer: null,
    keyReaderHook: null,
    tokens: probeTokens(view),
  };
  if (V) {
    for (const m of VIM_METHODS) r.methods[m] = typeof V[m] === 'function';
    r.multiSelect = typeof V.multiSelectHandleKey === 'function';
    if (r.methods.getKeymap) {
      try {
        const km = V.getKeymap('normal');
        r.keymapShape = Array.isArray(km) && km.some((e) => e && e.keys === 'j' && typeof e.motion === 'string');
      } catch (err) {
        r.keymapShape = false;
      }
    }
    try { r.keyReaderHook = typeof window.CodeMirrorAdapter.getTableDebugState === 'function'; } catch (err) { r.keyReaderHook = false; }
  }
  if (V && cm) {
    const vim = cm.state && cm.state.vim;
    const buf = vim && vim.inputState && vim.inputState.keyBuffer;
    r.keyBuffer = !!vim && (Array.isArray(buf) || typeof buf === 'string');
    r.backPointer = cm.cm6 === view;
    r.cursorLayer = !!view.scrollDOM.querySelector('.cm-vimCursorLayer');
  }
  return r;
}

// ---- END ADAPTER ----

// ===========================================================================
// 9. Features from probes (public API only; reads the probe result)
// ===========================================================================

// What each feature needs. A probe that couldn't run (null) counts as passed.
function featuresFrom(r) {
  const yes = (x) => x !== false;
  const m = r.methods || {};
  const vim = (ok) => (r.vimLoaded ? !!ok : null); // nothing to decide without Vim Motions
  const motions = !!(m.defineMotion && m.mapCommand);
  const feed = !!(m.handleKey || r.multiSelect); // feedKey uses either
  return {
    motions: vim(motions),
    visualMotions: vim(motions && yes(r.backPointer)),
    charArgs: vim(feed && yes(r.keyBuffer)),
    usKeys: vim(yes(r.keyBuffer)),
    escape: vim(feed),
    keymapCheck: vim(m.getKeymap && yes(r.keymapShape)),
    tokens: r.tokens && typeof r.tokens.ok === 'boolean' ? r.tokens.ok : null,
    cursorClass: r.vimOnEditor ? yes(r.cursorLayer) : null,
  };
}

// What the user loses when a feature is off.
const OFF_TEXT = {
  motions: 'visual h/l (Vim Motions has no defineMotion / mapCommand)',
  visualMotions: 'visual h/l (stock logical h/l instead)',
  charArgs: 'Hebrew f/t/r characters (English instead)',
  usKeys: 'US keys in normal mode on a Hebrew OS layout',
  escape: 'Ctrl+[ as Escape in the note on a Hebrew OS layout',
  keymapCheck: 'keymap check (motions mapped once per Vim Motions load)',
  tokens: 'math/code from Obsidian\'s parser (the text parser is used instead)',
  cursorClass: 'block-cursor direction fix',
};

// ===========================================================================
// 10. Plugin
// ===========================================================================

class HebrewMathSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.hebrewToggle = null;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();
    new Setting(containerEl)
      .setName('Hebrew typing')
      .setDesc('Typed letters become Hebrew outside math and code, with the system keyboard left on English. ' +
        'Same as the EN / עב status-bar button and the "Toggle Hebrew typing" command.')
      .addToggle((t) => {
        this.hebrewToggle = t;
        t.setValue(p.settings.hebrew).onChange((v) => {
          if (v !== p.settings.hebrew) p.setHebrew(v);
        });
      });
    new Setting(containerEl)
      .setName('Layout warning')
      .setDesc('Show a notice (at most every 5 s) when the system keyboard is on Hebrew: a Hebrew letter arrives ' +
        'in the note or a field that follows the layer, or a Hebrew-layout key reaches Vim in normal / visual mode.')
      .addToggle((t) => t.setValue(p.settings.layoutWarning).onChange(async (v) => {
        p.settings.layoutWarning = v;
        await p.saveSettings();
      }));
    new Setting(containerEl)
      .setName('Visual h / l')
      .setDesc('Vim Motions: h, l, <Left>, <Right>, x and X move by what you see, not by character order, ' +
        'in Hebrew and across formulas. Off: stock logical motions.')
      .addToggle((t) => t.setValue(p.settings.visualMotions).onChange(async (v) => {
        p.settings.visualMotions = v;
        await p.saveSettings();
        p.syncVim();
      }));
    new Setting(containerEl)
      .setName('Diagnostics')
      .setDesc('Re-runs the self-checks on Vim Motions and Obsidian\'s parser, prints a table to the Console ' +
        '(Ctrl+Shift+I) and shows a summary.')
      .addButton((b) => b.setButtonText('Run diagnostics').onClick(() => p.diagnostics()));
  }

  hide() {
    this.hebrewToggle = null;
    if (super.hide) super.hide();
  }
}

module.exports = class HebrewMathPlugin extends Plugin {
  async onload() {
    this.lastText = null;
    this.lastDir = 'ltr';
    this.inserting = false;
    this.vim = null;          // the Vim object our motions are defined on
    this.vimVisual = null;    // whether they are the visual or the logical ones
    this.mappedOn = null;     // Vim object mapped once (when the keymap can't be checked)
    this.probe = null;        // last probe result
    this.probePending = false;
    this.probeOverrides = {}; // for testing from the Console, see probeNow()
    this.vimVersion = undefined;
    this.notified = new Set();
    this.statusShown = null;
    this.windows = new Map(); // window → detach()
    for (const k of Object.keys(features)) features[k] = null;
    await this.loadSettings();

    // Shared helpers, for other plugins and the Console:
    // app.plugins.plugins['math-dir'].api
    this.api = {
      docDirection, scanLine, inlineClose, frontmatterEnd, visualOrder,
      regionsFor, textRegions, contextAt, inMathOrCode, translate, features,
    };

    // --- A. Direction ------------------------------------------------------
    this.registerEditorExtension(mathDirPlugin);
    // Runs after Obsidian's own post-processor, which sets dir="auto" on p, li,
    // headings and blockquotes.
    this.registerMarkdownPostProcessor((el, ctx) => this.postProcess(el, ctx), 100);

    // --- B. Hebrew layer ---------------------------------------------------
    // The status item is a button: click, or Enter / Space while focused (handled
    // in onKeyDown, ahead of other window-level key handlers).
    this.statusEl = this.addStatusBarItem();
    this.statusEl.style.cursor = 'pointer';
    this.statusEl.setAttr('role', 'button');
    this.statusEl.setAttr('tabindex', '0');
    this.registerDomEvent(this.statusEl, 'click', () => this.toggle());
    this.updateStatus();

    this.addCommand({
      id: 'toggle-hebrew-typing',
      name: 'Toggle Hebrew typing',
      hotkeys: [{ modifiers: [], key: 'F12' }],
      callback: () => this.toggle(),
    });

    // Hook 1: Hebrew layer for text typed into the note.
    // An input handler only sees real text insertion, so Vim commands in
    // normal/visual mode never reach it; only insert-mode typing does.
    // After translating, the Hebrew text is handed to the editor's *other* input
    // handlers (auto-pair brackets among them), exactly as if the OS had typed
    // it, so they behave the same as with the system Hebrew layout.
    const hebrewInput = (view, from, to, text) => {
      if (!this.settings.hebrew || view.composing || !text) return false;
      if (!hasMapped(text)) return false;
      if (inMathOrCode(view.state, from)) return false;
      const out = translate(text);
      // Same shape as CodeMirror's own default insert (applyDefaultInsert):
      // when the change is at the main selection, the text goes into *every*
      // range (as replaceSelection does), so visual-block insert (<C-v>jjI) and
      // multiple cursors get it on each line. With one cursor that is exactly
      // { changes: {from, to, insert}, selection: from + out.length }.
      // Built once and reused, like CM's (other handlers may call it too).
      let built = null;
      const defaultInsert = () => {
        if (built) return built;
        const state = view.state;
        const sel = state.selection.main;
        let spec;
        if (from >= sel.from && to <= sel.to && to - from >= (sel.to - sel.from) / 3) {
          const before = sel.from < from ? state.sliceDoc(sel.from, from) : '';
          const after = sel.to > to ? state.sliceDoc(to, sel.to) : '';
          // Each range gets the text for its own context: a cursor in math or
          // code (another line of a visual block, say) keeps the English key.
          spec = state.changeByRange((r) => {
            const ins = before + (r === sel || !inMathOrCode(state, r.from) ? out : text) + after;
            return { changes: { from: r.from, to: r.to, insert: ins }, range: EditorSelection.cursor(r.from + ins.length) };
          });
        } else {
          // A change away from the main selection (rare): one range, as before.
          spec = { changes: { from, to, insert: out }, selection: { anchor: from + out.length } };
        }
        built = state.update(spec, { userEvent: 'input.type', scrollIntoView: true });
        return built;
      };
      // The rest of the chain, as CodeMirror runs it (handlers.some(...)): the
      // first handler that returns true ends it. A handler that throws ends it
      // too, with nothing inserted (in CodeMirror the exception escapes the
      // .some() and the default insert never runs); it's reported through the
      // editor's exception sink like CodeMirror's own errors.
      for (const handler of view.state.facet(EditorView.inputHandler)) {
        if (handler === hebrewInput) continue;
        try {
          if (handler(view, from, to, out, defaultInsert)) return true;
        } catch (err) {
          if (typeof logException === 'function') logException(view.state, err, 'math-dir: input handler');
          else console.error('math-dir: input handler failed', err);
          return true;
        }
      }
      view.dispatch(defaultInsert());
      return true;
    };
    this.registerEditorExtension(Prec.highest(EditorView.inputHandler.of(hebrewInput)));

    // Hooks 2 and 3, on the main window and every popout:
    //   2. keydown, window capture: layout warning, Ctrl+[, ":" fallback, f/t/r,
    //      the status button. Vim Motions reads keys through CodeMirror
    //      eventObservers, which run before any domEventHandlers and can't be
    //      cancelled by them, so anything that must preempt Vim has to stop the
    //      event here, before it reaches the editor.
    //   3. beforeinput, document capture: Hebrew in the allowlisted text fields
    //      and contenteditable titles.
    // A popout's listeners are released when it closes; all of them on unload.
    this.onKeyDownBound = (e) => this.onKeyDown(e);
    this.onBeforeInputBound = (e) => this.onBeforeInput(e);
    this.attachWindow(window);
    // Same pattern as Vim Motions: the WorkspaceWindow's .win is the popout's window.
    this.registerEvent(this.app.workspace.on('window-open', (ws, win) => this.attachWindow(win || (ws && ws.win))));
    this.registerEvent(this.app.workspace.on('window-close', (ws, win) => this.detachWindow(win || (ws && ws.win))));

    this.settingTab = new HebrewMathSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // --- C. Vim Motions ----------------------------------------------------
    // Register the motions when Vim Motions loads (its load event), at layout
    // ready and on layout changes (a cheap "is it a new Vim object?" check).
    // A 10 s safety net also re-adds commands something dropped (a Lua
    // :mapclear, say). The probes run at layout ready and on each new Vim
    // object; probes that need an editor wait for one to open.
    this.registerEvent(this.app.workspace.on(VIM_LOAD_EVENT, () => this.syncVim()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.onLayoutChange()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.onLayoutChange()));
    this.app.workspace.onLayoutReady(() => {
      this.syncVim(); // probes on a new Vim object
      if (!this.probe) this.probeNow();
    });
    this.registerInterval(window.setInterval(() => this.syncVim(true), VIM_CHECK_MS));
  }

  onunload() {
    // The commands can't be removed safely (removeMapCommand would also drop
    // Vim's own h / l), so turn the motions back into stock logical h / l.
    const V = vimApi();
    if (V && V === this.vim && on('motions')) {
      try { defineVimMotions(V, false); } catch (e) { console.error('math-dir: could not reset the Vim motions', e); }
    }
    this.vim = null;
    this.vimVisual = null;
    for (const detach of this.windows.values()) detach();
    this.windows.clear();
  }

  attachWindow(win) {
    if (!win || this.windows.has(win)) return;
    const doc = win.document;
    win.addEventListener('keydown', this.onKeyDownBound, { capture: true });
    doc.addEventListener('beforeinput', this.onBeforeInputBound, { capture: true });
    this.windows.set(win, () => {
      win.removeEventListener('keydown', this.onKeyDownBound, { capture: true });
      doc.removeEventListener('beforeinput', this.onBeforeInputBound, { capture: true });
    });
  }

  detachWindow(win) {
    const detach = win && this.windows.get(win);
    if (!detach) return;
    detach();
    this.windows.delete(win);
  }

  // --- Settings ------------------------------------------------------------

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  saveSettings() {
    return this.saveData(this.settings);
  }

  // --- Vim Motions registration and probes -------------------------------------

  // Pending editor probes run once an editor with Vim Motions on it exists
  // (a cheap check; the probe itself copies the keymap).
  onLayoutChange() {
    if (this.probePending && editorWithVim(this.app)) this.probeNow();
    this.syncVim();
  }

  // full: also check that our commands are still in the keymap (the safety
  // net). A new Vim object always gets the full treatment, probes first.
  syncVim(full) {
    try {
      const V = vimApi();
      if (!V) {
        this.vim = null; // no Vim Motions: its own h / l (if any) apply
        this.vimVisual = null;
        return;
      }
      const isNew = V !== this.vim;
      if (isNew) {
        this.vim = V;
        this.vimVisual = null;
        this.mappedOn = null;
        this.needMap = true;
        for (const k of VIM_FEATURES) features[k] = null; // answers were for the old object
        this.checkVersion();
        this.probeNow(true);
      }
      if (!on('motions')) return;
      const visual = !!this.settings.visualMotions && on('visualMotions');
      if (visual !== this.vimVisual) {
        defineVimMotions(V, visual);
        this.vimVisual = visual;
      }
      // needMap: also after the motions come back from a failed probe.
      if (isNew || full || this.needMap) {
        this.needMap = false;
        if (on('keymapCheck')) {
          if (!vimCommandsPresent(V)) mapVimCommands(V);
        } else if (this.mappedOn !== V) {
          mapVimCommands(V);
          this.mappedOn = V;
        }
      }
    } catch (e) {
      console.error('math-dir: could not register the Vim motions', e);
    }
  }

  async checkVersion() {
    const v = await vimMotionsVersion(this.app);
    if (v !== this.vimVersion && v && !TESTED_VIM_MOTIONS.includes(v)) {
      console.info('math-dir: Vim Motions ' + v + ' is untested (tested: ' + TESTED_VIM_MOTIONS.join(', ') +
        '); the self-checks decide which features stay on.');
    }
    this.vimVersion = v;
    return v;
  }

  // Runs the probes and applies the result. this.probeOverrides (Console only)
  // replaces probe fields, e.g. { backPointer: false } or { tokens: { ok: false } }.
  // fromSync: called by syncVim, which applies the motion settings itself.
  probeNow(fromSync) {
    let r;
    try {
      r = Object.assign(probeAll(activeEditorView(this.app)), this.probeOverrides);
      if (this.probeOverrides.methods) r.methods = Object.assign({}, r.methods, this.probeOverrides.methods);
    } catch (e) {
      console.error('math-dir: self-check failed to run', e);
      return null;
    }
    this.probe = r;
    // Probes that need an editor with Vim Motions on it wait for one.
    this.probePending = r.vimLoaded ? !r.vimOnEditor : !r.editor;
    const f = featuresFrom(r);
    const before = Object.assign({}, features);
    // A probe that couldn't run this time (no editor, say) keeps the last
    // conclusive answer; syncVim clears the Vim ones for a new Vim object.
    for (const k of Object.keys(f)) if (f[k] !== null) features[k] = f[k];
    if (before.tokens !== features.tokens || before.cursorClass !== features.cursorClass) {
      featureEpoch++;
      for (const v of editorViews(this.app)) {
        try { v.dispatch({}); } catch (e) { /* rebuilt on its next update anyway */ }
      }
    }
    if (!fromSync && (before.motions !== features.motions || before.visualMotions !== features.visualMotions)) {
      this.syncVim();
    }
    // One notice when something new turns off (naming everything that's off);
    // features already reported don't bring it back.
    const off = Object.keys(OFF_TEXT).filter((k) => features[k] === false &&
      !(k === 'visualMotions' && features.motions === false));
    const fresh = off.filter((k) => !this.notified.has(k));
    if (fresh.length) {
      for (const k of fresh) this.notified.add(k);
      new Notice('Hebrew Vim + Math Direction: a self-check failed, so this is off: ' +
        off.map((k) => OFF_TEXT[k]).join('; ') + '. Details: Settings → Diagnostics.', 15000);
      console.warn('math-dir: self-check turned off: ' + off.join(', '), r);
    }
    return r;
  }

  // Settings → Diagnostics (also callable from the Console). Prints the probe
  // table and returns its rows.
  async diagnostics() {
    const version = await this.checkVersion();
    const r = this.probeNow() || this.probe || {};
    const show = (x) => x === true ? 'pass' : x === false ? 'FAIL' : 'n/a';
    const m = r.methods || {};
    const tok = r.tokens || {};
    const rows = [
      { check: 'Vim Motions version', result: version ? version + (TESTED_VIM_MOTIONS.includes(version) ? ' (tested)' : ' (untested)') : 'not installed', feature: '' },
      { check: 'Vim API loaded', result: show(r.vimLoaded), feature: 'everything Vim' },
      ...VIM_METHODS.map((k) => ({ check: 'Vim.' + k, result: show(r.vimLoaded ? m[k] : null), feature: k === 'handleKey' ? 'f/t/r, Ctrl+[' : k === 'getKeymap' ? 'keymap check' : 'visual h/l' })),
      { check: 'Vim.multiSelectHandleKey', result: show(r.multiSelect), feature: 'optional (handleKey otherwise)' },
      { check: 'keymap entries carry motion names', result: show(r.keymapShape), feature: 'keymap check' },
      { check: 'editor open', result: show(r.editor), feature: 'editor probes below' },
      { check: 'Vim on that editor', result: show(r.vimOnEditor), feature: 'editor probes below' },
      { check: 'Vim key buffer readable', result: show(r.keyBuffer), feature: 'f/t/r, US keys' },
      { check: 'editor back-pointer', result: show(r.backPointer), feature: 'visual h/l' },
      { check: 'Vim cursor layer', result: show(r.cursorLayer), feature: 'cursor direction fix' },
      { check: 'key-reader hook', result: show(r.keyReaderHook), feature: 'flash search with a Hebrew OS layout (optional)' },
      { check: 'tokenizer: math + fences', result: show(tok.ok) + (tok.detail ? ' — ' + tok.detail : ''), feature: 'math/code regions' },
      { check: 'tokenizer: indented code', result: show(tok.indent), feature: 'information' },
    ];
    for (const k of Object.keys(features)) rows.push({ check: 'feature ' + k, result: features[k] === false ? 'OFF' : features[k] === true ? 'on' : 'on (unchecked)', feature: '' });
    console.table(rows);
    const off = Object.keys(features).filter((k) => features[k] === false);
    new Notice('Hebrew Vim + Math Direction diagnostics: Vim Motions ' + (version || 'not installed') +
      (version && !TESTED_VIM_MOTIONS.includes(version) ? ' (untested)' : '') + '. ' +
      (off.length ? 'Off: ' + off.join(', ') + '.' : 'All features on.') +
      (this.probePending ? ' Open a note for the editor checks.' : '') + ' Table in the Console.', 10000);
    return rows;
  }

  // --- Hebrew layer ----------------------------------------------------------

  // Should the layout warning show for a key aimed at `el`? Only in the note
  // and the fields that follow the layer (plus Vim's prompts), not in fields
  // where the OS layout is used on purpose (Templater prompts, Settings …).
  warnsFor(el) {
    return isElement(el) && (!!el.closest('.cm-content') || isVimPanelInput(el) || isExPrompt(el) || followsLayer(el));
  }

  // Hook 2: keys that must be handled before Vim / CodeMirror see them.
  onKeyDown(e) {
    if (!e.isTrusted || e.isComposing) return;
    const target = e.target;

    // The status button.
    if (target === this.statusEl && (e.key === 'Enter' || e.key === ' ') &&
        !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.toggle();
      return;
    }

    // Jump labels with the OS layout on Hebrew: let Vim Motions see the
    // physical Latin key (relabel). Shift+letter already gives Latin capitals
    // on that layout. Independent of the Hebrew-typing toggle.
    const doc = (isElement(target) && target.ownerDocument) || document;
    if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      const en = labelKey(e, doc);
      if (en) {
        relabel(e, en);
        return;
      }
    }

    if (!isElement(target)) return;

    // Warn when the OS keyboard is on Hebrew. Only Hebrew *letters* count:
    // punctuation like / ' . , exists on both layouts and proves nothing.
    if (!e.ctrlKey && !e.altKey && !e.metaKey && isHebrewLetter(e.key) && this.warnsFor(target)) this.warnLayout();

    // Ctrl+[ → Escape when the OS layout isn't Latin. On the Windows Hebrew
    // layout the physical [ key types "]" (mirrored), so e.key isn't "[" and Vim
    // never sees <C-[>; CodeMirror would run indent-less instead. On English,
    // e.key is "[" and Vim Motions handles <C-[> itself.
    if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey &&
        e.code === 'BracketLeft' && e.key !== '[') {
      // In a Vim / ? : prompt: relabel the key to "[" and let the prompt's own
      // keydown handler run. It reads the key from the event (e.key with Ctrl
      // → "<C-[>") and cancels: restores the search query and the scroll
      // position, clears the pending operator (d/), pushes history and
      // refocuses the note. Only if the relabel fails: blur, which closes the
      // dialog without that cleanup.
      if (isVimPanelInput(target)) {
        if (relabel(e, '[')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        target.blur();
        return;
      }
      if (!on('escape')) return;
      const view = viewForTarget(target);
      if (!view || !canFeedKeys()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      feedKey(view, '<Esc>');
      return;
    }

    // Shift is allowed through: ( ) { } need it, and Shift+letter (Latin
    // capitals) isn't in the Hebrew map, so it passes through unchanged.
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    // The ":" command line types English even when the OS layout is Hebrew.
    if (isExPrompt(target)) {
      const en = US[e.code];
      if (e.shiftKey || !en || e.key === en) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.insertText(target, en);
      return;
    }

    // Normal / visual mode in the note with the OS layout on Hebrew: Vim gets
    // the US key (see usKey). Not while Vim waits for an f / t / r character
    // (those follow the rules below and Vim Motions' literal-next handling),
    // and not while jump labels are up (labelKey above owns those keys, and a
    // key that isn't a label is more of a flash-search pattern). Independent
    // of the Hebrew-typing toggle: it's about the OS layout.
    const us = usKey(e);
    if (us && on('usKeys')) {
      const view = viewForTarget(target);
      if (view && vimApi() && vimCommandMode(view) && !awaitingChar(view) &&
          !labelsVisible(doc) && !vimKeyReaderActive()) {
        if (relabel(e, us)) this.warnLayout();
        return;
      }
    }

    // Vim character arguments in the note (fש, 3tש, rש), outside math and code.
    if (!this.settings.hebrew || !EN2HE[e.key] || !on('charArgs')) return;
    const view = viewForTarget(target);
    if (!view || !canFeedKeys() || !awaitingChar(view)) return;
    if (inMathOrCode(view.state, view.state.selection.main.head)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    feedKey(view, EN2HE[e.key]);
  }

  // Hook 3: Hebrew in allowlisted text fields and titles.
  onBeforeInput(e) {
    if (this.inserting || !this.settings.hebrew) return;
    if (e.inputType !== 'insertText' || !e.data || e.isComposing) return;
    const target = e.target;
    if (!isElement(target) || !followsLayer(target)) return;
    if (!hasMapped(e.data)) return;
    e.preventDefault();
    this.insertText(target, translate(e.data));
  }

  // Insert text at the caret of a field, keeping native undo when possible.
  insertText(el, text) {
    this.inserting = true;
    try {
      let done = false;
      try {
        done = el.ownerDocument.execCommand('insertText', false, text);
      } catch (err) {
        done = false;
      }
      if (!done) insertTextDirect(el, text);
    } finally {
      this.inserting = false;
    }
  }

  warnLayout() {
    if (!this.settings.layoutWarning) return;
    const now = Date.now();
    if (now - (this.lastWarn || 0) < WARN_EVERY_MS) return;
    this.lastWarn = now;
    new Notice(
      'Your system keyboard is on Hebrew. Switch Windows to English (Alt+Shift or Win+Space) ' +
      'and use the EN/עב toggle for Hebrew text.',
      WARN_EVERY_MS,
    );
  }

  async setHebrew(on) {
    this.settings.hebrew = !!on;
    this.updateStatus();
    const t = this.settingTab && this.settingTab.hebrewToggle;
    if (t && t.getValue() !== this.settings.hebrew) t.setValue(this.settings.hebrew);
    await this.saveSettings();
  }

  toggle() {
    return this.setHebrew(!this.settings.hebrew);
  }

  // Writes the DOM only when the state changed.
  updateStatus() {
    if (!this.statusEl) return;
    const isOn = !!this.settings.hebrew;
    if (this.statusShown === isOn) return;
    this.statusShown = isOn;
    this.statusEl.setText(isOn ? 'עב' : 'EN');
    this.statusEl.setAttr('aria-label', 'Hebrew typing: ' + (isOn ? 'on' : 'off'));
    this.statusEl.setAttr('aria-pressed', isOn ? 'true' : 'false');
  }

  // --- Reading view ----------------------------------------------------------

  dirFor(text) {
    if (text !== this.lastText) {
      this.lastText = text;
      this.lastDir = docDirection(text);
    }
    return this.lastDir;
  }

  postProcess(el, ctx) {
    const info = ctx.getSectionInfo(el);
    if (info) {
      this.applySection(el, this.dirFor(info.text));
      return;
    }
    // Embeds, hover previews, export: no section info, so read the note.
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (file instanceof TFile && file.extension === 'md') {
      this.app.vault.cachedRead(file).then((text) => this.applySection(el, this.dirFor(text)));
    }
  }

  applySection(el, dir) {
    setSectionDir(el, dir);
    // Sections that didn't change aren't re-rendered, so after the note's
    // direction flips (first Hebrew letter, or a `direction:` edit) update the
    // siblings this plugin already marked.
    // The parent remembers the last direction it was swept with, so a first
    // render with hundreds of sections sweeps once, not once per section.
    (el.win || window).requestAnimationFrame(() => {
      const parent = el.parentElement;
      if (!parent || parent.dataset.mathDir === dir) return;
      parent.dataset.mathDir = dir;
      for (const sib of Array.from(parent.children)) {
        if (sib !== el && (sib.classList.contains('math-dir-rtl') || sib.classList.contains('math-dir-ltr'))) {
          setSectionDir(sib, dir);
        }
      }
    });
  }
};
