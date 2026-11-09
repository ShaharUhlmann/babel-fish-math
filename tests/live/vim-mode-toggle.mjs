// Vim mode toggle, live, with Vim Motions on.
const { setup, check, FILE } = await import('./lib.mjs');
const h = await setup();
const P = `app.plugins.plugins['rtl-math-mix']`;
const E = `app.workspace.activeLeaf.view.editor`;
const K = async (k, w = 200) => { await h.key(k); await h.sleep(w); };
const set = async (on) => { await h.ev(`(async () => { ${P}.settings.vimMode = ${on}; await ${P}.saveSettings(); ${P}.applyVimMode(); })()`); await h.sleep(500); };
const cls = () => h.ev(`app.workspace.activeLeaf.view.contentEl.querySelector('.cm-editor').className`);
let s;

await h.doc('שלום עולם\n', 0, 0); await h.keys('3h'); s = await h.st();
check('on: 3h is visual', s.ch === 3, 'ch=' + s.ch);
check('on: integration object and cursor class', /math-dir-cur-/.test(await cls()) && await h.ev(`!!${P}.vim`), await cls());

await set(false);
check('off: no integration object', await h.ev(`!${P}.vim`), '');
check('off: no cursor class', !/math-dir-cur-/.test(await cls()), await cls());
await h.doc('שלום עולם\n', 0, 3); await K('l'); s = await h.st();
check('off: l is stock (ch 3 → 4)', s.ch === 4, 'ch=' + s.ch);
await h.doc('שלום עולם\n', 0, 3); await K('h'); s = await h.st();
check('off: h is stock (ch 3 → 2)', s.ch === 2, 'ch=' + s.ch);
await h.doc('שלום עולם\n', 0, 0); await K('x'); s = await h.st();
check('off: x still deletes', s.text.startsWith('לום'), JSON.stringify(s.text));
await h.doc('שלום עולם\n', 0, 3); await K('X'); s = await h.st();
check('off: X deletes before the cursor', s.text.startsWith('שלם'), JSON.stringify(s.text));
await h.doc('', 0, 0); await h.key('i'); await h.keys('akuo'); await K('Escape'); s = await h.st();
check('off: layer still types Hebrew', s.text.startsWith('שלום'), JSON.stringify(s.text));
await h.doc('$x$\n', 0, 1); await h.key('i'); await h.keys('ab'); await K('Escape'); s = await h.st();
check('off: math stays English', s.text.startsWith('$abx$'), JSON.stringify(s.text));
check('off: note direction still works', await h.ev(`(async () => { ${E}.setValue('שלום'); await new Promise(r => setTimeout(r, 250)); return getComputedStyle(app.workspace.activeLeaf.view.contentEl.querySelector('.cm-content')).direction === 'rtl'; })()`), '');
// f takes the English key
await h.doc('שלום a שלום\n', 0, 0); await h.key('f'); await h.sleep(100); await h.key('a'); await h.sleep(250); s = await h.st();
check('off: fa finds the English a, not ש', s.ch === 5, 'ch=' + s.ch);
// / follows no layer; the command palette does
await h.doc('שלום\n', 0, 0); await h.key('/', { code: 'Slash', vk: 191 }); await h.sleep(300); await h.keys('ak');
const v = await h.ev(`document.querySelector('.cm-vim-panel input')?.value`); await K('Escape');
check('off: / prompt stays English', v === 'ak', JSON.stringify(v));
await h.ev(`app.commands.executeCommandById('command-palette:open')`); await h.sleep(500); await h.keys('ak');
const pv = await h.ev(`document.querySelector('input.prompt-input')?.value`); await K('Escape', 400);
check('off: command palette still follows the layer', pv === 'של', JSON.stringify(pv));

const flips = await h.ev(`(async () => { const n = CodeMirrorAdapter.Vim.getKeymap('normal').filter((e) => /mathDir/.test(e.motion || '')).length; return n; })()`);
await set(true);
await set(false);
await set(true);
const after = await h.ev(`CodeMirrorAdapter.Vim.getKeymap('normal').filter((e) => /mathDir/.test(e.motion || '')).length`);
check('on again: commands do not stack', flips === after && after === 6, `${flips} → ${after}`);
await h.ev(`${E}.focus()`);
await h.doc('שלום עולם\n', 0, 0); await h.keys('3h'); s = await h.st();
check('on again: 3h is visual', s.ch === 3, 'ch=' + s.ch);
await h.doc('שלום עולם\n', 0, 0); await h.key('f'); await h.sleep(100); await h.key('j'); await h.sleep(250); s = await h.st();
await K('Escape');
console.log('on again: fj (ח) ch=' + s.ch);
await h.doc('אבג\n', 0, 0); await K('R'); await K('a'); await K('Escape'); s = await h.st();
check('on again: Replace types Hebrew', s.text.startsWith('שבג'), JSON.stringify(s.text));

console.log('errors:', h.logs.filter((l) => /error|exception/i.test(l)).slice(-4).join(' | ') || '(none)');
await h.ev(`(async () => { const f = app.vault.getAbstractFileByPath('${FILE}'); app.workspace.getLeavesOfType('markdown').forEach((l) => { if (l.view.file === f) l.detach(); }); if (f) await app.vault.delete(f); })()`);
h.close();
