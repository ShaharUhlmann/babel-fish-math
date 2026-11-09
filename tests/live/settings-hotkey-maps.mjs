// 3.0.0: hotkey and key maps, through the real settings UI.
const { connectTo } = await import('./cdp2.mjs');
const { setup, check, FILE } = await import('./lib.mjs');
const h = await setup();
const P = `app.plugins.plugins['babel-fish-math']`;
const E = `app.workspace.activeLeaf.view.editor`;
const AD = `app.vault.adapter`;
const DIR = `${P}.manifest.dir + '/maps/'`;
const K = async (k, w = 200) => { await h.key(k); await h.sleep(w); };
const fkey = async (c, key, code, vk, extra = {}) => {
  const p = { key, code, windowsVirtualKeyCode: vk, ...extra };
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: extra.modifiers || 0 });
  await c.sleep(250);
};
const layer = () => h.ev(`${P}.settings.hebrew`);
const stored = () => h.ev(`JSON.stringify(${P}.settings.toggleHotkey)`);
const readMap = (id) => h.ev(`${AD}.read(${DIR} + '${id}.json')`);
const exists = (id) => h.ev(`${AD}.exists(${DIR} + '${id}.json')`);
const typed = async (keys) => { await h.doc('', 0, 0); await h.key('i'); await h.keys(keys); await K('Escape'); return (await h.st()).text.trim(); };
// Runs in the main page, reaches into the Settings window's DOM.
const SET = `document`;
let sw;
const clickBtn = (setting, label) => sw.ev(`(() => { const s = [...${SET}.querySelectorAll('.setting-item')].find((x) => x.querySelector('.setting-item-name')?.textContent === ${JSON.stringify(setting)}); if (!s) return 'no setting'; const b = [...s.querySelectorAll('button')].find((x) => x.textContent.startsWith(${JSON.stringify(label)})); if (!b) return 'no button'; if (b.disabled) return 'disabled'; b.click(); return 'ok'; })()`);
const DOC = `document`;
const modalBtn = (label) => sw.ev(`(() => { const ms = [...${DOC}.querySelectorAll('.modal')].filter((m) => !m.classList.contains('mod-settings')); const m = ms[ms.length - 1]; if (!m) return 'no modal'; const b = [...m.querySelectorAll('button')].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) return 'no button: ' + [...m.querySelectorAll('button')].map((x) => x.textContent).join(','); b.click(); return 'ok'; })()`);
const modalCount = () => sw.ev(`[...${DOC}.querySelectorAll('.modal')].filter((m) => !m.classList.contains('mod-settings')).length`);
const dropdown = () => sw.ev(`(() => { const s = [...${SET}.querySelectorAll('.setting-item')].find((x) => x.querySelector('.setting-item-name')?.textContent === 'Key map'); const d = s.querySelector('select'); return JSON.stringify({ value: d.value, options: [...d.options].map((o) => o.value + '=' + o.textContent) }); })()`);
const pick = (id) => sw.ev(`(() => { const s = [...${SET}.querySelectorAll('.setting-item')].find((x) => x.querySelector('.setting-item-name')?.textContent === 'Key map'); const d = s.querySelector('select'); d.value = '${id}'; d.dispatchEvent(new (d.ownerDocument.defaultView.Event)('change')); })()`);
const notices = async () => (await h.ev(`[...document.querySelectorAll('.notice')].map((n) => n.textContent).join(' || ')`)) + ' || ' + (await sw.ev(`[...document.querySelectorAll('.notice')].map((n) => n.textContent).join(' || ')`));
const clearN = async () => { for (const c of [h, sw]) await c.ev(`[...document.querySelectorAll('.notice')].forEach((n) => n.remove())`); };

// ---- First run
check('maps/qwerty.json was created', await exists('qwerty'), '');
const f0 = JSON.parse(await readMap('qwerty'));
check('default map content', f0.keys.a === 'ש' && f0.keys['('] === ')' && Object.keys(f0.keys).length === 37, f0.name + ' keys=' + Object.keys(f0.keys).length);
console.log('settings:', await h.ev(`JSON.stringify(${P}.settings)`));
check('command has no default hotkey', await h.ev(`!(app.commands.commands['babel-fish-math:toggle-hebrew-typing'].hotkeys || []).length`), '');

