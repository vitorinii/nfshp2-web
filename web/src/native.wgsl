// The native renderer's scene shaders (upstream/recomp/runtime/shaders/native.vert, native.frag) in WGSL: what VU1's strip programs did to a vertex,
// and the GS's sampling and TFX on its bytes. A strip is drawn up to three times: pass 0 the strip, 1 the road's specular, 2 the sphere map.
// The per-draw constants are P[instance_index] (WebGPU has no push constants; each pass is drawn as instance n of one).

struct Push {
  clip: mat4x4<f32>,
  scroll: vec2<f32>,
  alpha_test: f32,    // 1: the GS's alpha GREATER 0x30, AFAIL KEEP
  blend_alpha: f32,   // >= 0: the blend's fixed factor; -1 As; -2 no blending; -3 the frame's alpha; -4 the mask for -3's lerp
  textured: f32,
  light: i32,         // into L, -1: none
  flags: i32,         // vi07: 0x80 light, 0x40 road, 0x100 sphere map, 4 gloss map in alpha
  pass_: i32,
  tfx: i32,
  lod_l: f32,
  bits16: i32,        // the target is PSMCT16 (the envmap views)
  tex_mode: i32,      // 1 repeat s, 2 repeat t, 4 mag linear, 8 min linear, 16 mip linear, 64 its own envmap; from bit 8 the last level
  snap: vec2<f32>,    // half the target in GS pixels, if the vertices are to land on the GS's sixteenths of a pixel
  pad: vec2<f32>,
};

@group(0) @binding(0) var tex: texture_2d<f32>;
@group(1) @binding(0) var<storage, read> P: array<Push>;
// VU1 memory from 860 (eLightContext) and from 848 (the material), by quads, for each light of the frame
@group(1) @binding(1) var<storage, read> L: array<vec4<f32>>;

override ALPHA_TEST: bool = true;     // false for the pipelines of draws without the test: no discard, the early depth test kept

const COLOUR = 0; const DIR = 4; const EYE = 12; const ENV = 14; const MAT = 18; const QUADS = 22;
// VU1's fast inverse root, from its memory at 668
const ROOT_P = -0.5;

fn root_b() -> f32 { return bitcast<f32>(0x4ebe6189i); }
// VU1's fast power: m x^p as the float whose bits are p bits(x) + b
fn fast_pow(x: f32, p: f32, b: f32) -> f32 { return bitcast<f32>(i32(f32(bitcast<i32>(x)) * p + b)); }

struct VIn {
  @location(0) pos: vec3<f32>,
  @location(1) col: vec4<f32>,
  @location(2) st: vec2<f32>,
  @location(3) nrm: vec4<f32>,
  @location(4) w: f32,
  @builtin(instance_index) inst: u32,
};

struct VOut {
  @builtin(position) @invariant pos: vec4<f32>,
  @location(0) @interpolate(linear) col: vec4<f32>,   // the GS's colour is linear on the screen
  @location(1) st: vec2<f32>,
  @location(2) k: f32,
  @location(3) far: f32,
  @location(4) cw: f32,                               // clip w, perspective-interpolated: 1 / gl_FragCoord.w
  @location(5) @interpolate(flat) inst: u32,
};

