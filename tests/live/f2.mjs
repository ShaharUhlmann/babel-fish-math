import { setup, check, FILE } from './lib.mjs';
const h0 = await setup();
console.log(await h0.ev(`(async () => { await app.plugins.disablePlugin('babel-fish-math'); await app.plugins.enablePlugin('babel-fish-math'); await new Promise(r => setTimeout(r, 2500)); const p = app.plugins.plugins['babel-fish-math']; return 'reloaded: ' + (p ? 'loaded, hebrew=' + p.settings.hebrew : 'NOT LOADED'); })()`));
h0.close();
const h = await setup();
const P = `app.plugins.plugins['babel-fish-math']`;
const notices = () => h.ev(`[...document.querySelectorAll('.notice')].map(n=>n.textContent).join(' | ')`);
const clearN = () => h.ev(`document.querySelectorAll('.notice').forEach(n=>n.remove())`);
let s, n;

// Diagnostics
await clearN();
const diag = await h.ev(`(async () => { const r = await ${P}.diagnostics(); return JSON.stringify(r ?? null); })()`);
await h.sleep(300); n = await notices();
check('Diagnostics: all features on', /All features on/i.test(n), n.slice(0, 160));
console.log('   diagnostics return:', (diag || '').slice(0, 400));

// J12: Vim Motions off/on, motions back quickly
await h.ev(`app.plugins.disablePlugin('vim-motions')`); await h.sleep(800);
await h.ev(`app.plugins.enablePlugin('vim-motions')`);
const t0 = Date.now(); let back = false;
for (let i = 0; i < 40 && !back; i++) { await h.sleep(250); back = await h.ev(`!!window.CodeMirrorAdapter?.Vim && ${P}.vim?.V === window.CodeMirrorAdapter.Vim`); }
const dt = Date.now() - t0;
const entries = await h.ev(`CodeMirrorAdapter.Vim.getKeymap('normal').filter(e => /mathDir/.test(e.motion || '') || /mathDir/.test(e.motionArgs ? '' : '') ).length`);
check('J12 motions re-registered after Vim Motions reload', back, `${dt} ms, mathDir entries=${entries}`);
await h.ev(`(async () => { const f = app.vault.getAbstractFileByPath('${FILE}'); await app.workspace.getLeaf(false).openFile(f, { state: { mode: 'source', source: false } }); })()`); await h.sleep(600);
await h.doc('שלום עולם\n', 0, 0); await h.keys('3h'); s = await h.st(); check('J12 3h visual after reload', s.ch === 3, 'ch=' + s.ch);

// Simulated probe failure
await clearN();
await h.ev(`(async () => { ${P}.probeOverrides = { backPointer: false }; await ${P}.diagnostics(); })()`); await h.sleep(400);
n = await notices();
await h.doc('שלום עולם\n', 0, 0); await h.keys('3h'); s = await h.st();
check('Probe failure → notice + logical h/l', /visual h\/l/i.test(n) && s.ch === 0, `ch=${s.ch} notice=${n.slice(0, 140)}`);
await clearN();
await h.ev(`(async () => { ${P}.probeOverrides = {}; await ${P}.diagnostics(); })()`); await h.sleep(600);
await h.doc('שלום עולם\n', 0, 0); await h.keys('3h'); s = await h.st();
check('Probe restored → visual again', s.ch === 3, 'ch=' + s.ch);

// L8 keyboard toggle
const st0 = await h.ev(`${P}.statusEl.getAttribute('aria-label') + '|' + ${P}.statusEl.textContent + '|' + ${P}.statusEl.tabIndex + '|' + ${P}.statusEl.getAttribute('role')`);
await h.ev(`${P}.statusEl.focus()`); await h.key('Enter', { wait: 200 });
const st1 = await h.ev(`${P}.statusEl.getAttribute('aria-label') + '|' + ${P}.statusEl.textContent`);
await h.key(' ', { code: 'Space', vk: 32, wait: 200 });
const st2 = await h.ev(`${P}.statusEl.getAttribute('aria-label') + '|' + ${P}.statusEl.textContent`);
check('L8 status button: Enter and Space toggle, aria-label', st0.startsWith('Hebrew typing: on|עב') && /0\|button$/.test(st0) && st1.startsWith('Hebrew typing: off|EN') && st2.startsWith('Hebrew typing: on|עב'), `${st0} → ${st1} → ${st2}`);

// L9 no warning in Settings search; warning in note
await clearN(); await h.sleep(5200);
await h.ev(`app.setting.open()`); await h.sleep(600);
await h.ev(`(() => { const i = document.querySelector('.modal.mod-settings input[type="search"], .modal.mod-settings .setting-search input, .vertical-tab-header input'); if (i) i.focus(); return !!i; })()`);
await h.key('ש', { code: 'KeyA', vk: 65, wait: 300 }); n = await notices();
check('L9 no layout warning in Settings search', n === '', n.slice(0, 80));
await h.ev(`app.setting.close()`); await h.sleep(400);
await clearN(); await h.sleep(5200);
await h.doc('\n', 0, 0); await h.key('i'); await h.key('ש', { code: 'KeyA', vk: 65, wait: 300 }); await h.key('Escape'); n = await notices();
check('L9 warning still shows in the note', /keyboard/i.test(n), n.slice(0, 60));

// L14 settings toggle refresh (open settings tab, press F12 via command)
await h.ev(`(async () => { app.setting.open(); app.setting.openTabById('babel-fish-math'); })()`); await h.sleep(600);
const tog0 = await h.ev(`[...document.querySelectorAll('.modal.mod-settings .checkbox-container')][0]?.classList.contains('is-enabled')`);
await h.ev(`app.commands.executeCommandById('babel-fish-math:toggle-hebrew-typing')`); await h.sleep(300);
const tog1 = await h.ev(`[...document.querySelectorAll('.modal.mod-settings .checkbox-container')][0]?.classList.contains('is-enabled')`);
await h.ev(`app.commands.executeCommandById('babel-fish-math:toggle-hebrew-typing')`); await h.sleep(200);
await h.ev(`app.setting.close()`); await h.sleep(300);
check('L14 settings toggle follows F12', tog0 === true && tog1 === false, `${tog0} → ${tog1}`);

console.log('\nconsole:\n' + (h.logs.join('\n') || '(none)'));
console.log(await h.ev(`(async () => { const f = app.vault.getAbstractFileByPath('${FILE}'); app.workspace.getLeavesOfType('markdown').forEach(l => { if (l.view.file === f) l.detach(); }); if (f) await app.vault.delete(f); return 'cleaned; hebrew=' + ${P}.settings.hebrew; })()`));
h.close();
