// The page: starts the game process (the module, the shared memory, the I/O worker and a pool of game threads), then hands the blocks the
// runtime registers to the renderer, the sound and the input.
import { CTL_EXIT, CTL_INTS, CTL_NEXT_TID, CTL_POOL, HOST_KIND_AUDIO, HOST_KIND_GPU, HOST_KIND_INPUT, POOL_MAX, POOL_RUN_MAIN, RPC_BYTES } from './proto.js';
import { GameDataPanel, SavesPanel, tabs } from './panels.js';
import { GraphicsPanel } from './graphics.js';
import { root, seedSettings } from './store.js';
import { prefs, setBlurSides } from './prefs.js';

const $ = id => document.getElementById(id);
const playBtn = $('play');
const params = new URLSearchParams(location.search);
const phone = matchMedia('(pointer: coarse)').matches;       // a phone or a tablet: touch controls, full screen on Play
{ const box = $('blur-sides'); box.checked = prefs.blurSides; box.addEventListener('change', () => setBlurSides(box.checked)); }
// the big status ("Loading", "Ready") and the line under it
function setStatus(head, sub = '', bad = false) {
  $('status').textContent = head;
  $('status').classList.toggle('bad', bad);
  $('status-sub').textContent = sub;
}
function progress(frac) {
  const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
  $('progress-fill').style.width = `${pct}%`;
  $('progress').setAttribute('aria-valuenow', pct);
}
function problem(text) {
  const li = document.createElement('li');
  li.textContent = text;
  $('problems').append(li);
}

// ---- the log: the console, and the server's log in batches when it keeps one (the local server does) ----
let logBuf = [];
let logToServer = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);      // a public server keeps no log
const logLine = (s, fd = 1) => {
  (fd === 2 ? console.warn : console.log)(s);
  logBuf.push(s);
  if (logBuf.length > 5000) logBuf.splice(0, logBuf.length - 5000);
};
setInterval(() => {
  if (!logBuf.length) return;
  const text = logBuf.join('\n') + '\n';
  logBuf = [];
  if (logToServer) fetch('/log', { method: 'POST', body: text }).then(r => { if (r.status === 404) logToServer = false; }, () => {});
}, 1000);
window.hp2log = logLine;

// ---- the counts the site keeps (web/stats.mjs): a visit, a play, each minute played, a stop. Nothing is kept in the browser for them;
// not sent from automated browsers, nor from one its owner has left out on /stats ----
let counting = !navigator.webdriver && !/HeadlessChrome/.test(navigator.userAgent);
try { if (localStorage.getItem('hp2.nocount') === '1') counting = false; } catch {}
function count(e, more) {
  if (!counting) return;
  try { navigator.sendBeacon('/hi', JSON.stringify({ e, ...more })); } catch {}
}
let minutes = null;
function playingFor(on) {
  clearInterval(minutes);
  minutes = on ? setInterval(() => { if (document.visibilityState === 'visible') count('min'); }, 60000) : null;
}

const POOL = 20;
const MEM_INITIAL = 16384, MEM_MAX = 65536;     // wasm pages: 1 GB at the start, 4 GB at most (the module's own minimum and maximum)

// what this browser must have; each missing thing is a line with what to do
// (why: a word for the counts)
async function checks() {
  const bad = [];
  const no = (why, text) => bad.push({ why, text });
  if (!isSecureContext) no('https', 'This page has to be opened over https (or on localhost, on the computer that runs the server).');
  else if (!crossOriginIsolated) no('isolation', 'The server has to send the isolation headers (Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy): start it with web/server.mjs.');
  if (!navigator.gpu) no('webgpu', phone ? 'This browser has no WebGPU. On an Android phone or tablet, use the latest Google Chrome.'
    : 'This browser has no WebGPU. Use the latest Google Chrome or Microsoft Edge.');
  else if (!(await navigator.gpu.requestAdapter().catch(() => null))) no('gpu', phone
    ? 'WebGPU is turned off in this browser, or this phone\'s graphics are not supported. Update the system and Chrome.'
    : 'WebGPU is turned off in this browser, or the graphics card is not supported. Check chrome://gpu.');
  if (!Atomics.waitAsync) no('old', 'This browser is too old for the game. Use the latest Google Chrome or Microsoft Edge.');
  try { await root(); } catch { no('storage', 'This browser does not let the page keep files (for your saves). In a private window, use a normal one.'); }
  return bad;
}