@vertex
fn vs(v: VIn) -> VOut {
  let u = P[v.inst];
  var gp = u.clip * vec4<f32>(v.pos, 1.0) * v.w;
  // VU1 adds X / W to 2^19 as a float, which leaves four bits of fraction
  if (u.snap.x > 0.0 && gp.w > 0.0) {
    var px = (gp.xy / gp.w + 1.0) * u.snap;
    px = floor(px * 16.0 + 0.5) / 16.0;
    gp = vec4<f32>((px / u.snap - 1.0) * gp.w, gp.z, gp.w);
  }
  var o: VOut;
  o.k = v.nrm.w * 127.0 / 16.0;
  o.far = gp.z;
  var col = v.col * 255.0;
  var st = v.st + u.scroll;
  if (u.light >= 0 && (u.flags & 0x1c0) != 0) {
    let b = u.light * QUADS;
    let m0 = L[b + MAT];
    let diffuse = L[b + MAT + 1];
    let specular = L[b + MAT + 2];
    let gloss = L[b + MAT + 3];
    // vuiCalculateReflectionVectorsAndDecompressNormals: the length is VU1's fast inverse root, not an exact one
    let n = v.nrm.xyz;
    let vv = v.pos - L[b + EYE].xyz;
    var r = vv - n * (2.0 * dot(vv, n));
    r = r * fast_pow(dot(r, r), ROOT_P, root_b());
    let ld = L[b + DIR].xyz * n.x + L[b + DIR + 1].xyz * n.y + L[b + DIR + 2].xyz * n.z;
    let ls = L[b + DIR].xyz * r.x + L[b + DIR + 1].xyz * r.y + L[b + DIR + 2].xyz * r.z;
    let has_gloss = (u.flags & 4) != 0;
    let power = select(m0.xy, gloss.xy, has_gloss);
    var s = max(ls, vec3<f32>(m0.z));
    s = vec3<f32>(fast_pow(s.x, power.x, power.y), fast_pow(s.y, power.x, power.y), fast_pow(s.z, power.x, power.y));
    var lit = col.rgb;
    if ((u.flags & 0x80) != 0) {
      // vuiReferenceLighter; ftoi0 leaves whole numbers
      let d = max(ld, vec3<f32>(0.0));
      var c = L[b + COLOUR + 3].xyz;
      var a = L[b + COLOUR + 3].w;
      c += L[b + COLOUR + 0].xyz * diffuse.xyz * d.x + L[b + COLOUR + 0].xyz * specular.xyz * s.x;
      a += L[b + COLOUR + 0].w * d.x;
      c += L[b + COLOUR + 1].xyz * diffuse.xyz * d.y + L[b + COLOUR + 1].xyz * specular.xyz * s.y;
      a += L[b + COLOUR + 1].w * d.y;
      c += L[b + COLOUR + 2].xyz * diffuse.xyz * d.z + L[b + COLOUR + 2].xyz * specular.xyz * s.z;
      a += L[b + COLOUR + 2].w * d.z;
      let mix_ = 1.0 + (col.rgb - 255.0) * m0.w;
      lit = floor(clamp(c * mix_, vec3<f32>(0.0), vec3<f32>(255.0)));
      col = vec4<f32>(lit, floor(clamp(select(a, gloss.z + gloss.w * s.x, has_gloss), 0.0, 255.0)));
    }
    // vuiReferenceRoadSpecularBasePass: the frame's alpha for the second pass
    if ((u.flags & 0x40) != 0) {
      let sr = max(ls, vec3<f32>(m0.z));
      col.a = floor(clamp(gloss.z + gloss.w * fast_pow(sr.x, gloss.x, gloss.y), 0.0, 255.0));
    }
    if (u.pass_ == 2) {
      // vuiSphericalEnvMapper: x and z of the matrix negated. RGBAQ takes the low byte of the alpha, whatever it came to
      let neg = vec3<f32>(-1.0, 1.0, -1.0);
      let e0 = L[b + ENV].xyz * neg;
      let e1 = L[b + ENV + 1].xyz * neg;
      let e2 = L[b + ENV + 2].xyz * neg;
      let q = e0 * r.x + e1 * r.y + e2 * r.z;
      let h = q + vec3<f32>(0.0, 0.0, 1.0);
      st = q.xy * fast_pow(dot(h, h), ROOT_P, root_b()) * 0.5 + 0.5;
      col = vec4<f32>(select(vec3<f32>(128.0), lit, has_gloss), f32(i32(diffuse.w + specular.w * q.z) & 255));
    }
  }
  o.col = col / 255.0;
  o.st = st;
  o.cw = gp.w;
  o.inst = v.inst;
  o.pos = vec4<f32>(gp.x, -gp.y, gp.z, gp.w);     // Vulkan's clip space has y down, WebGPU's up
  return o;
}