// ---- F12 in the main window
await h.doc('שלום\n', 0, 0);
const l0 = await layer();
await fkey(h, 'F12', 'F12', 123);
check('F12 toggles', (await layer()) === !l0, `${l0} → ${await layer()}`);
await h.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 });
await h.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F12', code: 'F12', windowsVirtualKeyCode: 123, autoRepeat: true });
await h.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F12', code: 'F12', windowsVirtualKeyCode: 123, autoRepeat: true });
await h.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F12', code: 'F12', windowsVirtualKeyCode: 123 }); await h.sleep(200);
check('holding F12 toggles once', (await layer()) === l0, `${await layer()}`);
await h.ev(`app.commands.executeCommandById('babel-fish-math:toggle-hebrew-typing')`); await h.sleep(200);
check('the command toggles', (await layer()) === !l0, '');
await h.ev(`${P}.settings.hebrew || ${P}.toggle()`); await h.sleep(200);
check('Hebrew typing on for what follows', await layer(), '');

// ---- Settings window
await h.ev(`(async () => { app.setting.open(); app.setting.openTabById('babel-fish-math'); })()`); await h.sleep(1500);
sw = await connectTo(new RegExp('^Settings - ' + process.env.OBSIDIAN_TEST_VAULT));
await sw.send('Page.bringToFront'); await sw.sleep(300);
console.log('settings window title:', await sw.ev(`document.title`));
console.log('setting names:', await sw.ev(`JSON.stringify([...${SET}.querySelectorAll('.setting-item-name')].map((x) => x.textContent).slice(0, 14))`));

// Hotkey recording
console.log('Change:', await clickBtn('Toggle hotkey', 'Change')); await sw.sleep(300);
await fkey(sw, 'a', 'KeyA', 65, { text: 'a' });
check('recording refuses a plain letter', (await stored()).includes('F12') && /needed for typing/.test(await notices()), (await notices()).slice(0, 80));
await clearN();
await sw.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 });
await sw.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 }); await sw.sleep(250);
check('recording refuses a lone modifier', (await stored()).includes('F12') && /modifier alone/.test(await notices()), (await notices()).slice(0, 60));
await clearN();
const before = await layer();
await fkey(sw, 'Escape', 'Escape', 27);
check('Esc cancels and keeps Settings open', (await stored()).includes('F12') && await sw.ev(`!!document.querySelector('.vertical-tab-content')`), await stored());
check('recording did not toggle the layer', (await layer()) === before, '');
console.log('Change:', await clickBtn('Toggle hotkey', 'Change')); await sw.sleep(300);
await fkey(sw, 'F9', 'F9', 120);
check('records F9', (await stored()).includes('"F9"'), await stored());
console.log('Change:', await clickBtn('Toggle hotkey', 'Change')); await sw.sleep(300);
await fkey(sw, 'j', 'KeyJ', 74, { modifiers: 2 });
check('records Ctrl+J', (await stored()).includes('"KeyJ"') && (await stored()).includes('"ctrl":true'), await stored());
const desc = await sw.ev(`[...${SET}.querySelectorAll('.setting-item')].find((x) => x.querySelector('.setting-item-name')?.textContent === 'Toggle hotkey').textContent`);
check('the label shows it', /Ctrl\+J/.test(desc), desc.slice(0, 50));
await h.send('Page.bringToFront'); await h.ev(`${E}.focus()`); await h.sleep(300);
let l1 = await layer();
await fkey(h, 'F12', 'F12', 123);
check('old F12 no longer toggles', (await layer()) === l1, '');
await h.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74, modifiers: 2 });
await h.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74, modifiers: 2 }); await h.sleep(250);
check('Ctrl+J toggles', (await layer()) === !l1, '');
await sw.send('Page.bringToFront'); await sw.sleep(200);
console.log('Clear:', await clickBtn('Toggle hotkey', 'Clear')); await sw.sleep(300);
check('Clear removes it', (await stored()) === 'null', await stored());
await h.send('Page.bringToFront'); await h.ev(`${E}.focus()`); await h.sleep(200);
l1 = await layer();
await h.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74, modifiers: 2 });
await h.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74, modifiers: 2 }); await h.sleep(250);
check('cleared: Ctrl+J does nothing', (await layer()) === l1, '');
await sw.send('Page.bringToFront'); await sw.sleep(200);
console.log('Reset:', await clickBtn('Toggle hotkey', 'Reset to F12')); await sw.sleep(300);
check('Reset to F12', (await stored()).includes('"F12"'), await stored());
await sw.send('Page.bringToFront'); await sw.sleep(200);
const lS = await layer();
await fkey(sw, 'F12', 'F12', 123);
console.log('F12 with focus in the Settings window toggles:', (await layer()) !== lS);
if ((await layer()) !== lS) await h.ev(`${P}.toggle()`);
await h.ev(`${P}.settings.hebrew || ${P}.toggle()`);

