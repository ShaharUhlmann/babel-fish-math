// Any Language Math (BabelFish): the Vim integration (v0.9.0). Runs only while the
// "Vim mode" setting is on, as one VimIntegration object (section V6), which is all
// the core talks to. At load this file only declares things and builds key tables.
//
// build.mjs appends this file to src/core.js, so it shares the core's top-level
// scope and uses its names (features, on, mappedKey, inMathOrCode, …). The core may
// name only the class VimIntegration from here; the build enforces that. The key map
// is read only through the core's mappedKey and originalKey.
//
// Vim-only features need private details of Vim Motions and its codemirror-vim
// fork. Facts below were checked against Vim Motions 1.5.1 (main.js) and Obsidian
// 1.15 (app.js). Re-check this file after an update; the probes (section V5) say
// what changed. A failed probe turns off only the feature that needs it, with one
// notice.
//
// Without Vim Motions this file meets Obsidian's own Vim: window.CodeMirrorAdapter.Vim
// is always there, and view.cm while Obsidian's Vim setting is on. It has no getMotion,
// getKeymap, jump labels, table scope or load event, and each of those is checked for.

// Safety-net re-check of the Vim registration. Vim Motions loading or reloading
// is caught at once through its load event (see VIM_LOAD_EVENT).
const VIM_CHECK_MS = 10000;

// The features that depend on the current Vim object (see `features` in the core),
// and all features in the order Diagnostics lists them.
const VIM_FEATURES = ['motions', 'visualMotions', 'charArgs', 'usKeys', 'escape', 'keymapCheck', 'cursorClass'];
const FEATURE_ORDER = ['motions', 'visualMotions', 'charArgs', 'usKeys', 'escape', 'keymapCheck', 'tokens', 'cursorClass'];

// ===========================================================================
// V1. Visual order and the visual h / l step (public CodeMirror API)
// ===========================================================================
//
// The order comes from CodeMirror itself: view.bidiSpans(line) gives each
// character's bidi level for that line, with this plugin's isolates and
// per-line direction, i.e. what is drawn. Reordering those levels (Unicode bidi
// rule L2) gives the characters from left to right. Section V2 turns visualStep
// into Vim motions.

// Grapheme clusters: a letter with its niqqud or other combining
// marks, a ZWJ emoji sequence, an emoji with a skin tone, a flag. h / l step
// over a cluster as one character. Intl.Segmenter does the splitting, but only
// on lines that have something it would join (CLUSTER_HINT); everywhere else a
// character is a code point, as before.
const CLUSTER_HINT = /[\p{M}\u200D\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}]/u;
const graphemes = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

// starts[i] = 1 where a cluster starts (starts[text.length] = 1 too), or null
// when every code point is its own cluster.
function clusterStarts(text) {
  if (!graphemes || !CLUSTER_HINT.test(text)) return null;
  const starts = new Uint8Array(text.length + 1);
  for (const s of graphemes.segment(text)) starts[s.index] = 1;
  starts[text.length] = 1;
  return starts;
}

// Line-relative offsets of the characters (cluster starts) of `line` (a
// CodeMirror Line), in visual order from left to right. A cluster takes the
// bidi level of its first code point (marks inherit it anyway, bidi rule W1).
function visualOrder(view, line, starts = clusterStarts(line.text)) {
  return reorder(characters(line.text, starts), lineLevels(view, line));
}

// Each code unit's bidi level, from view.bidiSpans(line).
function lineLevels(view, line) {
  const level = new Array(line.length).fill(0);
  const spans = view.bidiSpans(line);
  // Over CodeMirror's bidi length limit a line gets one level-0 span, though it's
  // still drawn RTL. A real RTL line always has a level of at least 1.
  if (spans.length === 1 && spans[0].level === 0 && typeof view.textDirectionAt === 'function' &&
      view.textDirectionAt(line.from) === Direction.RTL) return level.fill(1);
  for (const s of spans) {
    for (let i = s.from; i < s.to && i < line.length; i++) level[i] = s.level;
  }
  return level;
}

