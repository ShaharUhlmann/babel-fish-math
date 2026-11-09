import { setup, check } from './lib.mjs';
const h = await setup();
await h.doc('שלום עולם\n\n$$\nx+1\n$$\n\n```\ncode\n```\n', 3, 1); await h.sleep(400);
const r = await h.ev(`(() => { const ed = app.workspace.activeLeaf.view.contentEl.querySelector('.cm-editor'); return [...ed.querySelectorAll('.cm-content > .cm-line')].map(l => getComputedStyle(l).direction + ':' + l.textContent.slice(0,6) + ':' + l.className.replace('cm-line','').trim()).join(' | '); })()`);
console.log(r);
check('C3 display math lines LTR (cursor inside)', /ltr:x\+1/.test(r) && /ltr:\$\$/.test(r), '');
check('C3 code lines LTR', /ltr:code/.test(r), '');
h.close();
