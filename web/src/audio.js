// The sound: an AudioContext at 48 kHz with the worklet that plays the runtime's ring. Browsers start a context only after the player has
// done something on the page: the Play button is that, and any key or click resumes one that was suspended.
export class Sound {
  constructor(memory, ptr, log) {
    this.memory = memory;
    this.ptr = ptr;
    this.log = log;
  }
  async start() {
    try {
      this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      await this.ctx.audioWorklet.addModule('audio-worklet.js');
      this.node = new AudioWorkletNode(this.ctx, 'hp2-sound', { numberOfInputs: 0, outputChannelCount: [2] });
      this.node.connect(this.ctx.destination);
      this.node.port.postMessage({ buffer: this.memory.buffer, ptr: this.ptr });
      const resume = () => { if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); };
      for (const ev of ['keydown', 'mousedown', 'pointerdown', 'touchstart']) window.addEventListener(ev, resume, { capture: true });
      resume();
      this.log(`[sound] ${this.ctx.sampleRate} Hz, ${this.ctx.state}`);
      setInterval(() => {
        const u32 = new Uint32Array(this.memory.buffer, this.ptr, 8);
        if (u32[6] > (this.lastUnder || 0) + 48000) { this.log(`[sound] ${u32[6]} frames made up so far (the ring ran dry)`); this.lastUnder = u32[6]; }
      }, 10000);
    } catch (e) {
      this.log(`[sound] could not start: ${e.message}`, 2);
    }
  }
}
