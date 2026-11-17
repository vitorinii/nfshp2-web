// Drives a headless Chrome over the DevTools protocol, for runs nobody watches: opens the page, plays, logs the console, takes screenshots and
// presses keys on a schedule.
//
//   node tools/cdp.mjs --seconds 40 --shots 10,20,30 --keys "12:Enter,15:ArrowDown" [--url http://localhost:8080/?autoplay] [--out dir]
//                      [--headful] [--hold "20-25:ArrowUp"] [--click "12:640:400"] [--eval "10:expr|12:expr"] [--keep-profile]
//                      [--profile <dir>] [--chrome <path>] [--size 1280,800]
//
// Screenshots go to --out (default build/cdp) as shot-<seconds>.png; the console to console.txt there.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const has = n => process.argv.includes(n);
const URL_ = arg('--url', 'http://localhost:8080/?autoplay');
const SECONDS = +arg('--seconds', 30);
const SHOTS = (arg('--shots', '') || '').split(',').filter(Boolean).map(Number);
const KEYS = (arg('--keys', '') || '').split(',').filter(Boolean).map(s => { const [t, k] = s.split(':'); return { t: +t, k }; });
const CLICKS = (arg('--click', '') || '').split(',').filter(Boolean).map(s => { const [t, x, y] = s.split(':').map(Number); return { t, x, y }; });
const EVALS = (arg('--eval', '') || '').split('|').filter(Boolean).map(s => { const i = s.indexOf(':'); return { t: +s.slice(0, i), x: s.slice(i + 1) }; });
const HOLDS = (arg('--hold', '') || '').split(',').filter(Boolean).map(s => { const [r, k] = s.split(':'); const [a, b] = r.split('-').map(Number); return { a, b, k }; });
const OUT = path.resolve(arg('--out', 'build/cdp'));
const PORT = +arg('--port', 9333);
const SIZE = arg('--size', '1280,800').split(',').map(Number);      // the page's viewport
const PROFILE = arg('--profile', path.join(os.tmpdir(), 'nfshp2-web-chrome'));     // made anew each run, unless --keep-profile
const CHROME = arg('--chrome', process.env.CHROME || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome'));

mkdirSync(OUT, { recursive: true });
const consoleFile = path.join(OUT, 'console.txt');
writeFileSync(consoleFile, '');
const note = s => { appendFileSync(consoleFile, s + '\n'); if (!/^\[(io|null)\]/.test(s) || has('--verbose')) console.log(s); };

if (!has('--keep-profile')) rmSync(PROFILE, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  has('--headful') ? '' : '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run',
  '--no-default-browser-check', '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required', `--window-size=${SIZE[0]},${SIZE[1] + 100}`,
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank',
].filter(Boolean), { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', d => { const s = String(d); if (/error|fatal/i.test(s) && !/DEPRECATED|dbus|Fontconfig/i.test(s)) appendFileSync(path.join(OUT, 'chrome-stderr.txt'), s); });
const stop = () => { try { chrome.kill('SIGKILL'); } catch {} };
process.on('exit', stop);

async function targets() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (r.ok) return r.json(); } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Chrome did not start');
}

const list = await targets();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const waiting = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const msg = { id: ++id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  waiting.set(msg.id, { res, rej });
  ws.send(JSON.stringify(msg));
});
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
ws.onmessage = async e => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const s = m.params.args.map(a => a.value !== undefined ? a.value : a.description || a.type).join(' ');
    note(`${stamp()} ${m.sessionId ? 'W' : 'P'} ${s}`);
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    note(`${stamp()} EXCEPTION ${d.exception ? d.exception.description : d.text} ${d.url || ''}:${d.lineNumber}`);
  } else if (m.method === 'Log.entryAdded') {
    note(`${stamp()} LOG ${m.params.entry.level} ${m.params.entry.text}`);
  } else if (m.method === 'Target.attachedToTarget') {
    const sid = m.params.sessionId;
    send('Runtime.enable', {}, sid).catch(() => {});
    send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
  }
};
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: SIZE[0], height: SIZE[1], deviceScaleFactor: 1, mobile: SIZE[0] < 600 });
await send('Page.navigate', { url: URL_ });

const keyDef = k => {
  const named = { Enter: [13, 'Enter', '\r'], Escape: [27, 'Escape'], ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'],
    ArrowRight: [39, 'ArrowRight'], Space: [32, 'Space', ' '], Backspace: [8, 'Backspace'], Tab: [9, 'Tab'] };
  if (named[k]) { const [code, c, text] = named[k]; return { windowsVirtualKeyCode: code, code: c, key: k === 'Space' ? ' ' : k, text }; }
  if (/^[A-Z]$/.test(k)) return { windowsVirtualKeyCode: k.charCodeAt(0), code: `Key${k}`, key: k.toLowerCase(), text: k.toLowerCase() };
  return { windowsVirtualKeyCode: 0, code: k, key: k };
};
const keyEvent = (type, k) => send('Input.dispatchKeyEvent', { type, ...keyDef(k) });
const press = async k => { await keyEvent('keyDown', k); await new Promise(r => setTimeout(r, 120)); await keyEvent('keyUp', k); };
const shot = async t => {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `shot-${String(t).padStart(3, '0')}.png`);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    note(`${stamp()} [cdp] screenshot ${file}`);
  } catch (err) { note(`${stamp()} [cdp] screenshot failed: ${err.message}`); }
};

const events = [...SHOTS.map(t => ({ t, f: () => shot(t) })), ...KEYS.map(({ t, k }) => ({ t, f: () => { note(`${stamp()} [cdp] key ${k}`); return press(k); } })),
  ...CLICKS.map(({ t, x, y }) => ({ t, f: async () => {
    note(`${stamp()} [cdp] click ${x},${y}`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await new Promise(r => setTimeout(r, 300));
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await new Promise(r => setTimeout(r, 120));
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  } })),
  ...EVALS.map(({ t, x }) => ({ t, f: async () => { try { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); note(`${stamp()} [eval] ${x} => ${JSON.stringify(r.result.value ?? r.result.description)}`); } catch (e) { note(`${stamp()} [eval] ${x} failed: ${e.message}`); } } })),
  ...HOLDS.flatMap(({ a, b, k }) => [{ t: a, f: () => { note(`${stamp()} [cdp] hold ${k}`); return keyEvent('keyDown', k); } }, { t: b, f: () => { note(`${stamp()} [cdp] release ${k}`); return keyEvent('keyUp', k); } }])]
  .sort((x, y) => x.t - y.t);
for (const ev of events) {
  const wait = t0 + ev.t * 1000 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  await ev.f();
}
const rest = t0 + SECONDS * 1000 - Date.now();
if (rest > 0) await new Promise(r => setTimeout(r, rest));
note(`${stamp()} [cdp] done`);
stop();
process.exit(0);
