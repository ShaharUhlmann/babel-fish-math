// RTL Math Mix: the core. v0.9.0
//
// Hebrew notes with math: notes with Hebrew are RTL while math, code and
// frontmatter stay LTR, with a LyX-style Hebrew typing layer and the keyboard left
// on English. Everything for the Vim Motions plugin is in src/vim.js, behind the
// "Vim mode" setting.
// Behaviour and internals: README.md here, and Notes/math-dir plugin documentation.md.
//
// Edit src/, then run `node build.mjs`. It joins core.js and vim.js into main.js,
// inlining default-map.json, and keeps one shared top-level scope. The build fails if this file names a Vim
// internal or anything declared in src/vim.js except the class VimIntegration, so
// this file reaches Vim only through one object: plugin.vim, or vimLink for the
// module-level code. Both are null while Vim mode is off.
//
// One source for "is this math or code?": regionsFor() below. The direction
// decorations and the Hebrew input translation ask it, and so does src/vim.js.
//
// Layout of this file: sections 1–6 and 8 use public Obsidian / CodeMirror API,
// except that sections 5 and 6 hard-code undocumented Obsidian DOM classes
// (input.prompt-input, .search-input-container, .inline-title, .view-header-title,
// .nav-file-title-content, .nav-folder-title-content, .modal.mod-settings,
// .vertical-tab-content, .markdown-preview-sizer, .markdown-rendered). Those have
// no probes, so a rename would silently stop that field or sweep. Section 7 holds
// what relies on Obsidian's private parser names, with its self-check. A failed
// check turns off only the feature that needs it, with one notice. Settings →
// "Diagnostics" prints the table. openIn (section 5) also writes Obsidian's
// activeWindow global, the way Obsidian does for its Settings window.
const { Plugin, PluginSettingTab, Setting, Notice, TFile, Modal, Scope } = require('obsidian');
const { ViewPlugin, Decoration, EditorView, Direction, logException } = require('@codemirror/view');
const { Prec, EditorSelection, EditorState } = require('@codemirror/state');
const { syntaxTree, ensureSyntaxTree, language } = require('@codemirror/language');

const F12 = Object.freeze({ code: 'F12', ctrl: false, alt: false, shift: false, meta: false });
const DEFAULT_MAP_ID = 'qwerty';
const DEFAULT_SETTINGS = {
  hebrew: false, layoutWarning: true, visualMotions: true, vimMode: false,
  toggleHotkey: F12, // null: no plugin hotkey (the command stays)
  activeMap: DEFAULT_MAP_ID,
};

const HEBREW = /[א-ת]/;
const DIRECTION_KEY = /^direction\s*:\s*["']?(rtl|ltr)["']?\s*$/i;
const WARN_EVERY_MS = 5000;
// Per typed key while the parse is behind (just after a big paste or opening a
// long note); the text fallbacks in inMathOrCode cover what it doesn't reach.
const PARSE_BUDGET_MS = 8;
// hebrewInput translates only this soon after a key that can type text
// (canTypeText), so text that arrives without one (a spell-check suggestion,
// picked with the mouse or the keyboard) stays as it is.
const TYPED_WITHIN_MS = 500;
const isHebrewLetter = (key) => !!key && key.length === 1 && key >= 'א' && key <= 'ת';

// Which features are on. Set by the probes: true = checked and working, false = a
// probe failed (the feature is off), null = not checked yet (counts as on). The
// core has one; the Vim integration adds its own while it runs.
const features = {
  tokens: null,        // math / code from Obsidian's tokenizer (else the text parser)
};
const on = (name) => features[name] !== false;
// The running Vim integration (src/vim.js), for the module-level code here (the
// editor class, the layer's allowlist). Null while Vim mode is off.
let vimLink = null;
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
const lineGetter = (doc) => (i) => doc.line(i + 1).text;
const fmOf = (doc) => frontmatterEndAt(doc.lines, lineGetter(doc));

function fenceMarker(line) {
  const m = /^\s*(`{3,}|~{3,})/.exec(line);
  return m ? m[1] : null;
}

// Does `line` close the fence recorded in walker state `s` (see S_FENCE)?
function closesFence(line, s) {
  const m = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  return !!m && m[1][0] === (s & S_TILDE ? '~' : '`') && m[1].length >= Math.floor(s / S_FLEN);
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
      if (isHebrewLetter(c)) hebrew = true;
      i++;
    }
  }
  return { inDisplay, hebrew };
}

// Walks a note's lines (0-based, `get(i)` returns line i) through frontmatter,
// fenced code (a fence only opens outside display math), indented code and $$
// display math.
// visit(i, kind, scan): kind is 'fm' | 'fence' | 'indent' | 'text', `scan` is
// scanLine's result for 'text' lines. Return true from visit to stop.
// `sink(i, event, a, b)`: scanLine's math events.
//
// Indented code, the same rule the editor's regions use (CommonMark, as far
// as a line walk can tell): a non-blank line indented by 4 spaces or a tab,
// outside display math, that follows a blank line (or the start of the body)
// or continues an indented block, and isn't inside a list (a list item's
// indented lines are its continuation). Blank lines inside the block are
// 'text' (they carry nothing). Indented code is never scanned for math.
function walkLines(count, get, visit, sink) {
  const fm = frontmatterEndAt(count, get);
  let s = S_START;
  for (let i = 0; i < count; i++) {
    const line = get(i);
    if (i <= fm) {
      if (visit(i, 'fm', null)) return;
      continue;
    }
    s = stepLine(s, line, false, sink && ((ev, a, b) => sink(i, ev, a, b)));
    if (visit(i, KIND_NAME[STEP.kind], STEP.scan)) return;
  }
}

// The walker's state between two lines, packed into one integer so a note's
// states fit in an Int32Array (LineScan below): inside display math, inside
// indented code, previous line blank, inside a list, inside a fence (with the
// fence's character and length; lengths are capped at 2^24).
const S_DISPLAY = 1, S_INDENT = 2, S_BLANK = 4, S_LIST = 8, S_FENCE = 16, S_TILDE = 32, S_FLEN = 64;
const S_START = S_BLANK; // start of the body: "after a blank line"
const K_TEXT = 0, K_FM = 1, K_FENCE = 2, K_INDENT = 3, F_HEB = 4; // line kinds, + "Hebrew text" flag
const KIND_NAME = ['text', 'fm', 'fence', 'indent'];
// stepLine's other results (no allocation per line): the line's kind, and
// scanLine's result for a 'text' line (null when `fast` skipped it).
const STEP = { kind: K_TEXT, scan: null };

// One body line of walkLines: state `s` before the line → state after it.
function stepLine(s, line, fast, sink) {
  STEP.scan = null;
  if (s & S_FENCE) {
    if (closesFence(line, s)) s &= S_DISPLAY | S_INDENT | S_BLANK | S_LIST;
    STEP.kind = K_FENCE;
    return s;
  }
  if (!(s & S_DISPLAY)) {
    const f = fenceMarker(line);
    if (f) {
      STEP.kind = K_FENCE; // also clears indented code, list and "after blank"
      return S_FENCE | (f[0] === '~' ? S_TILDE : 0) | (Math.min(f.length, 1 << 24) * S_FLEN);
    }
    const blank = !line.trim();
    if (!blank && INDENTED.test(line) && ((s & S_INDENT) || ((s & S_BLANK) && !(s & S_LIST)))) {
      STEP.kind = K_INDENT;
      return (s | S_INDENT) & ~S_BLANK;
    }
    if (blank) {
      s |= S_BLANK;
    } else {
      s &= ~(S_INDENT | S_BLANK);
      // An indented line in a list continues it; anything else decides anew.
      if (!INDENTED.test(line)) s = LIST_ITEM.test(line) ? s | S_LIST : s & ~S_LIST;
    }
  } else {
    s &= ~S_BLANK;
  }
  STEP.kind = K_TEXT;
  if (!fast || line.includes('$')) {
    const r = scanLine(line, !!(s & S_DISPLAY), sink);
    s = r.inDisplay ? s | S_DISPLAY : s & ~S_DISPLAY;
    STEP.scan = r;
  }
  return s;
}