// ---- Maps: New
console.log('dropdown:', await dropdown());
console.log('New:', await clickBtn('Manage key maps', 'New')); await sw.sleep(500);
check('name modal opens in the Settings window', (await modalCount()) === 1, 'modals=' + await modalCount());
await sw.keys('dvorak test'); await sw.sleep(150);
const nameVal = await sw.ev(`${DOC}.querySelector('.modal:not(.mod-settings) input')?.value`);
check('the name field stays English with the layer on', nameVal === 'dvorak test', JSON.stringify(nameVal));
console.log('confirm buttons:', await sw.ev(`[...${DOC}.querySelectorAll('.modal:not(.mod-settings) button')].map((b) => b.textContent).join(',')`));
await sw.ev(`(() => { const ms = [...${DOC}.querySelectorAll('.modal:not(.mod-settings) button')]; const b = ms.find((x) => x.classList.contains('mod-cta')); b && b.click(); })()`); await sw.sleep(600);
check('New writes the file', await exists('dvorak-test'), '');
console.log('dropdown:', await dropdown());
const dv = JSON.parse(await readMap('dvorak-test'));
check('New copies the map and keeps the name', dv.keys.a === 'ש' && dv.name === 'dvorak test', dv.name);
check('New made it active', (await h.ev(`${P}.settings.activeMap`)) === 'dvorak-test', await h.ev(`${P}.settings.activeMap`));

// Hebrew name: slug falls back
console.log('New:', await clickBtn('Manage key maps', 'New')); await sw.sleep(500);
await sw.ev(`(() => { const i = ${DOC}.querySelector('.modal:not(.mod-settings) input'); i.value = 'מפה'; i.dispatchEvent(new (i.ownerDocument.defaultView.Event)('input', { bubbles: true })); })()`); await sw.sleep(100);
await sw.ev(`[...${DOC}.querySelectorAll('.modal:not(.mod-settings) button')].find((x) => x.classList.contains('mod-cta')).click()`); await sw.sleep(600);
const listing = await h.ev(`(async () => JSON.stringify((await ${AD}.list(${DIR})).files.map((f) => f.split('/').pop())))()`);
console.log('files:', listing);
check('a Hebrew name gets a safe file name', /map-?\d*\.json/.test(listing), listing);
const hebrewFile = JSON.parse(listing).find((f) => /^map/.test(f))?.replace('.json', '');
await pick('dvorak-test'); await sw.sleep(400);

// Edit: invalid, then valid
console.log('Edit:', await clickBtn('Manage key maps', 'Edit')); await sw.sleep(500);
const area = `${DOC}.querySelector('.modal:not(.mod-settings) textarea')`;
check('edit modal shows the JSON', (await sw.ev(`${area}?.value`) || '').includes('"keys"'), '');
await sw.ev(`${area}.focus()`); await sw.send('Page.bringToFront'); await sw.sleep(150);
await sw.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
await sw.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 });
await sw.keys('ak'); await sw.sleep(150);
const tail = (await sw.ev(`${area}.value`)).slice(-3);
check('the textarea stays English with the layer on', tail.endsWith('ak'), JSON.stringify(tail));
const beforeInvalid = await readMap('dvorak-test');
await modalBtn('Save'); await sw.sleep(400);
const err1 = await sw.ev(`${DOC}.querySelector('.math-dir-map-error')?.textContent`);
check('invalid JSON is refused with a reason', /Not saved/.test(err1 || '') && (await readMap('dvorak-test')) === beforeInvalid, (err1 || '').slice(0, 90));
const setArea = (txt) => sw.ev(`(() => { const a = ${area}; a.value = ${JSON.stringify(txt)}; })()`);
await setArea(JSON.stringify({ name: 'dvorak test', keys: { a: 'ab' } }));
await modalBtn('Save'); await sw.sleep(400);
const err2 = await sw.ev(`${DOC}.querySelector('.math-dir-map-error')?.textContent`);
check('a two-letter value is refused', /Not saved/.test(err2 || ''), (err2 || '').slice(0, 90));
const edited = { name: 'dvorak test', keys: { ...dv.keys, a: 'ס', constructor: 'ק' } };
await setArea(JSON.stringify(edited, null, 2));
await modalBtn('Save'); await sw.sleep(500);
check('a valid edit saves and closes', (await modalCount()) === 0 && JSON.parse(await readMap('dvorak-test')).keys.a === 'ס', 'modals=' + await modalCount());