// the module, with its download on the progress bar
async function boot() {
  const bad = await checks();
  if (bad.length) {
    for (const b of bad) problem(b.text);
    count('cant', { why: bad.map(b => b.why) });
    throw Object.assign(new Error('This browser cannot run the game yet.'), { shown: true });
  }
  setStatus('Loading', 'Downloading the game code.');
  const t0 = performance.now();
  const r = await fetch('/hp2.wasm');
  if (!r.ok) throw new Error(`The game code is missing on the server (HTTP ${r.status}). Was it built (./setup.sh)?`);
  const total = +(r.headers.get('X-Size') || r.headers.get('Content-Length') || 0);
  let got = 0;
  const counted = r.body.pipeThrough(new TransformStream({
    transform(chunk, ctl) { got += chunk.length; if (total) progress(0.95 * got / total); ctl.enqueue(chunk); },
  }));
  const module = await WebAssembly.compileStreaming(new Response(counted, { headers: { 'Content-Type': 'application/wasm' } }));
  progress(1);
  logLine(`[page] module ${(got / 1048576).toFixed(1)} MB compiled in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return module;
}

let game = null;
// the game is over (its own Quit, or an error): the start panel again, and Play starts a fresh game (a reload: the process's memory is spent)
function ended(text, bad = false) {
  playingFor(false);
  // the game's other threads go on after its main one ends (the one that makes the sound among them): they stop here, and the sound and
  // the picture with them. The file worker stays to finish what it was asked (a save); nothing more comes to it
  for (const w of game?.workers || []) w.terminate();
  game?.sound?.ctx?.close().catch(() => {});
  game?.renderer?.stop();
  wake?.release().catch(() => {});
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('stage').hidden = true;
  $('start').hidden = false;
  setStatus(bad ? 'Stopped' : 'Ended', text, bad);
  playBtn.disabled = false;
  playBtn.firstChild.textContent = 'Play again ';
  playBtn.dataset.again = '1';
  saves.refresh().catch(() => {});
  graphics.refresh().catch(() => {});       // the game may have changed its settings in its own menus
}
async function start(module) {
  const memory = new WebAssembly.Memory({ initial: MEM_INITIAL, maximum: MEM_MAX, shared: true });
  const ctlBuf = new SharedArrayBuffer(CTL_INTS * 4), ctl = new Int32Array(ctlBuf);
  const rpc = new SharedArrayBuffer(RPC_BYTES * POOL_MAX);
  Atomics.store(ctl, CTL_NEXT_TID, 2);
  const env = ['HP2_DATA=/data', 'HOME=/'];
  for (const [k, v] of params) if (/^HP2_[A-Z0-9_]+$/.test(k)) env.push(`${k}=${v}`);

  const registered = new Map(), waiters = new Map();
  const registeredKind = kind => registered.has(kind) ? Promise.resolve(registered.get(kind))
    : new Promise(r => waiters.set(kind, [...(waiters.get(kind) || []), r]));
  const onMessage = (w, e) => {
    const m = e.data;
    switch (m.t) {
    case 'log': logLine(m.s, m.fd); break;
    case 'register':
      registered.set(m.kind, m);
      for (const r of waiters.get(m.kind) || []) r(m);
      waiters.delete(m.kind);
      logLine(`[page] block ${m.kind} at ${m.ptr.toString(16)}, ${m.size} bytes`);
      break;
    case 'exit': logLine(`[page] the game ended (${m.code})`); ended('The game has ended. Your progress is saved in this browser.'); break;
    case 'fatal': logLine(`[page] FATAL ${m.s}`, 2); count('stop', { s: m.s.split('\n')[0] }); ended(`The game stopped: ${m.s.split('\n')[0]}`, true); break;
    }
  };

  // a new browser starts at the widest picture (16:9 where the window is that wide): before the game reads its settings
  await seedSettings().then(w => w && logLine('[page] settings: new browser, picture aspect set to 16:9 (the game keeps it within the window)'),
    e => logLine(`[page] settings seed failed: ${e.message}`, 2));
  setStatus('Starting', 'Opening the game folder.');
  const ioWorker = new Worker('io-worker.js', { type: 'module' });
  await new Promise((res, rej) => {
    ioWorker.onmessage = e => {
      if (e.data.t === 'ready') res();
      else if (e.data.t === 'fatal') rej(new Error(e.data.s));
      else onMessage(ioWorker, e);
    };
    ioWorker.postMessage({ t: 'init', memory, ctl: ctlBuf, rpc, slots: POOL });
  });
  ioWorker.onmessage = e => onMessage(ioWorker, e);

  setStatus('Starting', 'Starting the game.');
  const workers = [];
  let ready = 0;
  await new Promise(res => {
    for (let slot = 0; slot < POOL; slot++) {
      const w = new Worker('game-worker.js', { type: 'module', name: `hp2 thread ${slot}` });
      w.onmessage = e => {
        if (e.data.t === 'ready') { if (++ready === POOL) res(); return; }
        onMessage(w, e);
      };
      w.onerror = e => logLine(`[page] worker ${slot} error: ${e.message}`, 2);
      w.postMessage({ t: 'init', module, memory, ctl: ctlBuf, rpc, slot, pool: POOL, env });
      workers.push(w);
    }
  });
  logLine(`[page] ${POOL} game threads ready`);

  game = { memory, ctl, registeredKind, workers, ioWorker };
  window.hp2 = game;
  // the main thread: _start on slot 0
  Atomics.store(ctl, CTL_POOL, POOL_RUN_MAIN);
  Atomics.notify(ctl, CTL_POOL);
  setStatus('Playing', 'The game is running.');
  return game;
}

async function attach(g) {
  const canvas = $('screen');
  const [{ Input }, { Renderer }, { Sound }, { Touch }] = await Promise.all([import('./input.js'), import('./gpu.js'), import('./audio.js'),
    import('./touch.js')]);
  g.registeredKind(HOST_KIND_INPUT).then(b => {
    g.input = new Input(g.memory, b.ptr, canvas);
    if (navigator.maxTouchPoints > 0) g.input.touch = new Touch($('stage'), g.input);      // a touch screen: the touch controls
  });
  g.registeredKind(HOST_KIND_GPU).then(async b => {
    try {
      g.renderer = new Renderer(g.memory, b.ptr, canvas, $('hud'), logLine);
      await g.renderer.init();
      g.renderer.run();
    } catch (err) {
      logLine(`[page] renderer: ${err.stack || err}`, 2);
      count('stop', { s: `picture: ${err.message}` });
      setStatus('Stopped', `The picture could not start: ${err.message}`, true);
    }
  });
  g.registeredKind(HOST_KIND_AUDIO).then(b => { g.sound = new Sound(g.memory, b.ptr, logLine); g.sound.start(); });
  const watch = setInterval(() => { if (Atomics.load(g.ctl, CTL_EXIT)) { clearInterval(watch); } }, 500);
}

// ---- the page ----
let running = false;
const busy = () => running;
const showControls = tabs($('controls'));
if (phone) showControls('touch');
const showAbout = tabs($('about'));
// Saves, Data and Graphics: one panel with tabs. A link to #saves, #data or #graphics opens that tab
const showManage = tabs($('manage'));
{ const named = ['saves', 'data', 'graphics'].find(n => location.hash === `#${n}`); if (named) { showManage(named); $('manage').scrollIntoView({ block: 'start' }); } }
// "Credits below" in the header: the About panel's Credits tab, scrolled to
function showCredits() { showAbout('credits'); $('about').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
$('credits-link').addEventListener('click', e => { e.preventDefault(); showCredits(); });
if (location.hash === '#credits') showCredits();
const saves = new SavesPanel({ busy });
const gameData = new GameDataPanel({ busy, done: () => count('preload') });
const graphics = new GraphicsPanel({ busy });
window.hp2page = { saves, gameData, graphics };       // for tools/cdp.mjs runs

// ---- a newer version on the server (a deploy). The page asks for the server's version every 5 minutes, when it comes back into view,
// and at Play. With nothing to lose on the page, it reloads. At Play, it reloads and the game starts straight away: no game starts on
// an older page than the server's (the parts loaded at Play would be new, the module old). During a game, a note once; the next Play
// takes the new version. Once per version in a tab: a server that kept answering another one would make a loop ----
async function serverVersion(ms = 5000) {
  try {
    const r = await fetch('/version', { cache: 'no-store', signal: AbortSignal.timeout(ms) });
    return r.ok ? (await r.json()).v || null : null;
  } catch { return null; }
}
const ours = serverVersion();                // the version this page is made of, asked as it loads (null: not known, any answer is newer)
let reloadedFor = null, updated = false;
try {
  reloadedFor = sessionStorage.getItem('hp2.reloadedFor');
  updated = sessionStorage.getItem('hp2.updated') === '1';
  sessionStorage.removeItem('hp2.updated');
} catch {}
async function newer(ms) {
  const [mine, now] = await Promise.all([ours, serverVersion(ms)]);
  return { mine, v: now && now !== mine ? now : null };
}
function reloadFor(v, andPlay) {
  if (v === reloadedFor) return false;
  try { sessionStorage.setItem('hp2.reloadedFor', v); sessionStorage.setItem(andPlay ? 'hp2.again' : 'hp2.updated', '1'); } catch { return false; }
  location.reload();
  return true;
}
// nothing to lose: no game on this page, no download of the game data, no saves being restored, no dialog open
const calm = () => !running && !gameData.abort && !saves.restoring && !document.querySelector('dialog[open]');
let noted = false, checked = Date.now();
async function check() {
  checked = Date.now();
  const { mine, v } = await newer();
  if (!v) return;
  if (calm()) reloadFor(v, false);
  else if (mine && !noted && !$('stage').hidden) { noted = true; noteNewer(); }
}
setInterval(check, 5 * 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - checked > 60000) check(); });
// during a game: a note on the picture for a few seconds, once the game is not in a race
function noteNewer() {
  const wait = setInterval(() => {
    if ($('stage').hidden) return clearInterval(wait);
    if (!game?.input || game.input.scene() === 2) return;
    clearInterval(wait);
    $('note').hidden = false;
    setTimeout(() => { $('note').hidden = true; }, 8000);
  }, 1000);
}

// "Play again" reloads the page and the game starts as soon as it can, without a second press (sessionStorage: this tab only)
let again = false;
try { again = sessionStorage.getItem('hp2.again') === '1'; sessionStorage.removeItem('hp2.again'); } catch {}
if (!again && !updated) count('view');      // a reload for Play again or a new version is the same visit
let modulePromise = boot().then(m => {
  playBtn.disabled = false;
  setStatus('Ready', `${updated ? 'Updated to the latest version. ' : ''}Press Play or Enter to start.`);
  if (params.has('autoplay') || again) playBtn.click();
  return m;
}).catch(err => {
  logLine(`[page] ${err.stack || err}`, 2);
  if (!err.shown) count('stop', { s: `loading: ${err.message}` });
  setStatus('Problem', err.shown ? err.message : `The game could not load: ${err.message}`, true);
  return null;
});

async function play() {
  if (playBtn.dataset.again) {
    try { sessionStorage.setItem('hp2.again', '1'); } catch {}
    location.reload();
    return;
  }
  if (playBtn.disabled) return;
  playBtn.disabled = true;
  running = true;
  gameData.stop();                    // what was preloaded is kept; the rest comes on the next Preload
  try {
    const [module, { v }] = await Promise.all([modulePromise, newer(2500)]);
    if (!module) return;
    if (v && reloadFor(v, true)) return;     // a newer version: the page again with it, and the game straight away
    $('start').hidden = true;
    $('stage').hidden = false;
    $('screen').focus();
    if (phone) {
      // a phone or tablet: the game on the whole screen (not on an iPhone, which has no full screen for a page), and the screen kept on.
      // Started by itself ("Play again" after the reload) there was no touch to allow it: the first touch on the game does
      const full = () => $('stage').requestFullscreen?.();
      full()?.catch(() => $('stage').addEventListener('pointerup', () => full()?.catch(() => {}), { once: true }));
      awake();
    }
    const g = await start(module);
    count('play');
    playingFor(true);
    await attach(g);
  } catch (err) {
    count('stop', { s: `starting: ${err.message}` });
    $('start').hidden = false;
    $('stage').hidden = true;
    logLine(`[page] ${err.stack || err}`, 2);
    setStatus('Problem', err.message, true);
    playBtn.disabled = false;
    running = false;
  }
}
playBtn.addEventListener('click', play);
let wake = null;
async function awake() {
  if (wake || !navigator.wakeLock || $('stage').hidden) return;
  try { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } catch {}
}
document.addEventListener('visibilitychange', () => { if (phone && document.visibilityState === 'visible') awake(); });
// Donate in the header: a short dialog with the Ko-fi link, closed as Ko-fi opens in its own tab
$('donate-btn').addEventListener('click', () => $('donate').showModal());
$('donate-go').addEventListener('click', () => $('donate').close());

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || $('start').hidden || e.altKey || e.ctrlKey || e.metaKey) return;
  if (document.querySelector('dialog[open]')) return;
  if (e.target.closest && e.target.closest('button, a, input, select, textarea')) return;
  e.preventDefault();
  play();
});