// Per-keystroke work counters, read live as app.plugins.plugins['rtl-math-mix'].perf
// (reset with perfReset()). Always on: a few integer increments and two clock
// reads per editor update.
const perf = {
  updates: 0, lastUpdateMs: 0, maxUpdateMs: 0, totalUpdateMs: 0,
  fullScans: 0, incrementalScans: 0, reusedScans: 0, textScans: 0, // math / code regions
  dirFull: 0, dirIncremental: 0, dirKept: 0, linesWalked: 0,        // line scan (direction)
  dirHeld: 0, // edits where the direction was held (the note ends inside an unclosed block)
};
const PERF_ZERO = Object.assign({}, perf);
const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---------------------------------------------------------------------------
// The line walk of one doc, kept up to date edit by edit. It records the
// walker state before every line it has walked and each line's kind and
// "has Hebrew text" flag, and walks further only when asked (ensure). After an
// edit, map() reuses everything before the first changed line, walks the
// changed lines, and keeps walking only until the state before a line equals
// the old state before the same (shifted) line: from there on the lines and
// their states are the old ones, so their records are copied. Gives exactly
// what walkLines gives (the oracle in the F3 harness checks it).
class LineScan {
  constructor(doc, fm, st, fl, walked, decide, override) {
    this.doc = doc;
    this.fm = fm;             // index of the frontmatter's closing line, or -1
    this.st = st;             // st[i]: walker state before line i (0-based), i <= walked
    this.fl = fl;             // fl[i]: kind | F_HEB, i < walked
    this.walked = walked;     // lines 0 … walked-1 are walked
    this.decide = decide;     // first Hebrew text line, -1 = none, undefined = not known yet
    this.override = override; // 'rtl' / 'ltr' from `direction:` in the frontmatter, or null
    this.searchFrom = fm + 1; // lines before this have no Hebrew text (when decide is unknown)
  }

  static full(doc) {
    const fm = fmOf(doc);
    const { st, fl } = allocScan(doc.lines, fm);
    st[fm + 1] = S_START;
    perf.dirFull++;
    return new LineScan(doc, fm, st, fl, fm + 1, undefined, overrideIn(fm, lineGetter(doc)));
  }

  // Walk lines walked … to-1.
  ensure(to) {
    to = Math.min(to, this.doc.lines);
    let i = this.walked;
    if (i >= to) return;
    let s = this.st[i];
    const it = this.doc.iterLines(i + 1, to + 1);
    for (; !it.next().done; i++) s = this.step(i, s, it.value);
    this.walked = to;
  }

  // Walks line i (text `line`) from state s; records it; returns the next state.
  step(i, s, line) {
    const next = stepLine(s, line, true);
    let f = STEP.kind;
    if (f === K_TEXT) {
      // scanLine's Hebrew test, without scanning lines that can't differ from
      // a plain test: no $ (no math), not in display math, no \ (escapes).
      const heb = STEP.scan ? STEP.scan.hebrew
        : !(s & S_DISPLAY) && (line.includes('\\') ? scanLine(line, false).hebrew : HEBREW.test(line));
      if (heb) f |= F_HEB;
    }
    this.fl[i] = f;
    this.st[i + 1] = next;
    perf.linesWalked++;
    return next;
  }

  // Is a fence still open after 1-based line n?
  fenceOpenAfter(n) {
    this.ensure(n);
    return !!(this.st[n] & S_FENCE);
  }

  // 'rtl' or 'ltr', the same answer as docDirection(doc.toString()).
  direction() {
    if (this.override) return this.override;
    if (this.decide === undefined) {
      const n = this.doc.lines;
      let i = this.searchFrom;
      for (;; i++) {
        if (i >= this.walked) {
          if (this.walked >= n) { this.decide = -1; break; }
          this.ensure(Math.max(i + 256, this.walked * 2)); // grows in steps
        }
        if (this.fl[i] & F_HEB) { this.decide = i; break; }
      }
    }
    return this.decide >= 0 ? 'rtl' : 'ltr';
  }

  // Does the note end inside a $$ block or a fence that is never closed?
  // Walks to the end if it hasn't yet; after that the records carry over from
  // edit to edit like the rest (map).
  endsOpen() {
    const n = this.doc.lines;
    this.ensure(n);
    return !!(this.st[n] & (S_DISPLAY | S_FENCE));
  }

  // The scan of `doc`, which is this scan's doc after `changes`.
  map(changes, doc) {
    const old = this.doc;
    let fromA = Infinity, toA = -1, fromB = Infinity, toB = -1;
    changes.iterChangedRanges((fa, ta, fb, tb) => {
      if (fa < fromA) fromA = fa;
      if (ta > toA) toA = ta;
      if (fb < fromB) fromB = fb;
      if (tb > toB) toB = tb;
    });
    const a = doc.lineAt(fromB).number - 1;      // first changed line (same in both docs)
    const bOld = old.lineAt(toA).number - 1;     // last changed line, old doc
    const bNew = doc.lineAt(toB).number - 1;     // last changed line, new doc
    const delta = doc.lines - old.lines;         // later lines: old i ↔ new i + delta
    const fm = this.fm;

    // Frontmatter: the closing line is the first '---' after a '---' line 0.
    if (fm >= 0 ? a <= fm : a === 0) {
      const nf = fmOf(doc);
      if (fm >= 0 && nf === fm + delta && bOld < fm) return this.shifted(doc, nf, delta);
      if (fm >= 0 || nf >= 0) return LineScan.full(doc);
    } else if (fm < 0 && old.line(1).text === '---') {
      // Unclosed frontmatter: it closes if a changed line is now '---'.
      for (let i = a; i <= bNew; i++) if (doc.line(i + 1).text === '---') return LineScan.full(doc);
    }

    perf.dirIncremental++;
    const { st, fl } = allocScan(doc.lines, -1);
    let walked;
    if (a >= this.walked) {
      // The change is past everything walked: the records stay as they are.
      walked = this.walked;
      st.set(this.st.subarray(0, walked + 1));
      fl.set(this.fl.subarray(0, walked));
    } else {
      st.set(this.st.subarray(0, a + 1));
      fl.set(this.fl.subarray(0, a));
      const next = new LineScan(doc, fm, st, fl, a, undefined, this.override);
      let s = st[a];
      let j = a;
      const it = doc.iterLines(a + 1);
      while (!it.next().done) {
        s = next.step(j, s, it.value);
        j++;
        if (j > bNew) {
          const o = j - delta; // the same line in the old doc
          if (o > this.walked) break; // the old scan went no further: stop here too
          if (this.st[o] === s) {
            // In step again: the rest is the old records, shifted.
            st.set(this.st.subarray(o + 1, this.walked + 1), j + 1);
            fl.set(this.fl.subarray(o, this.walked), j);
            j = this.walked + delta;
            break;
          }
          // The deciding line is known and above the edit: nobody needs the rest
          // now, and ensure() walks it on demand.
          if (this.decide !== undefined && this.decide >= 0 && this.decide < a) break;
        }
      }
      walked = j;
    }
    const out = new LineScan(doc, fm, st, fl, walked, undefined, this.override);
    // The deciding line: kept when it's before the change; otherwise the search
    // restarts at the change (nothing before it has Hebrew text).
    if (this.decide !== undefined && this.decide >= 0 && this.decide < a) {
      out.decide = this.decide;
      perf.dirKept++;
    } else {
      out.searchFrom = this.decide === undefined ? Math.min(this.searchFrom, a) : Math.max(fm + 1, a);
    }
    return out;
  }

  // An edit inside the frontmatter that left its closing line in place: the
  // body is unchanged, only shifted.
  shifted(doc, nf, delta) {
    const { st, fl } = allocScan(doc.lines, nf);
    st.set(this.st.subarray(this.fm + 1, this.walked + 1), nf + 1);
    fl.set(this.fl.subarray(this.fm + 1, this.walked), nf + 1);
    const decide = this.decide === undefined || this.decide < 0 ? this.decide : this.decide + delta;
    const out = new LineScan(doc, nf, st, fl, this.walked + delta, decide, overrideIn(nf, lineGetter(doc)));
    if (this.decide === undefined) out.searchFrom = this.searchFrom + delta;
    perf.dirIncremental++;
    return out;
  }

}

// A scan's two arrays for n lines, with the frontmatter lines (0 … fm) filled in.
function allocScan(n, fm) {
  const st = new Int32Array(n + 1);
  const fl = new Uint8Array(n);
  for (let i = 0; i <= fm; i++) { st[i] = S_START; fl[i] = K_FM; }
  return { st, fl };
}

