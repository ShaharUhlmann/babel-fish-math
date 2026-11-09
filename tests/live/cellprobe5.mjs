// R3: does h / l at a cell's edge get stuck?
const { setup, FILE } = await import('./lib.mjs');
const h = await setup();
const where = () => h.ev(`(()=>{const ae=app.workspace.activeEditor.editor;const cm=ae.activeCM;const v=cm&&cm.cm&&cm.cm.state.vim;const d=window.CodeMirrorAdapter.getTableDebugState();return JSON.stringify({text:cm?cm.state.doc.toString().slice(0,12):null,head:cm?cm.state.selection.main.head:null,mode:v?(v.insertMode?'ins':'nor'):null,nav:d.nav&&d.nav.state,row:d.nav&&d.nav.activeRow,col:d.nav&&d.nav.activeCol});})()`);
async function scenario(label, table) {
  console.log('--- ' + label);
  await h.doc('intro\n\n' + table + '\n\nend\n', 0, 0);
  await h.sleep(500);
  await h.key('j'); await h.sleep(200); await h.key('j'); await h.sleep(300);
  console.log('entered', await where());
  for (const k of ['l', 'l', 'h', 'h']) { await h.key(k); await h.sleep(250); console.log('nav ' + k, await where()); }
  await h.key('i'); await h.sleep(300); await h.key('Escape'); await h.sleep(300);
  console.log('edit', await where());
  await h.key('$'); await h.sleep(200); console.log('$', await where());
  await h.key('l'); await h.sleep(300); console.log('l at last char', await where());
  await h.key('i'); await h.sleep(300); await h.key('Escape'); await h.sleep(300);
  await h.key('0'); await h.sleep(200); console.log('0', await where());
  await h.key('h'); await h.sleep(300); console.log('h at first char', await where());
  await h.key('Escape'); await h.sleep(200); await h.key('Escape'); await h.sleep(200);
}
const en = '| abcdef | bb |\n| --- | --- |\n| cc | dd |';
const he = '| שלום | עולם |\n| --- | --- |\n| ככ | דד |\n\nשלום';
await scenario('ON, English table', en);
await scenario('ON, Hebrew table', he);
await h.ev(`app.plugins.disablePlugin('rtl-math-mix')`); await h.sleep(800);
await scenario('DISABLED, English table', en);
await h.ev(`app.plugins.enablePlugin('rtl-math-mix')`); await h.sleep(1500);
await h.ev(`(async()=>{for(const p of ['${FILE}']){const f=app.vault.getAbstractFileByPath(p);app.workspace.getLeavesOfType('markdown').forEach(l=>{if(l.view.file===f)l.detach();});if(f)await app.vault.delete(f);}})()`);
h.close();
