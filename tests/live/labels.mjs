import { setup, check } from './lib.mjs';
const h = await setup();
const L = 'שלום שלום שלום שלום\n';
const W = { a: ['ש','KeyA',65], s: ['ד','KeyS',68 - 0], d: ['ג','KeyD',68] };
const hk = (k) => h.key(W[k][0], { code: W[k][1], vk: k.toUpperCase().charCodeAt(0) });
let s;
await h.doc(L, 0, 0); await h.keys('fa'); await hk('a'); s = await h.st(); check('Win-Hebrew label a (ש) → first ש', s.ch === 5, `ch=${s.ch}`);
await h.doc(L, 0, 0); await h.keys('fa'); await hk('s'); s = await h.st(); check('Win-Hebrew label s (ד) → second ש', s.ch === 10, `ch=${s.ch}`);
await h.doc(L, 0, 0); await hk('a'); s = await h.st(); // Win-Hebrew: f is כ
await h.doc(L, 0, 0); await h.key('כ', { code: 'KeyF', vk: 70 }); await hk('a'); await hk('a'); s = await h.st(); check('All Win-Hebrew: כ ש ש (f a + label a) → first ש', s.ch === 5, `ch=${s.ch}`);
await h.doc(L, 0, 0); await h.keys('fa'); await h.key('a'); s = await h.st(); check('Win-English label a still works', s.ch === 5, `ch=${s.ch}`);
await h.doc(L, 0, 0); await h.keys('dfa'); await hk('a'); s = await h.st(); check('Win-Hebrew dfa + label', s.text.startsWith('לום שלום'), s.text.split('\n')[0]);
await h.doc('\n', 0, 0); await h.key('i'); await hk('a'); await hk('s'); await h.key('Escape'); s = await h.st(); check('Win-Hebrew insert still types שד', s.text.startsWith('שד'), s.text.split('\n')[0]);
console.log(h.logs.join('\n') || '(console clean)');
h.close();
