import fs from 'fs';
const { connect } = await import('./cdp.mjs');
const { setup, check, FILE } = await import('./lib.mjs');
const src = fs.readFileSync(new URL('./cellprobe5.mjs', import.meta.url), 'utf8');
const whereExpr = src.match(/const where = \(\) => h\.ev\(`([\s\S]*?)`\);/)[1];
const c0 = await connect();
await c0.ev(`(async () => { const w = require('@electron/remote')?.getCurrentWindow?.(); if (w) { if (w.isMinimized()) w.restore(); w.show(); } const l = app.workspace.getLeaf('tab'); app.workspace.setActiveLeaf(l, { focus: true }); await new Promise(r => setTimeout(r, 200)); })()`).catch(() => {});
await c0.send('Page.bringToFront');
c0.close();
const h = await setup();
const P = `app.plugins.plugins['rtl-math-mix']`;
const E = `app.workspace.activeLeaf.view.editor`;
const where = async () => JSON.parse(await h.ev(whereExpr));
const K = async (k, w = 450) => { await h.key(k); await h.sleep(w); };
const fresh = async () => {
  await h.ev(`(async () => { const f = app.vault.getAbstractFileByPath('${FILE}'); const l = app.workspace.activeLeaf; await l.setViewState({ type: 'empty' }); await l.openFile(f, { state: { mode: 'source', source: false } }); app.workspace.setActiveLeaf(l, { focus: true }); })()`);
  await h.sleep(500);
};
console.log(await h.ev(`(async () => { await app.plugins.disablePlugin('rtl-math-mix'); await app.plugins.enablePlugin('rtl-math-mix'); await new Promise(r => setTimeout(r, 2000)); return 'reloaded; lastKeyAt fn=' + (typeof ${P}.onKeyDown) + '; nativeMenus=' + app.vault.getConfig('nativeMenus') + '; spellcheck=' + app.vault.getConfig('spellcheck'); })()`));

const HE = 'intro\n\n| שלום | עולם |\n| --- | --- |\n| ככ | דד |\n\nשלום\n';
const dollar = async () => { await h.key('$', { code: 'Digit4', vk: 52, shift: true }); await h.sleep(450); };
const cell = async () => { await fresh(); await h.doc(HE, 0, 0); await h.sleep(700); await K('j', 400); await K('j', 600); await K('i', 600); await K('Escape', 600); };

async function L1(on) {
  await cell(); await K('l'); let w = await where();
  check(`L1 ${on} l at ch 0 → ch 1`, w.head === 1 && w.nav === 'edit', JSON.stringify(w));
  await cell(); await K('h', 600); w = await where();
  check(`L1 ${on} h at ch 0 → nav col 0`, w.head === 0 && w.nav === 'nav' && w.col === 0, JSON.stringify(w));
  await cell(); await dollar(); await K('h'); w = await where();
  check(`L1 ${on} h at last → last-1`, w.head === 2 && w.nav === 'edit', JSON.stringify(w));
  await cell(); await dollar(); await K('l', 600); w = await where();
  check(`L1 ${on} l at last → next column`, w.nav === 'nav' && w.col === 1, JSON.stringify(w));
}
await L1('on');

// the middle of a Hebrew cell stays visual
await cell(); await K('l'); await K('h'); let w = await where();
console.log('middle: l then h from ch 0', JSON.stringify(w));
// Arrow keys at the edge
await cell(); await h.key('ArrowRight'); await h.sleep(450); w = await where(); console.log('<Right> at ch 0', JSON.stringify(w));

// operators in a cell
await cell(); await K('x'); w = await where(); check('x at ch 0 deletes that letter', w.text === 'לום' && w.nav === 'edit', JSON.stringify(w));
await cell(); await K('d', 150); await K('l'); w = await where(); check('dl at ch 0 deletes that letter', w.text === 'לום' && w.nav === 'edit', JSON.stringify(w));
await cell(); await dollar(); await K('x'); w = await where(); check('x at last deletes that letter', w.text === 'שלו' && w.nav === 'edit', JSON.stringify(w));
await cell(); await dollar(); await K('d', 150); await K('l'); w = await where(); check('dl at last stays in the cell', w.text === 'שלו' && w.nav === 'edit', JSON.stringify(w));

// main editor clamps as before
await fresh();
await h.doc('שלום\n', 0, 0); await K('l'); let s = await h.st(); check('main editor RTL: l at ch 0 stays', s.ch === 0, 'ch=' + s.ch);
await h.doc('שלום\n', 0, 3); await K('h'); s = await h.st(); check('main editor RTL: h at last stays', s.ch === 3, 'ch=' + s.ch);
await h.doc('שלום\n', 0, 0); await K('h'); s = await h.st(); check('main editor RTL: h from ch 0 → ch 1', s.ch === 1, 'ch=' + s.ch);
await h.doc('hello\n', 0, 4); await K('l'); s = await h.st(); check('main editor LTR: l at last stays', s.ch === 4, 'ch=' + s.ch);

// L3: a real context menu
await h.ev(`${P}.settings.hebrew = true`);
for (const how of ['keyboard', 'mouse']) {
  await fresh();
  await h.doc('teh more words here\n', 0, 1); await h.sleep(1500);
  const r = JSON.parse(await h.ev(`(() => { const c = ${E}.cm.coordsAtPos(1); return JSON.stringify({ x: c.left, y: (c.top + c.bottom) / 2 }); })()`));
  for (const type of ['mousePressed', 'mouseReleased']) await h.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'right', buttons: 2, clickCount: 1 });
  await h.sleep(900);
  const items = JSON.parse(await h.ev(`JSON.stringify([...document.querySelectorAll('.menu .menu-item')].map(e => e.textContent.trim()).slice(0, 8))`));
  console.log(`L3 ${how} menu:`, JSON.stringify(items));
  const idx = items.indexOf('the');
  if (idx < 0) { console.log(`L3 ${how}: no "the" suggestion`); await K('Escape'); continue; }
  if (how === 'keyboard') {
    for (let i = 0; i <= idx; i++) await K('ArrowDown', 120);
    await K('Enter', 600);
  } else {
    const b = JSON.parse(await h.ev(`(() => { const e = [...document.querySelectorAll('.menu .menu-item')][${idx}].getBoundingClientRect(); return JSON.stringify({ x: e.x + e.width / 2, y: e.y + e.height / 2 }); })()`));
    await h.sleep(700);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await h.send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
    await h.sleep(800);
  }
  const line = (await h.st()).text.split('\n')[0];
  check(`L3 ${how} pick → the`, line.startsWith('the more'), JSON.stringify(line));
}
await h.key('Escape'); await h.ev(`${P}.settings.hebrew = false`);

await h.ev(`app.plugins.disablePlugin('rtl-math-mix')`); await h.sleep(800);
await L1('off');
await h.ev(`app.plugins.enablePlugin('rtl-math-mix')`); await h.sleep(1500);
await fresh();
console.log('console errors:', h.logs.filter(l => /error|exception/i.test(l)).slice(-5).join('\n') || '(none)');
console.log(await h.ev(`(async () => { const f = app.vault.getAbstractFileByPath('${FILE}'); app.workspace.getLeavesOfType('markdown').forEach(l => { if (l.view.file === f) l.detach(); }); if (f) await app.vault.delete(f); return 'cleaned; active=' + app.workspace.getActiveFile()?.path + '; hebrew=' + ${P}.settings.hebrew + '; ver=' + ${P}.manifest.version; })()`));
h.close();
