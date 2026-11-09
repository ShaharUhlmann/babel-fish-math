import { setup, check, FILE } from './lib.mjs';
const h0 = await setup();
console.log(await h0.ev(`(async () => { await app.plugins.disablePlugin('rtl-math-mix'); await app.plugins.enablePlugin('rtl-math-mix'); await new Promise(r => setTimeout(r, 2500)); return 'reloaded; has relabel: ' + String(app.plugins.plugins['rtl-math-mix'].constructor.toString().length) + ' hebrew=' + app.plugins.plugins['rtl-math-mix'].settings.hebrew; })()`));
h0.close();
const h = await setup();
const E = `app.workspace.activeLeaf.view.editor`;
const sels = () => h.ev(`JSON.stringify(${E}.listSelections().map(s => [s.head.line, s.head.ch]))`);
const notices = () => h.ev(`[...document.querySelectorAll('.notice')].map(n=>n.textContent).join(' | ')`);
const pending = () => h.ev(`JSON.stringify({kb: ${E}.cm.cm.state.vim.inputState.keyBuffer, op: ${E}.cm.cm.state.vim.inputState.operator || null, rec: !!CodeMirrorAdapter.Vim.getVimGlobalState_().macroModeState?.isRecording})`);
const K = (key, code, o = {}) => h.key(key, { code, vk: o.vk || 0, ...o });
let s;

// 1 visual block insert
await h.doc('a\nb\nc\n', 0, 0);
await h.key('v', { ctrl: true, code: 'KeyV', vk: 86, wait: 120 }); await h.keys('jj'); await h.key('I', { shift: true, code: 'KeyI', vk: 73 }); await h.keys('akuo'); await h.key('Escape', { wait: 300 });
s = await h.st(); check('1 <C-v>jjI akuo → שלום on 3 lines', s.text === 'שלוםa\nשלוםb\nשלוםc\n' && s.mode === 'normal', JSON.stringify(s.text) + ' ' + s.mode);

// 2 multi-cursor
await h.doc('x\ny\n', 0, 0); await h.key('i');
await h.ev(`${E}.setSelections([{anchor:{line:0,ch:0}},{anchor:{line:1,ch:0}}])`); await h.sleep(100);
await h.keys('akuo'); s = await h.st(); const sl = await sels();
check('2 multi-cursor akuo', s.text === 'שלוםx\nשלוםy\n' && sl === '[[0,4],[1,4]]', JSON.stringify(s.text) + ' ' + sl);
await h.key('Escape');

// 3 single cursor + undo
await h.doc('hello\n', 0, 2); await h.key('i'); await h.key('a'); s = await h.st();
check('3 single cursor', s.text === 'heשllo\n' && s.ch === 3, JSON.stringify(s.text) + ' ch=' + s.ch);
await h.key('Escape'); await h.key('u', { wait: 200 }); s = await h.st(); check('3 one undo step', s.text === 'hello\n', JSON.stringify(s.text));

// 4 auto-pair
await h.doc('\n\n', 0, 0); await h.key('i'); await h.key(')', { shift: true, code: 'Digit0', vk: 48 }); s = await h.st();
check('4 ) auto-pairs to ()', s.text.split('\n')[0] === '()' && s.ch === 1, JSON.stringify(s.text) + ' ch=' + s.ch);
await h.key('Escape');
await h.doc('\n\n', 0, 0); await h.key('i'); await h.ev(`${E}.setSelections([{anchor:{line:0,ch:0}},{anchor:{line:1,ch:0}}])`);
await h.key(')', { shift: true, code: 'Digit0', vk: 48 }); s = await h.st();
check('4 two cursors → () each', s.text.startsWith('()\n()'), JSON.stringify(s.text));
await h.key('Escape');

// 5 math cursor in multi
await h.doc('ab\n$cd$\n', 0, 1); await h.key('i');
await h.ev(`${E}.setSelections([{anchor:{line:0,ch:1}},{anchor:{line:1,ch:2}}], 0)`); await h.keys('k'); s = await h.st();
check('5 multi with one cursor in math', s.text === 'aלb\n$ckd$\n', JSON.stringify(s.text));
await h.key('Escape');