await h.send('Page.bringToFront'); await h.ev(`${E}.focus()`); await h.sleep(200);
let t = await typed('a');
check('the edited map types at once', t === 'ס', JSON.stringify(t));
await h.doc('אס ש\n', 0, 0); await h.key('f'); await h.sleep(100); await h.key('a'); await h.sleep(250);
let s = await h.st(); await K('Escape');
check('f follows the active map', s.ch === 1, 'ch=' + s.ch);
await h.doc('אבג\n', 0, 0); await K('r', 100); await K('a', 250); s = await h.st();
check('r follows the active map', s.text.startsWith('סבג'), JSON.stringify(s.text));
await h.doc('אבג\n', 0, 0); await K('R'); await K('a'); await K('Escape'); s = await h.st();
check('Replace follows the active map', s.text.startsWith('סבג'), JSON.stringify(s.text));
await h.ev(`app.commands.executeCommandById('command-palette:open')`); await h.sleep(500); await h.keys('a');
const pv = await h.ev(`document.querySelector('input.prompt-input')?.value`); await K('Escape', 400);
check('fields follow the active map, and palette opens in the main window', pv === 'ס', JSON.stringify(pv));

// Switch back and forth
await sw.send('Page.bringToFront'); await sw.sleep(200);
await pick('qwerty'); await sw.sleep(400);
await h.send('Page.bringToFront'); await h.ev(`${E}.focus()`); await h.sleep(200);
t = await typed('a'); check('switching to the default applies at once', t === 'ש', JSON.stringify(t));
await sw.send('Page.bringToFront'); await sw.sleep(200);
await pick('dvorak-test'); await sw.sleep(400);
await h.send('Page.bringToFront'); await h.ev(`${E}.focus()`); await h.sleep(200);
t = await typed('a'); check('switching back applies at once', t === 'ס', JSON.stringify(t));

// Survives a reload, then an invalid external file
await h.ev(`(async () => { await app.plugins.disablePlugin('babel-fish-math'); await app.plugins.enablePlugin('babel-fish-math'); await new Promise((r) => setTimeout(r, 1500)); })()`);
t = await typed('a'); check('the active map survives a plugin reload', t === 'ס', JSON.stringify(t));
await h.ev(`${P}.settings.hebrew`);
await h.ev(`(async () => { await ${AD}.write(${DIR} + 'bad.json', '{ nope'); await ${AD}.write(${DIR} + 'dvorak-test.json', '{ broken'); })()`);
await h.ev(`app.setting.close && 0`);
await sw.send('Page.bringToFront'); await sw.sleep(200);
await h.ev(`app.setting.openTabById('babel-fish-math')`); await sw.sleep(500);
await clearN();
console.log('Reload:', await clickBtn('Manage key maps', 'Reload')); await sw.sleep(600);
const n2 = await notices();
check('broken files are named in a notice', /bad\.json/.test(n2) && /dvorak-test\.json/.test(n2), n2.slice(0, 200));
check('a broken file is not overwritten', (await readMap('bad')) === '{ nope' && (await readMap('dvorak-test')) === '{ broken', '');
console.log('dropdown:', await dropdown());
await h.send('Page.bringToFront'); await h.ev(`${E}.focus()`); await h.sleep(200);
t = await typed('a'); check('a broken active map falls back to the original', t === 'ש', JSON.stringify(t));

