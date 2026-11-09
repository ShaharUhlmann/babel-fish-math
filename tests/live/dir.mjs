import { setup, check } from './lib.mjs';
const h = await setup();
const q = (js) => h.ev(`(() => { const v = app.workspace.activeLeaf.view; const ed = v.contentEl.querySelector('.cm-editor'); ${js} })()`);
const dirOf = (sel) => `getComputedStyle(${sel}).direction`;
const lineDir = (i) => q(`const ls = [...ed.querySelectorAll('.cm-content > .cm-line')]; const l = ls[${i}]; return l ? getComputedStyle(l).direction + '/' + getComputedStyle(l).textAlign + ' ' + l.className : 'none';`);
let r;

await h.doc('שלום עולם\n$x$ שלום\nabc def\n\n$$\nx+1\n$$\n', 0, 0); await h.sleep(300);
r = await q(`return ed.querySelector('.cm-content').getAttribute('dir') + ' ' + ${dirOf("ed.querySelector('.cm-content')")}`);
check('C1 Hebrew note → RTL editor', /rtl/.test(r), r);
r = await lineDir(1); check('C2 line starting with math is RTL', r.startsWith('rtl'), r);
r = await q(`const m = ed.querySelector('.cm-line:nth-child(2) .cm-math, .cm-line:nth-child(2) [class*="math"]'); return m ? getComputedStyle(m).direction + ' ' + getComputedStyle(m).unicodeBidi + ' ' + m.className : 'no math el';`);
check('C2 inline math is an LTR isolate', /ltr/.test(r) && /isolate/.test(r), r);
r = await lineDir(5); check('C3 display math line LTR', r.startsWith('ltr'), r);
r = await lineDir(2); check('C1 English line in Hebrew note', true, r);

// cursor class (V9)
await h.ev(`app.workspace.activeLeaf.view.editor.setCursor({line:1,ch:1})`); await h.sleep(200);
r = await q(`return ed.className.match(/math-dir-cur-\\w+/g)?.join(',')`); check('V9 cursor in math → cur-ltr', /cur-ltr/.test(r || ''), r);
await h.ev(`app.workspace.activeLeaf.view.editor.setCursor({line:0,ch:1})`); await h.sleep(200);
r = await q(`return ed.className.match(/math-dir-cur-\\w+/g)?.join(',')`); check('V9 cursor in Hebrew → cur-rtl', /cur-rtl/.test(r || ''), r);

// English-only note, and direction override
await h.doc('Just English here.\n', 0, 0); await h.sleep(300);
r = await q(`return ${dirOf("ed.querySelector('.cm-content')")}`); check('C1 English-only note → LTR', r === 'ltr', r);
await h.doc('---\ndirection: ltr\n---\nשלום עולם\n', 3, 0); await h.sleep(400);
r = await q(`return ${dirOf("ed.querySelector('.cm-content')")}`); check('C9 direction: ltr override', r === 'ltr', r);
await h.doc('---\ndirection: ltr\n---\nשלום עולם\n', 3, 0); await h.keys('3h'); const s = await h.st();
check('C9 override → h/l logical (3h from ש stays at 0)', s.ch === 0, `ch=${s.ch}`);

// Reading view
await h.doc('שלום עולם $x+1$\n\nEnglish paragraph first.\n\n$$\ny=2\n$$\n\n```\ncode\n```\n', 0, 0); await h.sleep(300);
await h.ev(`app.workspace.activeLeaf.setViewState({type:'markdown', state:{file:'_cdp-test.md', mode:'preview'}})`); await h.sleep(1200);
r = await h.ev(`(() => { const p = app.workspace.activeLeaf.view.contentEl.querySelector('.markdown-preview-view'); const ps = [...p.querySelectorAll('p')]; const mj = p.querySelector('mjx-container[display="true"], .math-block'); const pre = p.querySelector('pre');
  return JSON.stringify({ root: getComputedStyle(p.querySelector('.markdown-preview-sizer') || p).direction, paras: ps.map(e => getComputedStyle(e).direction + '/' + getComputedStyle(e).textAlign), block: mj ? getComputedStyle(mj).direction : 'none', inl: (() => { const m = p.querySelector('p mjx-container, p .math'); return m ? getComputedStyle(m).direction : 'none'; })(), pre: pre ? getComputedStyle(pre).direction : 'none' }); })()`);
const R = JSON.parse(r);
check('C10 Reading view RTL, English paragraph right-aligned', R.paras.every(p => p.startsWith('rtl') || /right|start/.test(p)), r);
check('C10 Reading view math/code LTR', R.block === 'ltr' && R.inl === 'ltr' && R.pre === 'ltr', r);
await h.ev(`app.workspace.activeLeaf.setViewState({type:'markdown', state:{file:'_cdp-test.md', mode:'source', source:false}})`); await h.sleep(800);

console.log('\nconsole:\n' + (h.logs.join('\n') || '(none)'));
h.close();