// The GS's sampling, integers and all
fn texel(u: Push, level: i32, at_in: vec2<i32>, size: vec2<i32>) -> vec4<i32> {
  var at = at_in;
  if ((u.tex_mode & 1) != 0) { at.x = at.x & (size.x - 1); } else { at.x = clamp(at.x, 0, size.x - 1); }
  if ((u.tex_mode & 2) != 0) { at.y = at.y & (size.y - 1); } else { at.y = clamp(at.y, 0, size.y - 1); }
  var t = vec4<i32>(textureLoad(tex, at, level) * 255.0 + 0.5);
  if (u.pass_ == 2 && (u.tex_mode & 64) == 0) { t = vec4<i32>((t.rgb / vec3<i32>(8)) * vec3<i32>(8), t.a); }    // the sphere map keeps 5 bits
  return t;
}

fn sample_level(u: Push, level: i32, uv_in: vec2<f32>, linear: bool) -> vec4<i32> {
  let size = vec2<i32>(textureDimensions(tex, level));
  var uv = uv_in / f32(1 << u32(level));
  if (!linear) { return texel(u, level, vec2<i32>(floor(uv)), size); }
  uv -= vec2<f32>(0.5);
  let f = floor(uv);
  let i = vec2<i32>(f);
  let w = vec2<i32>((uv - f) * 256.0);
  let t00 = texel(u, level, i, size);
  let t10 = texel(u, level, i + vec2<i32>(1, 0), size);
  let t01 = texel(u, level, i + vec2<i32>(0, 1), size);
  let t11 = texel(u, level, i + vec2<i32>(1, 1), size);
  let top = t00 + (((t10 - t00) * w.x) >> vec4<u32>(8u));
  let bottom = t01 + (((t11 - t01) * w.x) >> vec4<u32>(8u));
  return top + (((bottom - top) * w.y) >> vec4<u32>(8u));
}

fn sample_tex(u: Push, st: vec2<f32>, lod: f32) -> vec4<f32> {
  let uv = st * vec2<f32>(textureDimensions(tex, 0));
  let mxl = min(u.tex_mode >> 8u, i32(textureNumLevels(tex)) - 1);
  let min_linear = (u.tex_mode & 8) != 0;
  var t: vec4<i32>;
  if (lod <= 0.0) {
    t = sample_level(u, 0, uv, (u.tex_mode & 4) != 0);
  } else if (mxl == 0) {
    t = sample_level(u, 0, uv, min_linear);
  } else if ((u.tex_mode & 16) == 0) {
    t = sample_level(u, min(i32(lod + 0.5), mxl), uv, min_linear);
  } else {
    let l0 = min(i32(lod), mxl);
    t = sample_level(u, l0, uv, min_linear);
    if (l0 != mxl) {
      let t1 = sample_level(u, l0 + 1, uv, min_linear);
      t += ((t1 - t) * i32((lod - f32(l0)) * 256.0)) >> vec4<u32>(8u);
    }
  }
  return vec4<f32>(t);
}

