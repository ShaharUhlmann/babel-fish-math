import { setup, check } from './lib.mjs';
const h = await setup();
const cur = async (l, c) => { await h.ev(`app.workspace.activeLeaf.view.editor.setCursor({line:${l},ch:${c}})`); await h.sleep(60); };
const line = (s, n) => s.text.split('\n')[n];
const notices = () => h.ev(`[...document.querySelectorAll('.notice')].map(n=>n.textContent).join(' | ')`);
const clearNotices = () => h.ev(`document.querySelectorAll('.notice').forEach(n=>n.remove())`);
// Windows layout on Hebrew: physical key → Hebrew char
const HEBKEY = { a: 'ש', k: 'ל', u: 'ו', o: 'ם', l: 'ך', d: 'ג', f: 'כ', h: 'י', i: 'ן', x: 'ס' };
const hebPhys = async (k, o = {}) => h.key(HEBKEY[k], { code: 'Key' + k.toUpperCase(), vk: k.toUpperCase().charCodeAt(0), ...o });
let s;

// Insert-mode Hebrew typing (English layout)
await h.doc('\n', 0, 0); await h.keys('iakuo'); await h.key('Escape'); s = await h.st();
check('M3 insert akuo → שלום', line(s, 0) === 'שלום', line(s, 0));

// f / r
const L = 'שלום שלום שלום שלום';
await h.doc(L + '\n', 0, 0); await h.keys('fa'); s = await h.st(); check('B13 fa → next ש', s.ch === 5, `ch=${s.ch}`);
await cur(0, 0); await h.keys('3fa'); s = await h.st(); check('B13 3fa → third ש', s.ch === 15, `ch=${s.ch}`);
await cur(0, 1); await h.keys('ra'); s = await h.st(); check('B13 ra → ש', line(s, 0).startsWith('ששום'), line(s, 0));
const wk = await h.ev(`[...document.querySelectorAll('[class*="which-key"]')].filter(e=>e.offsetParent).length`);
check('B13 which-key popup closed', wk === 0, `visible which-key elements=${wk}`);
await h.doc('$$\nx=a\n$$\nאבג שלום\n', 3, 0); await h.keys('fa'); s = await h.st(); check('B13 fa after display block', s.ch === 4, `ch=${s.ch}`);
await cur(1, 0); await h.keys('fa'); s = await h.st(); check('B14 fa inside display math → Latin a', s.ch === 2, `ch=${s.ch}`);
await h.doc('אב $x+a$ גד\n', 0, 4); await h.keys('fa'); s = await h.st(); check('B14 fa inside $…$ → Latin a', s.ch === 6, `ch=${s.ch}`);

// Windows layout on Hebrew in normal mode
await h.doc('abc def\n', 0, 0); await hebPhys('l'); await hebPhys('l'); s = await h.st();
check('B11 Windows-Hebrew ך ך (l l) moves', s.ch === 2, `ch=${s.ch}`);
await h.doc('one\ntwo\n', 0, 0); await hebPhys('d'); await hebPhys('d'); s = await h.st();
check('B11 Windows-Hebrew גג (dd) deletes line', s.text === 'two\n', JSON.stringify(s.text));

// Ctrl+[ (Windows Hebrew: the [ key gives ']')
await h.doc('\tשלום\n', 0, 1); await h.key('i'); await h.key(']', { code: 'BracketLeft', vk: 221, ctrl: true }); s = await h.st();
check('B15 Ctrl+[ on Windows-Hebrew → normal, no indent change', s.mode === 'normal' && line(s, 0) === '\tשלום', `${s.mode} ${JSON.stringify(line(s, 0))}`);
await h.key('i'); await h.key('[', { code: 'BracketLeft', vk: 219, ctrl: true }); s = await h.st();
check('B15 Ctrl+[ on Windows-English → normal', s.mode === 'normal' && line(s, 0) === '\tשלום', s.mode);

// Prompts
await h.doc('abc\n', 0, 0); await h.key('/'); await h.sleep(150); await h.keys('akuo');
let pv = await h.ev(`(document.activeElement && document.activeElement.value) || ''`);
check('B10 Vim / prompt types Hebrew', pv === 'שלום', `value=${pv}`);
await h.key(']', { code: 'BracketLeft', vk: 221, ctrl: true }); await h.sleep(150);
const promptOpen = await h.ev(`!!document.activeElement && document.activeElement.tagName === 'INPUT'`);
check('B15 Ctrl+[ closes / prompt', !promptOpen, `input focused=${promptOpen}`);
await h.key('Escape');
await h.ev(`app.commands.executeCommandById('command-palette:open')`); await h.sleep(300); await h.keys('akuo');
pv = await h.ev(`document.querySelector('.prompt-input')?.value`);
check('B10 command palette types Hebrew', pv === 'שלום', `value=${pv}`);
await h.key('Escape'); await h.sleep(200);
await h.ev(`app.commands.executeCommandById('switcher:open')`); await h.sleep(300); await h.keys('akuo');
pv = await h.ev(`document.querySelector('.prompt-input')?.value`);
check('B10 quick switcher types Hebrew', pv === 'שלום', `value=${pv}`);
await h.key('Escape'); await h.sleep(200);
await h.ev(`app.workspace.activeLeaf.view.editor.focus()`);

// Layout warning
await clearNotices(); await h.sleep(5200);
await h.doc('\n', 0, 0); await h.key('i'); await hebPhys('a'); await hebPhys('k'); await h.key('Escape'); await h.sleep(200);
let n = await notices(); check('B16 Windows-Hebrew typing → layout warning', n.length > 0, n.slice(0, 120));
await clearNotices(); await h.sleep(5200);
await h.doc('\n', 0, 0); await h.keys('iakuo'); await h.key('Escape'); await h.sleep(200);
n = await notices(); check('B16 Windows-English typing → no warning', n === '', n.slice(0, 80));
await h.ev(`app.plugins.plugins['babel-fish-math'].settings.layoutWarning = false`);
await clearNotices(); await h.sleep(5200);
await h.doc('\n', 0, 0); await h.key('i'); await hebPhys('a'); await h.key('Escape'); await h.sleep(200);
n = await notices(); check('M3 layout warning off → silent', n === '', n.slice(0, 80));
await h.ev(`app.plugins.plugins['babel-fish-math'].settings.layoutWarning = true`);

// M7 indented code types English
await h.doc('שלום\n\n    code\n', 2, 8); await h.key('a'); await h.keys('akuo'); await h.key('Escape'); s = await h.st();
check('M7 indented code types English', line(s, 2) === '    codeakuo', JSON.stringify(line(s, 2)));
await h.doc('שלום\n\n```\ncode\n```\n', 3, 4); await h.key('a'); await h.keys('akuo'); await h.key('Escape'); s = await h.st();
check('M7 fenced code types English', line(s, 3) === 'codeakuo', JSON.stringify(line(s, 3)));
await h.doc('שלום $x$\n', 0, 6); await h.key('i'); await h.keys('ab'); await h.key('Escape'); s = await h.st();
check('M3 inside $…$ types English', line(s, 0) === 'שלום $xab$', line(s, 0));

console.log('\nconsole errors/warnings:\n' + (h.logs.join('\n') || '(none)'));
h.close();
