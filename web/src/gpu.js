// The renderer, the page's side: the frames native_web.cpp lays out in the shared memory (runtime/native_web.h), drawn with WebGPU
// as native_vk.cpp drew them with Vulkan:
//   the mirror (target 7) into a picture of its own; the six views round the car (targets 8..13) and the sphere map they are folded into;
//   the players' views and the 2D (targets 1..4, 6) into the picture, cut where eDisplayFrame lays fog, grey or the depth of field over it;
//   the picture kept for the next frame's DisplayBlendPrevious; the depth rects read back for the sun's flare; the picture into the canvas.
// Each strip is drawn up to three times (the strip, the road's specular, the sphere map) by draw_target's rules.

import { prefs } from './prefs.js';

const GPU_MAGIC = 0x46325048;
const C = { magic: 0, version: 1, size: 2, state: 3, frame: 4, attached: 5, framesDone: 6, features: 7, saved: 8, depthSeq: 9,
  depthBuf: 10, depthCap: 11, depthFrame: 12, errors: 13, wframeSize: 14, wdrawSize: 15, wuploadSize: 16, wfxSize: 17 };
const S_READY = 1, S_TAKEN = 2, S_DONE = 3;
const F = { magic: 0, seq: 1, number: 2, vertices: 3, vertexCount: 4, indices: 5, indexCount: 6, draws: 7, drawCount: 8, lights: 9,
  lightCount: 10, fx: 11, fxCount: 12, uploads: 13, uploadCount: 14, freed: 15, freedCount: 16, wide: 17, envLinear: 18, roadSpecular: 19,
  envOverride: 20, roadMode: 21, envMode: 22, samples: 23, backSamples: 24, depthRects: 25, depthRectCount: 26, narrow: 27, scale: 28,
  brightness: 29, contrast: 30, gamma: 31, aaMode: 32, aaLevel: 33, smooth: 34, showFps: 35, reflections: 36, fresh: 37, freshCount: 38,
  freshRuns: 39, freshRunCount: 40, dynBase: 41 };
// the GPU's vertex buffer: the cache (native_web.cpp's CACHE_VERTS), then a frame's own (DYN_VERTS)
const CACHE_VERTS = 3 << 20, DYN_VERTS = 2 << 20;
const WFRAME_SIZE = 176, WDRAW_SIZE = 160, WUPLOAD_SIZE = 48, WFX_SIZE = 1056;
const D = { first: 16, count: 17, tex: 18, rt: 19, bits: 20, blend: 21, blendFix: 22, scrollS: 23, scrollT: 24, texMode: 25, snapX: 26,
  snapY: 27, view: 28, tfx: 32, lodL: 33, target: 34, flags: 35, light: 36 };
const NB_OPAQUE = 0, NB_ALPHA = 1, NB_ADD = 2, NB_DEST = 4, NB_LERP_DEST = 5, NB_KEEP = 6, NB_SUB = 3;
const RT_MIRROR = 7, RT_PREVIOUS = 100;
const FX_FOG = 0, FX_GREY = 1;
const TEX_MISSING = 0xFFFFFFFF;
const PUSH_BYTES = 128, LIGHT_BYTES = 22 * 16, VERTEX_BYTES = 32;
const SCENE_LEVELS = 4;

function blendState(b) {
  if (b === NB_OPAQUE) return undefined;
  const byDest = b === NB_DEST || b === NB_LERP_DEST;
  return {
    color: {
      srcFactor: byDest ? 'dst-alpha' : b === NB_KEEP ? 'zero' : 'one',
      dstFactor: b === NB_ALPHA ? 'one-minus-src-alpha' : b === NB_LERP_DEST ? 'one-minus-dst-alpha' : 'one',
      operation: b === NB_SUB ? 'reverse-subtract' : 'add',
    },
    // the frame's alpha takes As, not a blend; the passes by Ad leave it for the next
    alpha: { srcFactor: byDest ? 'zero' : 'one', dstFactor: byDest ? 'one' : 'zero', operation: 'add' },
  };
}
// what is laid over the view: 0 over (Cs As + Cd (1 - As)), 1 darken (Cd As), 2 replace (black and white)
function postBlend(m) {
  return {
    color: { srcFactor: m === 1 ? 'zero' : 'one', dstFactor: m === 0 ? 'one-minus-src-alpha' : m === 1 ? 'src-alpha' : 'zero', operation: 'add' },
    alpha: { srcFactor: m === 2 ? 'one' : 'zero', dstFactor: m === 2 ? 'zero' : 'one', operation: 'add' },
  };
}

export class Renderer {
  constructor(memory, ctlPtr, canvas, hud, log) {
    this.memory = memory;
    this.ctlPtr = ctlPtr;
    this.canvas = canvas;
    this.hud = hud;
    this.log = log;
    this.textures = new Map();          // id -> { tex, group, w, h, levels }
    this.pipelines = new Map();
    this.frames = 0;
    this.fpsAt = performance.now();
    this.fpsFrames = 0;
    this.shown = '';
    this.savedSeen = 0;
    this.savedUntil = 0;
    this.envReady = [false, false, false, false, false, false];
    this.sphereReady = false;
    this.rvmReady = false;
    this.prevReady = false;
    this.depthBusy = false;
    this.depthSeq = 0;
  }

  i32() { if (!this._i32 || this._i32.buffer !== this.memory.buffer) this._i32 = new Int32Array(this.memory.buffer); return this._i32; }
  u32() { if (!this._u32 || this._u32.buffer !== this.memory.buffer) this._u32 = new Uint32Array(this.memory.buffer); return this._u32; }
  f32() { if (!this._f32 || this._f32.buffer !== this.memory.buffer) this._f32 = new Float32Array(this.memory.buffer); return this._f32; }
  u8() { if (!this._u8 || this._u8.buffer !== this.memory.buffer) this._u8 = new Uint8Array(this.memory.buffer); return this._u8; }
  ctl(i) { return Atomics.load(this.i32(), (this.ctlPtr >> 2) + i); }
  setCtl(i, v) { Atomics.store(this.i32(), (this.ctlPtr >> 2) + i, v); }

  async shader(file, label) {
    const code = await (await fetch(file)).text();
    const m = this.device.createShaderModule({ code, label });
    const info = await m.getCompilationInfo();
    for (const x of info.messages) this.log(`[gpu] ${file} ${x.type} ${x.lineNum}:${x.linePos} ${x.message}`, x.type === 'error' ? 2 : 1);
    if (info.messages.some(x => x.type === 'error')) throw new Error(`${file} did not compile`);
    return m;
  }

