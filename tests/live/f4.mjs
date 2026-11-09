import { setup, check, FILE } from './lib.mjs';
import { connect } from './cdp.mjs';
const f = await connect();
await f.ev(`(() => { const w = require('@electron/remote')?.getCurrentWindow?.(); if (w) { if (w.isMinimized()) w.restore(); w.show(); } })()`).catch(() => {});
await f.send('Page.bringToFront'); f.close();
const h0 = await setup();
console.log(await h0.ev(`(async () => { await app.plugins.disablePlugin('babel-fish-math'); await app.plugins.enablePlugin('babel-fish-math'); await new Promise(r => setTimeout(r, 2500)); const p = app.plugins.plugins['babel-fish-math']; return 'reloaded: ' + (p ? p.manifest.version + ' hebrew=' + p.settings.hebrew : 'NOT LOADED'); })()`));
h0.close();
const h = await setup();
const P = `app.plugins.plugins['babel-fish-math']`;
const E = `app.workspace.activeLeaf.view.editor`;
const dir = () => h.ev(`getComputedStyle(app.workspace.activeLeaf.view.contentEl.querySelector('.cm-content')).direction`);
let s;

// M6a/b: typing an opener at the top of a Hebrew note keeps RTL
for (const [label, keys] of [['M6a $$', [['$', 'Digit4', 52, true], ['$', 'Digit4', 52, true], ['Enter'], ['x', 'KeyX', 88], ['Enter'], ['$', 'Digit4', 52, true], ['$', 'Digit4', 52, true], ['Enter']]],
                              ['M6b fence', [['`', 'Backquote', 192], ['`', 'Backquote', 192], ['`', 'Backquote', 192], ['Enter'], ['c', 'KeyC', 67], ['Enter'], ['`', 'Backquote', 192], ['`', 'Backquote', 192], ['`', 'Backquote', 192], ['Enter']]]]) {
  await h.doc('שלום עולם\nעוד שורה\n', 0, 0); await h.key('i'); await h.ev(`${P}.perfReset()`);
  const dirs = [];
  for (const [k, code, vk, shift] of keys) { if (code) await h.key(k, { code, vk, shift: !!shift, wait: 80 }); else await h.key(k, { wait: 80 }); dirs.push(await dir()); }
  await h.key('Escape'); s = await h.st();
  const held = await h.ev(`${P}.perf.dirHeld`);
  check(`${label}: RTL after every key`, dirs.every(d => d === 'rtl'), `dirs=${dirs.join(',')} dirHeld=${held} text=${JSON.stringify(s.text.slice(0, 40))}`);
}

// M8 f/t fallback
await h.doc('שלום $x+1$ עוד\n', 0, 0); await h.keys('fx'); s = await h.st(); check('M8a fx from Hebrew → x in formula', s.ch === 6, 'ch=' + s.ch);
await h.doc('$x + y$ שלום\n', 0, 2); await h.keys('fa'); s = await h.st(); check('M8b fa from math → ש', s.ch === 8, 'ch=' + s.ch);
await h.doc('שלום $x$ ו $x$\n', 0, 0); await h.keys('fx'); const c1 = (await h.st()).ch; await h.key(';', { code: 'Semicolon', vk: 186 }); s = await h.st();
check('M8c fx then ; repeats on x', c1 === 6 && s.ch === 13, `${c1} → ${s.ch}`);
await h.doc('שלום $x+1$\n', 0, 0); await h.keys('dfx'); s = await h.st(); check('M8d dfx', s.text.startsWith('+1$'), JSON.stringify(s.text));

// L10 graphemes
await h.doc('שָׁלוֹם\n', 0, 0); await h.keys('h'); s = await h.st(); const ch10 = s.ch;
await h.keys('x'); s = await h.st();
check('L10 h steps over niqqud; x deletes the whole letter', ch10 === 3 && s.text === 'שָׁוֹם\n', `h→${ch10} text=${JSON.stringify(s.text)}`);

// M9: embed + unsaved edit in Reading view
await h.ev(`(async () => { for (const [p, t] of [['_cdp-heb.md', 'שלום עולם\\n\\nפסקה שנייה\\n'], ['_cdp-en.md', 'English note\\n\\n![[_cdp-heb]]\\n']]) { const f = app.vault.getAbstractFileByPath(p); if (f) await app.vault.modify(f, t); else await app.vault.create(p, t); } })()`);
await h.ev(`(async () => { const f = app.vault.getAbstractFileByPath('_cdp-en.md'); await app.workspace.getLeaf(false).openFile(f, { state: { mode: 'preview' } }); })()`); await h.sleep(2000);
const emb = await h.ev(`(() => { const v = app.workspace.activeLeaf.view.contentEl; const e = v.querySelector('.internal-embed .markdown-preview-view, .internal-embed .markdown-rendered, .markdown-embed'); if (!e) return 'no embed'; const ps = [...e.querySelectorAll('p')]; return ps.map(p => getComputedStyle(p).direction).join(',') + ' | host=' + [...v.querySelectorAll('.markdown-preview-sizer > div > p')].slice(0,1).map(p => getComputedStyle(p).direction).join(','); })()`);
check('M9a embedded Hebrew note renders RTL inside an English note', /^rtl/.test(emb) && /host=ltr/.test(emb), emb);
// unsaved edit: English note, type Hebrew line, switch to preview immediately
await h.ev(`(async () => { const f = app.vault.getAbstractFileByPath('_cdp-en.md'); await app.vault.modify(f, 'English only\\n'); await app.workspace.activeLeaf.openFile(f, { state: { mode: 'source', source: false } }); })()`); await h.sleep(800);
await h.ev(`${E}.focus(); ${E}.setCursor({line:0,ch:0})`); await h.key('Escape'); await h.key('O', { shift: true, code: 'KeyO', vk: 79 }); await h.keys('akuo'); await h.key('Escape');
await h.ev(`app.workspace.activeLeaf.setViewState({type:'markdown', state:{file:'_cdp-en.md', mode:'preview'}})`); await h.sleep(1200);
const unsaved = await h.ev(`(() => { const v = app.workspace.activeLeaf.view.contentEl; const ps = [...v.querySelectorAll('.markdown-preview-sizer p')]; return ps.map(p => p.textContent.slice(0,8) + ':' + getComputedStyle(p).direction).join(' | '); })()`);
check('M9c Reading view right after an unsaved Hebrew edit is RTL', /^שלום:rtl/.test(unsaved), unsaved);

console.log('\nconsole:\n' + (h.logs.filter(l => !/keymapCheck|visualMotions/.test(l)).join('\n') || '(none)'));
console.log(await h.ev(`(async () => { for (const p of ['_cdp-heb.md', '_cdp-en.md', '${FILE}']) { const f = app.vault.getAbstractFileByPath(p); app.workspace.getLeavesOfType('markdown').forEach(l => { if (l.view.file === f) l.detach(); }); if (f) await app.vault.delete(f); } return 'cleaned; hebrew=' + ${P}.settings.hebrew; })()`));
h.close();