// `direction:` in the frontmatter (lines 1 … fm-1), the first one wins.
function overrideIn(fm, get) {
  for (let i = 1; i < fm; i++) {
    const m = DIRECTION_KEY.exec(get(i));
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// The line scan of a doc, cached per doc; noteEdit carries it across edits.
const scanCache = new WeakMap();
function scanFor(doc) {
  let s = scanCache.get(doc);
  if (!s) { s = LineScan.full(doc); scanCache.set(doc, s); }
  return s;
}

// ===========================================================================
// 2. Document direction (one rule, for the editor and Reading view)
// ===========================================================================

// 'rtl' or 'ltr' for a whole note.
function docDirection(text) {
  let lines = null;
  if (text.startsWith('---')) {
    lines = text.split(/\r?\n/);
    const override = overrideIn(frontmatterEnd(lines), (i) => lines[i]);
    if (override) return override;
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
//   • tokenizer (default): reads Obsidian's syntax tree
//     (tokenRegions in section 7). Exact from the opening $ to the closing $,
//     knows indented code inside lists, and yields whole ranges.
//   • text parser (fallback, when the tokenizer self-check fails): the line
//     walk of section 1 over the whole note.
// Both mark fenced and indented code as code; the document rule in section 2
// uses the same two kinds.

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
  // "Is a fence still open after line n?" comes from the doc's line scan (the
  // plain-text fence walk, kept up to date per edit).
  const scan = runs.length ? scanFor(doc) : null;
  for (const { n, kind, end } of runs) {
    const fill = kind === 'fence' ? scan.fenceOpenAfter(n) : indentAfter(end);
    if (fill) for (let k = n + 1; k < end && k <= lastLine; k++) code.add(k);
  }
  return code;
}

// {
//   limit: how far the regions are known (min(upto, parsed length)),
//   math:  [{ from, to, open }] sorted; `open` for a $$ not closed before limit,
//   code:  Set of 1-based line numbers that are code,
// }
//
// Incremental: every result also remembers its tree and the raw code lines
// (codeKind). A new result starts from the latest one for the same doc or the doc
// before an edit, and rescans the tree only from a restart point R (the first
// change or tree difference, moved back out of any math region and blank-code run).
// What's before R is the same subtrees at the same places, so the same tokens,
// and the begin / end pairing restarts there with nothing open.
function regionsFor(doc, tree, upto) {
  if (!on('tokens')) return textRegions(doc);
  const limit = Math.min(upto, tree.length, doc.length);
  const hit = regionCache.get(tree);
  if (hit && hit.doc === doc && hit.limit >= limit) return hit;
  const last = lastRegions.get(doc);
  const base = last ? { prev: last, from: Infinity } : regionSeeds.get(doc);
  let result = base && incrementalRegions(doc, tree, limit, base.prev, base.from);
  if (!result) {
    result = scanRegions(doc, tree, limit, 0, null);
    perf.fullScans++;
  }
  regionCache.set(tree, result);
  // Keep the base that reaches furthest (any result for this doc is a valid
  // base for any tree), and drop the seed: it holds the previous doc's result,
  // and keeping it would chain every past doc and tree in memory.
  if (!last || result.limit >= last.limit) lastRegions.set(doc, result);
  regionSeeds.delete(doc);
  return result;
}

// Latest token result per doc, and per new doc the result to start from after
// an edit (set by noteEdit; `from` = the first changed position).
const lastRegions = new WeakMap();
const regionSeeds = new WeakMap();

// Tree regions from position R (a line start outside math) to `limit`, on top
// of `prev`'s regions before R (null: R = 0).
function scanRegions(doc, tree, limit, R, prev) {
  const { math, codeKind } = tokenRegions(doc, tree, limit, R);
  const code = codeLines(doc, codeKind, limit);
  if (!prev) return { doc, tree, limit, math, code, codeKind };
  const line = R ? doc.lineAt(R).number : 1;
  // prev.math is sorted and has nothing that crosses R.
  let k = prev.math.length;
  while (k > 0 && prev.math[k - 1].from >= R) k--;
  const allMath = prev.math.slice(0, k).concat(math);
  const allKind = new Map();
  for (const [n, kind] of prev.codeKind) if (n < line) allKind.set(n, kind);
  for (const [n, kind] of codeKind) allKind.set(n, kind);
  for (const n of prev.code) if (n < line) code.add(n);
  return { doc, tree, limit, math: allMath, code, codeKind: allKind };
}

function incrementalRegions(doc, tree, limit, prev, changeFrom) {
  const diff = treeDiffPos(prev.tree, tree);
  if (changeFrom === Infinity && prev.doc === doc && diff >= prev.limit && prev.limit >= limit) {
    // Same doc, and the trees agree as far as the old result went.
    perf.reusedScans++;
    return Object.assign({}, prev, { tree });
  }
  let R = Math.min(changeFrom, diff, prev.limit, limit);
  if (R <= 0) return null;
  // Positions and line numbers before R agree in both docs and both trees.
  // 1. The nearest code line above R's line whose blank-line run reaches that
  //    line: its fill depends on what follows the run, so rescan from it.
  let line = doc.lineAt(R);
  let m = line.number - 1;
  while (m >= 1 && !prev.codeKind.has(m) && !doc.line(m).text.trim()) m--;
  if (m >= 1 && prev.codeKind.has(m)) line = doc.line(m);
  R = line.from;
  // 2. Out of math: to the start of a region that contains R (an open $$ runs
  //    to prev.limit), and to the start of that line; repeat.
  for (let moved = true; moved && R > 0;) {
    moved = false;
    for (let k = prev.math.length - 1; k >= 0; k--) {
      const r = prev.math[k];
      if (r.from >= R) continue;
      if (R < r.to || (r.open && R <= r.to)) { R = doc.lineAt(r.from).from; moved = true; }
      break;
    }
  }
  if (R <= 0) return null;
  // Frontmatter edits: a full scan (the frontmatter is at the top; cheap).
  const scan = scanFor(doc);
  if (scan.fm >= 0 && R <= doc.line(scan.fm + 1).to) return null;
  perf.incrementalScans++;
  return scanRegions(doc, tree, limit, R, prev);
}

// The first position where two syntax trees may differ: their top-level
// children are compared by identity (an incremental parse reuses the old
// subtrees before an edit as the same objects, Lezer's public Tree.children /
// Tree.positions). Same objects at the same place hold the same tokens.
// Anything else (a re-parse, another tree shape) gives an earlier position,
// down to 0: a full scan, never a wrong result.
function treeDiffPos(a, b) {
  if (a === b) return Infinity;
  if (!a || !b || a.type !== b.type) return 0;
  const n = Math.min(a.children.length, b.children.length);
  for (let i = 0; i < n; i++) {
    if (a.children[i] !== b.children[i] || a.positions[i] !== b.positions[i]) {
      return Math.min(a.positions[i], b.positions[i]);
    }
  }
  if (!n) return 0;
  return a.positions[n - 1] + a.children[n - 1].length;
}

// After an edit (editor update): carry the line scan and the regions to the
// new doc. `changes` maps oldDoc to newDoc.
function noteEdit(oldDoc, newDoc, changes) {
  if (!scanCache.has(newDoc)) {
    const old = scanCache.get(oldDoc);
    scanCache.set(newDoc, old ? old.map(changes, newDoc) : LineScan.full(newDoc));
  }
  if (lastRegions.has(newDoc) || regionSeeds.has(newDoc)) return;
  let from = Infinity;
  changes.iterChangedRanges((fa) => { if (fa < from) from = fa; });
  const last = lastRegions.get(oldDoc);
  const seed = last ? { prev: last, from } : regionSeeds.get(oldDoc);
  if (seed) regionSeeds.set(newDoc, { prev: seed.prev, from: Math.min(seed.from, from) });
}

// The same result from the text parser, for the whole doc.
function textRegions(doc) {
  const hit = textRegionCache.get(doc);
  if (hit) return hit;
  perf.textScans++; // the fallback stays a whole-note scan per new doc
  const math = [];
  const codeKind = new Map();
  let openFrom = -1;
  walkLines(doc.lines, lineGetter(doc), (i, kind) => {
    if (kind === 'fence' || kind === 'indent') codeKind.set(i + 1, kind);
    return false;
  }, (i, ev, a, b) => {
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
  const r = R.math[firstNot(R.math, (m) => m.from < pos) - 1];
  return !!r && (pos < r.to || (r.open && pos <= r.to));
}

// Binary search over math regions, which are sorted and don't overlap: the first
// index where `before(region)` is false.
function firstNot(regions, before) {
  let lo = 0;
  for (let hi = regions.length; lo < hi;) {
    const mid = (lo + hi) >> 1;
    if (before(regions[mid])) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// 'math', 'code', 'text', or null when the parse hasn't reached `pos`.
function contextAt(state, pos) {
  let tree = null;
  if (on('tokens')) {
    tree = (ensureSyntaxTree && ensureSyntaxTree(state, pos, PARSE_BUDGET_MS)) || syntaxTree(state);
    if (tree.length < pos) return null;
  }
  const R = regionsFor(state.doc, tree, pos);
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
//   • The editor (.cm-editor) gets dir + class math-dir-rtl / math-dir-ltr via
//     EditorView.editorAttributes, plus any class the Vim integration asks for.

const LINE = {
  rtl: Decoration.line({ attributes: { dir: 'rtl' }, class: 'math-dir-line-rtl' }),
  ltr: Decoration.line({ attributes: { dir: 'ltr' }, class: 'math-dir-line-ltr' }),
};
const MATH = Decoration.mark({
  class: 'math-dir-iso',
  attributes: { dir: 'ltr' },
  bidiIsolate: Direction.LTR,
});

class MathDirView {
  constructor(view) {
    this.scan = scanFor(view.state.doc);
    this.dir = this.scan.direction();
    this.tree = syntaxTree(view.state);
    this.epoch = featureEpoch;
    this.build(view);
    this.editorClass = vimLink ? vimLink.editorClass(this, view.state) : '';
  }

  update(u) {
    const t0 = clock();
    if (u.docChanged) {
      // The line scan follows the edit; the direction is re-decided only when
      // the edit is at or before the deciding line (see LineScan.map).
      noteEdit(u.startState.doc, u.state.doc, u.changes);
      this.scan = scanFor(u.state.doc);
      this.dir = this.nextDir(this.scan, replacesAll(u.changes, u.startState.doc.length));
    }
    const tree = syntaxTree(u.state);
    if (u.docChanged || u.viewportChanged || this.epoch !== featureEpoch ||
        (this.stale && !u.view.compositionStarted) ||
        (tree !== this.tree && this.treeMatters(tree, u.view))) {
      this.tree = tree;
      if (u.view.compositionStarted && this.epoch === featureEpoch) {
        // Don't redraw around an IME composition; just keep positions in step,
        // and rebuild on the first update after it ends.
        this.deco = this.deco.map(u.changes);
        this.marks = this.marks.map(u.changes);
        this.stale = true;
      } else {
        this.stale = false;
        this.epoch = featureEpoch;
        this.build(u.view);
      }
    }
    this.editorClass = vimLink ? vimLink.editorClass(this, u.state) : '';
    const ms = clock() - t0;
    perf.updates++;
    perf.lastUpdateMs = ms;
    perf.totalUpdateMs += ms;
    if (ms > perf.maxUpdateMs) perf.maxUpdateMs = ms;
  }

  // The direction after an edit. The rule (scan.direction()) decides, except
  // while the note ends inside a $$ block or a fence that isn't closed: then the
  // editor keeps the direction it had, because an unclosed opener turns everything
  // below it into math or code, and typing `$$` above the first Hebrew line would
  // flip the note until the closer is typed. A `direction:` key always applies.
  // A hold, not a different rule: Reading view and a freshly opened editor use
  // the rule as it is, and so does an edit that replaced the whole note.
  nextDir(scan, replaced) {
    const next = scan.direction();
    if (next !== this.dir && !replaced && !scan.override && scan.endsOpen()) {
      perf.dirHeld++;
      return this.dir;
    }
    return next;
  }

  // A new syntax tree without an edit (a background parse step): rebuild only
  // if the last build didn't reach the viewport's end (the parse was behind)
  // or the new tree differs from the built one before where that build went
  // (e.g. a skipped stretch of a very long note parsed for real). With the
  // text parser the tree isn't used at all.
  treeMatters(tree, view) {
    if (!on('tokens')) return false;
    const visible = view.visibleRanges;
    if (!visible.length) return false;
    const end = Math.min(visible[visible.length - 1].to, view.state.doc.length);
    return this.limit < end || treeDiffPos(this.tree, tree) < this.limit;
  }

  build(view) {
    const doc = view.state.doc;
    const visible = view.visibleRanges;
    if (!visible.length) {
      this.deco = this.marks = Decoration.none;
      this.limit = 0;
      return;
    }
    const R = regionsFor(doc, this.tree, visible[visible.length - 1].to);
    this.limit = R.limit;
    const math = R.math;
    const code = R.code;

    const fmLine = this.scan.fm + 1; // the frontmatter's closing line, or 0
    const deco = [];
    const marks = [];
    // First math region that can reach the viewport.
    const first = doc.lineAt(visible[0].from).from;
    let mi = firstNot(math, (r) => r.to < first);
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

// Did `changes` replace the whole of a doc of length `len`? An empty doc counts:
// the first edit of an empty note follows the rule, with nothing to hold.
function replacesAll(changes, len) {
  let all = false;
  changes.iterChangedRanges((fromA, toA) => { if (fromA === 0 && toA === len) all = true; });
  return all;
}

const mathDirPlugin = ViewPlugin.fromClass(MathDirView, {
  provide: (plugin) => [
    EditorView.outerDecorations.of((view) => view.plugin(plugin)?.deco ?? Decoration.none),
    EditorView.bidiIsolatedRanges.of((view) => view.plugin(plugin)?.marks ?? Decoration.none),
    EditorView.editorAttributes.of((view) => {
      const p = view.plugin(plugin);
      if (!p) return null;
      return { dir: p.dir, class: 'math-dir-' + p.dir + p.editorClass };
    }),
  ],
});

// ===========================================================================
// 5. Hebrew layer: key map and DOM helpers
// ===========================================================================

// The original map: standard Hebrew layout (SI-1452), unshifted, with the bracket
// pairs mirrored as on the Windows Hebrew layout (outside math). build.mjs puts the
// file's contents here, so this copy is the source of truth wherever main.js goes.
const DEFAULT_MAP = require('./default-map.json');
const DEFAULT_MAP_TEXT = JSON.stringify(DEFAULT_MAP, null, 2) + '\n';

// A Map has no prototype to hit, so no key can misfire on an inherited name.
const keyLookup = (keys) => new Map(Object.entries(keys));
const ORIGINAL_KEYS = keyLookup(DEFAULT_MAP.keys);

// The active map: key → character. KeyMaps sets it; it starts as the original.
let EN2HE = ORIGINAL_KEYS;
const mappedKey = (ch) => EN2HE.get(ch);
const originalKey = (ch) => ORIGINAL_KEYS.get(ch);
const translate = (text) => [...text].map((ch) => mappedKey(ch) || ch).join('');
const hasMapped = (text) => [...text].some((ch) => mappedKey(ch));

// --- Key map files -----------------------------------------------------------
//
// <plugin folder>/maps/*.json: { "name": "...", "keys": { "q": "/", ... } }. Public
// vault.adapter calls only. A file that fails the checks is skipped and never
// overwritten; if the active map isn't there, the original is used in memory.

const isOneChar = (s) => typeof s === 'string' && [...s].length === 1;

// Why `data` isn't a key map, or null when it is one.
function mapProblem(data) {
  const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  if (!isObject(data)) return 'it must be an object with "name" and "keys"';
  if (typeof data.name !== 'string' || !data.name.trim()) return '"name" must be a non-empty string';
  if (!isObject(data.keys)) return '"keys" must be an object';
  for (const [k, v] of Object.entries(data.keys)) {
    if (!isOneChar(k)) return `key "${k}" must be exactly one character`;
    if (!isOneChar(v)) return `the value of key "${k}" must be exactly one character`;
  }
  return null;
}

// { map: { name, keys, lookup } } or { error }. A BOM (Notepad) is dropped.
function parseMap(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (err) {
    return { error: 'not valid JSON (' + err.message + ')' };
  }
  const error = mapProblem(data);
  return error ? { error } : { map: { name: data.name, keys: data.keys, lookup: keyLookup(data.keys) } };
}

// A file name for a new map: [a-z0-9-] only, so it can't leave maps/, and not one of
// `taken` (compared in lower case: Windows file names ignore case). A name with no
// such characters, a Hebrew one say, gets "map"; Windows reserves a few names.
function mapSlug(name, taken) {
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  let base = String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-')
    .slice(0, 40).replace(/^-|-$/g, '');
  if (!base) base = 'map';
  else if (/^(con|prn|aux|nul|com\d|lpt\d)$/.test(base)) base = 'map-' + base;
  let slug = base;
  for (let n = 2; used.has(slug); n++) slug = base + '-' + n;
  return slug;
}

class KeyMaps {
  constructor(plugin) {
    this.plugin = plugin;
    const vault = plugin.app.vault;
    this.adapter = (vault && vault.adapter) || null;
    const dir = plugin.manifest && plugin.manifest.dir;
    this.dir = this.adapter && dir ? dir + '/maps' : null;
    this.valid = new Map();   // id (file name without .json) → { path, name, keys, lookup }
    this.invalid = new Map(); // id → { path, reason }
    this.failure = null;      // the folder couldn't be read or prepared
  }

  pathOf(id) {
    return this.dir + '/' + id + '.json';
  }

  // The active map's entry, or null when the original is in use.
  active() {
    return this.valid.get(this.plugin.settings.activeMap) || null;
  }

  applyActive() {
    const entry = this.active();
    EN2HE = entry ? entry.lookup : ORIGINAL_KEYS;
  }

  // Creates the folder and qwerty.json if missing, reads every maps/*.json, applies
  // the active map and reports problems in one notice. True when there were none.
  async load() {
    this.valid = new Map();
    this.invalid = new Map();
    this.failure = null;
    if (this.dir) {
      try {
        const a = this.adapter;
        if (!await a.exists(this.dir)) await a.mkdir(this.dir);
        if (!await a.exists(this.pathOf(DEFAULT_MAP_ID))) await a.write(this.pathOf(DEFAULT_MAP_ID), DEFAULT_MAP_TEXT);
        for (const path of (await a.list(this.dir)).files) {
          const m = /([^/]+)\.json$/.exec(path);
          if (m) await this.readFile(m[1], path);
        }
      } catch (err) {
        this.failure = err.message || String(err);
      }
    }
    this.applyActive();
    return this.report();
  }

  async readFile(id, path) {
    let parsed;
    try {
      parsed = parseMap(await this.adapter.read(path));
    } catch (err) {
      parsed = { error: 'it could not be read (' + err.message + ')' };
    }
    if (parsed.error) this.invalid.set(id, { path, reason: parsed.error });
    else this.valid.set(id, Object.assign({ path }, parsed.map));
  }

  report() {
    if (!this.dir) return true;
    const parts = [];
    if (this.failure) parts.push('The maps folder could not be read: ' + this.failure + '.');
    if (this.invalid.size) {
      parts.push('Skipped: ' + [...this.invalid].map(([id, x]) => `${id}.json (${x.reason})`).join('; ') + '.');
    }
    if (!this.active()) {
      parts.push(`Key map "${this.plugin.settings.activeMap}" isn't available, so the built-in original is in use.`);
    }
    if (!parts.length) return true;
    new Notice('RTL Math Mix: ' + parts.join(' '), 15000);
    return false;
  }

  async setActive(id) {
    this.plugin.settings.activeMap = id;
    this.applyActive();
    await this.plugin.saveSettings();
  }

  // A copy of the active map, as a new file, which becomes the active map (the Edit
  // button works on that one). Never overwrites: the folder is listed again first.
  async create(name) {
    const taken = new Set([DEFAULT_MAP_ID]);
    for (const path of (await this.adapter.list(this.dir)).files) {
      const m = /([^/]+)\.json$/i.exec(path);
      if (m) taken.add(m[1]);
    }
    const id = mapSlug(name, taken);
    const source = this.active() || DEFAULT_MAP;
    const text = JSON.stringify({ name: name.trim(), keys: source.keys }, null, 2) + '\n';
    await this.adapter.write(this.pathOf(id), text);
    this.valid.set(id, Object.assign({ path: this.pathOf(id) }, parseMap(text).map));
    await this.setActive(id);
    return id;
  }

  // The file of map `id`, valid or not, or null.
  entry(id) {
    return this.valid.get(id) || this.invalid.get(id) || null;
  }

  // Saves edited text as it is. Returns the reason when it's refused, and then the
  // file isn't touched; null when it's saved.
  async saveText(id, text) {
    const parsed = parseMap(text);
    if (parsed.error) return parsed.error;
    const path = this.entry(id).path;
    await this.adapter.write(path, text);
    this.invalid.delete(id);
    this.valid.set(id, Object.assign({ path }, parsed.map));
    this.applyActive();
    return null;
  }

  async remove(id) {
    if (id === DEFAULT_MAP_ID) return;
    const entry = this.entry(id);
    if (entry) await this.adapter.remove(entry.path);
    this.valid.delete(id);
    this.invalid.delete(id);
    if (this.plugin.settings.activeMap === id) await this.setActive(DEFAULT_MAP_ID);
  }

  // Rewrites qwerty.json from the embedded original.
  async resetDefault() {
    const path = this.pathOf(DEFAULT_MAP_ID);
    await this.adapter.write(path, DEFAULT_MAP_TEXT);
    this.invalid.delete(DEFAULT_MAP_ID);
    this.valid.set(DEFAULT_MAP_ID, Object.assign({ path }, parseMap(DEFAULT_MAP_TEXT).map));
    this.applyActive();
  }
}

// --- The toggle hotkey ---------------------------------------------------------
//
// { code, ctrl, alt, shift, meta }, matched on the physical key (e.code), so it works
// the same on any keyboard layout. Obsidian has no public way for a plugin to change
// its own hotkeys, so hook 2 handles this one.

const hotkeyOf = (e) => ({ code: e.code, ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, meta: !!e.metaKey });
const hotkeyMatches = (h, e) => !!h && e.code === h.code && !!e.ctrlKey === h.ctrl &&
  !!e.altKey === h.alt && !!e.shiftKey === h.shift && !!e.metaKey === h.meta;

function hotkeyLabel(h) {
  if (!h) return 'none';
  const mods = [h.ctrl && 'Ctrl', h.alt && 'Alt', h.shift && 'Shift', h.meta && 'Meta'].filter(Boolean);
  return [...mods, h.code.replace(/^(Key|Digit)/, '')].join('+');
}

// data.json's value: null stays "no hotkey", anything unreadable is the default.
function cleanHotkey(h) {
  if (h === null) return null;
  if (!h || typeof h.code !== 'string' || !h.code) return F12;
  return { code: h.code, ctrl: !!h.ctrl, alt: !!h.alt, shift: !!h.shift, meta: !!h.meta };
}

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'AltGraph', 'Shift', 'Meta', 'OS']);
const LONE_MODIFIER = 'A modifier alone can\'t be the hotkey. Hold it and press another key, or press Esc to cancel.';

// Why this key press can't be the hotkey, or null. Without Ctrl, Alt or Meta only keys
// that neither type nor edit qualify; Shift doesn't count, Shift+a is just a capital.
function hotkeyRefusal(e) {
  if (MODIFIER_KEYS.has(e.key)) return LONE_MODIFIER;
  if (!e.code || e.code === 'Unidentified') return 'This key has no name the plugin can match. Try another, or press Esc to cancel.';
  if (e.ctrlKey || e.altKey || e.metaKey || /^(F\d{1,2}|Insert|Pause|ScrollLock)$/.test(e.code)) return null;
  return `${e.code} is needed for typing, so it can't be the hotkey without Ctrl, Alt or Meta. ` +
    'Try a function key or add a modifier, or press Esc to cancel.';
}

// --- Modals from the settings tab ------------------------------------------------
//
// Settings can have its own window (Obsidian's "settingsPopoutWindow", on by default).
// Modal.open() and keymap.pushScope() both go by the activeWindow global (app.js: the
// modal goes into activeWindow.document.body). Obsidian keeps that on the window that
// last had focus, and sets it itself when Settings opens, so this does the same for the
// window `el` is in: it's only a write if the global is out of date.
function useWindowOf(el) {
  const win = el.ownerDocument.defaultView;
  if (win && window.activeWindow !== win) {
    window.activeWindow = win;
    window.activeDocument = win.document;
  }
}

function openIn(modal, el) {
  useWindowOf(el);
  modal.open();
}

// Returns finish(value), which closes the modal and resolves with `value`. Closing it
// any other way (Esc, the X, a click outside) resolves with `fallback`.
function settle(modal, fallback, resolve) {
  let result = fallback;
  modal.onClose = () => {
    modal.contentEl.empty();
    resolve(result);
  };
  return (value) => {
    result = value;
    modal.close();
  };
}

// Resolves to true only when confirmed.
function askConfirm(app, el, title, text, action) {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.titleEl.setText(title);
    const finish = settle(modal, false, resolve);
    modal.contentEl.createEl('p', { text });
    new Setting(modal.contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => finish(false)))
      .addButton((b) => b.setButtonText(action).setWarning().onClick(() => finish(true)));
    openIn(modal, el);
  });
}

// Resolves to the trimmed name, or null when cancelled.
function askName(app, el) {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.titleEl.setText('New key map');
    const finish = settle(modal, null, resolve);
    const input = modal.contentEl.createEl('input', { type: 'text', attr: { placeholder: 'Name' } });
    input.addClass('math-dir-map-name');
    const submit = () => { if (input.value.trim()) finish(input.value.trim()); };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
    });
    new Setting(modal.contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => finish(null)))
      .addButton((b) => b.setButtonText('Create').setCta().onClick(submit));
    openIn(modal, el);
    input.focus();
  });
}

