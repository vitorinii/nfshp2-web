// The keyboard, the mouse and the gamepads into the runtime's HostInput block (runtime/host_input.h): keys by Windows virtual-key
// code (the port's bindings and hp2.ini keep those), gamepads as SDL would give them, the canvas's size and focus.

// HostInput's layout (wasm32); the block's own size word must agree
const OFF = { magic: 0, version: 4, size: 8, focused: 12, keys: 16, caps: 272, mx: 276, my: 280, buttons: 284, moves: 288, wheel: 292,
  vw: 296, vh: 300, pads: 304, padSize: 44, evHead: 392, evTail: 396, ev: 400, evSize: 12, quit: 1168, cursor: 1172, total: 1176 };
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
    const key = (e, down) => {
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
  toggleFullscreen() {
    const stage = this.canvas.parentElement;
    if (!document.fullscreenElement) stage.requestFullscreen().catch(() => {});
    else document.exitFullscreen();
  }
  frame() {
    const wantCursor = this.i32a()[(this.ptr + OFF.cursor) >> 2] !== 0;
    if (wantCursor !== this.cursorShown) { this.cursorShown = wantCursor; this.canvas.classList.toggle('nocursor', !wantCursor); }
    this.i32(OFF.focused, document.hasFocus() && document.visibilityState === 'visible' ? 1 : 0);
    const dpr = window.devicePixelRatio || 1;
    this.i32(OFF.vw, Math.round(this.canvas.clientWidth * dpr));
    this.i32(OFF.vh, Math.round(this.canvas.clientHeight * dpr));
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(p => p && p.connected) : [];
    for (let slot = 0; slot < 2; slot++) {
      const base = OFF.pads + slot * OFF.padSize, p = pads[slot];
      if (!p) { this.i32(base, 0); continue; }
      let mask = 0;
      for (const [i, bit] of PAD_BITS) if (p.buttons[i] && p.buttons[i].pressed) mask |= bit;
      const axis = i => Math.max(-32768, Math.min(32767, Math.round((p.axes[i] || 0) * 32767)));
      const trig = i => Math.round(Math.min(1, Math.max(0, p.buttons[i] ? p.buttons[i].value : 0)) * 32767);
      this.i32(base + 4, mask);
      this.i32(base + 8, trig(6));
      this.i32(base + 12, trig(7));
      this.i32(base + 16, axis(2)), this.i32(base + 20, axis(3)), this.i32(base + 24, axis(0)), this.i32(base + 28, axis(1));
      this.i32(base + 32, /054c|dualsense|dualshock|wireless controller/i.test(p.id) ? 1 : 0);
      this.i32(base, 1);
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
}
