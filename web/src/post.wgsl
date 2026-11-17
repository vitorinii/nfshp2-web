// The renderer's other passes (upstream/recomp/runtime/shaders/native_fold.*, native_post.*): a view of the car's surroundings folded into the sphere
// map, what eDisplayFrame lays over the frame (fog by depth, black and white, the depth of field), and the levels of the scene's copy.

// ---- the fold: RGBA (96, 96, 96, 64), modulated, ALPHA 0x44 over a PSMCT16 map that nothing clears, worked out from a copy of the map
struct FoldU { linear: i32, pad0: i32, pad1: i32, pad2: i32, };
@group(0) @binding(0) var view_tex: texture_2d<f32>;
@group(0) @binding(1) var prev_tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> fu: FoldU;
struct FIn { @location(0) st: vec2<f32>, @location(1) uv: vec2<f32>, };
struct FOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, };

@vertex
fn fold_vs(i: FIn) -> FOut {
  var o: FOut;
  o.pos = vec4<f32>(i.st.x * 2.0 - 1.0, 1.0 - i.st.y * 2.0, 0.0, 1.0);
  o.uv = i.uv;
  return o;
}

// a view is PSMCT16 with TEXA 0, 0x80: its alpha is the bit, 0x80 where something was drawn and 0 where the clear's grey is left
fn ftexel(at_in: vec2<i32>) -> vec4<i32> {
  let size = vec2<i32>(textureDimensions(view_tex, 0));
  let at = clamp(at_in, vec2<i32>(0), size - vec2<i32>(1));
  let t = textureLoad(view_tex, at, 0);
  return vec4<i32>((vec3<i32>(t.rgb * 255.0 + 0.5) / vec3<i32>(8)) * vec3<i32>(8), select(0, 128, t.a > 0.25));
}

@fragment
fn fold_fs(i: FOut) -> @location(0) vec4<f32> {
  var uv = i.uv * vec2<f32>(textureDimensions(view_tex, 0));
  var ct: vec4<i32>;
  if (fu.linear != 0) {
    uv -= vec2<f32>(0.5);
    let f = floor(uv);
    let ii = vec2<i32>(f);
    let w = vec2<i32>((uv - f) * 256.0);
    let t00 = ftexel(ii);
    let t10 = ftexel(ii + vec2<i32>(1, 0));
    let t01 = ftexel(ii + vec2<i32>(0, 1));
    let t11 = ftexel(ii + vec2<i32>(1, 1));
    let top = t00 + (((t10 - t00) * w.x) >> vec4<u32>(8u));
    let bottom = t01 + (((t11 - t01) * w.x) >> vec4<u32>(8u));
    ct = top + (((bottom - top) * w.y) >> vec4<u32>(8u));
  } else {
    ct = ftexel(vec2<i32>(floor(uv)));
  }
  let cs = (ct.rgb * 96) >> vec3<u32>(7u);
  let as_ = (64 * ct.a) >> 7u;
  let cd = vec3<i32>(textureLoad(prev_tex, vec2<i32>(i.pos.xy), 0).rgb * 255.0 + 0.5);
  let o = (((cs - cd) * as_) >> vec3<u32>(7u)) + cd;
  return vec4<f32>(vec3<f32>((o / vec3<i32>(8)) * vec3<i32>(8)) / 255.0, 1.0);
}

// ---- what eDisplayFrame lays over the frame by each pixel's depth or its own colour
struct PostU {
  mode: i32,          // 0 fog, 1 black and white, 3 the depth of field (the port's smooth blur)
  row: i32,           // of the palette image
  size: vec2<f32>,    // the picture
  lod: f32,           // the level of the picture that is one GS pixel a texel
  pad0: f32,
  scale: vec2<f32>,   // the picture's pixels to a GS pixel
  origin: vec2<f32>,  // where the 512 x 448 of the GS start in the picture
  pad1: vec2<f32>,
  rect: vec4<f32>,    // the view in the picture's pixels: left, top, right, bottom
};
@group(0) @binding(0) var depth_tex: texture_depth_2d;
@group(0) @binding(1) var palette: texture_2d<f32>;
@group(0) @binding(2) var scene: texture_2d<f32>;
@group(0) @binding(3) var scene_smp: sampler;
@group(0) @binding(4) var<uniform> pu: PostU;

