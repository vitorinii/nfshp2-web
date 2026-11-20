// The start page's panels: Controls (tabs), Saves (in this browser: profiles, backup, restore) and Game data (the preload).
import { GAME_DIR, PART, gameRoot, lookup, partName, readGameIndex, root, saveRoot, walkFiles, writeFile, writeGameIndex, dirAt } from './store.js';
import { makeZip, readZip } from './zip.js';
import { fetchRange } from './net.js';

const $ = id => document.getElementById(id);
export const gb = n => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

// ---- tabs: a .tabs row of buttons with data-tab, panes with the same data-tab beside it ------------------------------------------
export function tabs(panel) {
  const btns = [...panel.querySelectorAll('.tabs [data-tab]')], panes = [...panel.querySelectorAll('.pane[data-tab]')];
  const show = name => {
    for (const b of btns) { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); }
    for (const p of panes) p.hidden = p.dataset.tab !== name;
  };
  for (const b of btns) b.addEventListener('click', () => show(b.dataset.tab));
  show(btns[0].dataset.tab);
  return show;
}

// ---- Saves -------------------------------------------------------------------------------------------------------------------------
export class SavesPanel {
  constructor({ busy }) {
    this.busy = busy;                          // () => true while the game runs: its files are not touched then
    this.list = $('profiles');
    this.msg = $('saves-msg');
    $('backup').addEventListener('click', () => this.backup().catch(e => this.say(e.message, true)));
    $('restore').addEventListener('click', () => { if (!this.busy()) $('restore-file').click(); });
    $('restore-file').addEventListener('change', e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      this.restoring = true;                   // the saves are replaced: the page does not reload for a new version meanwhile
      this.restore(f).catch(err => this.say(err.message, true)).finally(() => { this.restoring = false; });
    });
    this.refresh().catch(e => this.say(e.message, true));
  }
  say(text, bad = false) { this.msg.textContent = text; this.msg.hidden = !text; this.msg.classList.toggle('bad', bad); }

  async refresh() {
    const saves = await lookup(await saveRoot(), ['saves']);
    const rows = [];
    if (saves && saves.kind === 'dir') {
      for await (const [name, h] of saves.handle.entries()) {
        if (h.kind !== 'directory') continue;
        let when = null;
        for await (const [, f] of h.entries()) if (f.kind === 'file') { const t = (await f.getFile()).lastModified; if (!when || t > when) when = t; }
        rows.push({ name, when });
      }
    }
    rows.sort((a, b) => (b.when || 0) - (a.when || 0));
    this.list.replaceChildren(...rows.map(r => {
      const li = document.createElement('li');
      const n = document.createElement('b'); n.textContent = r.name;
      const t = document.createElement('span'); t.className = 'hint';
      t.textContent = r.when ? `played ${new Date(r.when).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : '';
      li.append(n, t);
      return li;
    }));
    $('profiles-none').hidden = rows.length > 0;
    $('backup').disabled = rows.length === 0;
  }

  async backup() {
    const files = await walkFiles(await saveRoot());
    if (!files.length) return this.say('Nothing to back up yet.');
    const entries = [];
    for (const [name, file] of files) entries.push({ name, data: new Uint8Array(await file.arrayBuffer()), date: new Date(file.lastModified) });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(makeZip(entries));
    a.download = `hot-pursuit-2-saves-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    this.say(`Backup downloaded: ${entries.length} files.`);
  }

  // a backup replaces what this browser has, once it is read whole: hp2.ini and saves/ at its top (or in one folder)
  async restore(file) {
    if (this.busy()) return this.say('Close the game first.', true);
    let entries = (await readZip(await file.arrayBuffer())).filter(e => !/(^|\/)(__MACOSX|\.DS_Store)(\/|$)|(^|\/)\._/.test(e.name));     // the Mac's own extras
    const ours = e => /^saves\//i.test(e.name) || /^hp2\.ini$/i.test(e.name);
    if (!entries.some(ours)) {
      const top = entries.length && entries[0].name.split('/')[0];
      if (top && entries.every(e => e.name.startsWith(top + '/'))) entries = entries.map(e => ({ ...e, name: e.name.slice(top.length + 1) }));
    }
    entries = entries.filter(ours);
    if (!entries.length) throw new Error('This zip has no saves of this game (hp2.ini or a saves folder).');
    await (await root()).removeEntry('save', { recursive: true }).catch(() => {});
    const dir = await saveRoot();
    for (const e of entries) await writeFile(dir, e.name.split('/').filter(Boolean), e.data);
    await this.refresh();
    this.say(`Restored: ${entries.length} files.`);
  }
}

// ---- Game data: the preload --------------------------------------------------------------------------------------------------------
const PIECE = 32 << 20;
const LANES = 4;              // pieces asked for at once (about LANES x 32 MB held in memory)

export class GameDataPanel {
  constructor({ busy, done }) {
    this.busy = busy;
    this.done = done;           // told when a preload has all of the game
    this.btn = $('preload');
    this.remove = $('data-remove');
    this.fill = $('data-fill');
    this.text = $('data-text');
    this.msg = $('data-msg');
    this.abort = null;
    this.btn.addEventListener('click', () => (this.abort ? this.stop() : this.preload().catch(e => this.fail(e))));
    this.remove.addEventListener('click', () => this.clear().catch(e => this.fail(e)));
    if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) $('data-local').hidden = false;
    this.refresh().catch(e => this.fail(e));
  }
  fail(e) {
    this.abort = null;
    this.msg.textContent = e.name === 'QuotaExceededError'
      ? 'This browser ran out of space for the game data. What was saved stays and the game streams the rest from the server; free some disk space and Preload again to finish.'
      : e.message;
    this.msg.hidden = false;
    this.refresh().catch(() => {});
  }

  async list() {
    const r = await fetch('/game.json');
    if (!r.ok) throw new Error(`The server did not give the game's list (HTTP ${r.status}).`);
    return r.json();
  }
  // how much of the game this browser has: [bytes kept, bytes in all]
  async refresh() {
    const [g, index] = await Promise.all([this.list(), readGameIndex()]);
    this.game = g;
    let have = 0;
    for (const f of g.files) if (!f.d) { const k = index.files[f.p]; if (k && k[0] === f.s && k[1] === f.m) have += f.s; }
    this.show(have, g.size);
    return [have, g.size];
  }
  show(have, all) {
    const running = !!this.abort;
    this.fill.style.width = `${all ? (100 * have) / all : 0}%`;
    this.text.textContent = have >= all ? `All of the game is on this device (${gb(all)}).`
      : have ? `${gb(have)} of ${gb(all)} on this device.` : `Not on this device yet: the game streams it from the server as you play.`;
    this.btn.textContent = running ? 'Stop' : have >= all ? 'Preloaded' : have ? `Preload the rest (${gb(all - have)})` : `Preload the game data (${gb(all)})`;
    this.btn.disabled = !running && have >= all;
    this.remove.hidden = running || !have;
  }

  async preload() {
    if (this.busy()) return;
    this.msg.hidden = true;
    const ac = new AbortController();
    this.abort = ac;
    const g = await this.list(), index = await readGameIndex();
    if (index.version !== g.version) index.version = g.version;
    const ok = f => { const k = index.files[f.p]; return k && k[0] === f.s && k[1] === f.m; };
    for (const p of Object.keys(index.files)) if (!g.files.some(f => f.p === p && ok(f))) delete index.files[p];
    const todo = g.files.filter(f => !f.d && !ok(f)).sort((a, b) => a.s - b.s);
    let have = g.size - todo.reduce((n, f) => n + f.s, 0);
    if (navigator.storage.persist) await navigator.storage.persist().catch(() => false);
    const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const need = g.size - have;
    // The estimate is only a hint: Brave and others report a fuzzed or capped quota, so a low number does not stop the
    // preload. A browser that is really full says so while writing (QuotaExceededError, below).
    if (est && est.quota - est.usage < need * 1.02) {
      console.warn(`[preload] the browser reports room for ${gb(Math.max(0, est.quota - est.usage))}, the game needs ${gb(need)}: trying anyway`);
    }
    this.show(have, g.size);
    const dir = await gameRoot();
    const t0 = performance.now(), start = have;
    let shown = 0;
    try {
      for (const f of todo) {
        const parts = f.p.split('/');
        const d = await dirAt(dir, parts.slice(0, -1), true);
        let got = 0;
        const onBytes = n => {
          got += n;
          const now = performance.now();
          if (now - shown < 250) return;
          shown = now;
          const speed = (have + got - start) / ((now - t0) / 1000);
          this.show(have + got, g.size);
          const left = speed > 0 ? (g.size - have - got) / speed : 0;
          this.text.textContent = `${gb(have + got)} of ${gb(g.size)}, ${gb(speed)}/s` + (left > 5 ? `, about ${left > 90 ? `${Math.ceil(left / 60)} minutes` : `${Math.ceil(left)} seconds`} left` : '');
        };
        // a file over PART is kept in pieces of PART bytes: one file that big does not fit in the browser's storage (store.js)
        const pieces = f.s > PART ? Math.ceil(f.s / PART) : 1;
        for (let k = 0; k < pieces; k++) {
          const lo = k * PART, hi = Math.min(lo + PART, f.s);
          const name = parts[parts.length - 1];
          const fh = await d.getFileHandle(pieces > 1 ? partName(name, k) : name, { create: true });
          // in 32 MB pieces, each asked for again on its own if the connection drops (net.js). LANES at a time: one request
          // alone does not fill the connection (14-18 MB/s measured against 60 MB/s free), and the pieces may arrive in any
          // order since each is written at its own position.
          const w = await fh.createWritable();
          const stop = new AbortController();
          const onAbort = () => stop.abort();
          ac.signal.addEventListener('abort', onAbort);
          let cursor = lo;
          const lane = async () => {
            while (!stop.signal.aborted && cursor < hi) {
              const at = cursor;
              cursor += PIECE;
              const data = await fetchRange(f.p, at, Math.min(at + PIECE, hi) - 1, { signal: stop.signal, onBytes, log: s => console.warn(`[preload] ${s}`) });
              await w.write({ type: 'write', position: at - lo, data });
            }
          };
          // a lane that fails stops the others; every lane has ended before the file is closed or dropped
          const done = await Promise.allSettled(Array.from({ length: Math.min(LANES, Math.ceil((hi - lo) / PIECE)) }, () => lane().catch(e => { stop.abort(); throw e; })));
          ac.signal.removeEventListener('abort', onAbort);
          const failed = done.filter(r => r.status === 'rejected').map(r => r.reason);
          if (failed.length || stop.signal.aborted) {
            await w.abort().catch(() => {});
            // the lane that broke, not the ones it stopped
            throw failed.find(e => e.name !== 'AbortError') || failed[0] || new DOMException('stopped', 'AbortError');
          }
          await w.close().catch(async e => { await w.abort().catch(() => {}); throw e; });
        }
        have += f.s;
        index.files[f.p] = [f.s, f.m];
        await writeGameIndex(index);
      }
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    } finally {
      this.abort = null;
    }
    if (todo.length && !ac.signal.aborted) this.done?.();
    await this.refresh();
  }
  stop() { if (this.abort) this.abort.abort(); }

  async clear() {
    if (this.busy() || this.abort) return;
    await (await root()).removeEntry(GAME_DIR, { recursive: true }).catch(() => {});
    this.msg.hidden = true;
    await this.refresh();
  }
}