// The JSON of a map file in a plain textarea, which isn't on the layer's allowlist
// (followsLayer), so it never turns Hebrew. `save(text)` returns the reason it refused,
// or null. On a refusal the modal stays open with the reason.
function openMapEditor(app, el, title, text, save) {
  const modal = new Modal(app);
  modal.titleEl.setText(title);
  modal.modalEl.addClass('math-dir-map-modal');
  modal.onClose = () => modal.contentEl.empty();
  const area = modal.contentEl.createEl('textarea', { attr: { dir: 'ltr', spellcheck: 'false' } });
  area.addClass('math-dir-map-text');
  area.value = text;
  const errorEl = modal.contentEl.createEl('p');
  errorEl.addClass('math-dir-map-error');
  new Setting(modal.contentEl)
    .addButton((b) => b.setButtonText('Cancel').onClick(() => modal.close()))
    .addButton((b) => b.setButtonText('Save').setCta().onClick(async () => {
      try {
        const reason = await save(area.value);
        if (reason) errorEl.setText('Not saved: ' + reason + '.');
        else modal.close();
      } catch (err) {
        errorEl.setText('Not saved: ' + (err.message || err) + '.');
      }
    }));
  openIn(modal, el);
  return modal;
}

// The key is handled here: no default action, and no later listener sees it.
const consume = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };

// Can this keydown type text? A printable key; a dead key or one an IME holds
// (their text comes with a later event); or one the browser can't name. Named
// keys can't (Enter and the arrows pick from a menu), nor can Ctrl or Meta
// shortcuts. Alt can: AltGr reads as Ctrl+Alt on Windows, and there's Alt+numpad.
function canTypeText(e) {
  if (!e.key || e.metaKey || (e.ctrlKey && !e.altKey)) return false;
  return e.key.length === 1 || e.key === 'Unidentified' || e.key === 'Dead' || e.key === 'Process';
}

// Cross-window safe: popouts have their own HTMLElement globals.
const isElement = (x) => !!x && x.nodeType === 1;
const isTextInput = (el) =>
  el.tagName === 'TEXTAREA' ||
  (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'search' || el.type === ''));

// Never follow the layer here, even if a selector below would match.
const BLOCKED = '.modal.mod-settings, .vertical-tab-content, .cm-content';

// Text fields that follow the layer (checked against Obsidian 1.15 app.js), plus
// the Vim integration's fields while it runs. Quick switcher, command palette, other suggest modals; search pane and in-note
// search (Settings search is a modal, not a leaf).
const TEXT_FIELDS = 'input.prompt-input, .workspace-leaf .search-input-container input';

// Contenteditable note titles: inline title, tab-header title, file-explorer rename.
const TITLE_FIELDS = '.inline-title, .view-header-title, .nav-file-title-content, .nav-folder-title-content';

