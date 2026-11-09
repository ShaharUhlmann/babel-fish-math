// Obsidian's built-in Vim, no Vim Motions. Layer on, Vim mode on.
const { setup, check, FILE } = await import('./lib.mjs');
const h = await setup();
const P = `app.plugins.plugins['babel-fish-math']`;
const E = `app.workspace.activeLeaf.view.editor`;
const K = async (k, w = 200) => { await h.key(k); await h.sleep(w); };
let s;
console.log('setup:', await h.ev(`JSON.stringify({ vimCfg: app.vault.getConfig('vimMode'), vimMotions: !!app.plugins.plugins['vim-motions'], Vim: !!window.CodeMirrorAdapter?.Vim, viewCm: !!${E}.cm.cm, settings: ${P}.settings, integration: !!${P}.vim, getKeymap: typeof window.CodeMirrorAdapter?.Vim?.getKeymap, getMotion: typeof window.CodeMirrorAdapter?.Vim?.getMotion })`));
console.log('features:', await h.ev(`JSON.stringify(${P}.api.features)`));

await h.doc('שלום עולם\n', 0, 0); await h.keys('3h'); s = await h.st();
check('3h is visual', s.ch === 3, 'ch=' + s.ch);
await h.doc('שלום עולם\n', 0, 3); await K('l'); s = await h.st();
check('l is visual (ch 3 → 2)', s.ch === 2, 'ch=' + s.ch);
await h.doc('שלום עולם\n', 0, 3); await h.key('ArrowLeft'); await h.sleep(200); s = await h.st();
check('<Left> is visual (ch 3 → 4)', s.ch === 4, 'ch=' + s.ch);
await h.doc('hello\n', 0, 2); await K('l'); s = await h.st();
check('English l is normal', s.ch === 3, 'ch=' + s.ch);
await h.doc('שלום $x+y$ עוד\n', 0, 7); await K('l'); s = await h.st();
check('inside a formula l moves right (ch 7 → 8)', s.ch === 8, 'ch=' + s.ch);
await h.doc('שלום\n', 0, 0); await K('x'); s = await h.st();
check('x deletes under the cursor', s.text.startsWith('לום'), JSON.stringify(s.text));
await h.doc('שלום\n', 0, 1); await K('X'); s = await h.st();
console.log('   X on ch 1:', JSON.stringify(s.text));
await h.doc('שלום\n', 0, 1); await K('d', 100); await K('l'); s = await h.st();
check('dl deletes the cursor letter', s.text.startsWith('שום'), JSON.stringify(s.text));
await h.doc('שלום\n', 0, 0); await K('l'); s = await h.st();
check('stops at the visual edge', s.ch === 0, 'ch=' + s.ch);

await h.doc('', 0, 0); await h.key('i'); await h.keys('akuo'); await K('Escape'); s = await h.st();
check('insert types Hebrew', s.text.startsWith('שלום'), JSON.stringify(s.text));
await h.doc('$x$\n', 0, 1); await h.key('i'); await h.keys('ab'); await K('Escape'); s = await h.st();
check('math types English', s.text.startsWith('$abx$'), JSON.stringify(s.text));
await h.doc('x\ny\n', 0, 0); await h.key('i'); await h.ev(`${E}.setSelections([{ anchor: { line: 0, ch: 0 } }, { anchor: { line: 1, ch: 0 } }])`); await h.sleep(100); await K('a'); await K('Escape'); s = await h.st();
check('multiple cursors', s.text.startsWith('שx\nשy'), JSON.stringify(s.text));

await h.doc('אבג ש דה\n', 0, 0); await K('f', 100); await K('a', 250); s = await h.st();
check('fa finds ש', s.ch === 4, 'ch=' + s.ch);
await h.doc('אבג $x$ דה\n', 0, 0); await K('f', 100); await K('x', 250); s = await h.st();
check('fx falls back to x in a formula', s.ch === 5, 'ch=' + s.ch);
await h.doc('אבג\n', 0, 0); await K('r', 100); await K('a', 250); s = await h.st();
check('ra replaces with ש', s.text.startsWith('שבג'), JSON.stringify(s.text));
await h.doc('$abc$\n', 0, 1); await K('r', 100); await K('z', 250); s = await h.st();
check('r in math stays English', s.text.startsWith('$zbc$'), JSON.stringify(s.text));

