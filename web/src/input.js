// The keyboard, the mouse and the gamepads into the runtime's HostInput block (runtime/host_input.h): keys by Windows virtual-key
// code (the port's bindings and hp2.ini keep those), gamepads as SDL would give them, the canvas's size and focus. The touch controls
// (touch.js) come in as the first gamepad, and a tap on the picture as the mouse.

// HostInput's layout (wasm32); the block's own size word must agree
const OFF = { magic: 0, version: 4, size: 8, focused: 12, keys: 16, caps: 272, mx: 276, my: 280, buttons: 284, moves: 288, wheel: 292,
  vw: 296, vh: 300, pads: 304, padSize: 44, evHead: 392, evTail: 396, ev: 400, evSize: 12, quit: 1168, cursor: 1172, scene: 1176, typing: 1180, total: 1184 };
const MAGIC = 0x49505548;

const VK = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0D, NumpadEnter: 0x0D, ShiftLeft: 0xA0, ShiftRight: 0xA1, ControlLeft: 0xA2, ControlRight: 0xA3,
  AltLeft: 0xA4, AltRight: 0xA5, Pause: 0x13, CapsLock: 0x14, Escape: 0x1B, Space: 0x20, PageUp: 0x21, PageDown: 0x22, End: 0x23,
  Home: 0x24, ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28, Insert: 0x2D, Delete: 0x2E, MetaLeft: 0x5B,
  MetaRight: 0x5C, NumpadMultiply: 0x6A, NumpadAdd: 0x6B, NumpadSubtract: 0x6D, NumpadDecimal: 0x6E, NumpadDivide: 0x6F,
  Semicolon: 0xBA, Equal: 0xBB, Comma: 0xBC, Minus: 0xBD, Period: 0xBE, Slash: 0xBF, Backquote: 0xC0, BracketLeft: 0xDB,
  Backslash: 0xDC, BracketRight: 0xDD, Quote: 0xDE,
};
function vkOf(code) {
  if (VK[code] !== undefined) return VK[code];
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1].charCodeAt(0);
  if ((m = /^Digit([0-9])$/.exec(code))) return 0x30 + +m[1];
  if ((m = /^Numpad([0-9])$/.exec(code))) return 0x60 + +m[1];
  if ((m = /^F([0-9]{1,2})$/.exec(code))) return 0x6F + +m[1];
  return 0;
}

// standard gamepad buttons to pad.cpp's bits
const PAD_BITS = [[0, 0x1000], [1, 0x2000], [2, 0x4000], [3, 0x8000], [4, 0x100], [5, 0x200], [8, 0x20], [9, 0x10], [10, 0x40], [11, 0x80],
  [12, 0x1], [13, 0x2], [14, 0x4], [15, 0x8]];

