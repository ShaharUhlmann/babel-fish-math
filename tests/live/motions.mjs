import { setup, check, results } from './lib.mjs';
const h = await setup();
const HEB = 'שלום עולם';
const T = `${HEB}\nabc def\nאב $x+1$ גד\nאבגדהוזח\n`;
const cur = async (l, c) => { await h.ev(`app.workspace.activeLeaf.view.editor.setCursor({line:${l},ch:${c}})`); await h.sleep(60); };
const line = (s, n) => s.text.split('\n')[n];
let s;

// J1 / J2 / arrows
await h.doc(T, 0, 0); await h.keys('3h'); s = await h.st(); check('J1 3h from ש → ם', s.ch === 3, `ch=${s.ch}`);
await h.keys('3l'); s = await h.st(); check('J1 3l back → ש', s.ch === 0, `ch=${s.ch}`);
await cur(0, 0); await h.key('ArrowLeft'); s = await h.st(); check('J13 <Left> from ש → ל', s.ch === 1, `ch=${s.ch}`);
await h.key('ArrowRight'); s = await h.st(); check('J13 <Right> back → ש', s.ch === 0, `ch=${s.ch}`);
await cur(0, 0); await h.key('3'); await h.key('ArrowLeft'); s = await h.st(); check('J13 3<Left> → ם', s.ch === 3, `ch=${s.ch}`);
await h.key('3'); await h.key('ArrowRight'); s = await h.st(); check('J13 3<Right> → ש', s.ch === 0, `ch=${s.ch}`);
await cur(1, 0); await h.keys('3l'); s = await h.st(); check('J2 3l on abc → space', s.ch === 3, `ch=${s.ch}`);
await cur(1, 4); await h.keys('2h'); s = await h.st(); check('J2 2h from d → c', s.ch === 2, `ch=${s.ch}`);
await cur(1, 0); await h.key('ArrowRight'); s = await h.st(); check('J13 <Right> English → b', s.ch === 1, `ch=${s.ch}`);
await h.key('ArrowLeft'); s = await h.st(); check('J13 <Left> English → a', s.ch === 0, `ch=${s.ch}`);

// J3–J7 operators
await h.doc(T, 0, 2); await h.keys('dl'); s = await h.st(); check('J3 dl on ו', line(s, 0) === 'שלם עולם', line(s, 0));
await h.doc(T, 0, 2); await h.keys('3dl'); s = await h.st(); check('J3 3dl on ו', line(s, 0) === 'ם עולם', line(s, 0));
await h.doc(T, 1, 0); await h.keys('3dl'); s = await h.st(); check('J3 3dl English', line(s, 1) === ' def', line(s, 1));
await h.doc(T, 0, 2); await h.keys('dh'); s = await h.st(); check('J4 dh on ו → deletes ם', line(s, 0) === 'שלו עולם', line(s, 0));
await h.doc(T, 1, 2); await h.keys('dh'); s = await h.st(); check('J4 dh English on c', line(s, 1) === 'ac def', line(s, 1));
await h.doc(T, 1, 0); await h.keys('dh'); s = await h.st(); check('J4 dh at line start: nothing', line(s, 1) === 'abc def', line(s, 1));
await h.doc(T, 0, 2); await h.keys('cl'); s = await h.st(); check('J5 cl on ו', line(s, 0) === 'שלם עולם' && s.mode === 'insert' && s.ch === 2, `${line(s, 0)} ${s.mode} ch=${s.ch}`);
await h.key('Escape');
await h.doc(T, 0, 2); await h.keys('yl');
const reg = await h.ev(`CodeMirrorAdapter.Vim.getRegisterController().getRegister('"').toString()`);
await h.keys('p'); s = await h.st(); check('J6 yl → register ו, p pastes', reg === 'ו' && line(s, 0).length === HEB.length + 1, `reg=${reg} line=${line(s, 0)}`);
await h.doc(T, 0, 2); await h.keys('x'); s = await h.st(); check('J7 x on ו', line(s, 0) === 'שלם עולם', line(s, 0));
await h.doc(T, 0, 2); await h.keys('3x'); s = await h.st(); check('J7 3x on ו', line(s, 0) === 'ם עולם', line(s, 0));
await h.doc(T, 1, 0); await h.keys('3x'); s = await h.st(); check('J7 3x English', line(s, 1) === ' def', line(s, 1));

// J8 visual
await h.doc(T, 1, 0); await h.keys('vlld'); s = await h.st(); check('J8 vlld English', line(s, 1) === ' def', line(s, 1));
await h.doc(T, 0, 0); await h.keys('vhh'); s = await h.st(); check('J8 vhh Hebrew selects שלו', s.sel === 'שלו', `sel=${s.sel}`);
await h.keys('d'); s = await h.st(); check('J8 vhh d', line(s, 0) === 'ם עולם', line(s, 0));
await h.doc(T, 0, 0); await h.key('v'); await h.key('ArrowLeft'); await h.key('ArrowLeft'); s = await h.st(); check('J13 v + <Left><Left> selects שלו', s.sel === 'שלו', `sel=${s.sel}`);
await h.key('Escape');

// J9 dot
await h.doc(T, 3, 3); await h.keys('3dl'); s = await h.st(); const a = line(s, 3);
await h.keys('.'); s = await h.st();
check('J9 3dl then .', a === 'אהוזח' && line(s, 3).length === 2, `after 3dl=${a} (cursor ch ${s.ch}) after .=${line(s, 3)}`);

// J10 formula: אב $x+1$ גד  (א0 ב1 sp2 $3 x4 +5 16 $7 sp8 ג9 ד10)
await h.doc(T, 2, 1); const path = [];
for (let i = 0; i < 4; i++) { await h.key('h'); path.push((await h.st()).ch); }
check('J10 h from ב → space, $, 1, +', path.join(',') === '2,7,6,5', `path=${path}`);
await cur(2, 1); await h.keys('2h'); s = await h.st(); check('J10 2h from ב → closing $', s.ch === 7, `ch=${s.ch}`);
await cur(2, 4); await h.keys('l'); s = await h.st(); check('J10 l inside formula → +', s.ch === 5, `ch=${s.ch}`);
await cur(2, 4); await h.keys('dl'); s = await h.st(); check('J10 dl inside formula deletes x', line(s, 2) === 'אב $+1$ גד', line(s, 2));

// J11 long line
const long = 'a'.repeat(300) + '\n' + HEB + ' ' + 'מילה '.repeat(60) + '$y$ סוף\n';
await h.doc(long, 1, 0);
const t0 = Date.now(); await h.keys('3h'); const dt = Date.now() - t0; s = await h.st();
check('J11 3h on long line', s.ch === 3, `ch=${s.ch} ${dt}ms for 2 keys`);
await cur(1, 2); await h.keys('3dl'); s = await h.st(); check('J11 3dl on long line', line(s, 1).startsWith('ם עולם'), line(s, 1).slice(0, 12));

console.log('\nconsole errors/warnings:\n' + (h.logs.join('\n') || '(none)'));
h.close();