await h.doc('אבגד\n', 0, 0); await K('R'); await K('a'); await K('k'); s = await h.st();
check('R overwrites with Hebrew', s.text.startsWith('שלגד'), JSON.stringify(s.text));
await K('Backspace'); s = await h.st();
check('R then Backspace restores', s.text.startsWith('שבגד'), JSON.stringify(s.text));
await K('Escape');
await h.doc('$abc$\n', 0, 1); await K('R'); await K('z'); await K('Escape'); s = await h.st();
check('R in math is English', s.text.startsWith('$zbc$'), JSON.stringify(s.text));

await h.doc('שלום\n', 0, 0); await h.key('/', { code: 'Slash', vk: 191 }); await h.sleep(300); await h.keys('ak');
let v = await h.ev(`document.querySelector('.cm-vim-panel input')?.value`); await K('Escape');
check('/ prompt follows the layer', v === 'של', JSON.stringify(v));
await h.doc('שלום\n', 0, 0); await h.key(':', { code: 'Semicolon', vk: 186, shift: true }); await h.sleep(300); await h.keys('ak');
v = await h.ev(`document.querySelector('.cm-vim-panel input')?.value`); await K('Escape');
check(': prompt stays English', v === 'ak', JSON.stringify(v));

// Ctrl+[ with the Hebrew layout: physical [ gives ]
await h.doc('שלום\n', 0, 0); await h.key('i'); await h.key(']', { code: 'BracketLeft', vk: 219, ctrl: true }); await h.sleep(250); s = await h.st();
check('Ctrl+[ on the Hebrew layout leaves insert mode', s.mode === 'normal', s.mode);

// Hebrew OS layout: . is ץ
await h.doc('שלום עולם\n', 0, 0); await K('x'); await h.key('ץ', { code: 'Period', vk: 190 }); await h.sleep(250); s = await h.st();
check('Hebrew OS: . repeats x', s.text.startsWith('ום'), JSON.stringify(s.text));

const cls = await h.ev(`app.workspace.activeLeaf.view.contentEl.querySelector('.cm-editor').className`);
check('cursor class', /math-dir-cur-/.test(cls) && await h.ev(`!!app.workspace.activeLeaf.view.contentEl.querySelector('.cm-vimCursorLayer')`), cls.match(/math-dir-cur-\w+/)?.[0] || 'none');

// Toggle off and on
await h.ev(`(async () => { ${P}.settings.vimMode = false; await ${P}.saveSettings(); ${P}.applyVimMode(); })()`); await h.sleep(500);
await h.ev(`${E}.focus()`);
await h.doc('שלום עולם\n', 0, 3); await K('l'); s = await h.st();
check('toggle off: l is logical (ch 3 → 4)', s.ch === 4, 'ch=' + s.ch);
await h.doc('שלום עולם\n', 0, 0); await K('x'); s = await h.st();
check('toggle off: x still deletes', s.text.startsWith('לום'), JSON.stringify(s.text));
await h.ev(`(async () => { ${P}.settings.vimMode = true; await ${P}.saveSettings(); ${P}.applyVimMode(); })()`); await h.sleep(500);
await h.ev(`${E}.focus()`);
await h.doc('שלום עולם\n', 0, 0); await h.keys('3h'); s = await h.st();
check('toggle on: 3h is visual', s.ch === 3, 'ch=' + s.ch);
const diag = await h.ev(`(async () => { const rows = await ${P}.diagnostics(); return JSON.stringify(rows.filter((r) => r.result === 'FAIL' || r.result === 'OFF').map((r) => r.check)); })()`);
console.log('diagnostics FAIL/OFF:', diag);
const notes = await h.ev(`[...document.querySelectorAll('.notice')].map((n) => n.textContent).join(' || ')`);
console.log('notices:', notes.slice(0, 400));
console.log('errors:', h.logs.filter((l) => /error|exception|TypeError/i.test(l)).slice(-5).join(' | ') || '(none)');
await h.ev(`(async () => { const f = app.vault.getAbstractFileByPath('${FILE}'); app.workspace.getLeavesOfType('markdown').forEach((l) => { if (l.view.file === f) l.detach(); }); if (f) await app.vault.delete(f); })()`);
h.close();
