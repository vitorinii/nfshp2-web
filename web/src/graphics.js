// The start page's Graphics panel: the game's own Options > Graphics (upstream recomp/runtime/pcsettings.cpp), set here before Play. It reads
// and writes the same hp2.ini the game does (ini.js merges into it, so nothing else in the file changes); the game reads it when it starts,
// so a change applies at the next Play, and the game's own menus go on writing the same file: the two stay in step.
//
// Only what the browser build acts on is here. Left out, on purpose: VSync (a browser always waits for the screen), Window and Resolution (the
// canvas is the window; Alt+Enter is fullscreen), Antialiasing and Anisotropic Filtering (the game's menu has them, the web renderer does not
// draw either yet).
import { saveRoot, lookup, writeFile } from './store.js';
import { parseIni, mergeIni } from './ini.js';

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const range = (lo, hi, step) => Array.from({ length: (hi - lo) / step + 1 }, (_, i) => lo + i * step);

// key: the hp2.ini key; def: what the game starts with, except aspect (a new browser starts at 16:9: store.js seedSettings); opts: [value, label]
// for a list, or lo/hi/step/fmt for a slider; help: the game's own line under it, a little plainer
export const GROUPS = [
  { title: 'Picture', rows: [
    { key: 'aspect', label: 'Aspect ratio', def: 2, opts: [[0, '4:3'], [1, '16:10'], [2, '16:9']],
      help: 'The shape of the race picture, never wider than the window. The menus stay 4:3.' },
    { key: 'scale', label: 'Render scale', def: 2, opts: range(1, 8, 1).map(n => [n, `${n}x`]),
      help: 'The picture\'s detail, times the PS2\'s 512 × 448. 4x and more need a strong graphics card.' },
    { key: 'smooth', label: 'Scaling', def: 1, opts: [[1, 'Smooth'], [0, 'Sharp']],
      help: 'How the picture is scaled to the window.' },
  ] },
  { title: 'Quality', rows: [
    { key: 'frame_rate', label: 'Frame rate', def: 30, opts: [[30, '30 FPS'], [60, '60 FPS']],
      help: 'The race\'s frame rate. The PS2\'s was 30. The menus always run at 60.' },
    { key: 'draw_distance', label: 'Draw distance', def: 200, opts: [100, 150, 200, 300, 400].map(n => [n, `${n}%`]),
      help: 'How far away scenery still shows. 100% is the PS2\'s.' },
    { key: 'max_detail', label: 'Level of detail', def: 1, opts: [[1, 'Maximum'], [0, 'Original']],
      help: 'Maximum: scenery and cars always at their most detailed models. Original: as on the PS2.' },
    { key: 'reflections', label: 'Reflections', def: 0, opts: [[0, 'PS2'], [1, 'Advanced'], [2, 'High']],
      help: 'The reflections on the cars. Advanced: new every frame. High: new every frame, at twice the resolution.' },
  ] },
  { title: 'Image', reset: true, rows: [
    { key: 'brightness', label: 'Brightness', def: 0, lo: -50, hi: 50, step: 5, fmt: v => (v > 0 ? '+' : '') + v,
      help: 'Lighter or darker, all over.' },
    { key: 'contrast', label: 'Contrast', def: 100, lo: 50, hi: 150, step: 5, fmt: v => `${v}%`,
      help: 'The difference between light and dark.' },
    { key: 'gamma', label: 'Gamma', def: 100, lo: 50, hi: 200, step: 5, fmt: v => (v / 100).toFixed(2),
      help: 'Above 1.00 the dark parts get lighter.' },
  ] },
  { title: 'Extras', rows: [
    { key: 'show_fps', label: 'Show FPS', def: 0, opts: [[0, 'Off'], [1, 'On']],
      help: 'Frames per second in the corner of the picture.' },
  ] },
];
const ROWS = GROUPS.flatMap(g => g.rows);
const DEFAULTS = Object.fromEntries(ROWS.map(r => [r.key, r.def]));

export class GraphicsPanel {
  constructor({ busy }) {
    this.busy = busy;
    this.controls = new Map();            // key -> { row, input, out }
    this.values = { ...DEFAULTS };
    this.queue = Promise.resolve();       // writes one after another: each reads the file the last one left
    this.msg = $('graphics-msg');
    this.build();
    $('graphics-reset').addEventListener('click', () => this.set(DEFAULTS));
    this.refresh().catch(e => this.fail(e));
  }

