import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.CDP_PORT || '9223';
const FILE = process.env.INJECT_FILE || 'inject2.js';
const MATCH = process.env.CDP_MATCH || '';
const dir = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const src = fs.readFileSync(path.join(dir, FILE), 'utf8');

async function list() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return await r.json();
}

let ws, id = 0;
const pend = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)); } }, 20000);
  });

async function main() {
  const pages = (await list()).filter((t) => t.type === 'page');
  const page = MATCH ? pages.find((t) => t.url.includes(MATCH)) : pages[0];
  if (!page) throw new Error('no page target for ' + JSON.stringify(MATCH) + ' have=' + pages.map((p) => p.url).join(','));
  console.log('TARGET', page.url.slice(0, 80));

  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { res, rej } = pend.get(m.id);
      pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
    if (m.method === 'Page.frameNavigated' && m.params?.frame?.parentId === undefined) {
      console.log('NAV', m.params.frame.url.slice(0, 80));
      setTimeout(() => send('Runtime.evaluate', { expression: src, userGesture: true }).catch(() => {}), 2500);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  await send('Page.enable');
  const r = await send('Page.addScriptToEvaluateOnNewDocument', { source: src });
  console.log('REGISTERED', r.identifier);
  await send('Runtime.evaluate', { expression: src, returnByValue: true, userGesture: true });
  console.log('APPLIED_NOW ' + FILE);

  setInterval(async () => {
    try { await send('Runtime.evaluate', { expression: 'window.__YT_BOOST__&&window.__YT_BOOST__.tick()' }); } catch (e) {}
  }, 5000);
  setInterval(() => { try { ws.send(JSON.stringify({ id: ++id, method: 'Runtime.evaluate', params: { expression: '1' } })); } catch (e) {} }, 15000);
  await new Promise(() => {});
}
main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
