// Touch controls for phones and tablets: buttons over the game that work as a controller (input.js puts them into the first pad), and a
// tap on the picture as a click of the menus' pointer. Which buttons show follows the game (runtime/host_input.h's scene): driving, or
// a screen with menus. They show on a touch screen, go when a key or a controller's button is pressed, and come back at the next touch.
//
// Each finger holds the button under it, and moves to the one it slides onto: from Gas to Brake, or from one steering arrow to the other.
// A button is held at least 120 ms, however short the tap: the page and the game each look at it once a frame.
// While the game waits for a typed name, the phone's own keyboard types it (a text box out of sight; the Keyboard button brings it up).

// a button's controller part, as the game's default layout (Options, Controls) takes it: pad.cpp's bits, or the left stick, or a trigger
const PART = {
  gas: { bit: 0x1000 }, brake: { bit: 0x4000 }, hand: { bit: 0x200 }, horn: { bit: 0x2000 }, view: { bit: 0x8000 }, look: { bit: 0x100 },
  reset: { bit: 0x20 }, start: { bit: 0x10 }, left: { steer: -1 }, right: { steer: 1 }, gearDown: { lt: 1 }, gearUp: { rt: 1 },
  up: { bit: 0x1 }, down: { bit: 0x2 }, mleft: { bit: 0x4 }, mright: { bit: 0x8 }, ok: { bit: 0x1000 }, cancel: { bit: 0x2000 },
};

export class Touch {
  constructor(stage, input) {
    this.stage = stage;
    this.input = input;
    this.el = stage.querySelector('#touch');
    this.fingers = new Map();            // pointer id -> the button it holds (an element with data-b), or 'tap' for the picture
    this.since = new Map();              // pointer id -> when it took that button (performance.now())
    this.latched = new Map();            // button let go too soon -> until when it stays held
    this.scene = -1;
    this.typing = 0;
    this.on = matchMedia('(pointer: coarse)').matches;
    this.box = stage.querySelector('#type-box');
    this.kbd = this.el.querySelector('[data-b="ui-kbd"]');
    this.show();

    // the text box: what changes in it goes to the game as key presses; Enter ends the name
    let was = '';
    this.box.addEventListener('input', () => {
      const now = this.box.value;
      let same = 0;
      while (same < was.length && same < now.length && was[same] === now[same]) same++;
      input.typeText('\b'.repeat(was.length - same) + now.slice(same));
      was = now;
    });
    const stopKey = e => {
      e.stopPropagation();
      if (e.type !== 'keydown') return;
      if (e.key === 'Enter') { e.preventDefault(); input.typeText('\r'); }
      else if (e.key === 'Backspace' && !this.box.value) input.typeText('\b');     // nothing left in the box: the game's name still is
    };
    this.box.addEventListener('keydown', stopKey);
    this.box.addEventListener('keyup', stopKey);
    this.box.addEventListener('focus', () => { was = this.box.value = ''; });

    const at = e => {
      const b = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-b]');
      return b && this.el.contains(b) && b.offsetParent ? b : null;
    };
    stage.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      if (!this.on) { this.on = true; this.show(); }
      const b = at(e);
      if (b) this.hold(e.pointerId, b);
      else if (this.scene !== 2) { this.fingers.set(e.pointerId, 'tap'); input.tap(e.clientX, e.clientY, true); }
    });
    stage.addEventListener('pointermove', e => {
      const was = this.fingers.get(e.pointerId);
      if (was === undefined) return;
      if (was === 'tap') { input.tap(e.clientX, e.clientY, true); return; }
      const b = at(e);
      if (b !== was && b && !b.dataset.b.startsWith('ui-')) this.hold(e.pointerId, b);
    });
    const up = e => {
      const was = this.fingers.get(e.pointerId);
      if (was === undefined) return;
      this.fingers.delete(e.pointerId);
      if (was === 'tap') input.tap(e.clientX, e.clientY, false);
      else {
        this.letGo(e.pointerId, was);
        if (e.type === 'pointerup' && was.dataset.b === 'ui-full') this.fullscreen();
        if (e.type === 'pointerup' && was.dataset.b === 'ui-kbd') this.box.focus();
        this.lit();
      }
    };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    // no mouse events made up from touches (the taps are the pointer's own), no scrolling, no zoom, no long-press menu
    stage.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
    stage.addEventListener('contextmenu', e => e.preventDefault());
    // a key sends them away (a controller's button too: input.js calls away())
    window.addEventListener('keydown', e => { if (!e.repeat && !['Alt', 'Meta', 'Control', 'Shift'].includes(e.key)) this.away(); });
  }

  hold(id, b) {
    const was = this.fingers.get(id);
    if (was && was !== 'tap') this.letGo(id, was);
    this.fingers.set(id, b);
    this.since.set(id, performance.now());
    this.lit();
  }
  // a finger leaves a button: held on for what is left of the 120 ms
  letGo(id, b) {
    const left = 120 - (performance.now() - (this.since.get(id) || 0));
    this.since.delete(id);
    if (left > 0) {
      this.latched.set(b, performance.now() + left);
      setTimeout(() => this.lit(), left + 5);
    }
  }
  // the held buttons lit
  held() {
    const now = performance.now();
    for (const [b, until] of this.latched) if (until <= now) this.latched.delete(b);
    return new Set([...this.fingers.values(), ...this.latched.keys()].filter(b => b !== 'tap'));
  }
  lit() {
    const held = this.held();
    for (const b of this.el.querySelectorAll('[data-b]')) b.classList.toggle('held', held.has(b));
  }
  away() {
    if (!this.on) return;
    this.on = false;
    this.release();
    this.show();
  }
  release() {
    for (const [id, b] of this.fingers) if (b === 'tap') this.input.tap(-1, -1, false);
    this.fingers.clear();
    this.latched.clear();
    this.lit();
  }
  show() {
    this.el.hidden = !this.on;
    this.stage.classList.toggle('touching', this.on);
  }
  fullscreen() {
    if (!document.fullscreenElement) this.stage.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen();
  }

  // once a frame, from input.js: the game's scene in, the pad's state out (null while the controls are away)
  frame(scene, typing) {
    if (typing !== this.typing) {
      this.typing = typing;
      // a name to type: the phone's keyboard (the box takes the focus; where a phone does not bring the keyboard up for that, the
      // Keyboard button does); the name done: away with it
      if (typing && this.on) this.box.focus();
      else if (!typing && document.activeElement === this.box) this.box.blur();
    }
    this.kbd.hidden = !(typing && this.on);
    if (scene !== this.scene) {
      const was = this.scene;
      this.scene = scene;
      this.el.dataset.scene = scene === 2 ? 'drive' : 'menu';
      // what the fingers held in one set of buttons is let go when the other comes (not a tap on the picture)
      if (was !== -1) for (const [id, b] of this.fingers) if (b !== 'tap') this.fingers.delete(id);
      if (was !== -1) this.latched.clear();
      this.lit();
    }
    if (!this.on) return null;
    const pad = { mask: 0, lx: 0, lt: 0, rt: 0 };
    for (const b of this.held()) {
      const p = PART[b.dataset.b];
      if (!p) continue;
      if (p.bit) pad.mask |= p.bit;
      if (p.steer) pad.lx += p.steer;
      if (p.lt) pad.lt = 1;
      if (p.rt) pad.rt = 1;
    }
    pad.lx = Math.max(-1, Math.min(1, pad.lx));
    return pad;
  }
}