// 6 OS Hebrew normal mode punctuation
await h.ev(`document.querySelectorAll('.notice').forEach(n=>n.remove())`);
await h.doc('one two three\n', 0, 0);
await K('ץ', 'Period', { vk: 190 }); let p = await pending(); s = await h.st();
check('6 ץ (Period) does not start a delete', !JSON.parse(p).op && s.text === 'one two three\n', p);
await K('ת', 'Comma', { vk: 188 }); s = await h.st(); check('6 ת (Comma) stays normal', s.mode === 'normal', s.mode);
await K('ף', 'Semicolon', { vk: 186 }); s = await h.st(); check('6 ף (Semicolon) stays normal, no change', s.mode === 'normal' && s.text === 'one two three\n', s.mode);
await K("'", 'KeyW', { vk: 87 }); s = await h.st(); check("6 ' on KeyW acts as w → (0,4)", s.ch === 4, 'ch=' + s.ch);
let n = await notices(); check('6 layout warning shown', /keyboard|Hebrew/i.test(n), n.slice(0, 80));
await K('.', 'Slash', { vk: 191, wait: 200 }); const promptOpen = await h.ev(`!!document.activeElement && document.activeElement.tagName === 'INPUT'`);
check('6 . on Slash opens / prompt', promptOpen, String(promptOpen));
await h.key('Escape', { wait: 200 }); await h.ev(`${E}.focus()`);
await h.doc('one two three\n', 0, 0);
await K('/', 'KeyQ', { vk: 81, wait: 100 }); await h.key('a', { wait: 100 }); p = await pending();
check('6 / on KeyQ starts macro recording (q a)', JSON.parse(p).rec === true, p);
await K('/', 'KeyQ', { vk: 81, wait: 150 }); p = await pending(); check('6 stop recording', JSON.parse(p).rec === false, p);

// 7 f/t/r and labels on OS Hebrew
await h.doc('שלום\n', 0, 0); await K('כ', 'KeyF', { vk: 70 }); await K('ו', 'KeyU', { vk: 85 }); s = await h.st();
check('7 OS-Hebrew f ו → (0,2)', s.ch === 2, 'ch=' + s.ch);
await h.doc('שלום\n', 0, 0); await K('ר', 'KeyR', { vk: 82 }); await K('ש', 'KeyA', { vk: 65 }); s = await h.st();
check('7 OS-Hebrew r ש replaces', s.text === 'ששום\n', JSON.stringify(s.text));
await h.doc('שלום שלום שלום\n', 0, 0); await h.keys('fa'); await K('ש', 'KeyA', { vk: 65 }); s = await h.st();
check('7 flash label a via ש', s.ch === 5, 'ch=' + s.ch);

// 9 Ctrl+[ in / after incsearch, with d pending
const lines = Array.from({ length: 220 }, (_, i) => i === 200 ? 'שלום target' : 'line ' + i).join('\n') + '\n';
await h.doc(lines, 0, 0); await h.sleep(300);
const top0 = await h.ev(`${E}.cm.scrollDOM.scrollTop`);
await h.key('d'); await h.key('/', { code: 'Slash', vk: 191, wait: 200 }); await h.keys('akuo'); await h.sleep(500);
const topMid = await h.ev(`${E}.cm.scrollDOM.scrollTop`);
await h.key(']', { code: 'BracketLeft', vk: 221, ctrl: true, wait: 500 });
const top1 = await h.ev(`${E}.cm.scrollDOM.scrollTop`); p = await pending();
await h.key('w', { wait: 200 }); s = await h.st();
check('9 incsearch scrolled', topMid > top0 + 100, `${top0}→${topMid}`);
check('9 Ctrl+[ restores scroll, no pending d, nothing deleted', Math.abs(top1 - top0) < 5 && !JSON.parse(p).op && s.text === lines && s.line === 0 && s.ch === 5, `scroll ${top1}, pending ${p}, cursor ${s.line}:${s.ch}, same text ${s.text === lines}`);

// 8 Ex modal from file explorer
await h.ev(`(() => { const l = app.workspace.getLeavesOfType('file-explorer')[0]; app.workspace.revealLeaf(l); app.workspace.setActiveLeaf(l, { focus: true }); l.view.containerEl.querySelector('.nav-files-container')?.focus(); })()`); await h.sleep(400);
await h.key(':', { code: 'Semicolon', vk: 186, shift: true, wait: 400 });
const exOpen = await h.ev(`document.querySelector('.prompt-input')?.placeholder || 'none'`);
await K("'", 'KeyW', { vk: 87 }); const v1 = await h.ev(`document.querySelector('.prompt-input')?.value`);
await h.ev(`(() => { const i = document.querySelector('.prompt-input'); if (i) { i.value=''; i.dispatchEvent(new Event('input')); } })()`);
await h.key('w', { code: 'KeyW', vk: 87 }); const v2 = await h.ev(`document.querySelector('.prompt-input')?.value`);
check('8 Ex modal opened from explorer', /Ex command/i.test(exOpen), exOpen);
check('8 Ex modal: OS-Hebrew KeyW → w, layer-on w → w', v1 === 'w' && v2 === 'w', `os-hebrew=${v1} layer=${v2}`);
await h.key('Escape', { wait: 300 });

console.log('\nconsole:\n' + (h.logs.join('\n') || '(none)'));
console.log(await h.ev(`(async () => { const f = app.vault.getAbstractFileByPath('${FILE}'); app.workspace.getLeavesOfType('markdown').forEach(l => { if (l.view.file === f) l.detach(); }); if (f) await app.vault.delete(f); return 'cleaned; hebrew=' + app.plugins.plugins['rtl-math-mix'].settings.hebrew; })()`));
h.close();
