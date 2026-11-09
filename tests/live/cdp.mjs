// Minimal CDP driver for Obsidian (started with --remote-debugging-port=9222).
// The test vault's name, as in its window title.
const VAULT = process.env.OBSIDIAN_TEST_VAULT || '';
export async function connect() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find(p => p.type === 'page' && p.url.startsWith('app://obsidian.md') && p.title.includes(' - ' + VAULT + ' - Obsidian '));
  if (!page) throw new Error(`no window for the vault "${VAULT}" (set OBSIDIAN_TEST_VAULT)`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map(); const logs = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning'))
      logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' '));
    else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function ev(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  }
  const special = {
    Escape: ['Escape', 27], Enter: ['Enter', 13], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
    ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], Backspace: ['Backspace', 8], Tab: ['Tab', 9], F12: ['F12', 123],
  };
  // key(k, {code, mods}) : k is a printable char or a special name.
  async function key(k, o = {}) {
    let p;
    const mods = (o.ctrl ? 2 : 0) | (o.shift ? 8 : 0) | (o.alt ? 1 : 0);
    if (special[k]) p = { key: k, code: special[k][0], windowsVirtualKeyCode: special[k][1] };
    else {
      const up = k.toUpperCase();
      const code = o.code || (/[a-z]/i.test(k) ? 'Key' + up : /[0-9]/.test(k) ? 'Digit' + k : '');
      const vk = o.vk || (/[a-z0-9]/i.test(k) ? up.charCodeAt(0) : 0);
      p = { key: k, code, windowsVirtualKeyCode: vk, text: o.ctrl ? undefined : k, unmodifiedText: k };
    }
    await send('Input.dispatchKeyEvent', { type: p.text ? 'keyDown' : 'rawKeyDown', modifiers: mods, ...p });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, ...p, text: undefined });
    await sleep(o.wait ?? 40);
  }
  async function keys(s, o) { for (const ch of s) await key(ch, o); }
  return { send, ev, key, keys, sleep, logs, close: () => ws.close() };
}
