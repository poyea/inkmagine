// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// WGSL sources for the GPU path. Kept as plain strings so the site needs no
// build step and no extra fetches.

/** Fullscreen triangle used by the mip blit and the final present pass. */
const FULLSCREEN_VS = /* wgsl */ `
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  // One oversized triangle covering the viewport.
  var xy = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  let p = xy[i];
  var out: VsOut;
  out.pos = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}
`;

export const BLIT_WGSL = /* wgsl */ `
${FULLSCREEN_VS}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  return textureSample(src, samp, in.uv);
}
`;

/**
 * Compose + tone. Samples the source through its mip chain using an LOD
 * derived from the zoom, converts to luma, then applies the tone curve.
 */
export const COMPOSE_WGSL = /* wgsl */ `
struct Params {
  inv: vec4<f32>,        // inverse 2x2 of rotate.mirror.scale, row-major
  centre: vec2<f32>,     // source pixel parked at the frame centre
  outSize: vec2<f32>,
  srcSize: vec2<f32>,
  lod: f32,
  matte: f32,
  brightness: f32,
  contrast: f32,
  invGamma: f32,
  invert: f32,
  edge: f32,             // output pixels per source pixel, for edge coverage
  present: f32,          // 1 when a source is loaded, 0 for bare matte
  // Uniform structs round up to 16 bytes; spell the tail out so the JS side
  // and the shader agree on an 80-byte block.
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> p: Params;

const LUMA = vec3<f32>(0.2126, 0.7152, 0.0722);

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dim = vec2<u32>(p.outSize);
  if (gid.x >= dim.x || gid.y >= dim.y) { return; }

  // Output pixel centre, relative to the middle of the frame.
  let o = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5) - p.outSize * 0.5;
  let s = p.centre + vec2<f32>(
    p.inv.x * o.x + p.inv.y * o.y,
    p.inv.z * o.x + p.inv.w * o.y,
  );

  var value = p.matte;
  // Antialias the image border so a rotated edge matches the 2D path.
  let inset = min(min(s.x, p.srcSize.x - s.x), min(s.y, p.srcSize.y - s.y));
  let cover = clamp(inset * p.edge + 0.5, 0.0, 1.0) * p.present;
  if (cover > 0.0) {
    let uv = s / p.srcSize;
    let texel = textureSampleLevel(src, samp, uv, p.lod);
    // Straight (un-premultiplied) alpha, so a transparent PNG composites onto
    // the matte the same way the 2D path does.
    value = mix(p.matte, dot(texel.rgb, LUMA), cover * texel.a);
  }

  value = (value + p.brightness - 0.5) * p.contrast + 0.5;
  value = clamp(value, 0.0, 1.0);
  value = pow(value, p.invGamma);
  value = mix(value, 1.0 - value, p.invert);

  textureStore(dst, vec2<i32>(gid.xy), vec4<f32>(value, value, value, 1.0));
}
`;

/**
 * Unsharp mask in a single pass. The CPU path repeats a 1-2-1 blur, whose
 * variance is 0.5 per pass, so sigma = sqrt(0.5 * passes) matches it.
 */
export const SHARPEN_WGSL = /* wgsl */ `
struct Params {
  outSize: vec2<u32>,
  radius: i32,
  amount: f32,
  sigma: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> p: Params;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= p.outSize.x || gid.y >= p.outSize.y) { return; }
  let here = vec2<i32>(gid.xy);
  let last = vec2<i32>(p.outSize) - vec2<i32>(1, 1);
  let centre = textureLoad(src, here, 0).r;

  var sum = 0.0;
  var weight = 0.0;
  let denom = 2.0 * p.sigma * p.sigma;
  for (var dy = -p.radius; dy <= p.radius; dy = dy + 1) {
    for (var dx = -p.radius; dx <= p.radius; dx = dx + 1) {
      let w = exp(-f32(dx * dx + dy * dy) / denom);
      let at = clamp(here + vec2<i32>(dx, dy), vec2<i32>(0, 0), last);
      sum = sum + textureLoad(src, at, 0).r * w;
      weight = weight + w;
    }
  }

  let blurred = sum / weight;
  let v = clamp(centre + p.amount * (centre - blurred), 0.0, 1.0);
  textureStore(dst, here, vec4<f32>(v, v, v, 1.0));
}
`;

/**
 * Ordered screening and quantisation. Error diffusion is not here on purpose:
 * it is sequential and belongs on the CPU.
 */
export const SCREEN_WGSL = /* wgsl */ `
struct Params {
  outSize: vec2<u32>,
  matSize: u32,
  mode: u32,        // 0 = passthrough, 1 = hard threshold, 2 = ordered
  steps: f32,       // levels - 1
  strength: f32,
  bias: f32,
  _pad: f32,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> p: Params;
// Not named "matrix": that is on WGSL's reserved-word list.
@group(0) @binding(3) var<storage, read> thresholds: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= p.outSize.x || gid.y >= p.outSize.y) { return; }
  let here = vec2<i32>(gid.xy);
  var v = textureLoad(src, here, 0).r + p.bias;

  if (p.mode == 2u) {
    let mx = gid.x % p.matSize;
    let my = gid.y % p.matSize;
    let t = thresholds[my * p.matSize + mx];
    v = v + p.strength * (t - 0.5) / p.steps;
  }

  var out = clamp(v, 0.0, 1.0);
  if (p.mode != 0u) {
    out = round(out * p.steps) / p.steps;
  }

  textureStore(dst, here, vec4<f32>(out, out, out, 1.0));
}
`;

export const PRESENT_WGSL = /* wgsl */ `
${FULLSCREEN_VS}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  return textureSample(src, samp, in.uv);
}
`;