// Delete
await h.ev(`(async () => { await ${AD}.remove(${DIR} + 'bad.json'); await ${AD}.write(${DIR} + 'dvorak-test.json', ${JSON.stringify(JSON.stringify(edited))}); })()`);
await sw.send('Page.bringToFront'); await sw.sleep(200);
console.log('Reload:', await clickBtn('Manage key maps', 'Reload')); await sw.sleep(600);
console.log('dropdown:', await dropdown());
console.log('Delete:', await clickBtn('Manage key maps', 'Delete')); await sw.sleep(500);
console.log('confirm buttons:', await sw.ev(`[...${DOC}.querySelectorAll('.modal:not(.mod-settings) button')].map((b) => b.textContent).join(',')`));
await modalBtn('Cancel'); await sw.sleep(400);
check('Delete cancelled keeps the file', await exists('dvorak-test'), '');
console.log('Delete:', await clickBtn('Manage key maps', 'Delete')); await sw.sleep(500);
await modalBtn('Delete'); await sw.sleep(600);
check('Delete removes it and switches to the default', !(await exists('dvorak-test')) && (await h.ev(`${P}.settings.activeMap`)) === 'qwerty', await h.ev(`${P}.settings.activeMap`));
console.log('default Delete button:', await clickBtn('Manage key maps', 'Delete'));

// Edit the default on disk, then Reset
const orig = await readMap('qwerty');
await h.ev(`${AD}.write(${DIR} + 'qwerty.json', ${JSON.stringify(orig.replace('"a": "ש"', '"a": "ס"'))})`);
console.log('Reload:', await clickBtn('Manage key maps', 'Reload')); await sw.sleep(600);
await h.send('Page.bringToFront'); await h.ev(`${E}.focus()`); await h.sleep(200);
t = await typed('a'); check('editing qwerty.json by hand, then Reload, applies', t === 'ס', JSON.stringify(t));
await sw.send('Page.bringToFront'); await sw.sleep(200);
console.log('Reset:', await clickBtn('Reset default map', 'Reset default map')); await sw.sleep(500);
await modalBtn('Cancel'); await sw.sleep(400);
check('Reset cancelled keeps the edit', (await readMap('qwerty')).includes('"a": "ס"'), '');
console.log('Reset:', await clickBtn('Reset default map', 'Reset default map')); await sw.sleep(500);
await modalBtn('Reset'); await sw.sleep(600);
check('Reset restores the original', (await readMap('qwerty')) === orig || !(await readMap('qwerty')).includes('"a": "ס"'), '');
await h.send('Page.bringToFront'); await h.ev(`${E}.focus()`); await h.sleep(200);
t = await typed('a'); check('Reset applies at once', t === 'ש', JSON.stringify(t));
// Delete the file: comes back on the next load
await h.ev(`${AD}.remove(${DIR} + 'qwerty.json')`);
await h.ev(`(async () => { await app.plugins.disablePlugin('babel-fish-math'); await app.plugins.enablePlugin('babel-fish-math'); await new Promise((r) => setTimeout(r, 1500)); })()`);
check('a deleted default comes back on load', await exists('qwerty'), '');

// Cleanup
if (hebrewFile) await h.ev(`${AD}.remove(${DIR} + '${hebrewFile}.json')`);
await h.ev(`app.setting.close()`); sw.close();
await h.sleep(100); await h.ev(`1`); await h.sleep(500);
console.log('errors:', h.logs.filter((l) => /error|exception|TypeError/i.test(l) && !/placeCursorAround|Invalid position/.test(l)).slice(-5).join(' | ') || '(none)');
console.log('final:', await h.ev(`(async () => { const f = app.vault.getAbstractFileByPath('${FILE}'); app.workspace.getLeavesOfType('markdown').forEach((l) => { if (l.view.file === f) l.detach(); }); if (f) await app.vault.delete(f); return JSON.stringify(app.plugins.plugins['babel-fish-math'].settings) + ' files=' + JSON.stringify((await ${AD}.list(${DIR})).files.map((x) => x.split('/').pop())); })()`));
h.close();
