import { setup, check, FILE } from './lib.mjs';
import { connect } from './cdp.mjs';
const f = await connect();
await f.ev(`(() => { const w = require('@electron/remote')?.getCurrentWindow?.(); if (w) { if (w.isMinimized()) w.restore(); w.show(); } })()`).catch(() => {});
await f.send('Page.bringToFront'); f.close();
const h0 = await setup();
console.log(await h0.ev(`(async () => { await app.plugins.disablePlugin('rtl-math-mix'); await app.plugins.enablePlugin('rtl-math-mix'); await new Promise(r => setTimeout(r, 2500)); const p = app.plugins.plugins['rtl-math-mix']; return 'reloaded: ' + (p ? p.manifest.version + ' perf=' + !!p.perf : 'NOT LOADED'); })()`));
h0.close();
const h = await setup();
const P = `app.plugins.plugins['rtl-math-mix']`;
const E = `app.workspace.activeLeaf.view.editor`;
const dir = () => h.ev(`getComputedStyle(app.workspace.activeLeaf.view.contentEl.querySelector('.cm-content')).direction`);
let s;

// Long note: ~3000 lines of mixed Hebrew + math + blocks
const block = (i) => [`פסקה ${i} עם נוסחה $x_${i}+1$ וטקסט`, `English line ${i} with $y^2$`, '', i % 10 === 0 ? '$$\n\\sum_{k=1}^{n} k\n$$' : `שורה נוספת ${i}`, ''].join('\n');
const LONG = '---\ntags: [test]\n---\n' + Array.from({ length: 600 }, (_, i) => block(i)).join('\n');
const nLines = LONG.split('\n').length;
await h.ev(`${E}.setValue(${JSON.stringify(LONG)})`); await h.sleep(1500);
await h.ev(`${E}.focus(); ${E}.setCursor({ line: ${nLines - 2}, ch: 0 })`); await h.sleep(500);
await h.key('Escape'); await h.key('A', { shift: true, code: 'KeyA', vk: 65 });
await h.ev(`${P}.perfReset()`);
for (let i = 0; i < 50; i++) await h.key('a', { wait: 15 });
await h.sleep(400);
let perf = JSON.parse(await h.ev(`JSON.stringify(${P}.perf)`));
console.log('   end-of-note perf:', JSON.stringify(perf));
check('F3 typing at end of 3000-line note is incremental', perf.fullScans <= 2 && perf.dirFull <= 1 && perf.maxUpdateMs < 16, `full=${perf.fullScans} inc=${perf.incrementalScans} reused=${perf.reusedScans} dirFull=${perf.dirFull} dirInc=${perf.dirIncremental} dirKept=${perf.dirKept} max=${perf.maxUpdateMs.toFixed(2)}ms avg=${(perf.totalUpdateMs / Math.max(1, perf.updates)).toFixed(2)}ms`);
s = await h.st(); check('F3 typed text arrived as Hebrew', s.text.split('\n')[nLines - 2].endsWith('ש'.repeat(5)), s.text.split('\n')[nLines - 2].slice(-8));
await h.key('Escape');
// typing at the top (after frontmatter)
await h.ev(`${E}.setCursor({ line: 3, ch: 0 })`); await h.key('i'); await h.ev(`${P}.perfReset()`);
for (let i = 0; i < 30; i++) await h.key('a', { wait: 15 });
await h.sleep(400); perf = JSON.parse(await h.ev(`JSON.stringify(${P}.perf)`));
check('F3 typing at top of long note stays fast', perf.maxUpdateMs < 25, `full=${perf.fullScans} inc=${perf.incrementalScans} dirFull=${perf.dirFull} dirInc=${perf.dirIncremental} dirKept=${perf.dirKept} max=${perf.maxUpdateMs.toFixed(2)}ms avg=${(perf.totalUpdateMs / Math.max(1, perf.updates)).toFixed(2)}ms`);
await h.key('Escape');
check('F3 long note is RTL', (await dir()) === 'rtl', '');

// Direction flips
await h.doc('English only\nשלום\nmore English\n', 0, 0); await h.sleep(200);
const d0 = await dir();
await h.ev(`${E}.replaceRange('', {line:1,ch:0}, {line:2,ch:0})`); await h.sleep(300); const d1 = await dir();
await h.ev(`${E}.replaceRange('עברית\\n', {line:0,ch:0})`); await h.sleep(300); const d2 = await dir();
check('F3 deleting the only Hebrew line → LTR; adding Hebrew above → RTL', d0 === 'rtl' && d1 === 'ltr' && d2 === 'rtl', `${d0} → ${d1} → ${d2}`);
await h.doc('---\ndirection: ltr\n---\nשלום עולם\n', 3, 0); await h.sleep(300); const e0 = await dir();
await h.ev(`${E}.replaceRange('rtl', {line:1,ch:11}, {line:1,ch:14})`); await h.sleep(300); const e1 = await dir();
await h.ev(`${E}.replaceRange('ltr', {line:1,ch:11}, {line:1,ch:14})`); await h.sleep(300); const e2 = await dir();
check('F3 frontmatter direction edits apply at once', e0 === 'ltr' && e1 === 'rtl' && e2 === 'ltr', `${e0} → ${e1} → ${e2}`);
await h.doc('שלום\n\n$$\nx\n$$\n\nשלום\n', 0, 0); await h.sleep(200);
await h.ev(`${E}.replaceRange('', {line:2,ch:0}, {line:5,ch:0})`); await h.sleep(300);
await h.ev(`${E}.replaceRange('$$\\nz\\n$$\\n', {line:2,ch:0})`); await h.sleep(300);
check('F3 removing and re-adding a $$ block keeps RTL', (await dir()) === 'rtl', '');

// Region cases
await h.doc('שלום $x$ עולם\n', 0, 6); await h.key('i'); await h.keys('ab'); await h.key('Escape'); s = await h.st();
check('F3 inside $…$ types English', s.text.startsWith('שלום $abx$'), s.text.split('\n')[0]);
await h.doc('שלום\n\nטקסט\n', 1, 0); await h.key('i'); await h.keys('$$'); await h.key('Enter'); await h.keys('ab'); s = await h.st();
check('F3 opening $$ mid-note: typing inside is English', s.text.split('\n')[2] === 'ab', JSON.stringify(s.text));
await h.key('Enter'); await h.keys('$$'); await h.key('Enter'); await h.keys('akuo'); await h.key('Escape'); s = await h.st();
check('F3 after closing $$: typing is Hebrew again', s.text.split('\n')[4] === 'שלום', JSON.stringify(s.text));
await h.doc('שלום\n\n```\ncode\n```\n', 3, 4); await h.key('a'); await h.keys('akuo'); await h.key('Escape'); s = await h.st();
check('F3 typing in a fence is English', s.text.split('\n')[3] === 'codeakuo', s.text.split('\n')[3]);

console.log('\nconsole:\n' + (h.logs.filter(l => !/self-check turned off: visualMotions/.test(l)).join('\n') || '(none)'));
console.log(await h.ev(`(async () => { const f = app.vault.getAbstractFileByPath('${FILE}'); app.workspace.getLeavesOfType('markdown').forEach(l => { if (l.view.file === f) l.detach(); }); if (f) await app.vault.delete(f); return 'cleaned; hebrew=' + ${P}.settings.hebrew; })()`));
h.close();
