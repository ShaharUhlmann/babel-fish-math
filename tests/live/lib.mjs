import { connect } from './cdp.mjs';
export const FILE = '_cdp-test.md';
export async function setup() {
  const c = await connect();
  await c.ev(`(async () => {
    let f = app.vault.getAbstractFileByPath('${FILE}');
    if (!f) f = await app.vault.create('${FILE}', '');
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(f, { state: { mode: 'source', source: false } });
    app.workspace.setActiveLeaf(leaf, { focus: true });
  })()`);
  await c.sleep(500);
  const H = {
    ...c,
    async doc(text, line = 0, ch = 0) {
      await c.ev(`(async () => {
        const v = app.workspace.activeLeaf.view; const e = v.editor;
        e.setValue(${JSON.stringify(text)}); await new Promise(r => setTimeout(r, 150));
        e.focus(); e.setCursor({ line: ${line}, ch: ${ch} });
      })()`);
      await c.sleep(250);
      await c.key('Escape'); await c.key('Escape');
      await c.ev(`app.workspace.activeLeaf.view.editor.setCursor({ line: ${line}, ch: ${ch} })`);
      await c.sleep(80);
    },
    async st() {
      return JSON.parse(await c.ev(`(() => {
        const e = app.workspace.activeLeaf.view.editor; const cur = e.getCursor();
        const vim = e.cm.cm?.state?.vim;
        const sel = e.getSelection();
        return JSON.stringify({ text: e.getValue(), line: cur.line, ch: cur.ch,
          mode: vim ? (vim.insertMode ? 'insert' : vim.visualMode ? 'visual' : 'normal') : '?', sel });
      })()`));
    },
  };
  return H;
}
export const results = [];
export function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + (detail ? '  — ' + detail : ''));
}
