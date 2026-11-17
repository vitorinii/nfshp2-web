// The AudioWorklet: plays the runtime's ring (runtime/audio_web.cpp) from the shared memory. 48 kHz stereo s16 frames; the context
// runs at 48 kHz too, so a frame in is a frame out.
class Hp2Sound extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = null;
    this.port.onmessage = e => {
      const { buffer, ptr } = e.data;
      const u32 = new Uint32Array(buffer, ptr, 8);
      this.hdr = u32;
      this.cap = u32[2];
      this.data = new Int16Array(buffer, u32[3], this.cap * 2);
      Atomics.store(u32, 7, 1);       // running
    };
  }
  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    if (!this.hdr) return true;
    const h = this.hdr, n = L.length;
    const written = Atomics.load(h, 4), read = Atomics.load(h, 5);
    const have = (written - read) >>> 0;
    const take = Math.min(have, n);
    for (let i = 0; i < take; i++) {
      const at = ((read + i) % this.cap) * 2;
      L[i] = this.data[at] / 32768;
      R[i] = this.data[at + 1] / 32768;
    }
    for (let i = take; i < n; i++) L[i] = R[i] = 0;
    if (take < n) Atomics.add(h, 6, n - take);
    Atomics.store(h, 5, (read + take) >>> 0);
    return true;
  }
}
registerProcessor('hp2-sound', Hp2Sound);