@vertex
fn post_vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let at = vec2<f32>(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 4.0 - 1.0;
  return vec4<f32>(at, 0.0, 1.0);
}

// Near a Gaussian of sigma 1.41 GS pixels, from the level of the picture that is a GS pixel a texel: 5 x 5 weights as 3 x 3 bilinear taps
fn soft_buffer(fc: vec2<f32>) -> vec3<f32> {
  let off = 1.3208;
  let w0 = 0.3036;
  let w1 = 0.3482;
  let size = vec2<f32>(textureDimensions(scene, 0));
  var sum = vec3<f32>(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let at = clamp(fc + vec2<f32>(f32(i), f32(j)) * off * pu.scale, pu.rect.xy + 0.5, pu.rect.zw - 0.5);
      sum += textureSampleLevel(scene, scene_smp, at / size, pu.lod).rgb * select(w1, w0, i == 0) * select(w1, w0, j == 0);
    }
  }
  return sum;
}

@fragment
fn post_fs(@builtin(position) fc: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = fc.xy / pu.size;
  if (pu.mode == 1) {
    let g = textureSampleLevel(scene, scene_smp, uv, 0.0).g;     // the grey is the green
    return vec4<f32>(g, g, g, 1.0);
  }
  let z = textureLoad(depth_tex, vec2<i32>(fc.xy), 0) * 16777216.0;
  let i = select(i32(z) >> 8u, 255, z > 65535.0);
  var p = textureLoad(palette, vec2<i32>(i, pu.row), 0);
  if (pu.mode == 3) {
    // how much of the blur by depth: between the palette's entries too, not in the 256 steps of Z >> 8
    let next = textureLoad(palette, vec2<i32>(min(i + 1, 255), pu.row), 0);
    p = mix(p, next, select(fract(z / 256.0), 0.0, z > 65535.0));
    let a = min(p.a * 255.0 / 128.0, 1.0);
    return vec4<f32>(soft_buffer(fc.xy) * a, a);
  }
  let a = min(p.a * 255.0 / 128.0, 1.0);
  return vec4<f32>(max(p.rgb * a - 0.49 / 255.0, vec3<f32>(0.0)), a);
}

// ---- a level of the scene's copy from the one above it: the linear filter at the half's texel centres is the 2 x 2 average
@group(0) @binding(0) var down_src: texture_2d<f32>;
@group(0) @binding(1) var down_smp: sampler;
struct DOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, };
@vertex
fn down_vs(@builtin(vertex_index) vi: u32) -> DOut {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  var o: DOut;
  o.pos = vec4<f32>(p, 0.0, 1.0);
  o.uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return o;
}
@fragment
fn down_fs(i: DOut) -> @location(0) vec4<f32> { return textureSampleLevel(down_src, down_smp, i.uv, 0.0); }

// ---- eTransferZBufferRect's rects of the picture's depth, as the GS's PSMZ24 words at each GS pixel's middle (native_vk_depth's sampling)
// params: [n, W, H, -, ox, sx, sy, -] then per rect [x, y, w, h, at, -, -, -] (ox sx sy as float bits)
@group(0) @binding(0) var zdepth: texture_depth_2d;
@group(0) @binding(1) var<storage, read> zp: array<i32>;
@group(0) @binding(2) var<storage, read_write> zout: array<u32>;
@compute @workgroup_size(8, 8, 1)
fn depth_cs(@builtin(global_invocation_id) id: vec3<u32>) {
  let k = i32(id.z);
  if (k >= zp[0]) { return; }
  let b = 8 + k * 8;
  let rx = zp[b]; let ry = zp[b + 1]; let rw = zp[b + 2]; let rh = zp[b + 3]; let at = u32(zp[b + 4]);
  let x = i32(id.x); let y = i32(id.y);
  if (x >= rw || y >= rh) { return; }
  let ox = bitcast<f32>(zp[4]); let sx = bitcast<f32>(zp[5]); let sy = bitcast<f32>(zp[6]);
  let px = clamp(i32(floor(ox + (f32(rx + x) + 0.5) * sx)), 0, zp[1] - 1);
  let py = clamp(i32(floor((f32(ry + y) + 0.5) * sy)), 0, zp[2] - 1);
  let z = textureLoad(zdepth, vec2<i32>(px, py), 0);
  zout[at + u32(y * rw + x)] = min(u32(z * 16777216.0), 0xFFFFFFu);
}
