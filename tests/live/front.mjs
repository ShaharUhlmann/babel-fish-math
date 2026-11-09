import { connect } from './cdp.mjs';
const c = await connect();
await c.ev(`(() => { const w = require('electron').remote?.getCurrentWindow?.() || require('@electron/remote')?.getCurrentWindow?.(); if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); return 'shown'; } return 'no remote'; })()`).then(r => console.log(r)).catch(e => console.log('remote err', e.message.slice(0, 120)));
await c.send('Page.bringToFront');
await c.sleep(800);
console.log(await c.ev(`document.visibilityState`));
c.close();