// The characters (cluster starts, or code points skipping the second half of
// a surrogate pair) of `text`, in logical order.
function characters(text, starts) {
  const seq = [];
  for (let i = 0; i < text.length; i++) {
    if (starts) {
      if (!starts[i]) continue; // inside a cluster
    } else {
      const c = text.charCodeAt(i);
      if (i > 0 && c >= 0xDC00 && c <= 0xDFFF) continue; // second half of a pair
    }
    seq.push(i);
  }
  return seq;
}

// Unicode bidi rule L2 on `seq` (offsets in logical order) with `level`:
// from the highest level down to 1, reverse every maximal run at that level or
// higher. Reorders `seq` in place and returns it.
function reorder(seq, level) {
  let max = 0;
  for (const i of seq) if (level[i] > max) max = level[i];
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

// End of the character (cluster) that starts at i.
function charEnd(text, i, starts) {
  if (starts) {
    let j = i + 1;
    while (j < text.length && !starts[j]) j++;
    return j;
  }
  const c = text.charCodeAt(i);
  return c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length ? i + 2 : i + 1;
}

// Soft wraps. The browser applies the bidi line rules (L1, L2)
// per visual row, after wrapping, with the levels of the whole paragraph:
//   • L1: whitespace at the end of a row goes back to the paragraph's level;
//   • L2: the row's characters are reordered on their own.
// The whole-line order is wrong at the joins when a run of the other
// direction (an inline formula in a Hebrew paragraph, say) is cut by the wrap:
// from the end of the formula's first part, the "next" character would be its
// second part, on the other row. So a wrapped line is ordered row by row, and
// the rows are joined in reading order: for an LTR line the next row continues
// to the right of the previous one, for an RTL line to its left (moving left
// from a row's left edge goes to the next row's right edge, as you read).
//
// The rows come from public CodeMirror API: view.lineWrapping, coordsAtPos
// (side 1: the box of the character after the position) and textDirectionAt.
// Row breaks are found by bisection over the line's characters (rows are
// contiguous in logical order), so a line of R rows costs about R·log(length)
// coordsAtPos calls, and an unwrapped line two. Anything unmeasurable (the line
// isn't drawn, no layout, an exception) leaves the whole-line order.
// Two character boxes are on one row when either one's vertical middle is
// inside the other (a tall formula widget and the text beside it included).
function sameRow(a, b) {
  const am = (a.top + a.bottom) / 2;
  const bm = (b.top + b.bottom) / 2;
  return (am >= b.top && am <= b.bottom) || (bm >= a.top && bm <= a.bottom);
}

// The line's characters (`chars`, logical order) in visual order, row by row
// on a soft-wrapped line. `level`: lineLevels.
function rowOrder(view, line, chars, level) {
  // With one bidi level on the line, row-by-row and whole-line order are the same.
  const rtl = typeof view.textDirectionAt === 'function' && view.textDirectionAt(line.from) === Direction.RTL;
  const uniform = chars.every((i) => level[i] === (rtl ? 1 : 0));
  if (!uniform && view.lineWrapping && typeof view.coordsAtPos === 'function' && chars.length > 1) {
    try {
      const rows = rowOrderMeasured(view, line, chars, level);
      if (rows) return rows;
    } catch (err) {
      // measuring failed: the whole-line order
    }
  }
  return reorder(chars.slice(), level);
}

// null when the line is one row or can't be measured.
function rowOrderMeasured(view, line, idx, level) {
  const box = (k) => view.coordsAtPos(line.from + idx[k], 1);
  const first = box(0);
  const last = box(idx.length - 1);
  if (!first || !last || sameRow(first, last)) return null;
  // No layout at all (both boxes empty): can't tell rows apart.
  if (first.bottom <= first.top && last.bottom <= last.top) return null;
  const breaks = []; // positions in idx where a new row starts
  const split = (lo, hi, blo, bhi) => {
    if (sameRow(blo, bhi)) return true;
    if (hi - lo === 1) { breaks.push(hi); return true; }
    const mid = (lo + hi) >> 1;
    const bmid = box(mid);
    if (!bmid) return false;
    return split(lo, mid, blo, bmid) && split(mid, hi, bmid, bhi);
  };
  if (!split(0, idx.length - 1, first, last) || !breaks.length) return null;
  const rtl = typeof view.textDirectionAt === 'function' && view.textDirectionAt(line.from) === Direction.RTL;
  const base = rtl ? 1 : 0;
  const lv = level.slice();
  const text = line.text;
  const rows = [];
  for (let r = 0, a = 0; r <= breaks.length; r++) {
    const b = r < breaks.length ? breaks[r] : idx.length;
    const chars = idx.slice(a, b);
    // L1: whitespace at the end of a row takes the base level. Not on the last
    // row: the end of the line is treated as in an unwrapped line (the levels
    // as bidiSpans gives them), so wrapping changes nothing there.
    if (r < breaks.length) {
      for (let k = chars.length - 1; k >= 0 && /\s/.test(text[chars[k]]); k--) lv[chars[k]] = base;
    }
    rows.push(reorder(chars, lv));
    a = b;
  }
  if (rtl) rows.reverse();
  return [].concat(...rows);
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
  if (!line.length) return undefined;
  const starts = clusterStarts(line.text);
  const seq = rowOrder(view, line, characters(line.text, starts), lineLevels(view, line));
  if (!seq.length) return undefined;
  let ch = Math.min(ch0, line.length - 1);
  if (starts) while (ch > 0 && !starts[ch]) ch--; // inside a cluster: its start
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
  return { from, to: charEnd(line.text, last, starts) };
}

// ===========================================================================
// V2. Vim Motions and codemirror-vim: API, motions, DOM
// ===========================================================================
//
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

// Is Vim Motions itself loaded? CodeMirrorAdapter.Vim doesn't say: Obsidian's app.js
// sets it at startup for its own Vim mode (window.CodeMirrorAdapter=Io; Io.Vim=…),
// whether that mode is on or not. Vim Motions replaces it with its getter and adds
// setKeyInterceptActive next to it, and deletes both when it unloads (Yw / Zw in its
// main.js). The answer is only for the user; the features go by what is there.
function vimMotionsLoaded() {
  try {
    const a = window.CodeMirrorAdapter;
    return !!a && typeof a.setKeyInterceptActive === 'function';
  } catch (err) {
    return false;
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
    try { signal(cm, 'vim-keypress', key); } catch (err) { console.error('babel-fish-math: signal failed', err); }
  }
  return !!handled;
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

// Is Vim in Replace mode (R, gR)? Vim Motions overwrites the text itself in its
// key handler (cm.state.overwrite), so typed keys never reach inputHandler.
function vimOverwrite(view) {
  const vim = vimState(view);
  return !!vim && vim.insertMode && !!view.cm.state.overwrite;
}

// codemirror-vim keeps the pending keys in vim.inputState.keyBuffer (an array
// in the fork; a string in older upstream versions).
// The f / F / t / T / r command waiting for its character, or null:
//   { cmd: 'f' | 'F' | 't' | 'T' | 'r', count, pos }
// `count` is the repeat Vim will use: the count typed before f (still in the
// keyBuffer: "3f") times a count typed before an operator (inputState.
// prefixRepeat, pushed when the operator matched: "2d3f" → 6), as in the
// fork's InputState.getRepeat(). `pos` is the doc offset Vim searches from:
// the cursor, or in visual mode the selection's moving end as Vim tracks it
// (vim.sel.head, a {line, ch} Pos).
function pendingCharArg(view) {
  const vim = vimState(view);
  if (!vim || vim.insertMode) return null;
  const is = vim.inputState;
  const buf = is && is.keyBuffer;
  const keys = Array.isArray(buf) ? buf.join('') : (buf || '');
  const m = /^(\d*)([fFtTr])$/.exec(keys);
  if (!m) return null;
  let count = m[1] ? parseInt(m[1], 10) || 1 : 1;
  const pre = is && Array.isArray(is.prefixRepeat) ? is.prefixRepeat.join('') : '';
  if (pre) count *= parseInt(pre, 10) || 1;
  const doc = view.state.doc;
  let pos = view.state.selection.main.head;
  const h = vim.visualMode && vim.sel && vim.sel.head;
  if (h && typeof h.line === 'number' && typeof h.ch === 'number' && h.line >= 0 && h.line < doc.lines) {
    const line = doc.line(h.line + 1);
    pos = line.from + Math.max(0, Math.min(h.ch, line.length));
  }
  return { cmd: m[2], count, pos };
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

// Logical h / l: stock moveByCharacters without its whichwrap or Vim Motions'
// cell crossing (Vim clips the result to the line). What the visual motion falls
// back to, and what stockVimMotion falls back to without getMotion.
function logicalVimMotion(left) {
  return (cm, head, motionArgs) => {
    const n = Math.max(1, motionArgs.repeat || 1);
    return new head.constructor(head.line, left ? head.ch - n : head.ch + n);
  };
}

// Really stock h / l: whatever moveByCharacters is at the moment of the key. Late
// bound, because Vim Motions swaps it while a table scope is up (defineMotion
// ("moveByCharacters", …) in its main.js), which is its cell crossing, and restores
// it later. getMotion returns that entry bound to the motion table. No recursion:
// nothing here defines moveByCharacters, and it never calls our two names. Obsidian's
// own Vim has no getMotion, so there it's the logical motion.
function stockVimMotion(V, left) {
  const fallback = logicalVimMotion(left);
  return (cm, head, motionArgs, vim, inputState) => {
    const stock = typeof V.getMotion === 'function' ? V.getMotion('moveByCharacters') : null;
    return stock ? stock(cm, head, motionArgs, vim, inputState) : fallback(cm, head, motionArgs);
  };
}

// Is this the editor of a Live Preview table cell? Obsidian mounts that editor
// (editMode.tableCell.cm, which Vim Motions' cell helpers read) inside the cell,
// so inside the table widget (app.js editTableCell), and Vim Motions finds the
// widget by the same class (ju in its main.js). The note's own editor is outside
// it. Unknown (no view, a renamed class) counts as "no": h / l clamp at the edge.
function inTableCell(cm) {
  try {
    const dom = cm && cm.cm6 && cm.cm6.dom;
    return !!dom && !!dom.closest('.cm-table-widget');
  } catch (err) {
    return false;
  }
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
    if ('ch' in r) {
      // At a visual edge of a table cell, step logically as stock does, so the
      // key doesn't stick. Operators (x, dl) never get here.
      if (r.ch === head.ch && inTableCell(cm)) return fallback(cm, head, motionArgs);
      return new Pos(head.line, r.ch);
    }
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

// visual = false binds the same names to stock h / l (setting off, a failed probe,
// and on stop and unload: the commands can't be removed safely). x and X stay delete
// operators then: their entries give the operator and motionArgs.forward, which is
// all moveByCharacters reads, as in the default x and X.
function defineVimMotions(V, visual) {
  V.defineMotion(MOTION_LEFT, visual ? visualVimMotion(true) : stockVimMotion(V, true));
  V.defineMotion(MOTION_RIGHT, visual ? visualVimMotion(false) : stockVimMotion(V, false));
}

// Marks a Vim object that has our commands, where the keymap can't be read to tell
// (no getKeymap, as in Obsidian's own Vim). That object outlives toggling Vim mode
// and reloading this plugin, so without the mark the commands would stack.
const COMMANDS_MAPPED = Symbol.for('math-dir.commands-mapped');

function mapVimCommands(V) {
  for (const [keys, type, name, args, extra] of VIM_COMMANDS) V.mapCommand(keys, type, name, args, extra);
}

// Adds only the commands missing from the keymap, so a user map placed in front
// of them wins and toggling this plugin doesn't stack duplicates. Copies the
// whole keymap: called on a Vim (re)load and by the 10 s safety net only.
function ensureVimCommands(V) {
  const km = V.getKeymap('normal');
  for (const [keys, type, name, args, extra] of VIM_COMMANDS) {
    const motion = extra ? extra.motion : name;
    if (!km.some((e) => e.keys === keys && e.motion === motion)) V.mapCommand(keys, type, name, args, extra);
  }
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
const VIM_TEXT_FIELDS = VIM_PANEL + ' input, input.vim-motions-picker-input, input.vim-motions-input-modal-input';

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
    console.error('babel-fish-math: could not relabel the key', err);
    return false;
  }
}

// ===========================================================================
// V3. Hebrew-OS keys and f / t / r characters
// ===========================================================================

// What each physical key (e.code) types on a US-English layout, without Shift.
// Used by every Hebrew-OS-layout fallback: the ":" prompts (VimIntegration), jump
// labels (labelKey), and normal / visual mode keys in the note (HE_OS / usKey).
const US = {
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  BracketLeft: '[', BracketRight: ']', Backquote: '`',
};
for (const c of 'qwertyuiopasdfghjklzxcvbnm') US['Key' + c.toUpperCase()] = c;

// The US key a normal / visual-mode key stands for when the OS layout is
// Hebrew, or null. Vim Motions turns a non-ASCII key into the last letter of
// e.code (Period → "d", Comma → "a", Semicolon → "n"), and ASCII keys pass as
// they are ("/" sends ".", q sends "/", w sends "'", ' sends ",", ` sends ";",
// [ and ] are swapped). Only when e.key is exactly what the Hebrew layout types
// on that key (HE_OS), so other layouts are never touched. Unshifted keys only:
// what the Hebrew layout gives with Shift isn't in this table, so shifted keys
// pass unchanged (Shift+letter is a Latin capital there anyway).
// Built from the embedded original, never from the active map: this describes what
// Windows' Hebrew layout sends, and the user's key map doesn't change that.
const HE_OS = {};
for (const code of Object.keys(US)) {
  const he = code === 'Backquote' ? ';' : originalKey(US[code]);
  if (he) HE_OS[code] = he;
}
function usKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return null;
  return HE_OS[e.code] && e.key === HE_OS[e.code] ? US[e.code] : null;
}

// The character an f / F / t / T / r argument gets with the layer on.
// `arg` is pendingCharArg's { cmd, count, pos }, `key` the typed key (one
// that the active key map maps). First choice by the cursor's context: the
// Hebrew character in text, the key itself in math or code. For f / F / t / T,
// if the first choice has fewer than `count` matches on the cursor's line in
// the search direction (after the cursor for f / t, before it for F / T; for
// t / T not counting the character right beside the cursor) and
// the other one has enough, the other one is used. r (replace) always takes
// the first choice: there's nothing to match.
function charArgFor(state, arg, key) {
  const he = mappedKey(key);
  const inMath = inMathOrCode(state, arg.pos);
  const first = inMath ? key : he;
  if (arg.cmd === 'r') return first;
  const second = inMath ? he : key;
  const line = state.doc.lineAt(arg.pos);
  const at = arg.pos - line.from;
  // t / T stop next to the match, so a match right beside the cursor doesn't
  // move it and doesn't count.
  const skip = arg.cmd === 't' || arg.cmd === 'T' ? 1 : 0;
  const range = arg.cmd === 'f' || arg.cmd === 't'
    ? line.text.slice(at + 1 + skip)
    : line.text.slice(0, Math.max(0, at - skip));
  const enough = (c) => range.split(c).length - 1 >= arg.count;
  return enough(first) || !enough(second) ? first : second;
}

// ===========================================================================
// V4. The block cursor's direction
// ===========================================================================
//
// Direction of the text at `pos` (the character under Vim's block cursor), for
// the class math-dir-cur-* on .cm-editor (styles.css). Vim Motions draws that
// character again in its own cursor layer (.cm-vimCursorLayer, inside .cm-editor),
// which would otherwise inherit the note's direction and mirror < > ( ) [ ] { }
// inside math. `p` is the editor's MathDirView.
function dirAt(p, state, pos) {
  if (p.dir === 'ltr') return 'ltr';
  let inMath = false;
  p.marks.between(pos, pos + 1, (from, to) => {
    if (from <= pos && pos < to) { inMath = true; return false; }
  });
  if (inMath) return 'ltr';
  const lineFrom = state.doc.lineAt(pos).from;
  let dir = p.dir;
  p.deco.between(lineFrom, lineFrom, (from, to, value) => {
    if (value === LINE.ltr) dir = 'ltr';
    else if (value === LINE.rtl) dir = 'rtl';
  });
  return dir;
}

// ===========================================================================
// V5. Probes, and the features they decide
// ===========================================================================

// The editor to probe: the active one if Vim Motions is on it, else any that
// has Vim Motions, else the active one or any.
function vimEditorView(app) {
  const active = activeView(app);
  if (active && active.cm) return active;
  const views = editorViews(app);
  return views.find((x) => x.cm) || active || views[0] || null;
}

const VIM_METHODS = ['handleKey', 'defineMotion', 'mapCommand', 'getKeymap'];

// All probes. `view`: an editor to probe (may be null). Cheap: no keymap copy
// beyond one getKeymap call, a 40-character throwaway parse (cached per
// language), and a few property reads.
function probeAll(view) {
  const V = vimApi();
  const cm = view && view.cm;
  const r = {
    vimMotions: vimMotionsLoaded(),
    vimLoaded: !!V,
    methods: {},
    multiSelect: null,
    keymapShape: null,
    editor: !!view,
    vimOnEditor: !!cm,
    keyBuffer: null,
    backPointer: null,
    cursorLayer: null,
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
    tokens: tokensAnswer(r),
    cursorClass: r.vimOnEditor ? yes(r.cursorLayer) : null,
  };
}

// What the user loses when a feature is off.
const VIM_OFF_TEXT = {
  motions: 'visual h/l (Vim Motions has no defineMotion / mapCommand)',
  visualMotions: 'visual h/l (stock logical h/l instead)',
  charArgs: 'Hebrew f/t/r characters and Replace mode (English instead)',
  usKeys: 'US keys in normal mode on a Hebrew OS layout',
  escape: 'Ctrl+[ as Escape in the note on a Hebrew OS layout',
  keymapCheck: 'keymap check (motions mapped once per Vim Motions load)',
  tokens: OFF_TEXT.tokens,
  cursorClass: 'block-cursor direction fix',
};
// ===========================================================================
// V6. VimIntegration: all the core sees of this file
// ===========================================================================

class VimIntegration {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.V = null;            // the Vim object our motions are defined on
    this.vimVisual = null;    // whether they are the visual or the stock ones
    this.needMap = false;     // the commands still have to be mapped on this.V
    this.eventRefs = [];
    this.interval = null;
  }

  // Register the motions when Vim Motions loads (its load event), at layout ready
  // and on layout changes (a cheap "is it a new Vim object?" check). A 10 s safety
  // net also re-adds commands something dropped (a Lua :mapclear, say). The probes
  // run at layout ready and on each new Vim object; probes that need an editor
  // wait for one to open. This only sets things up: the core calls syncVim when
  // the layout is ready, or at once for the settings toggle.
  start() {
    const tokens = features.tokens;
    delete features.tokens;
    for (const k of FEATURE_ORDER) features[k] = k === 'tokens' ? tokens : null;
    this.plugin.api.visualOrder = visualOrder;
    const ws = this.app.workspace;
    this.eventRefs = [
      ws.on(VIM_LOAD_EVENT, () => this.syncVim()),
      ws.on('layout-change', () => this.onLayoutChange()),
      ws.on('active-leaf-change', () => this.onLayoutChange()),
    ];
    this.interval = window.setInterval(() => this.syncVim(true), VIM_CHECK_MS);
  }

  // Everything stops. The commands can't be removed safely (removeMapCommand would
  // also drop Vim's own h / l), so they stay, bound to stock h / l.
  stop() {
    const V = vimApi();
    if (V && V === this.V && on('motions')) {
      try { defineVimMotions(V, false); } catch (e) { console.error('babel-fish-math: could not reset the Vim motions', e); }
    }
    this.V = null;
    this.vimVisual = null;
    for (const ref of this.eventRefs) this.app.workspace.offref(ref);
    this.eventRefs = [];
    window.clearInterval(this.interval);
    this.interval = null;
    delete this.plugin.api.visualOrder;
    for (const k of VIM_FEATURES) {
      delete features[k];
      this.plugin.notified.delete(k);
    }
  }

  // Pending editor probes run once an editor with Vim Motions on it exists
  // (a cheap check; the probe itself copies the keymap).
  onLayoutChange() {
    if (this.plugin.probePending) {
      const view = vimEditorView(this.app);
      if (view && view.cm) this.plugin.probeNow();
    }
    this.syncVim();
  }

  // full: also check that our commands are still in the keymap (the safety
  // net). A new Vim object always gets the full treatment, probes first.
  syncVim(full) {
    try {
      const V = vimApi();
      if (!V) {
        this.V = null; // no Vim Motions: its own h / l (if any) apply
        this.vimVisual = null;
        return;
      }
      const isNew = V !== this.V;
      if (isNew) {
        this.V = V;
        this.vimVisual = null;
        this.needMap = true;
        for (const k of VIM_FEATURES) features[k] = null; // answers were for the old object
        this.plugin.probeNow(true);
      }
      if (!on('motions')) return;
      const visual = !!this.plugin.settings.visualMotions && on('visualMotions');
      if (visual !== this.vimVisual) {
        defineVimMotions(V, visual);
        this.vimVisual = visual;
      }
      // needMap: also after the motions come back from a failed probe.
      if (this.needMap || (full && on('keymapCheck'))) {
        this.needMap = false;
        if (on('keymapCheck')) {
          ensureVimCommands(V);
        } else if (!V[COMMANDS_MAPPED]) { // can't check: once per Vim object
          V[COMMANDS_MAPPED] = true;
          mapVimCommands(V);
        }
      }
    } catch (e) {
      console.error('babel-fish-math: could not register the Vim motions', e);
    }
  }

  // --- For the core's probeNow and diagnostics ---------------------------------

  // The probe result. overrides (Console only) replaces probe fields, e.g.
  // { backPointer: false } or { tokens: { ok: false } }.
  probe(overrides) {
    const r = Object.assign(probeAll(vimEditorView(this.app)), overrides);
    if (overrides.methods) r.methods = Object.assign({}, r.methods, overrides.methods);
    // Probes that need an editor with Vim Motions on it wait for one.
    r.pending = r.vimLoaded ? !r.vimOnEditor : !r.editor;
    return r;
  }

  answers(r) {
    return featuresFrom(r);
  }

  afterProbe(before, fromSync) {
    if (before.cursorClass !== features.cursorClass) this.plugin.redrawEditors();
    if (!fromSync && (before.motions !== features.motions || before.visualMotions !== features.visualMotions)) {
      this.syncVim();
    }
  }

  // What a turned-off feature loses, for the notice. Motions off already says that
  // visual h/l is gone. Obsidian's own Vim has no getKeymap: expected, not a failure.
  offText() {
    const texts = Object.assign({}, VIM_OFF_TEXT);
    if (features.motions === false) delete texts.visualMotions;
    if (!vimMotionsLoaded()) delete texts.keymapCheck;
    return texts;
  }

  diagnosticsRows(r) {
    const show = showProbe;
    const m = r.methods || {};
    return [
      { check: 'Vim Motions plugin', result: show(r.vimMotions), feature: 'load event, jump labels, flash search' },
      { check: 'Vim API loaded', result: show(r.vimLoaded), feature: 'everything Vim' },
      ...VIM_METHODS.map((k) => ({ check: 'Vim.' + k, result: show(r.vimLoaded ? m[k] : null), feature: k === 'handleKey' ? 'f/t/r, Ctrl+[' : k === 'getKeymap' ? 'keymap check' : 'visual h/l' })),
      { check: 'Vim.multiSelectHandleKey', result: show(r.multiSelect), feature: 'optional (handleKey otherwise)' },
      { check: 'keymap entries carry motion names', result: show(r.keymapShape), feature: 'keymap check' },
      { check: 'editor open', result: show(r.editor), feature: 'editor probes below' },
      { check: 'Vim on that editor', result: show(r.vimOnEditor), feature: 'editor probes below' },
      { check: 'Vim key buffer readable', result: show(r.keyBuffer), feature: 'f/t/r, US keys' },
      { check: 'editor back-pointer', result: show(r.backPointer), feature: 'visual h/l' },
      { check: 'Vim cursor layer', result: show(r.cursorLayer), feature: 'cursor direction fix' },
    ];
  }

  // For the Diagnostics notice.
  loadedText(r) {
    if (r.vimMotions) return 'Vim Motions loaded';
    return r.vimLoaded ? 'Vim Motions not loaded (Obsidian\'s own Vim API found)' : 'Vim Motions not loaded';
  }

  // Added to the Vim mode setting's description.
  settingsNote() {
    return vimMotionsLoaded() ? '' : ' Vim Motions isn\'t loaded at the moment, so only what Obsidian\'s own Vim mode supports can work.';
  }

  // --- For the editor and the layer -------------------------------------------

  // Extra class for .cm-editor: the block cursor's direction (section V4).
  editorClass(p, state) {
    return on('cursorClass') ? ' math-dir-cur-' + dirAt(p, state, state.selection.main.head) : '';
  }

  extraTextFields() {
    return VIM_TEXT_FIELDS;
  }

  // A field that matches an allowlist but must stay out of the layer.
  isExcludedField(el) {
    return isExPrompt(el);
  }

  // The layout warning also shows in Vim's prompts.
  warnsFor(el) {
    return isVimPanelInput(el) || isExPrompt(el);
  }

  // --- Hook 2, the keydown handler ---------------------------------------------

  // Before the layout warning. True: the key is dealt with.
  // Jump labels with the OS layout on Hebrew: let Vim Motions see the
  // physical Latin key (relabel). Shift+letter already gives Latin capitals
  // on that layout. Independent of the Hebrew-typing toggle.
  onKeyDownLabels(e) {
    const target = e.target;
    const doc = (isElement(target) && target.ownerDocument) || document;
    if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      const en = labelKey(e, doc);
      if (en) {
        relabel(e, en);
        return true;
      }
    }
    return false;
  }

  // After the layout warning, for a key aimed at an element.
  onKeyDown(e) {
    const target = e.target;
    const doc = target.ownerDocument || document;

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
        consume(e);
        target.blur();
        return;
      }
      if (!on('escape')) return;
      const view = viewForTarget(target);
      if (!view || !canFeedKeys()) return;
      consume(e);
      feedKey(view, '<Esc>');
      return;
    }

    // Shift is allowed through: ( ) { } need it, and Shift+letter (Latin
    // capitals) isn't in the Hebrew map, so it passes through unchanged.
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    // The ":" command line types English even when the OS layout is Hebrew.
    if (isExPrompt(target)) {
      const en = usKey(e);
      if (!en) return;
      consume(e);
      this.plugin.insertText(target, en);
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
      if (view && vimApi() && vimCommandMode(view) && !pendingCharArg(view) &&
          !labelsVisible(doc) && !vimKeyReaderActive()) {
        if (relabel(e, us)) this.plugin.warnLayout();
        return;
      }
    }

    // Vim character arguments in the note (fש, 3tש, rש): Hebrew outside math
    // and code, with a fallback for f / F / t / T (charArgFor). When the
    // answer is the key itself, the event goes on and Vim reads it as typed.
    // Either way Vim records the character it got, so ; and , repeat it, and
    // Vim Motions' flash labels search for it.
    // Replace mode (R, gR) gets the Hebrew character the same way, outside math
    // and code, also when the OS layout is Hebrew (Vim Motions would turn that key
    // into an English letter).
    const hebrewKey = isHebrewLetter(e.key);
    if (!this.plugin.settings.hebrew || !(mappedKey(e.key) || hebrewKey) || !on('charArgs')) return;
    const view = viewForTarget(target);
    if (!view || !canFeedKeys()) return;
    const arg = pendingCharArg(view);
    if (!arg) {
      if (vimOverwrite(view) && !inMathOrCode(view.state, view.state.selection.main.head)) {
        consume(e);
        const replacement = hebrewKey ? e.key : mappedKey(e.key);
        // Vim Motions' fork overwrites inside handleKey. Obsidian's own Vim says "not
        // handled" and overwrites in its key handler (app.js), which a consumed key
        // never reaches, so do what that handler does.
        if (!feedKey(view, replacement) && typeof view.cm.overWriteSelection === 'function') {
          view.cm.overWriteSelection(replacement);
        }
      }
      return;
    }
    if (hebrewKey) return;
    const ch = charArgFor(view.state, arg, e.key);
    if (ch === e.key) return;
    consume(e);
    feedKey(view, ch);
  }
}