@fragment
fn fs(i: VOut) -> @location(0) vec4<f32> {
  let u = P[i.inst];
  if (i.far < 0.0) { discard; }               // past the far plane: the depth clamp would have kept it
  let c = floor(i.col * 255.0 + 0.01);
  var rgb: vec3<f32>;
  var a8: f32;
  if (u.textured > 0.5) {
    // the GS's level goes by Q alone: (log2(1 / Q) << L) + K, and Q is 1 / w
    var lod = 0.0;
    if (u.pass_ != 2) { lod = log2(i.cw) * exp2(u.lod_l) + select(0.0, i.k, u.pass_ == 0); }
    var t = sample_tex(u, i.st, lod);
    // the sphere map: its alpha is 1. The showroom's own map (bit 64) is 32 bits, and its alpha goes into As as any texture's
    if (u.pass_ == 2 && (u.tex_mode & 64) == 0) { t.a = 128.0; }
    if (u.tfx == 1) {                   // DECAL
      rgb = t.rgb / 255.0;
      a8 = t.a;
    } else if (u.tfx >= 2) {            // HIGHLIGHT, HIGHLIGHT2
      rgb = min(floor(c.rgb * t.rgb / 128.0) + c.a, vec3<f32>(255.0)) / 255.0;
      a8 = select(t.a, min(t.a + c.a, 255.0), u.tfx == 2);
    } else {
      rgb = min(floor(c.rgb * t.rgb / 128.0), vec3<f32>(255.0)) / 255.0;
      a8 = min(floor(c.a * t.a / 128.0), 255.0);
    }
  } else {
    rgb = c.rgb / 255.0;
    a8 = c.a;
  }
  if (ALPHA_TEST && u.alpha_test > 0.5 && a8 <= 48.0) { discard; }
  if (u.bits16 != 0) {                  // what such a target keeps
    rgb = floor(rgb * 255.0 / 8.0 + 1e-3) * 8.0 / 255.0;
    if (u.blend_alpha < -1.5) { a8 = 128.0; }
  }
  // The frame's alpha holds As as it is, a byte. Cs Ad, with 0x80 as 1.0, comes to twice Cs Ad / 256: drawn twice, -3.
  if (u.blend_alpha < -3.5) {
    return vec4<f32>(rgb, min(a8 / 128.0, 1.0));
  } else if (u.blend_alpha < -2.5) {
    return vec4<f32>(rgb * (255.0 / 256.0), 0.0);
  } else if (u.blend_alpha < -1.5) {
    return vec4<f32>(rgb, a8 / 255.0);
  }
  // the factor can go past 1 on the GS: the colour takes it whole, the blend's alpha what fits. ... >> 7 + Cd: the GS rounds down
  let f = select(u.blend_alpha, a8 / 128.0, u.blend_alpha < 0.0);
  return vec4<f32>(max(rgb * f - 0.49 / 255.0, vec3<f32>(0.0)), min(f, 1.0));
}

// ---- the picture into the canvas: a box of the canvas, a rect of the picture, filtered by the setting
// the picture's rect, 0..1: x, y, w, h; the settings' brightness (added), contrast (around the middle grey) and gamma (native_grade.frag)
struct Blit { src: vec4<f32>, grade: vec4<f32>, };
@group(0) @binding(0) var pic: texture_2d<f32>;
@group(0) @binding(1) var pic_smp: sampler;
@group(0) @binding(2) var<uniform> blit: Blit;
struct BOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, };
@vertex
fn blit_vs(@builtin(vertex_index) vi: u32) -> BOut {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  var o: BOut;
  o.pos = vec4<f32>(p, 0.0, 1.0);
  o.uv = blit.src.xy + vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5) * blit.src.zw;
  return o;
}
@fragment
fn blit_fs(i: BOut) -> @location(0) vec4<f32> {
  var rgb = textureSampleLevel(pic, pic_smp, i.uv, 0.0).rgb;
  if (blit.grade.w > 0.5) {
    rgb = clamp((rgb - 0.5) * blit.grade.y + 0.5 + blit.grade.x, vec3<f32>(0.0), vec3<f32>(1.0));
    rgb = pow(rgb, vec3<f32>(1.0 / blit.grade.z));
  }
  return vec4<f32>(rgb, 1.0);
}
// the bars beside a picture that does not fill the canvas: a soft, dimmed copy of it. Here src is the picture's rect scaled to cover the
// whole canvas; grade.x is the blur's radius (a fraction of the picture's height), grade.y the share of the light kept. 24 taps on a golden
// spiral, each kept inside the rect (its edge colour spreads; the black beyond the picture never bleeds in).
@fragment
fn blit_bg_fs(i: BOut) -> @location(0) vec4<f32> {
  let size = vec2<f32>(textureDimensions(pic, 0));
  let lo = blit.src.xy;
  let hi = blit.src.xy + blit.src.zw;
  let radius = blit.grade.x * size.y;
  var sum = vec3<f32>(0.0);
  for (var k = 0; k < 24; k++) {
    let a = f32(k) * 2.39996323;
    let r = sqrt((f32(k) + 0.5) / 24.0) * radius;
    let at = clamp(i.uv + vec2<f32>(cos(a), sin(a)) * r / size, lo, hi);
    sum += textureSampleLevel(pic, pic_smp, at, 0.0).rgb;
  }
  return vec4<f32>(sum / 24.0 * blit.grade.y, 1.0);
}