export class Input {
  constructor(memory, ptr, canvas) {
    this.memory = memory;
    this.ptr = ptr;
    this.canvas = canvas;
    const dv = this.dv();
    if (dv.getUint32(ptr + OFF.magic, true) !== MAGIC || dv.getUint32(ptr + OFF.size, true) !== OFF.total)
      throw new Error(`input block: size ${dv.getUint32(ptr + OFF.size, true)}, expected ${OFF.total}`);
    this.moves = 0;
    this.wheel = 0;
    this.rumbleSent = [-1, -1];
    this.touch = null;                  // touch.js, once the page has made it
    this.padHeld = 0;
    this.tapUp = 0;
    const key = (e, down) => {
      if (e.target && e.target.id === 'type-box') return;          // the phone's keyboard: typeText() has it
      if (e.altKey && e.code === 'Enter') {
        if (down && !e.repeat) this.toggleFullscreen();
        e.preventDefault();
        return;
      }
      const vk = vkOf(e.code);
      if (!vk) return;
      if (!(e.metaKey || (e.ctrlKey && /^Key[RLTW]$/.test(e.code)))) e.preventDefault();
      this.setKey(vk, down);
      this.event(vk, down, e.repeat);
      this.i32(OFF.caps, e.getModifierState && e.getModifierState('CapsLock') ? 1 : 0);
    };
    window.addEventListener('keydown', e => key(e, true));
    window.addEventListener('keyup', e => key(e, false));
    window.addEventListener('blur', () => this.releaseAll());
    canvas.addEventListener('mousemove', e => this.mouse(e));
    canvas.addEventListener('mousedown', e => { this.mouse(e); this.buttons(e.buttons); canvas.focus(); });
    window.addEventListener('mouseup', e => this.buttons(e.buttons));
    canvas.addEventListener('mouseleave', () => { this.f32(OFF.mx, -1); this.f32(OFF.my, -1); });
    canvas.addEventListener('wheel', e => { e.preventDefault(); this.wheel += e.deltaY < 0 ? 1 : -1; this.i32(OFF.wheel, this.wheel); }, { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    const tick = () => { this.frame(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  dv() { if (!this._dv || this._dv.buffer !== this.memory.buffer) this._dv = new DataView(this.memory.buffer); return this._dv; }
  i32a() { if (!this._i32 || this._i32.buffer !== this.memory.buffer) this._i32 = new Int32Array(this.memory.buffer); return this._i32; }
  i32(off, v) { Atomics.store(this.i32a(), (this.ptr + off) >> 2, v | 0); }
  f32(off, v) { this.dv().setFloat32(this.ptr + off, v, true); }
  setKey(vk, down) { new Uint8Array(this.memory.buffer)[this.ptr + OFF.keys + vk] = down ? 1 : 0; }
  releaseAll() { new Uint8Array(this.memory.buffer).fill(0, this.ptr + OFF.keys, this.ptr + OFF.keys + 256); }
  event(vk, down, repeat) {
    const a = this.i32a(), headIdx = (this.ptr + OFF.evHead) >> 2;
    const head = Atomics.load(a, headIdx) >>> 0;
    const e = (this.ptr + OFF.ev + (head % 64) * OFF.evSize) >> 2;
    a[e] = vk, a[e + 1] = down ? 1 : 0, a[e + 2] = repeat ? 1 : 0;
    Atomics.store(a, headIdx, (head + 1) | 0);
  }
  mouse(e) {
    const r = this.canvas.getBoundingClientRect();
    this.f32(OFF.mx, (e.clientX - r.left) / r.width);
    this.f32(OFF.my, (e.clientY - r.top) / r.height);
    this.i32(OFF.moves, ++this.moves);
  }
  buttons(b) { this.i32(OFF.buttons, (b & 1) | (b & 2 ? 2 : 0) | (b & 4 ? 4 : 0)); }
  // typed text (a phone's keyboard, touch.js) as key presses, one at a time: a capital with Shift held (the game reads it as it takes
  // the press), '\b' Backspace, '\r' Enter. Only what a name can have: letters, digits, space, ! . #
  typeText(text) {
    for (const ch of text) {
      let vk = 0, shift = false;
      if (/[a-z]/.test(ch)) vk = ch.toUpperCase().charCodeAt(0);
      else if (/[A-Z]/.test(ch)) vk = ch.charCodeAt(0), shift = true;
      else if (/[0-9]/.test(ch)) vk = ch.charCodeAt(0);
      else if (ch === ' ') vk = 0x20;
      else if (ch === '!') vk = 0x31, shift = true;
      else if (ch === '#') vk = 0x33, shift = true;
      else if (ch === '.') vk = 0xBE;
      else if (ch === '\b') vk = 0x08;
      else if (ch === '\r') vk = 0x0D;
      if (vk) (this.typing ||= []).push({ vk, shift });
    }
    if (!this.typingBusy) this.typeNext();
  }
  typeNext() {
    const k = this.typing && this.typing.shift();
    this.typingBusy = !!k;
    if (!k) return;
    if (k.shift) this.setKey(0xA0, true);
    this.setKey(k.vk, true);
    this.event(k.vk, true, false);
    setTimeout(() => {
      this.setKey(k.vk, false);
      this.event(k.vk, false, false);
      if (k.shift) this.setKey(0xA0, false);
      setTimeout(() => this.typeNext(), 30);
    }, 50);
  }
  // a finger on the picture as the mouse's left button (x < 0: let go wherever it is). The game reads the button now and then, so a
  // tap holds it at least 100 ms
  tap(x, y, down) {
    if (x >= 0) this.mouse({ clientX: x, clientY: y });
    clearTimeout(this.tapUp);
    if (down) { this.tapAt = performance.now(); this.buttons(1); }
    else this.tapUp = setTimeout(() => this.buttons(0), Math.max(0, 100 - (performance.now() - (this.tapAt || 0))));
  }
  toggleFullscreen() {
    const stage = this.canvas.parentElement;
    if (!document.fullscreenElement) stage.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
  }
  // what the game shows (host_input.h): 0 logos, films, loading; 1 menus; 2 driving
  scene() { return this.i32a()[(this.ptr + OFF.scene) >> 2]; }
  frame() {
    const wantCursor = this.i32a()[(this.ptr + OFF.cursor) >> 2] !== 0;
    if (wantCursor !== this.cursorShown) { this.cursorShown = wantCursor; this.canvas.classList.toggle('nocursor', !wantCursor); }
    this.i32(OFF.focused, document.hasFocus() && document.visibilityState === 'visible' ? 1 : 0);
    const dpr = window.devicePixelRatio || 1;
    this.i32(OFF.vw, Math.round(this.canvas.clientWidth * dpr));
    this.i32(OFF.vh, Math.round(this.canvas.clientHeight * dpr));
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(p => p && p.connected) : [];
    // the touch controls: what the game shows, in; the buttons held, out. A controller's button pressed sends them away
    const a32 = this.i32a();
    const touch = this.touch ? this.touch.frame(a32[(this.ptr + OFF.scene) >> 2], a32[(this.ptr + OFF.typing) >> 2]) : null;
    if (touch) this.touchUsed = true;
    let held = 0;
    for (const p of pads) for (const [i, bit] of PAD_BITS) if (p.buttons[i] && p.buttons[i].pressed) held |= bit;
    if (held & ~this.padHeld && this.touch) this.touch.away();
    this.padHeld = held;
    for (let slot = 0; slot < 2; slot++) {
      const base = OFF.pads + slot * OFF.padSize, p = pads[slot];
      // the first slot: the controller and the touch controls together; once touched, a pad stays there (a pad that came and went
      // would be a controller pulled out)
      const t = slot === 0 && this.touchUsed ? (touch || { mask: 0, lx: 0, lt: 0, rt: 0 }) : null;
      if (!p && !t) { this.i32(base, 0); continue; }
      let mask = 0;
      if (p) for (const [i, bit] of PAD_BITS) if (p.buttons[i] && p.buttons[i].pressed) mask |= bit;
      const axis = i => (p ? Math.max(-32768, Math.min(32767, Math.round((p.axes[i] || 0) * 32767))) : 0);
      const trig = i => (p ? Math.round(Math.min(1, Math.max(0, p.buttons[i] ? p.buttons[i].value : 0)) * 32767) : 0);
      const lx = t && t.lx ? t.lx * 32767 : axis(0);
      this.i32(base + 4, mask | (t ? t.mask : 0));
      this.i32(base + 8, t && t.lt ? 32767 : trig(6));
      this.i32(base + 12, t && t.rt ? 32767 : trig(7));
      this.i32(base + 16, axis(2)), this.i32(base + 20, axis(3)), this.i32(base + 24, lx), this.i32(base + 28, axis(1));
      this.i32(base + 32, p && /054c|dualsense|dualshock|wireless controller/i.test(p.id) ? 1 : 0);
      this.i32(base, 1);
      if (!p) { this.buzz(base); continue; }
      // the motors: the game's wish, told again while it lasts
      const a = this.i32a(), small = a[(this.ptr + base + 36) >> 2], large = a[(this.ptr + base + 40) >> 2];
      const want = small << 8 | large, now = performance.now();
      if (p.vibrationActuator && (want !== this.rumbleSent[slot] || (want && now - (this.rumbleAt || 0) > 900))) {
        this.rumbleSent[slot] = want;
        this.rumbleAt = now;
        p.vibrationActuator.playEffect('dual-rumble', { duration: want ? 1000 : 0, strongMagnitude: large / 255, weakMagnitude: small ? 1 : 0 }).catch(() => {});
      }
    }
  }
  // the touch controls' pad: a strong rumble (a crash) as a short buzz of the phone, where it has one (Android)
  buzz(base) {
    const large = this.i32a()[(this.ptr + base + 40) >> 2];
    const now = performance.now();
    if (large >= 128 && !(this.buzzing > 0) && now - (this.buzzAt || 0) > 500 && navigator.vibrate) {
      this.buzzAt = now;
      try { navigator.vibrate(Math.min(250, 40 + large)); } catch {}
    }
    this.buzzing = large >= 128 ? 1 : 0;
  }
}
