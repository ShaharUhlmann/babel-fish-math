import { setup, check } from './lib.mjs';
const h = await setup();
const HEB = 'שלום עולם\n';
const line0 = (s) => s.text.split('\n')[0];
const dirNow = () => h.ev(`getComputedStyle(app.workspace.activeLeaf.view.contentEl.querySelector('.cm-content')).direction`);
const visualOK = async (label) => {
  await h.doc(HEB, 0, 0); await h.keys('3h'); const a = await h.st();
  await h.doc(HEB, 0, 2); await h.keys('3dl'); const b = await h.st();
  check(label, a.ch === 3 && line0(b) === 'ם עולם', `3h→${a.ch}, 3dl→${line0(b)}`);
};
const reopen = async () => { await h.ev(`(async () => { const f = app.vault.getAbstractFileByPath('_cdp-test.md'); await app.workspace.getLeaf(false).openFile(f, { state: { mode: 'source', source: false } }); })()`); await h.sleep(600); };

// Vim Motions off → on
await h.ev(`app.plugins.disablePlugin('vim-motions')`); await h.sleep(1000);
await h.ev(`app.plugins.enablePlugin('vim-motions')`); await h.sleep(3500); await reopen();
await visualOK('J12 Vim Motions off/on → visual motions back');

// math-dir off
await h.ev(`app.plugins.disablePlugin('rtl-math-mix')`); await h.sleep(1000); await reopen();
await h.doc(HEB, 0, 2); await h.keys('h'); let s = await h.st();
check('J12 math-dir off → h logical', s.ch === 1, `ch=${s.ch}`);
await h.doc('\n', 0, 0); await h.keys('iakuo'); await h.key('Escape'); s = await h.st();
const d = await (async () => { await h.doc(HEB, 0, 0); return dirNow(); })();
check('J12 math-dir off → no Hebrew typing, no RTL', line0(s) === 'akuo' && d === 'ltr', `typed=${line0(s)} dir=${d}`);
await h.ev(`app.plugins.enablePlugin('rtl-math-mix')`); await h.sleep(3500); await reopen();
await visualOK('J12 math-dir on again → visual motions');
await h.doc('\n', 0, 0); await h.keys('iakuo'); await h.key('Escape'); s = await h.st();
await h.doc(HEB, 0, 0);
check('J12 math-dir on again → Hebrew typing + RTL', line0(s) === 'שלום' && (await dirNow()) === 'rtl', `typed=${line0(s)}`);

// Visual h/l setting
await h.ev(`app.plugins.plugins['rtl-math-mix'].settings.visualMotions = false`); await h.sleep(2600);
await h.doc(HEB, 0, 2); await h.keys('h'); s = await h.st();
check('M6 Visual h/l off → logical within 2 s', s.ch === 1, `ch=${s.ch}`);
await h.ev(`app.plugins.plugins['rtl-math-mix'].settings.visualMotions = true`); await h.sleep(2600);
await visualOK('M6 Visual h/l on again → visual');

// M1 overlap with hebrew-vim
await h.ev(`document.querySelectorAll('.notice').forEach(n=>n.remove())`);
await h.ev(`app.plugins.enablePlugin('hebrew-vim')`); await h.sleep(2500); await reopen();
const ind = await h.ev(`[...document.querySelectorAll('.status-bar-item')].filter(e => e.offsetParent && /^(EN|עב)$/.test(e.textContent.trim())).map(e => e.className.replace('status-bar-item','').trim() + ':' + e.textContent).join(', ')`);
const notice = await h.ev(`[...document.querySelectorAll('.notice')].map(n=>n.textContent).join(' | ')`);
await h.doc('\n', 0, 0); await h.keys('iakuo'); await h.key('Escape'); s = await h.st();
check('M1 one indicator while both on', ind.split(', ').filter(Boolean).length === 1, ind);
check('M1 notice to disable hebrew-vim', /disable/i.test(notice), notice.slice(0, 100));
check('M1 akuo → שלום (no double translation)', line0(s) === 'שלום', line0(s));
const before = await h.ev(`app.plugins.plugins['hebrew-vim']?.settings?.hebrew`);
await h.key('F12'); await h.sleep(300);
const after = await h.ev(`app.plugins.plugins['hebrew-vim']?.settings?.hebrew`);
await h.doc('\n', 0, 0); await h.keys('iakuo'); await h.key('Escape'); const s2 = await h.st();
check('M1 F12 during overlap toggles typing', before !== after && line0(s2) === 'akuo', `hebrew-vim hebrew ${before}→${after}, typed ${line0(s2)}`);
await h.key('F12'); await h.sleep(300);
await h.ev(`app.plugins.disablePlugin('hebrew-vim')`); await h.sleep(2500); await reopen();

// M2 F12 after hebrew-vim is off
const ind2 = () => h.ev(`[...document.querySelectorAll('.status-bar-item.plugin-rtl-math-mix')].map(e=>e.textContent).join(',')`);
const i0 = await ind2(); await h.key('F12'); await h.sleep(300); const i1 = await ind2(); await h.key('F12'); await h.sleep(300); const i2 = await ind2();
check('M2 עב on, F12 toggles and back', i0 === 'עב' && i1 === 'EN' && i2 === 'עב', `${i0} → ${i1} → ${i2}`);
await h.doc('\n', 0, 0); await h.keys('iakuo'); await h.key('Escape'); s = await h.st();
check('M2 typing Hebrew after overlap ends', line0(s) === 'שלום', line0(s));

console.log('\nconsole:\n' + (h.logs.join('\n') || '(none)'));
console.log('enabled now:', await h.ev(`JSON.stringify([...app.plugins.enabledPlugins].filter(x => /math|hebrew|vim/.test(x)))`));
h.close();