  async init() {
    const u32 = this.u32(), base = this.ctlPtr >> 2;
    if (u32[base + C.magic] !== GPU_MAGIC) throw new Error('the renderer block is not the runtime\'s');
    const sizes = [u32[base + C.wframeSize], u32[base + C.wdrawSize], u32[base + C.wuploadSize], u32[base + C.wfxSize]];
    if (sizes.join() !== [WFRAME_SIZE, WDRAW_SIZE, WUPLOAD_SIZE, WFX_SIZE].join())
      throw new Error(`the renderer's records differ: ${sizes.join()} (page ${[WFRAME_SIZE, WDRAW_SIZE, WUPLOAD_SIZE, WFX_SIZE].join()})`);
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no WebGPU adapter');
    const want = ['depth-clip-control'].filter(f => adapter.features.has(f));
    this.unclipped = want.includes('depth-clip-control');
    this.device = await adapter.requestDevice({
      requiredFeatures: want,
      requiredLimits: { maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 256 << 20),
        maxBufferSize: Math.min(adapter.limits.maxBufferSize, 512 << 20) },
    });
    this.device.lost.then(info => this.log(`[gpu] device lost: ${info.message}`, 2));
    let errors = 0;
    this.device.addEventListener('uncapturederror', e => {
      if (errors++ < 20) this.log(`[gpu] ${e.error.message}`, 2);
      this.setCtl(C.errors, errors);
    });
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context = this.canvas.getContext('webgpu');
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
    this.module = await this.shader('native.wgsl', 'native');
    this.post = await this.shader('post.wgsl', 'post');
    const d = this.device, FRAG = GPUShaderStage.FRAGMENT, VERT = GPUShaderStage.VERTEX;
    this.texLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: FRAG, texture: { sampleType: 'float' } }] });
    this.frameLayout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: VERT | FRAG, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: VERT, buffer: { type: 'read-only-storage' } }] });
    this.sceneLayout = d.createPipelineLayout({ bindGroupLayouts: [this.texLayout, this.frameLayout] });
    // the picture into the canvas
    this.blitLayout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: FRAG, texture: { sampleType: 'float' } },
      { binding: 1, visibility: FRAG, sampler: { type: 'filtering' } },
      { binding: 2, visibility: VERT | FRAG, buffer: { type: 'uniform' } }] });
    this.blitPipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.blitLayout] }),
      vertex: { module: this.module, entryPoint: 'blit_vs' },
      fragment: { module: this.module, entryPoint: 'blit_fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.blitUniform = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // the bars beside the picture (blit_bg_fs): its own pipeline and rect, the same layout
    this.blitBgPipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.blitLayout] }),
      vertex: { module: this.module, entryPoint: 'blit_vs' },
      fragment: { module: this.module, entryPoint: 'blit_bg_fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.blitBgUniform = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.samplers = {
      linear: d.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
      nearest: d.createSampler({}),
      mip: d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' }),
    };
    // the fold
    this.foldLayout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: FRAG, texture: { sampleType: 'float' } },
      { binding: 1, visibility: FRAG, texture: { sampleType: 'float' } },
      { binding: 2, visibility: FRAG, buffer: { type: 'uniform' } }] });
    this.foldPipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.foldLayout] }),
      vertex: { module: this.post, entryPoint: 'fold_vs', buffers: [{ arrayStride: 16, attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x2' }] }] },
      fragment: { module: this.post, entryPoint: 'fold_fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    this.foldUniform = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.foldVB = d.createBuffer({ size: 10 * 150 * 16, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    // the effects over the view
    this.postLayout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: FRAG, texture: { sampleType: 'depth' } },
      { binding: 1, visibility: FRAG, texture: { sampleType: 'float' } },
      { binding: 2, visibility: FRAG, texture: { sampleType: 'float' } },
      { binding: 3, visibility: FRAG, sampler: { type: 'filtering' } },
      { binding: 4, visibility: FRAG, buffer: { type: 'uniform', hasDynamicOffset: true } }] });
    const postPL = d.createPipelineLayout({ bindGroupLayouts: [this.postLayout] });
    this.postPipelines = [0, 1, 2].map(m => d.createRenderPipeline({
      layout: postPL,
      vertex: { module: this.post, entryPoint: 'post_vs' },
      fragment: { module: this.post, entryPoint: 'post_fs', targets: [{ format: 'rgba8unorm', blend: postBlend(m) }] },
      primitive: { topology: 'triangle-list' },
    }));
    this.postUniform = d.createBuffer({ size: 8 * 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.palette = d.createTexture({ size: [256, 8], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.downLayout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: FRAG, texture: { sampleType: 'float' } },
      { binding: 1, visibility: FRAG, sampler: { type: 'filtering' } }] });
    this.downPipeline = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.downLayout] }),
      vertex: { module: this.post, entryPoint: 'down_vs' },
      fragment: { module: this.post, entryPoint: 'down_fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    // a white texel for the strips without a texture (the set is bound, not read)
    this.white = d.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    d.queue.writeTexture({ texture: this.white }, new Uint8Array([255, 255, 255, 128]), { bytesPerRow: 4 }, [1, 1]);
    this.whiteGroup = this.texGroup(this.white.createView());
    this.buffers = {};
    await this.warm();
    this.setCtl(C.features, this.unclipped ? 2 : 0);
    this.setCtl(C.attached, 1);
    this.log(`[gpu] WebGPU ready (${adapter.info ? adapter.info.vendor + ' ' + adapter.info.architecture : ''}), unclipped depth ${this.unclipped}`);
  }

  texGroup(view) { return this.device.createBindGroup({ layout: this.texLayout, entries: [{ binding: 0, resource: view }] }); }

  // a buffer at least this big, made again (larger) when it is not
  buffer(name, bytes, usage) {
    const b = this.buffers[name];
    if (b && b.size >= bytes) return b;
    if (b) b.destroy();
    const size = Math.max(64 * 1024, 2 ** Math.ceil(Math.log2(Math.max(bytes, 16))));
    this.buffers[name] = this.device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST, label: name });
    this.frameGroup = null;
    return this.buffers[name];
  }

  pipelineDesc(alphaTest, blend, depthWrite, depthTest, alphaOnly, key) {
    return {
      layout: this.sceneLayout,
      vertex: {
        module: this.module, entryPoint: 'vs',
        buffers: [{ arrayStride: VERTEX_BYTES, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'unorm8x4' },
          { shaderLocation: 2, offset: 16, format: 'float32x2' }, { shaderLocation: 3, offset: 24, format: 'snorm8x4' },
          { shaderLocation: 4, offset: 28, format: 'float32' }] }],
      },
      fragment: {
        module: this.module, entryPoint: 'fs', constants: { ALPHA_TEST: alphaTest ? 1 : 0 },
        targets: [{ format: 'rgba8unorm', blend: alphaOnly ? undefined : blendState(blend), writeMask: alphaOnly ? GPUColorWrite.ALPHA : GPUColorWrite.ALL }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none', unclippedDepth: this.unclipped || undefined },
      depthStencil: { format: 'depth32float', depthWriteEnabled: !!depthWrite && !alphaOnly, depthCompare: depthTest ? 'greater-equal' : 'always' },
      label: `scene ${key}`,
    };
  }

  pipeline(alphaTest, blend, depthWrite, depthTest, alphaOnly) {
    const key = `${alphaTest ? 1 : 0}${blend}${depthWrite ? 1 : 0}${depthTest ? 1 : 0}${alphaOnly ? 1 : 0}`;
    let p = this.pipelines.get(key);
    if (p) return p;
    p = this.device.createRenderPipeline(this.pipelineDesc(alphaTest, blend, depthWrite, depthTest, alphaOnly, key));
    this.pipelines.set(key, p);
    return p;
  }

  // every pipeline a frame can ask for, compiled before the first: made on first use, each held a race's frame up to 100 ms
  async warm() {
    const t0 = performance.now(), jobs = [];
    for (const at of [false, true])
      for (let b = 0; b < 7; b++)
        for (const dw of [false, true])
          for (const dt of [false, true]) jobs.push([at, b, dw, dt, false]);
    for (const at of [false, true]) for (const dt of [false, true]) jobs.push([at, 0, false, dt, true]);
    await Promise.all(jobs.map(async ([at, b, dw, dt, ao]) => {
      const key = `${at ? 1 : 0}${b}${dw ? 1 : 0}${dt ? 1 : 0}${ao ? 1 : 0}`;
      if (!this.pipelines.has(key)) this.pipelines.set(key, await this.device.createRenderPipelineAsync(this.pipelineDesc(at, b, dw, dt, ao, key)));
    }));
    this.log(`[gpu] ${jobs.length} pipelines made in ${(performance.now() - t0).toFixed(0)} ms`);
  }

  target(w, h, color = true) {
    const d = this.device;
    const c = d.createTexture({ size: [w, h], format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
    const z = d.createTexture({ size: [w, h], format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    const t = { w, h, color: c, depth: z, colorView: c.createView(), depthView: z.createView() };
    t.group = this.texGroup(t.colorView);
    return t;
  }

  // the pictures that depend on the settings: made again when the picture's size or the reflections' change
  resources(W, H, W43, envSize) {
    const key = `${W}x${H}/${W43}/${envSize}`;
    if (this.resKey === key) return;
    this.resKey = key;
    for (const t of this.res ? [this.res.pic, this.res.rvm, ...this.res.env] : []) { t.color.destroy(); t.depth.destroy(); }
    if (this.res) for (const t of [this.res.prev, this.res.scene, this.res.sphere, this.res.spherePrev]) t.destroy();
    const d = this.device;
    const pic = this.target(W, H);
    const rvm = this.target(Math.max(W43 >> 1, 1), Math.max(Math.floor(H / 7), 1));
    const env = [0, 1, 2, 3, 4, 5].map(() => this.target(envSize, envSize));
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    const prev = d.createTexture({ size: [W, H], format: 'rgba8unorm', usage });
    const scene = d.createTexture({ size: [W, H], format: 'rgba8unorm', usage, mipLevelCount: SCENE_LEVELS });
    const sphere = d.createTexture({ size: [envSize * 4, envSize * 4], format: 'rgba8unorm', usage });
    const spherePrev = d.createTexture({ size: [envSize * 4, envSize * 4], format: 'rgba8unorm', usage });
    this.res = {
      pic, rvm, env, prev, scene, sphere, spherePrev, envSize,
      prevGroup: this.texGroup(prev.createView()),
      sphereView: sphere.createView(),
      sphereGroup: this.texGroup(sphere.createView()),
      sceneLevels: [...Array(SCENE_LEVELS).keys()].map(l => scene.createView({ baseMipLevel: l, mipLevelCount: 1 })),
      foldGroups: env.map(t => d.createBindGroup({ layout: this.foldLayout, entries: [
        { binding: 0, resource: t.colorView }, { binding: 1, resource: spherePrev.createView() }, { binding: 2, resource: { buffer: this.foldUniform } }] })),
    };
    this.res.downGroups = this.res.sceneLevels.slice(0, -1).map(v => d.createBindGroup({ layout: this.downLayout, entries: [
      { binding: 0, resource: v }, { binding: 1, resource: this.samplers.linear }] }));
    this.res.postGroup = d.createBindGroup({ layout: this.postLayout, entries: [
      { binding: 0, resource: pic.depth.createView({ aspect: 'depth-only' }) }, { binding: 1, resource: this.palette.createView() },
      { binding: 2, resource: scene.createView() }, { binding: 3, resource: this.samplers.mip },
      { binding: 4, resource: { buffer: this.postUniform, size: 64 } }] });
    this.blitGroups = {};
    this.blitBgGroup = null;
    this.envReady.fill(false);
    this.sphereReady = this.rvmReady = this.prevReady = false;
    this.log(`[gpu] picture ${W}x${H}, mirror ${rvm.w}x${rvm.h}, reflections ${envSize}`);
  }

  upload(at) {
    const u32 = this.u32(), b = at >> 2;
    const id = u32[b], w = u32[b + 1], h = u32[b + 2], levels = Math.max(1, u32[b + 3]), px = u32[b + 4], count = u32[b + 5];
    let t = this.textures.get(id);
    if (!t || t.w !== w || t.h !== h || t.levels !== levels) {
      if (t) t.tex.destroy();
      const tex = this.device.createTexture({ size: [w, h], mipLevelCount: levels, format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: `tex ${id}` });
      t = { tex, w, h, levels, group: this.texGroup(tex.createView()) };
      this.textures.set(id, t);
    }
    let off = 0;
    const mem = this.u8();
    for (let l = 0; l < levels; l++) {
      const lw = Math.max(w >> l, 1), lh = Math.max(h >> l, 1);
      if (off + lw * lh > count) break;
      this.device.queue.writeTexture({ texture: t.tex, mipLevel: l }, mem, { offset: px + off * 4, bytesPerRow: lw * 4, rowsPerImage: lh }, [lw, lh]);
      off += lw * lh;
    }
  }

  // A frame is drawn as soon as the game hands it over: waiting for the display's next tick held the game back up to a refresh per
  // frame (a 60 fps race came out at 44). Where there is no Atomics.waitAsync, the display's ticks.
  run() {
    const step = () => { try { this.poll(); } catch (e) { this.log(`[gpu] ${e.stack || e}`, 2); } };
    if (Atomics.waitAsync) {
      const at = (this.ctlPtr >> 2) + C.state;
      const loop = async () => {
        while (!this.stopped) {
          step();
          const v = Atomics.load(this.i32(), at);
          if (v === S_READY) continue;
          const w = Atomics.waitAsync(this.i32(), at, v, 100);
          if (w.async) await w.value;
        }
      };
      loop();
    } else {
      const tick = () => { if (this.stopped) return; step(); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }
  }
  // the game has ended: no more frames to wait for
  stop() { this.stopped = true; }

  poll() {
    const i32 = this.i32(), st = (this.ctlPtr >> 2) + C.state;
    if (Atomics.compareExchange(i32, st, S_READY, S_TAKEN) !== S_READY) return;
    try {
      this.draw(this.ctl(C.frame) >>> 0);
    } finally {
      Atomics.store(i32, st, S_DONE);
      Atomics.notify(i32, st);
    }
  }

  // ---- one target's passes (draw_target): appended to `list` as [pipeline, group, pass, draw], constants into P[pass] ----
  passes(fr, target, first, last, list) {
    const u32 = this.u32(), f32 = this.f32(), i32 = this.i32(), pf = this.pushF, pi = this.pushI;
    const roadTex = this.textures.get(fr.roadSpecular), envTex = this.textures.get(fr.envOverride);
    const envGroup = envTex ? envTex.group : this.res.sphereGroup;
    const bits16 = target >= 8 && target <= 13 ? 1 : 0;
    const pass = (db, which, group, pipeline, factor, textured) => {
      const n = this.npass++, o = n * (PUSH_BYTES / 4);
      for (let k = 0; k < 16; k++) pf[o + k] = f32[db + k];
      pf[o + 16] = which === 2 ? 0 : f32[db + D.scrollS];
      pf[o + 17] = which === 2 ? 0 : f32[db + D.scrollT];
      pf[o + 18] = u32[db + D.bits] & 2 ? 1 : 0;
      pf[o + 19] = factor;
      pf[o + 20] = textured ? 1 : 0;
      pi[o + 21] = i32[db + D.light];
      pi[o + 22] = u32[db + D.flags];
      pi[o + 23] = which;
      pi[o + 24] = which === 0 ? u32[db + D.tfx] : 0;
      pf[o + 25] = which === 0 ? u32[db + D.lodL] : 0;
      pi[o + 26] = bits16;
      const rt = i32[db + D.rt], tex = u32[db + D.tex];
      pi[o + 27] = which === 2 && envTex ? fr.envMode | 64 : which === 2 || rt >= 0 || !tex ? 4 | 8 : which === 1 ? fr.roadMode : u32[db + D.texMode];
      pf[o + 28] = f32[db + D.snapX];
      pf[o + 29] = f32[db + D.snapY];
      list.push(pipeline, group, n, db);
    };
    last = Math.min(last, fr.drawCount);
    for (let i = first; i < last; i++) {
      const db = fr.dbase + i * (WDRAW_SIZE / 4);
      const count = u32[db + D.count], t8 = u32[db + D.target], tex = u32[db + D.tex], rt = i32[db + D.rt];
      // the players' views and the 2D layer share a picture (target 6 in the frontend: the car again, half a line off, not drawn)
      const mine = target === 1 ? t8 <= 4 || (t8 === 6 && !envTex) : t8 === target;
      if (!count || !mine) continue;
      if (tex === TEX_MISSING) continue;
      if (rt === RT_MIRROR && !this.rvmReady) continue;
      if (rt === RT_PREVIOUS && !this.prevReady) continue;
      const t = tex ? this.textures.get(tex) : null;
      if (tex && !t) continue;
      const group = rt === RT_MIRROR ? this.res.rvm.group : rt === RT_PREVIOUS ? this.res.prevGroup : t ? t.group : this.whiteGroup;
      const blend = u32[db + D.blend], bits = u32[db + D.bits], light = i32[db + D.light], flags = u32[db + D.flags];
      const alphaTest = (bits & 2) !== 0, depthWrite = (bits & 1) !== 0, depthTest = (bits & 4) !== 0;
      const factor = blend === NB_OPAQUE ? -2 : blend === NB_KEEP ? -4 : blend === NB_DEST || blend === NB_LERP_DEST ? -3 : f32[db + D.blendFix];
      const textured = tex !== 0 || rt >= 0;
      const hasRoad = light >= 0 && (flags & 0x40) && roadTex;
      const hasSphere = light >= 0 && (flags & 0x100) && (this.sphereReady || envTex);
      const gloss = (flags & 4) !== 0;
      const main = this.pipeline(alphaTest, blend, depthWrite, depthTest, false);
      const dest = this.pipeline(alphaTest, NB_DEST, false, depthTest, false);
      const alphaOnly = this.pipeline(alphaTest, 0, false, depthTest, true);
      pass(db, 0, group, main, factor, textured);
      if (blend === NB_DEST) pass(db, 0, group, main, factor, textured);
      const alphaRead = target === 7 || hasRoad || (hasSphere && gloss);
      if (blend !== NB_OPAQUE && blend !== NB_KEEP && blend !== NB_LERP_DEST && alphaRead) pass(db, 0, group, alphaOnly, -2, textured);
      if (hasRoad) {
        pass(db, 1, roadTex.group, dest, -3, true);
        pass(db, 1, roadTex.group, dest, -3, true);
        if (target === 7 || (hasSphere && gloss)) pass(db, 1, roadTex.group, alphaOnly, -2, true);
      }
      if (hasSphere) {
        if (gloss && !envTex) { pass(db, 2, envGroup, dest, -3, true); pass(db, 2, envGroup, dest, -3, true); }
        else pass(db, 2, envGroup, this.pipeline(alphaTest, NB_ADD, false, depthTest, false), -1, true);
        if (target === 7) pass(db, 2, envGroup, alphaOnly, -2, true);
      }
    }
  }

  // ---- a list into a render pass; target 1 sets each draw's view of the picture ----
  encode(rp, list, view) {
    const u32 = this.u32(), f32 = this.f32();
    rp.setVertexBuffer(0, this.vb);
    rp.setIndexBuffer(this.ib, 'uint32');
    rp.setBindGroup(1, this.frameGroup);
    let boundPipe = null, boundGroup = null, v0 = NaN, v1 = NaN, v2 = NaN, v3 = NaN;
    for (let k = 0; k < list.length; k += 4) {
      const pipe = list[k], group = list[k + 1], passN = list[k + 2], db = list[k + 3];
      if (view) {
        const a0 = f32[db + D.view], a1 = f32[db + D.view + 1], a2 = f32[db + D.view + 2], a3 = f32[db + D.view + 3];
        if (a0 !== v0 || a1 !== v1 || a2 !== v2 || a3 !== v3) {
          v0 = a0, v1 = a1, v2 = a2, v3 = a3;
          const { W, H, ox, sx, sy } = view;
          let vx = ox + f32[db + D.view] * sx, vy = f32[db + D.view + 1] * sy, vw = f32[db + D.view + 2] * sx, vh = f32[db + D.view + 3] * sy;
          if (!(vw > 0 && vh > 0)) { vx = 0, vy = 0, vw = W, vh = H; }
          const x0 = Math.max(0, vx), y0 = Math.max(0, vy), x1 = Math.min(W, vx + vw), y1 = Math.min(H, vy + vh);
          rp.setViewport(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0), 0, 1);
          rp.setScissorRect(Math.floor(x0), Math.floor(y0), Math.max(1, Math.floor(x1 - x0)), Math.max(1, Math.floor(y1 - y0)));
        }
      }
      if (pipe !== boundPipe) { rp.setPipeline(pipe); boundPipe = pipe; }
      if (group !== boundGroup) { rp.setBindGroup(0, group); boundGroup = group; }
      const first = u32[db + D.first], count = u32[db + D.count];
      if (u32[db + D.bits] & 8) rp.drawIndexed(count, 1, first, 0, passN);
      else rp.draw(count, 1, this.dynBase + first, passN);
    }
  }

  // the picture so far into the scene's copy, with its levels
  copyScene(enc) {
    const { pic, scene, sceneLevels, downGroups } = this.res;
    enc.copyTextureToTexture({ texture: pic.color }, { texture: scene, mipLevel: 0 }, [pic.w, pic.h]);
    for (let l = 1; l < SCENE_LEVELS; l++) {
      const rp = enc.beginRenderPass({ colorAttachments: [{ view: sceneLevels[l], loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      rp.setPipeline(this.downPipeline);
      rp.setBindGroup(0, downGroups[l - 1]);
      rp.draw(3);
      rp.end();
    }
  }

  draw(fp) {
    const t0 = performance.now();
    const u32 = this.u32(), f32 = this.f32(), d = this.device, fb = fp >> 2;
    const fr = {};
    for (const k in F) fr[k] = u32[fb + F[k]];
    fr.narrow = f32[fb + F.narrow] || 1;
    fr.dbase = fr.draws >> 2;
    // the textures decoded for this frame, then those let go
    for (let i = 0, at = fr.uploads; i < fr.uploadCount; i++, at += WUPLOAD_SIZE) this.upload(at);
    for (let i = 0, at = fr.freed >> 2; i < fr.freedCount; i++) {
      const t = this.textures.get(u32[at + i]);
      if (t) { t.tex.destroy(); this.textures.delete(u32[at + i]); }
    }
    // the picture: 512 x 448 times the scale; a race wider by its aspect (native_vk.cpp's W, W43, H)
    const scale = Math.max(1, Math.min(8, fr.scale || 2));
    const W43 = 512 * scale, H = 448 * scale, W = Math.round(W43 / fr.narrow) & ~1;
    const envSize = fr.reflections === 2 ? 128 : 64;
    this.resources(W, H, W43, envSize);
    const { pic, rvm, env } = this.res;
    const wide = fr.wide !== 0;
    const regionW = wide ? W : W43, ox = (W - regionW) / 2, sx = regionW / 512, sy = H / 448;

    // the frame's vertices, indices and lights
    const vcount = fr.vertexCount, icount = fr.indexCount, lcount = fr.lightCount;
    // the vertex cache's new strips into it, the frame's own after it (dyn_base: the cache's size as the game's thread knew it)
    if (!this.vb) this.vb = d.createBuffer({ size: (CACHE_VERTS + DYN_VERTS) * VERTEX_BYTES, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, label: 'vertices' });
    this.dynBase = fr.dynBase;
    this.ib = this.buffer('indices', Math.max(icount * 4, 64), GPUBufferUsage.INDEX);
    const lb = this.buffer('lights', Math.max(lcount * LIGHT_BYTES, 64), GPUBufferUsage.STORAGE);
    const mem = this.u8();
    for (let i = 0, r = fr.freshRuns >> 2; i < fr.freshRunCount; i++, r += 3) {
      const dst = u32[r], src = u32[r + 1], n = u32[r + 2];
      if (n && dst + n <= CACHE_VERTS && src + n <= fr.freshCount)
        d.queue.writeBuffer(this.vb, dst * VERTEX_BYTES, mem, fr.fresh + src * VERTEX_BYTES, n * VERTEX_BYTES);
    }
    if (vcount && fr.dynBase + vcount <= CACHE_VERTS + DYN_VERTS) d.queue.writeBuffer(this.vb, fr.dynBase * VERTEX_BYTES, mem, fr.vertices, vcount * VERTEX_BYTES);
    if (icount) d.queue.writeBuffer(this.ib, 0, mem, fr.indices, icount * 4);
    if (lcount) d.queue.writeBuffer(lb, 0, mem, fr.lights, lcount * LIGHT_BYTES);

    // which targets have strips this frame
    let hasRvm = false, wantsPrev = false;
    const hasEnv = [false, false, false, false, false, false];
    for (let i = 0; i < fr.drawCount; i++) {
      const db = fr.dbase + i * (WDRAW_SIZE / 4);
      if (!u32[db + D.count]) continue;
      const t = u32[db + D.target];
      if (t === 7) hasRvm = true;
      else if (t >= 8 && t <= 13) hasEnv[t - 8] = true;
      if (this.i32()[db + D.rt] === RT_PREVIOUS) wantsPrev = true;
    }

    // the passes' constants, all the frame's at once
    const maxPasses = fr.drawCount * 4 + 4;
    if (!this.push || this.push.byteLength < maxPasses * PUSH_BYTES) {
      this.push = new ArrayBuffer(2 ** Math.ceil(Math.log2(maxPasses * PUSH_BYTES)));
      this.pushF = new Float32Array(this.push);
      this.pushI = new Int32Array(this.push);
    }
    this.npass = 0;
    const rvmList = [];
    if (hasRvm) this.passes(fr, 7, 0, fr.drawCount, rvmList);
    const envLists = hasEnv.map((h, i) => { const l = []; if (h) this.passes(fr, 8 + i, 0, fr.drawCount, l); return l; });
    // the mirror and the views are drawn before the picture's passes are listed: the picture reads them this frame
    if (hasRvm) this.rvmReady = true;
    if (hasEnv.some(Boolean)) this.sphereReady = true;
    const nfx = Math.min(fr.fxCount, 8);
    const sceneLists = [];
    let at = 0;
    for (let i = 0; i < nfx; i++) {
      const fxAt = u32[(fr.fx >> 2) + i * (WFX_SIZE / 4)];
      const l = [];
      this.passes(fr, 1, at, fxAt, l);
      sceneLists.push(l);
      at = fxAt;
    }
    const lastList = [];
    this.passes(fr, 1, at, fr.drawCount, lastList);
    sceneLists.push(lastList);

    const pb = this.buffer('push', Math.max(this.npass * PUSH_BYTES, 256), GPUBufferUsage.STORAGE);
    if (this.npass) d.queue.writeBuffer(pb, 0, this.push, 0, this.npass * PUSH_BYTES);
    const groupKey = `${pb.size}/${lb.size}/${this.buffers.push === pb}`;
    if (!this.frameGroup || this.frameGroupFor !== groupKey) {
      this.frameGroup = d.createBindGroup({ layout: this.frameLayout, entries: [{ binding: 0, resource: { buffer: pb } }, { binding: 1, resource: { buffer: lb } }] });
      this.frameGroupFor = groupKey;
    }

    const enc = d.createCommandEncoder();
    // the mirror first: nothing in it reads it
    if (hasRvm) {
      const rp = enc.beginRenderPass({
        colorAttachments: [{ view: rvm.colorView, clearValue: [0, 0, 0, 128 / 255], loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: rvm.depthView, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      this.encode(rp, rvmList, null);
      rp.end();
    }
    // the views round the car, each over a grey of its own whose alpha bit is clear
    for (let i = 0; i < 6; i++) {
      if (!hasEnv[i]) continue;
      const grey = ((96 + 16 * i) & 0xf8) / 255;
      const rp = enc.beginRenderPass({
        colorAttachments: [{ view: env[i].colorView, clearValue: [grey, grey, grey, 0], loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: env[i].depthView, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      this.encode(rp, envLists[i], null);
      rp.end();
    }
    if (hasEnv.some(Boolean)) this.fold(enc, fr, hasEnv);

    // the picture, cut where something is laid over it
    if (nfx) {
      const fxu = new ArrayBuffer(8 * 256), fxf = new Float32Array(fxu), fxi = new Int32Array(fxu);
      for (let i = 0; i < nfx; i++) {
        const fx = (fr.fx >> 2) + i * (WFX_SIZE / 4);
        d.queue.writeTexture({ texture: this.palette, origin: [0, i] }, mem, { offset: (fx + 7) * 4, bytesPerRow: 1024 }, [256, 1]);
        const kind = u32[fx + 1];
        const vx = ox + f32[fx + 3] * sx, vy = f32[fx + 4] * sy, vw = f32[fx + 5] * sx, vh = f32[fx + 6] * sy;
        const o = i * 64;
        fxi[o] = kind === FX_FOG ? 0 : kind === FX_GREY ? 1 : 3;
        fxi[o + 1] = i;
        fxf[o + 2] = W, fxf[o + 3] = H;
        fxf[o + 4] = Math.max(Math.log2(sy), 0);
        fxf[o + 6] = sx, fxf[o + 7] = sy;
        fxf[o + 8] = ox, fxf[o + 9] = 0;
        fxf[o + 12] = vx, fxf[o + 13] = vy, fxf[o + 14] = vx + vw, fxf[o + 15] = vy + vh;
      }
      d.queue.writeBuffer(this.postUniform, 0, fxu, 0, nfx * 256);
    }
    const view = { W, H, ox, sx, sy };
    for (let s = 0; s < sceneLists.length; s++) {
      const rp = enc.beginRenderPass({
        colorAttachments: [{ view: pic.colorView, clearValue: [0, 0, 0, 128 / 255], loadOp: s ? 'load' : 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: pic.depthView, depthClearValue: 0, depthLoadOp: s ? 'load' : 'clear', depthStoreOp: 'store' },
      });
      this.encode(rp, sceneLists[s], view);
      rp.end();
      if (s < nfx) this.effect(enc, fr, s, view);
    }
    // what the next frame's DisplayBlendPrevious reads, if this one asked for it
    this.prevReady = wantsPrev;
    if (wantsPrev) enc.copyTextureToTexture({ texture: pic.color }, { texture: this.res.prev }, [W, H]);
    const depthCopy = this.depthRects(enc, fr, view);

    this.blit(enc, fr, W, H, W43, wide);
    d.queue.submit([enc.finish()]);
    if (depthCopy) this.depthRead(depthCopy);

    this.frames++;
    this.setCtl(C.framesDone, this.frames);
    this.fpsFrames++;
    const now = performance.now();
    this.encSum = (this.encSum || 0) + (now - t0);
    this.encMax = Math.max(this.encMax || 0, now - t0);
    const saved = this.ctl(C.saved);
    if (saved !== this.savedSeen) { this.savedSeen = saved; this.savedUntil = now + 1500; }
    if (now - this.fpsAt >= 1000) {
      this.fps = Math.round(this.fpsFrames * 1000 / (now - this.fpsAt));
      this.fpsAt = now;
      this.fpsFrames = 0;
      if (this.frames % 600 < 60) this.log(`[gpu] frame ${fr.number}: ${fr.drawCount} draws, ${this.npass} passes, ${vcount} own + ${fr.freshCount} new cached vertices, ${icount} indices, ${this.textures.size} textures, fx ${nfx}, mirror ${hasRvm}, views ${hasEnv.filter(Boolean).length}, ${this.fps} fps, page ${(this.encSum / Math.max(1, this.fpsFramesLast || this.fps || 1)).toFixed(1)} ms a frame (worst ${this.encMax.toFixed(1)})`);
      this.encSum = 0, this.encMax = 0, this.fpsFramesLast = this.fps;
    }
    const text = (fr.showFps ? `${this.fps || 0} fps` : '') + (now < this.savedUntil ? '\nSAVED' : '');
    if (text !== this.shown) { this.shown = text; this.hud.textContent = text; }
  }

  // CreateEnvMap, CreateBackEnvMap: each view drawn this frame but view 2 by its grid, then view 2 round the rim (fold_sphere_map)
  fold(enc, fr, drawn) {
    const d = this.device, { sphere, spherePrev, envSize } = this.res, size = envSize * 4;
    if (!this.sphereCleared) this.sphereCleared = new WeakSet();
    if (!this.sphereCleared.has(sphere)) {
      const rp = enc.beginRenderPass({ colorAttachments: [{ view: this.res.sphereView, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }] });
      rp.end();
      this.sphereCleared.add(sphere);
    }
    // RefSample: x y z s t u v; a grid is 7 by 7 with its last row and column unused
    const out = new Float32Array(10 * 150 * 4), first = [], count = [];
    let n = 0;
    const dv = new DataView(this.memory.buffer);
    const grid = (base, which) => {
      first[which] = n;
      const atv = (r, c) => {
        const p = base + (r * 7 + c) * 28;
        const s = dv.getFloat32(p + 12, true), t = dv.getFloat32(p + 16, true), u = dv.getFloat32(p + 20, true), v = dv.getFloat32(p + 24, true);
        out.set([Math.floor(s * 256) / 256, Math.floor(t * 256) / 256, u, v], n * 4);
        n++;
      };
      for (let r = 0; r < 5; r++)
        for (let c = 0; c < 5; c++) { atv(r, c); atv(r, c + 1); atv(r + 1, c); atv(r + 1, c); atv(r, c + 1); atv(r + 1, c + 1); }
      count[which] = n - first[which];
    };
    for (let i = 0; i < 6; i++) grid(fr.samples + i * 49 * 28, i);
    for (let i = 0; i < 4; i++) grid(fr.backSamples + i * 49 * 28, 6 + i);
    d.queue.writeBuffer(this.foldVB, 0, out, 0, n * 4);
    d.queue.writeBuffer(this.foldUniform, 0, new Int32Array([fr.envLinear ? 1 : 0, 0, 0, 0]));
    const one = (view, from, vertices) => {
      enc.copyTextureToTexture({ texture: sphere }, { texture: spherePrev }, [size, size]);
      const rp = enc.beginRenderPass({ colorAttachments: [{ view: this.res.sphereView, loadOp: 'load', storeOp: 'store' }] });
      rp.setPipeline(this.foldPipeline);
      rp.setBindGroup(0, this.res.foldGroups[view]);
      rp.setVertexBuffer(0, this.foldVB);
      rp.draw(vertices, 1, from, 0);
      rp.end();
    };
    for (let i = 0; i < 6; i++) if (i !== 2 && drawn[i]) one(i, first[i], count[i]);
    if (drawn[2]) for (let i = 0; i < 4; i++) one(2, first[6 + i], count[6 + i]);
  }

  // the render pass of the picture is over: lay this on it (draw_fx)
  effect(enc, fr, i, view) {
    const fx = (fr.fx >> 2) + i * (WFX_SIZE / 4), u32 = this.u32(), f32 = this.f32();
    const kind = u32[fx + 1], darken = u32[fx + 2];
    if (kind !== FX_FOG) this.copyScene(enc);
    const { W, H, ox, sx, sy } = view;
    const vx = ox + f32[fx + 3] * sx, vy = f32[fx + 4] * sy, vw = f32[fx + 5] * sx, vh = f32[fx + 6] * sy;
    const x0 = Math.max(0, vx), y0 = Math.max(0, vy), x1 = Math.min(W, vx + vw), y1 = Math.min(H, vy + vh);
    if (!(x1 > x0 && y1 > y0)) return;
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: this.res.pic.colorView, loadOp: 'load', storeOp: 'store' }] });
    rp.setViewport(x0, y0, x1 - x0, y1 - y0, 0, 1);
    rp.setScissorRect(Math.floor(x0), Math.floor(y0), Math.max(1, Math.floor(x1 - x0)), Math.max(1, Math.floor(y1 - y0)));
    rp.setPipeline(this.postPipelines[kind === FX_GREY ? 2 : darken ? 1 : 0]);
    rp.setBindGroup(0, this.res.postGroup, [i * 256]);
    rp.draw(3);
    rp.end();
  }

  // eTransferZBufferRect's rects of this frame's depth, read back for a later frame's FetchVRAM (the sun's flare). WebGPU copies a depth
  // texture only whole: a compute pass reads the GS pixels' middles (native_vk_depth's sampling) into finished words instead
  depthRects(enc, fr, view) {
    if (!fr.depthRectCount || this.depthBusy) return null;
    const i32 = this.i32(), { W, H, ox, sx, sy } = view, d = this.device;
    if (!this.depthPipe) {
      this.depthLayout = d.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }] });
      this.depthPipe = d.createComputePipeline({ layout: d.createPipelineLayout({ bindGroupLayouts: [this.depthLayout] }),
        compute: { module: this.post, entryPoint: 'depth_cs' } });
      this.depthParams = d.createBuffer({ size: 8 * 4 + 16 * 8 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    const n = Math.min(fr.depthRectCount, 16), rects = [];
    const params = new Int32Array(8 + n * 8), pf = new Float32Array(params.buffer);
    let words = 0, maxW = 1, maxH = 1;
    for (let k = 0; k < n; k++) {
      const b = (fr.depthRects >> 2) + k * 4;
      const r = { x: i32[b], y: i32[b + 1], w: Math.max(0, i32[b + 2]), h: Math.max(0, i32[b + 3]), at: words };
      rects.push(r);
      params.set([r.x, r.y, r.w, r.h, r.at], 8 + k * 8);
      words += r.w * r.h;
      maxW = Math.max(maxW, r.w), maxH = Math.max(maxH, r.h);
    }
    if (!words) return null;
    params[0] = n, params[1] = W, params[2] = H;
    pf[4] = ox, pf[5] = sx, pf[6] = sy;
    d.queue.writeBuffer(this.depthParams, 0, params);
    const bytes = Math.ceil(words * 4 / 256) * 256;
    if (!this.depthOut || this.depthOut.size < bytes) {
      if (this.depthOut) this.depthOut.destroy(), this.depthMap.destroy();
      const size = Math.max(bytes, 65536);
      this.depthOut = d.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      this.depthMap = d.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      this.depthGroup = null;
    }
    if (!this.depthGroup || this.depthGroupFor !== this.res.pic) {
      this.depthGroup = d.createBindGroup({ layout: this.depthLayout, entries: [
        { binding: 0, resource: this.res.pic.depth.createView({ aspect: 'depth-only' }) }, { binding: 1, resource: { buffer: this.depthParams } },
        { binding: 2, resource: { buffer: this.depthOut } }] });
      this.depthGroupFor = this.res.pic;
    }
    const cp = enc.beginComputePass();
    cp.setPipeline(this.depthPipe);
    cp.setBindGroup(0, this.depthGroup);
    cp.dispatchWorkgroups(Math.ceil(maxW / 8), Math.ceil(maxH / 8), n);
    cp.end();
    enc.copyBufferToBuffer(this.depthOut, 0, this.depthMap, 0, bytes);
    this.depthBusy = true;
    return { rects, words };
  }

  depthRead({ rects, words }) {
    const buf = this.depthMap;
    buf.mapAsync(GPUMapMode.READ).then(() => {
      const src = new Uint32Array(buf.getMappedRange(), 0, words);
      const dst = this.ctl(C.depthBuf) >>> 0, cap = (this.ctl(C.depthCap) >>> 0) / 4;
      const head = 1 + rects.length * 4;
      if (head + words <= cap) {
        const u32 = this.u32(), base = dst >> 2;
        u32[base] = rects.length;
        rects.forEach((r, k) => { u32[base + 1 + k * 4] = r.x; u32[base + 2 + k * 4] = r.y; u32[base + 3 + k * 4] = r.w; u32[base + 4 + k * 4] = r.h; });
        u32.set(src, base + head);
        Atomics.add(this.i32(), (this.ctlPtr >> 2) + C.depthSeq, 1);
      }
      buf.unmap();
      this.depthBusy = false;
    }).catch(() => { this.depthBusy = false; });
  }

  // into the canvas: the largest TV box (4:3, or the race's aspect) in the middle, the rest black
  blit(enc, fr, W, H, W43, wide) {
    const d = this.device;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), ch = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    const aspect = (4 / 3) / (wide ? fr.narrow : 1);
    let bw = cw, bh = ch;
    if (bw > bh * aspect) bw = Math.floor(bh * aspect); else bh = Math.floor(bw / aspect);
    const bx = Math.floor((cw - bw) / 2), by = Math.floor((ch - bh) / 2);
    const from = wide ? 0 : (W - W43) / 2, across = wide ? W : W43;
    const graded = fr.brightness !== 0 || fr.contrast !== 100 || fr.gamma !== 100;
    d.queue.writeBuffer(this.blitUniform, 0, new Float32Array([from / W, 0, across / W, (H * 444 / 448) / H,
      (fr.brightness | 0) / 100, (fr.contrast | 0) / 100 || 1, (fr.gamma | 0) / 100 || 1, graded ? 1 : 0]));
    const smooth = fr.smooth !== 0 ? 'linear' : 'nearest';
    let bg = this.blitGroups[smooth];
    if (!bg) bg = this.blitGroups[smooth] = d.createBindGroup({ layout: this.blitLayout, entries: [
      { binding: 0, resource: this.res.pic.colorView }, { binding: 1, resource: this.samplers[smooth] }, { binding: 2, resource: { buffer: this.blitUniform } }] });
    const bp = enc.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }] });
    // bars beside (or above) the picture: a soft, dimmed copy of it, scaled to cover the canvas and drawn only where the bars are
    if (prefs.blurSides && (bx > 0 || by > 0)) {
      const sx = from / W, sw = across / W, sh = (H * 444 / 448) / H, ca = cw / ch;
      let rect;      // the picture's rect, cropped to the canvas's shape
      if (ca > aspect) { const fh = sh * aspect / ca; rect = [sx, (sh - fh) / 2, sw, fh]; }
      else { const fw = sw * ca / aspect; rect = [sx + (sw - fw) / 2, 0, fw, sh]; }
      d.queue.writeBuffer(this.blitBgUniform, 0, new Float32Array([...rect, 0.06, 0.6, 0, 0]));
      this.blitBgGroup ||= d.createBindGroup({ layout: this.blitLayout, entries: [
        { binding: 0, resource: this.res.pic.colorView }, { binding: 1, resource: this.samplers.linear }, { binding: 2, resource: { buffer: this.blitBgUniform } }] });
      bp.setViewport(0, 0, cw, ch, 0, 1);
      bp.setPipeline(this.blitBgPipeline);
      bp.setBindGroup(0, this.blitBgGroup);
      const bars = bx > 0 ? [[0, 0, bx, ch], [bx + bw, 0, cw - bx - bw, ch]] : [[0, 0, cw, by], [0, by + bh, cw, ch - by - bh]];
      for (const [x, y, w, h] of bars) if (w > 0 && h > 0) { bp.setScissorRect(x, y, w, h); bp.draw(3); }
      bp.setScissorRect(0, 0, cw, ch);
    }
    bp.setViewport(bx, by, bw, bh, 0, 1);
    bp.setPipeline(this.blitPipeline);
    bp.setBindGroup(0, bg);
    bp.draw(3);
    bp.end();
  }
}