function followsLayer(el) {
  if (el.closest(BLOCKED)) return false;
  if (isTextInput(el)) {
    if (!el.matches(TEXT_FIELDS) && !(vimLink && el.matches(vimLink.extraTextFields()))) return false;
    return !(vimLink && vimLink.isExcludedField(el));
  }
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
// 6. Reading view
// ===========================================================================

// Containers whose children are a rendered note's sections: Reading view and
// embeds / hover previews (.markdown-preview-sizer), and MarkdownRenderer
// output (.markdown-rendered). Only these get the sibling sweep.
const SECTION_PARENTS = '.markdown-preview-sizer, .markdown-rendered';

function setSectionDir(el, dir) {
  el.classList.toggle('math-dir-rtl', dir === 'rtl');
  el.classList.toggle('math-dir-ltr', dir === 'ltr');
  el.setAttribute('dir', dir);
}

// ===========================================================================
// 7. PARSER NAMES — what relies on Obsidian's private Markdown tokenizer
// ===========================================================================
//
// ---- BEGIN PARSER NAMES ----
//
// Nothing else in the plugin reads Obsidian's syntax-node names. Facts checked
// against Obsidian 1.15 (app.js). Re-check this section after an update; the
// self-check (probeTokens) says what changed.
//
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

// Math ranges and code lines from the tree, from `from` (default 0: a line
// start outside math, see incrementalRegions) up to `limit`. Tokens that start
// before `from` are skipped. The begin / end delimiter tokens are read as
// pairs, so a region is exact from its opening $ to its closing $; a $$ still
// open at `limit` runs to `limit`.
// Returns { math: [{from,to,open}], codeKind: Map(line number → 'fence' | 'indent') }.
function tokenRegions(doc, tree, limit, from = 0) {
  const math = [];
  const codeKind = new Map();
  let open = -1;
  tree.iterate({
    from,
    to: limit,
    enter: (node) => {
      if (!node.type.name || isLineNode(node)) return; // Document, wrappers: look inside
      if (node.from < from) return; // before the restart point (containers: look inside)
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
// The active editor's EditorView, or null.
function activeView(app) {
  const ae = app.workspace.activeEditor;
  const cm = ae && ae.editor && ae.editor.cm;
  return cm && cm.state && cm.dom ? cm : null;
}

// The editor for the token check: the active one, or any.
function activeEditorView(app) {
  return activeView(app) || editorViews(app)[0] || null;
}

// The EditorView of `mdView` when it's in source mode (Live Preview included), or
// null. In Reading mode its editor can hold old text, so that goes the slower way,
// through the text, as does a view with no getMode. The embed class app.js assigns
// to activeEditor for a canvas card has getMode and editor, so it passes this test.
function sourceModeEditorView(mdView) {
  if (!mdView || typeof mdView.getMode !== 'function' || mdView.getMode() !== 'source') return null;
  const cm = mdView.editor && mdView.editor.cm;
  return cm && cm.state ? cm : null;
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
  if (!lang) return { ok: null, detail: 'no language on the editor' };
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
      res = { ok: null, detail: 'the throwaway parse produced no tokens' };
    } else {
      const { math, codeKind } = tokenRegions(d, tree, d.length);
      const ok = math.length === 2 &&
        math[0].from === 2 && math[0].to === 5 &&
        math[1].from === d.line(3).from && math[1].to === d.line(5).to &&
        codeKind.get(8) === 'fence';
      res = {
        ok,
        detail: ok ? 'math and fence tokens as expected'
          : 'unexpected tokens: ' + JSON.stringify({ math, code: [...codeKind] }),
      };
    }
  } catch (err) {
    res = { ok: null, detail: 'probe failed: ' + (err && err.message) };
  }
  tokenProbeCache.set(lang, res);
  return res;
}

// ---- END PARSER NAMES ----

// What the token check decides. A check that couldn't run (null) counts as passed.
const tokensAnswer = (r) => (r.tokens && typeof r.tokens.ok === 'boolean' ? r.tokens.ok : null);

// What the user loses when a feature is off.
const OFF_TEXT = {
  tokens: 'math/code from Obsidian\'s parser (the text parser is used instead)',
};

// A probe's answer as Diagnostics prints it.
const showProbe = (x) => (x === true ? 'pass' : x === false ? 'FAIL' : 'n/a');

// ===========================================================================
// 8. Plugin
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
    const flag = (key, name, desc, after) => new Setting(containerEl).setName(name).setDesc(desc)
      .addToggle((t) => t.setValue(p.settings[key]).onChange(async (v) => {
        p.settings[key] = v;
        await p.saveSettings();
        if (after) after();
      }));
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
    this.displayHotkey();
    this.displayMaps();
    flag('layoutWarning', 'Layout warning',
      'Show a notice (at most every 5 s) when the system keyboard is on Hebrew: a Hebrew letter arrives ' +
      'in the note or a field that follows the layer, or a Hebrew-layout key reaches Vim in normal / visual mode.');
    flag('vimMode', 'Vim mode (experimental, might be unstable)',
      'Works best with the Vim Motions plugin; Obsidian\'s own Vim mode gets all of this except jump labels. ' +
      'Adds visual h / l / x / X, Hebrew in f / t / r and Replace mode, and the fixes for a Hebrew system ' +
      'keyboard: normal-mode keys, Ctrl+[, jump labels and the : prompt.' +
      (p.vim ? p.vim.settingsNote() : ''),
      () => { p.applyVimMode(); this.display(); });
    if (p.settings.vimMode) {
      flag('visualMotions', 'Visual h / l',
        'Vim Motions: h, l, <Left>, <Right>, x and X move by what you see, not by character order, ' +
        'in Hebrew and across formulas. Off: stock logical motions.', () => { if (p.vim) p.vim.syncVim(); });
    }
    new Setting(containerEl)
      .setName('Diagnostics')
      .setDesc('Re-runs the self-checks on ' + (p.vim ? 'Vim Motions and ' : '') + 'Obsidian\'s parser, prints a table to the Console ' +
        '(Ctrl+Shift+I) and shows a summary.')
      .addButton((b) => b.setButtonText('Run diagnostics').onClick(() => p.diagnostics()));
  }

  displayHotkey() {
    const { containerEl } = this;
    const p = this.plugin;
    const set = (h) => p.setHotkey(h).then(() => this.display());
    new Setting(containerEl)
      .setName('Toggle hotkey')
      .setDesc('Current: ' + hotkeyLabel(p.settings.toggleHotkey) + '. Works by physical key, on any keyboard layout. ' +
        'The command stays in the palette and in Obsidian\'s Hotkeys; don\'t give it the same key there, or it toggles twice.')
      .addButton((b) => b.setButtonText('Change').onClick(() => {
        b.setButtonText('Press a key (Esc cancels)');
        p.recordHotkey(containerEl, () => this.display());
      }))
      .addButton((b) => b.setButtonText('Clear').onClick(() => set(null)))
      .addButton((b) => b.setButtonText('Reset to F12').onClick(() => set(F12)));
  }

  displayMaps() {
    const { containerEl, app } = this;
    const p = this.plugin;
    const maps = p.keyMaps;
    const current = p.settings.activeMap;
    // Runs one action on the map files, reports a failure, and redraws the tab.
    const run = async (action) => {
      try {
        await action();
      } catch (err) {
        new Notice('RTL Math Mix: the key map action failed: ' + (err.message || err));
      }
      this.display();
    };
    const names = [...maps.valid.values()].map((m) => m.name);
    new Setting(containerEl)
      .setName('Key map')
      .setDesc('What each key types while Hebrew typing is on. Maps are JSON files in the plugin\'s maps folder.')
      .addDropdown((d) => {
        for (const [id, m] of maps.valid) {
          d.addOption(id, names.indexOf(m.name) === names.lastIndexOf(m.name) ? m.name : `${m.name} (${id})`);
        }
        if (!maps.active()) d.addOption(current, 'Built-in original (' + current + '.json isn\'t available)');
        d.setValue(current).onChange((id) => run(() => maps.setActive(id)));
      });
    new Setting(containerEl)
      .setName('Manage key maps')
      .setDesc('New copies the current map. Edit works on the current map. Reload picks up changes made outside Obsidian.')
      .addButton((b) => b.setButtonText('New').onClick(() => run(async () => {
        const name = await askName(app, containerEl);
        if (name) await maps.create(name);
      })))
      .addButton((b) => b.setButtonText('Edit').onClick(() => run(async () => {
        const entry = maps.entry(current);
        if (!entry) throw new Error(current + '.json isn\'t there. Reload, or pick another map');
        const text = await maps.adapter.read(entry.path);
        openMapEditor(app, containerEl, 'Edit ' + current + '.json', text, async (edited) => {
          const reason = await maps.saveText(current, edited);
          if (!reason) this.display();
          return reason;
        });
      })))
      .addButton((b) => b.setButtonText('Delete').setDisabled(current === DEFAULT_MAP_ID).onClick(() => run(async () => {
        const sure = await askConfirm(app, containerEl, 'Delete key map',
          `Delete ${current}.json? This can't be undone. The default map becomes the current one.`, 'Delete');
        if (sure) await maps.remove(current);
      })))
      .addButton((b) => b.setButtonText('Reload').onClick(() => run(async () => {
        if (await maps.load()) new Notice('Key maps reloaded: ' + maps.valid.size + '.');
      })));
    new Setting(containerEl)
      .setName('Reset default map')
      .setDesc('Rewrites ' + DEFAULT_MAP_ID + '.json from the original built into the plugin. Your other maps stay.')
      .addButton((b) => b.setButtonText('Reset default map').setWarning().onClick(() => run(async () => {
        const sure = await askConfirm(app, containerEl, 'Reset default map',
          `Rewrite ${DEFAULT_MAP_ID}.json from the original? Any edits to it are lost.`, 'Reset');
        if (sure) await maps.resetDefault();
      })));
  }

  hide() {
    this.hebrewToggle = null;
    this.plugin.stopRecording();
    super.hide();
  }
}

module.exports = class HebrewMathPlugin extends Plugin {
  async onload() {
    this.lastText = null;
    this.lastDir = 'ltr';
    this.inserting = false;
    this.vim = vimLink = null; // the Vim integration while Vim mode is on (src/vim.js)
    this.sectionParents = new Map(); // ctx.docId → WeakRef(section container), see applySection
    this.probe = null;        // last probe result
    this.probePending = false;
    this.probeOverrides = {}; // for testing from the Console, see probeNow()
    this.notified = new Set();
    this.statusShown = null;
    this.windows = new Map(); // window → detach()
    this.recording = null;    // stops the hotkey recording in progress (recordHotkey)
    for (const k of Object.keys(features)) features[k] = null;
    await this.loadSettings();
    this.keyMaps = new KeyMaps(this);
    await this.keyMaps.load();

    // Shared helpers, for other plugins and the Console:
    // app.plugins.plugins['rtl-math-mix'].api
    this.api = {
      docDirection, scanLine, inlineClose, frontmatterEnd,
      regionsFor, textRegions, contextAt, inMathOrCode, translate, features,
      scanFor, perf,
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

    // No default hotkey here: settings.toggleHotkey is handled in onKeyDown, and with
    // both, Obsidian's keymap would run this as well and the key would toggle twice.
    this.addCommand({
      id: 'toggle-hebrew-typing',
      name: 'Toggle Hebrew typing',
      callback: () => this.toggle(),
    });

    // Hook 1: Hebrew layer for text typed into the note.
    // An input handler only sees text arriving in the editor: insert-mode typing,
    // and also a spell-check replacement (hence the check below). Vim commands in
    // normal/visual mode never reach it.
    // After translating, the Hebrew text is handed to the editor's *other* input
    // handlers (auto-pair brackets among them), exactly as if the OS had typed
    // it, so they behave the same as with the system Hebrew layout.
    const hebrewInput = (view, from, to, text) => {
      if (!this.settings.hebrew || view.composing || !text) return false;
      if (!hasMapped(text)) return false;
      // Only right after a key that can type text (hook 2 records it). A popout
      // that was open at load has no hook 2, so there it translates as before.
      if (this.windows.has(view.dom.ownerDocument.defaultView) &&
          Date.now() - (this.lastKeyAt || 0) > TYPED_WITHIN_MS) return false;
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
          if (typeof logException === 'function') logException(view.state, err, 'rtl-math-mix: input handler');
          else console.error('rtl-math-mix: input handler failed', err);
          return true;
        }
      }
      view.dispatch(defaultInsert());
      return true;
    };
    this.registerEditorExtension(Prec.highest(EditorView.inputHandler.of(hebrewInput)));

    // Hooks 2 and 3, on the main window and every popout:
    //   2. keydown, window capture: the layout warning and the status button; in
    //      Vim mode also Ctrl+[, ":" fallback, f/t/r. Vim Motions reads keys through CodeMirror
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

    // --- C. Probes and Vim mode ---------------------------------------------
    // The token check runs at layout ready, and when an editor opens if none
    // was open then. Vim mode brings its own events and timer (VimIntegration).
    this.registerEvent(this.app.workspace.on('layout-change', () => this.onLayoutChange()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.onLayoutChange()));
    if (this.settings.vimMode) this.startVim();
    this.app.workspace.onLayoutReady(() => {
      if (this.vim) this.vim.syncVim(); // probes on a new Vim object
      if (!this.probe) this.probeNow();
    });
  }

  onunload() {
    this.stopRecording();
    this.stopVim();
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

  // --- Per-keystroke work (Console) --------------------------------------------
  // p.perf: editor updates and their time (ms), region scans (full /
  // incremental / reused / text parser) and line-scan work (direction: full
  // walks, incremental maps, deciding line kept, lines walked). p.perfReset()
  // zeroes them.
  get perf() { return perf; }

  perfReset() {
    Object.assign(perf, PERF_ZERO);
    return perf;
  }

  // --- Settings ------------------------------------------------------------

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.toggleHotkey = cleanHotkey(this.settings.toggleHotkey);
    if (typeof this.settings.activeMap !== 'string' || !this.settings.activeMap) this.settings.activeMap = DEFAULT_MAP_ID;
  }

  saveSettings() {
    return this.saveData(this.settings);
  }

  // --- The toggle hotkey -----------------------------------------------------

  setHotkey(h) {
    this.settings.toggleHotkey = cleanHotkey(h);
    return this.saveSettings();
  }

  // Takes the next key press in the window `el` is in as the hotkey, then calls `done`.
  // Esc, losing focus, or closing the tab cancels. Three things keep the keys away from
  // everything else:
  //   • onKeyDown skips everything while this.recording is set;
  //   • these listeners consume the keys at window capture;
  //   • a catch-all scope. In a popout, Obsidian relays each key to the main window's
  //     keymap from a capture listener it added first (app.js), so that happens before
  //     anything here runs. Without the scope, Esc would close Settings.
  // A modifier on its own is refused when it's released: Ctrl goes down first on the
  // way to Ctrl+J, and that must not count.
  recordHotkey(el, done) {
    this.stopRecording();
    useWindowOf(el);
    const win = el.ownerDocument.defaultView;
    const shield = new Scope();
    shield.register(null, null, () => false);
    this.app.keymap.pushScope(shield);
    let loneModifier = false;
    const finish = () => { this.stopRecording(); done(); };
    const onDown = (e) => {
      if (!e.isTrusted) return;
      consume(e);
      if (e.repeat) return;
      if (e.key === 'Escape') { finish(); return; }
      const why = hotkeyRefusal(e);
      loneModifier = why === LONE_MODIFIER;
      if (loneModifier) return;
      if (why) { new Notice(why); return; }
      this.stopRecording();
      this.setHotkey(hotkeyOf(e)).then(done);
    };
    const onUp = (e) => {
      if (!e.isTrusted) return;
      consume(e);
      if (loneModifier && MODIFIER_KEYS.has(e.key)) {
        loneModifier = false;
        new Notice(LONE_MODIFIER);
      }
    };
    win.addEventListener('keydown', onDown, { capture: true });
    win.addEventListener('keyup', onUp, { capture: true });
    win.addEventListener('blur', finish);
    this.recording = () => {
      win.removeEventListener('keydown', onDown, { capture: true });
      win.removeEventListener('keyup', onUp, { capture: true });
      win.removeEventListener('blur', finish);
      this.app.keymap.popScope(shield);
    };
  }

  stopRecording() {
    const stop = this.recording;
    this.recording = null;
    if (stop) stop();
  }

  // --- Vim mode ------------------------------------------------------------

  startVim() {
    this.vim = vimLink = new VimIntegration(this);
    this.vim.start();
  }

  stopVim() {
    if (!this.vim) return;
    this.vim.stop();
    this.vim = vimLink = null;
  }

  // The Vim mode setting changed: applies at once, with no reload.
  applyVimMode() {
    const want = !!this.settings.vimMode;
    if (want === !!this.vim) return;
    if (want) {
      this.startVim();
      this.vim.syncVim(); // probes if there is a Vim object
      if (!this.vim.V) this.probeNow();
    } else {
      this.stopVim();
      this.probeNow();
    }
    this.redrawEditors();
  }

  // Every editor rebuilds its decorations and attributes.
  redrawEditors() {
    featureEpoch++;
    for (const v of editorViews(this.app)) {
      try { v.dispatch({}); } catch (e) { /* rebuilt on its next update anyway */ }
    }
  }

  // --- Probes ----------------------------------------------------------------

  // A token check that waited for an editor runs once one is open. With Vim mode
  // on, the Vim integration decides when waiting probes run.
  onLayoutChange() {
    if (!this.vim && this.probePending && activeEditorView(this.app)) this.probeNow();
  }

  // Runs the probes and applies the result. this.probeOverrides (Console only)
  // replaces probe fields, e.g. { tokens: { ok: false } }.
  // fromSync: called by the Vim integration's sync, which applies the settings itself.
  probeNow(fromSync) {
    const vim = this.vim;
    let r;
    try {
      if (vim) {
        r = vim.probe(this.probeOverrides);
      } else {
        const view = activeEditorView(this.app);
        r = Object.assign({ editor: !!view, tokens: probeTokens(view) }, this.probeOverrides);
        r.pending = !r.editor;
      }
    } catch (e) {
      console.error('rtl-math-mix: self-check failed to run', e);
      return null;
    }
    this.probe = r;
    this.probePending = r.pending; // probes that need an editor wait for one
    const f = vim ? vim.answers(r) : { tokens: tokensAnswer(r) };
    const before = Object.assign({}, features);
    // A probe that couldn't run this time (no editor, say) keeps the last
    // conclusive answer; a new Vim object clears the Vim ones.
    for (const k of Object.keys(f)) if (f[k] !== null) features[k] = f[k];
    if (before.tokens !== features.tokens) this.redrawEditors();
    if (vim) vim.afterProbe(before, fromSync);
    // One notice when something new turns off (naming everything that's off);
    // features already reported don't bring it back.
    const texts = vim ? vim.offText() : OFF_TEXT;
    const off = Object.keys(features).filter((k) => features[k] === false && texts[k]);
    const fresh = off.filter((k) => !this.notified.has(k));
    if (fresh.length) {
      for (const k of fresh) this.notified.add(k);
      new Notice('RTL Math Mix: a self-check failed, so this is off: ' +
        off.map((k) => texts[k]).join('; ') + '. Details: Settings → Diagnostics.', 15000);
      console.warn('rtl-math-mix: self-check turned off: ' + off.join(', '), r);
    }
    return r;
  }

  // Settings → Diagnostics (also callable from the Console). Prints the probe
  // table and returns its rows. The token check always; Vim rows only in Vim mode.
  diagnostics() {
    const r = this.probeNow() || this.probe || {};
    const tok = r.tokens || {};
    const vim = this.vim;
    const rows = [
      ...(vim ? vim.diagnosticsRows(r) : [{ check: 'editor open', result: showProbe(r.editor), feature: 'tokenizer check' }]),
      { check: 'tokenizer: math + fences', result: showProbe(tok.ok) + (tok.detail ? ' — ' + tok.detail : ''), feature: 'math/code regions' },
    ];
    for (const k of Object.keys(features)) rows.push({ check: 'feature ' + k, result: features[k] === false ? 'OFF' : features[k] === true ? 'on' : 'on (unchecked)', feature: '' });
    console.table(rows);
    const off = Object.keys(features).filter((k) => features[k] === false);
    new Notice('RTL Math Mix diagnostics: ' + (vim ? vim.loadedText(r) : 'Vim mode off') + '. ' +
      (off.length ? 'Off: ' + off.join(', ') + '.' : 'All features on.') +
      (this.probePending ? ' Open a note for the editor checks.' : '') + ' Table in the Console.', 10000);
    return rows;
  }

  // --- Hebrew layer ----------------------------------------------------------

  // Should the layout warning show for a key aimed at `el`? Only in the note
  // and the fields that follow the layer (plus Vim's prompts in Vim mode), not in
  // fields where the OS layout is used on purpose (Templater prompts, Settings …).
  warnsFor(el) {
    if (!isElement(el)) return false;
    return !!el.closest('.cm-content') || followsLayer(el) || (!!this.vim && this.vim.warnsFor(el));
  }

  // Hook 2: keys that must be handled before Vim / CodeMirror see them. The toggle
  // hotkey goes first; in Vim mode the order after it is: the status button, jump
  // labels, the layout warning, then the rest of the Vim keys (VimIntegration.onKeyDown).
  onKeyDown(e) {
    if (this.recording || !e.isTrusted || e.isComposing) return;
    if (hotkeyMatches(this.settings.toggleHotkey, e)) {
      consume(e);
      if (!e.repeat) this.toggle(); // holding the key toggles once
      return;
    }
    if (canTypeText(e)) this.lastKeyAt = Date.now();
    const target = e.target;

    // The status button.
    if (target === this.statusEl && (e.key === 'Enter' || e.key === ' ') &&
        !e.ctrlKey && !e.altKey && !e.metaKey) {
      consume(e);
      this.toggle();
      return;
    }

    if (this.vim && this.vim.onKeyDownLabels(e)) return;

    if (!isElement(target)) return;

    // Warn when the OS keyboard is on Hebrew. Only Hebrew *letters* count:
    // punctuation like / ' . , exists on both layouts and proves nothing.
    if (!e.ctrlKey && !e.altKey && !e.metaKey && isHebrewLetter(e.key) && this.warnsFor(target)) this.warnLayout();

    if (this.vim) this.vim.onKeyDown(e);
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
      this.applySection(el, this.dirFor(info.text), ctx.docId);
      return;
    }
    // Embeds, hover previews, export, Live Preview widgets: no section info,
    // so take the note's text from ctx.sourcePath: from an open
    // editor when there is one (its buffer, unsaved edits included, and
    // synchronous, so the section has its direction before anything snapshots
    // it), else the saved file (async).
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    // A Live Preview table renders each cell through here, so the active note's
    // direction comes from its line scan rather than a copy of its text per cell.
    const ae = this.app.workspace.activeEditor;
    const cm = ae && ae.file === file ? sourceModeEditorView(ae) : null;
    if (cm) {
      this.applySection(el, scanFor(cm.state.doc).direction(), ctx.docId);
      return;
    }
    const open = this.openText(file);
    if (open !== null) {
      this.applySection(el, this.dirFor(open), ctx.docId);
      return;
    }
    this.app.vault.cachedRead(file)
      .then((text) => this.applySection(el, this.dirFor(text), ctx.docId))
      .catch((err) => console.warn('rtl-math-mix: could not read ' + file.path + ' to set its direction', err));
  }

  // The text of `file` as an open editor holds it, or null. Public API only:
  // the active editor (workspace.activeEditor, which also covers an editor
  // inside a canvas card), else any Markdown leaf showing the file
  // (TextFileView.getViewData).
  openText(file) {
    try {
      const ae = this.app.workspace.activeEditor;
      // getViewData first: in Reading mode the view's source editor can be stale.
      // A canvas card has no getViewData.
      if (ae && ae.file === file && ae.editor) return typeof ae.getViewData === 'function' ? ae.getViewData() : ae.editor.getValue();
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        const v = leaf.view;
        if (v && v.file === file && typeof v.getViewData === 'function') {
          const text = v.getViewData();
          if (typeof text === 'string') return text;
        }
      }
    } catch (err) {
      console.warn('rtl-math-mix: could not read the open editor', err);
    }
    return null;
  }

  applySection(el, dir, docId) {
    setSectionDir(el, dir);
    // Sections that didn't change aren't re-rendered, so after the note's
    // direction flips (first Hebrew letter, or a `direction:` edit) update the
    // siblings this plugin already marked.
    // The parent remembers the last direction it was swept with, so a first
    // render with hundreds of sections sweeps once, not once per section. It's
    // also what the sections follow (styles.css): Reading view detaches sections
    // far from the viewport, out of the sweep's reach, and doesn't re-process
    // them when they come back. So a section that is detached right now still
    // has to reach the parent, through docId.
    // Only a rendered note's own section container is swept: never a
    // Live Preview widget's DOM, which CodeMirror owns.
    (el.win || window).requestAnimationFrame(() => {
      const known = docId && this.sectionParents.get(docId);
      const parent = el.parentElement || (known && known.deref());
      if (!parent || !parent.matches(SECTION_PARENTS)) return;
      if (docId) {
        if (this.sectionParents.size > 64) this.sectionParents.clear();
        this.sectionParents.set(docId, new WeakRef(parent));
      }
      if (parent.dataset.mathDir === dir) return;
      parent.dataset.mathDir = dir;
      for (const sib of Array.from(parent.children)) {
        if (sib !== el && (sib.classList.contains('math-dir-rtl') || sib.classList.contains('math-dir-ltr'))) {
          setSectionDir(sib, dir);
        }
      }
    });
  }
};
