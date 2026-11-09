// R then Backspace on built-in Vim: is it the plugin?
const { setup, FILE } = await import('./lib.mjs');
const h = await setup();
const P = `app.plugins.plugins['babel-fish-math']`;
const K = async (k, w = 200) => { await h.key(k); await h.sleep(w); };
const run = async (label, doc, a, b) => {
  await h.doc(doc, 0, 0); await K('R'); await K(a); await K(b);
  const t1 = (await h.st()).text.split('\n')[0];
  await K('Backspace');
  const s = await h.st(); await K('Escape');
  console.log(label.padEnd(40), JSON.stringify(t1), '→ Backspace →', JSON.stringify(s.text.split('\n')[0]), 'ch=' + s.ch);
};
await run('math-dir on, layer on, Hebrew', 'אבגד\n', 'a', 'k');
await h.ev(`${P}.settings.hebrew = false`);
await run('math-dir on, layer off, English', 'abcd\n', 'x', 'y');
await h.ev(`app.plugins.disablePlugin('babel-fish-math')`); await h.sleep(800);
await run('math-dir disabled, English', 'abcd\n', 'x', 'y');
await h.ev(`app.plugins.enablePlugin('babel-fish-math')`); await h.sleep(1500);
await h.ev(`(async () => { const f = app.vault.getAbstractFileByPath('${FILE}'); app.workspace.getLeavesOfType('markdown').forEach((l) => { if (l.view.file === f) l.detach(); }); if (f) await app.vault.delete(f); })()`);
h.close();