  build() {
    const host = $('graphics-groups');
    for (const g of GROUPS) {
      const body = el('div', { className: 'gfx-body' });
      const head = el('div', { className: 'gfx-head' }, el('h3', { textContent: g.title }));
      if (g.reset) {
        const btn = el('button', { type: 'button', className: 'text-btn', textContent: 'Reset' });
        btn.addEventListener('click', () => this.set(Object.fromEntries(g.rows.map(r => [r.key, r.def]))));
        head.append(btn);
      }
      for (const r of g.rows) body.append(this.row(r));
      if (g.title === 'Picture') body.append($('blur-wrap'));        // the page's own option, next to the game's
      const group = el('section', { className: 'gfx-group' }, head, body);
      group.setAttribute('aria-label', g.title);
      host.append(group);
    }
  }

  row(r) {
    const id = `gfx-${r.key}`;
    let input, out = null;
    if (r.opts) {
      input = el('select', { id });
      for (const [v, text] of r.opts) input.append(el('option', { value: v, textContent: text }));
      input.addEventListener('change', () => this.set({ [r.key]: Number(input.value) }));
    } else {
      input = el('input', { id, type: 'range', min: r.lo, max: r.hi, step: r.step });
      out = el('output', { htmlFor: id });
      input.addEventListener('input', () => { out.textContent = r.fmt(Number(input.value)); });
      input.addEventListener('change', () => this.set({ [r.key]: Number(input.value) }));
    }
    const label = el('label', { htmlFor: id, className: 'gfx-label', textContent: r.label });
    const help = el('p', { className: 'hint gfx-help', textContent: r.help });
    const control = el('div', { className: 'gfx-control' }, input, ...(out ? [out] : []));
    const row = el('div', { className: 'gfx-row' }, el('div', { className: 'gfx-text' }, label, help), control);
    this.controls.set(r.key, { r, input, out });
    return row;
  }

  // the controls show `values`; a value the list does not have (an edited hp2.ini) is shown, not changed
  show() {
    for (const { r, input, out } of this.controls.values()) {
      const v = this.values[r.key];
      if (r.opts && ![...input.options].some(o => Number(o.value) === v)) input.append(el('option', { value: v, textContent: String(v) }));
      input.value = String(v);
      if (out) out.textContent = r.fmt(v);
    }
    const locked = !!this.busy();
    for (const { input } of this.controls.values()) input.disabled = locked;
    $('graphics-reset').disabled = locked;
    for (const b of document.querySelectorAll('#graphics .gfx-head .text-btn')) b.disabled = locked;
    if (locked) this.note('The game is running: its settings change in the game (Options, Graphics) or here once it ends.');
  }

  note(text, bad = false) {
    this.msg.textContent = text;
    this.msg.classList.toggle('bad', bad);
    this.msg.hidden = !text;
  }
  fail(e) {
    this.note(e && e.name === 'NoModificationAllowedError'
      ? 'The game is open in another tab or window: close it, then change the settings.' : `The settings could not be saved: ${e && e.message || e}`, true);
    return this.refresh().catch(() => {});
  }

  // what hp2.ini says now, over the defaults
  async read() {
    const found = await lookup(await saveRoot(), ['hp2.ini']);
    if (!found) return { exists: false, values: { ...DEFAULTS } };
    const ini = parseIni(await (await found.handle.getFile()).text());
    const values = { ...DEFAULTS };
    for (const r of ROWS) if (ini[r.key] !== undefined && Number.isFinite(Number(ini[r.key]))) values[r.key] = Number(ini[r.key]);
    return { exists: true, values };
  }

  async refresh() {
    const { values } = await this.read();
    this.values = values;
    if (!this.busy()) this.note('');
    this.show();
  }

  // save `changes`: merged into the file as it is now. A browser with no hp2.ini yet also gets the 16:9 aspect the page starts it with (else the
  // file this makes would keep the Play-time seed from running, and the game would start at 4:3)
  set(changes) {
    Object.assign(this.values, changes);
    this.show();
    this.queue = this.queue.then(async () => {
      const dir = await saveRoot();
      const found = await lookup(dir, ['hp2.ini']);
      const text = found ? await (await found.handle.getFile()).text() : '';
      await writeFile(dir, ['hp2.ini'], mergeIni(text, found ? changes : { aspect: DEFAULTS.aspect, ...changes }));
      this.note('Saved. It applies at the next Play.');
    }).catch(e => this.fail(e));
    return this.queue;
  }
}
