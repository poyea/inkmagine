// SPDX-License-Identifier: MIT
// Copyright (c) 2026 @poyea

// The WebGPU path: compose, tone, sharpen and ordered screening run as
// compute passes and present straight to a canvas, with no pixel readback in
// the interactive loop. Readback happens only when something needs the bytes
// (export, or the ink-coverage readout).

import { BLIT_WGSL, COMPOSE_WGSL, SHARPEN_WGSL, SCREEN_WGSL, PRESENT_WGSL } from './shaders.js';
import { initGpu, gpuState } from './device.js';
import { linear, invertLinear } from '../transform.js';
import { thresholdMatrix, algorithm } from '../dither.js';

const WG = 8; // workgroup edge, must match @workgroup_size in the shaders
const ROW_ALIGN = 256; // copyTextureToBuffer bytesPerRow requirement

export class GpuRenderer {
  constructor(device, format, canvas) {
    this.device = device;
    this.format = format;
    this.canvas = canvas;
    this.context = canvas.getContext('webgpu');
    this.context.configure({ device, format, alphaMode: 'opaque' });

    this.width = 0;
    this.height = 0;
    this.source = null;
    this.srcTexture = null;
    this.mipCount = 1;
    this.matrixId = null;
    this.dirty = true;

    this.linearSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.nearestSampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

    this.composeParams = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sharpenParams = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.screenParams = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.composeScratch = new ArrayBuffer(80);
    this.sharpenScratch = new ArrayBuffer(32);
    this.screenScratch = new ArrayBuffer(32);

    const blit = device.createShaderModule({ code: BLIT_WGSL });
    this.blitPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: blit, entryPoint: 'vs' },
      fragment: { module: blit, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });

    const present = device.createShaderModule({ code: PRESENT_WGSL });
    this.presentPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: present, entryPoint: 'vs' },
      fragment: { module: present, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });

    this.composePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: COMPOSE_WGSL }), entryPoint: 'main' },
    });
    this.sharpenPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: SHARPEN_WGSL }), entryPoint: 'main' },
    });
    this.screenPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: SCREEN_WGSL }), entryPoint: 'main' },
    });

    // Bound even when unused, so the screen bind group layout is always valid.
    this.matrixBuffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.matrixSize = 1;
    this.device.queue.writeBuffer(this.matrixBuffer, 0, new Float32Array([0.5]));
  }

  static async create(canvas) {
    const device = await initGpu();
    if (!device) return null;
    try {
      return new GpuRenderer(device, gpuState().format, canvas);
    } catch (err) {
      console.warn('[inkmagine] GPU renderer unavailable:', err);
      return null;
    }
  }

  // --- resources -----------------------------------------------------------

  setSource(source) {
    if (this.source === source) return;
    this.srcTexture?.destroy();
    this.srcTexture = null;
    this.source = source;
    if (!source) return;

    const { width: w, height: h, base } = source;
    this.mipCount = 1 + Math.floor(Math.log2(Math.max(w, h)));
    this.srcTexture = this.device.createTexture({
      size: [w, h, 1],
      format: 'rgba8unorm',
      mipLevelCount: this.mipCount,
      usage: GPUTextureUsage.TEXTURE_BINDING
        | GPUTextureUsage.COPY_DST
        | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source: base, flipY: false },
      { texture: this.srcTexture, premultipliedAlpha: false },
      [w, h],
    );
    this.generateMips();
    this.dirty = true;
  }

  generateMips() {
    const encoder = this.device.createCommandEncoder({ label: 'mips' });
    for (let level = 1; level < this.mipCount; level++) {
      const srcView = this.srcTexture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
      const dstView = this.srcTexture.createView({ baseMipLevel: level, mipLevelCount: 1 });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: dstView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      });
      pass.setPipeline(this.blitPipeline);
      pass.setBindGroup(0, this.device.createBindGroup({
        layout: this.blitPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: this.linearSampler },
        ],
      }));
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  resize(width, height) {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;

    for (const key of ['toneTex', 'sharpTex', 'outTex']) {
      this[key]?.destroy();
    }
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    const make = (extra = 0) => this.device.createTexture({
      size: [width, height, 1],
      format: 'rgba8unorm',
      usage: usage | extra,
    });
    this.toneTex = make();
    this.sharpTex = make();
    this.outTex = make(GPUTextureUsage.COPY_SRC);

    // Destroying a buffer with a mapAsync in flight would reject that read.
    // Dropping the reference is enough; the GC reclaims it once the map ends.
    if (!this.reading) this.readBuffer?.destroy();
    this.readValid = false;
    this.bytesPerRow = Math.ceil((width * 4) / ROW_ALIGN) * ROW_ALIGN;
    this.readBuffer = this.device.createBuffer({
      size: this.bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.readCache = new Uint8ClampedArray(width * height);
    this.dirty = true;
  }

  useMatrix(algoId) {
    if (this.matrixId === algoId) return;
    const { size, data } = thresholdMatrix(algoId);
    this.matrixBuffer?.destroy();
    // Storage buffer bindings must be a multiple of 4 bytes; f32 already is.
    this.matrixBuffer = this.device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.matrixBuffer, 0, data);
    this.matrixSize = size;
    this.matrixId = algoId;
  }

  // --- rendering -----------------------------------------------------------

  /**
   * @param {object} source
   * @param {object} geo
   * @param {{width:number,height:number,matte:number,tone:object,screen:object}} settings
   */
  render(source, geo, settings) {
    const { width, height, matte, tone, screen: screenOpts } = settings;
    this.setSource(source);
    this.resize(width, height);

    const spec = algorithm(screenOpts.algo);
    const mode = spec.kind === 'none' ? 0 : spec.kind === 'threshold' ? 1 : 2;
    if (mode === 2) this.useMatrix(screenOpts.algo);

    this.writeComposeParams(source, geo, settings);
    this.writeSharpenParams(tone);
    this.writeScreenParams(screenOpts, mode);

    const encoder = this.device.createCommandEncoder({ label: 'render' });
    const groupsX = Math.ceil(width / WG);
    const groupsY = Math.ceil(height / WG);

    const compute = (pipeline, entries) => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries,
      }));
      pass.dispatchWorkgroups(groupsX, groupsY);
      pass.end();
    };

    // A source is optional: with none loaded the compose pass fills the matte.
    const srcView = (this.srcTexture || this.blankTexture()).createView();
    compute(this.composePipeline, [
      { binding: 0, resource: srcView },
      { binding: 1, resource: this.linearSampler },
      { binding: 2, resource: this.toneTex.createView() },
      { binding: 3, resource: { buffer: this.composeParams } },
    ]);

    const sharpened = tone.sharpen > 0;
    if (sharpened) {
      compute(this.sharpenPipeline, [
        { binding: 0, resource: this.toneTex.createView() },
        { binding: 1, resource: this.sharpTex.createView() },
        { binding: 2, resource: { buffer: this.sharpenParams } },
      ]);
    }

    compute(this.screenPipeline, [
      { binding: 0, resource: (sharpened ? this.sharpTex : this.toneTex).createView() },
      { binding: 1, resource: this.outTex.createView() },
      { binding: 2, resource: { buffer: this.screenParams } },
      { binding: 3, resource: { buffer: this.matrixBuffer } },
    ]);

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
      }],
    });
    pass.setPipeline(this.presentPipeline);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this.presentPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.outTex.createView() },
        { binding: 1, resource: this.nearestSampler },
      ],
    }));
    pass.draw(3);
    pass.end();

    this.device.queue.submit([encoder.finish()]);
    this.dirty = true;
    return { width, height, backend: 'gpu' };
  }

  writeComposeParams(source, geo, settings) {
    const { width, height, matte, tone } = settings;
    const inv = invertLinear(linear(geo));
    const srcW = source ? source.width : 1;
    const srcH = source ? source.height : 1;
    // Zoom below 1:1 means reading from a smaller mip.
    const lod = geo.scale > 0 ? Math.log2(1 / geo.scale) : 0;

    const f = new Float32Array(this.composeScratch);
    f[0] = inv.a; f[1] = inv.b; f[2] = inv.c; f[3] = inv.d;
    f[4] = geo.cx; f[5] = geo.cy;
    f[6] = width; f[7] = height;
    f[8] = srcW; f[9] = srcH;
    f[10] = clamp(lod, 0, Math.max(0, this.mipCount - 1));
    f[11] = matte ? 1 : 0;
    // Neutral with no source, matching CpuRenderer.render(): there is nothing
    // to shape, and inverting a bare matte would render the plate solid.
    f[12] = source ? tone.brightness : 0;
    f[13] = source ? tone.contrast : 1;
    f[14] = source ? 1 / (tone.gamma || 1) : 1;
    f[15] = source && tone.invert ? 1 : 0;
    f[16] = geo.scale;        // edge feather width, in output pixels
    f[17] = source ? 1 : 0;   // without this a bare ink matte renders mid grey
    f[18] = 0; f[19] = 0;
    this.device.queue.writeBuffer(this.composeParams, 0, this.composeScratch);
  }

  writeSharpenParams(tone) {
    const passes = Math.max(1, Math.round(tone.radius || 1));
    const sigma = Math.sqrt(0.5 * passes);
    const view = new DataView(this.sharpenScratch);
    view.setUint32(0, this.width, true);
    view.setUint32(4, this.height, true);
    view.setInt32(8, Math.min(4, Math.ceil(3 * sigma)), true);
    view.setFloat32(12, tone.sharpen, true);
    view.setFloat32(16, sigma, true);
    this.device.queue.writeBuffer(this.sharpenParams, 0, this.sharpenScratch);
  }

  writeScreenParams(opts, mode) {
    const steps = Math.max(2, opts.levels) - 1;
    const view = new DataView(this.screenScratch);
    view.setUint32(0, this.width, true);
    view.setUint32(4, this.height, true);
    view.setUint32(8, this.matrixSize, true);
    view.setUint32(12, mode, true);
    view.setFloat32(16, steps, true);
    view.setFloat32(20, opts.strength, true);
    view.setFloat32(24, opts.bias, true);
    this.device.queue.writeBuffer(this.screenParams, 0, this.screenScratch);
  }

  blankTexture() {
    if (!this._blank) {
      this._blank = this.device.createTexture({
        size: [1, 1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.device.queue.writeTexture(
        { texture: this._blank },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        [1, 1, 1],
      );
    }
    return this._blank;
  }

  /**
   * Pull the rendered plate back as greyscale bytes. Only called for exports
   * and the coverage readout, never per frame.
   * @returns {Promise<Uint8ClampedArray>}
   */
  async readback() {
    if (!this.outTex || !this.readBuffer) return new Uint8ClampedArray(0);
    if (!this.dirty && this.readValid) return this.readCache;
    // mapAsync throws if the buffer is already mapped, so overlapping callers
    // (export fired while the coverage readout is in flight) share one map.
    if (this.reading) return this.reading;
    this.reading = this.doReadback().finally(() => { this.reading = null; });
    return this.reading;
  }

  async doReadback() {
    // Snapshot everything: a resize during the await would otherwise leave us
    // unmapping a different buffer and copying with mismatched strides.
    const buffer = this.readBuffer;
    const { width, height, bytesPerRow } = this;
    const out = this.readCache;

    const encoder = this.device.createCommandEncoder({ label: 'readback' });
    encoder.copyTextureToBuffer(
      { texture: this.outTex },
      { buffer, bytesPerRow, rowsPerImage: height },
      [width, height, 1],
    );
    this.device.queue.submit([encoder.finish()]);

    await buffer.mapAsync(GPUMapMode.READ);
    const raw = new Uint8Array(buffer.getMappedRange());
    for (let y = 0; y < height; y++) {
      const rowStart = y * bytesPerRow;
      const outStart = y * width;
      for (let x = 0; x < width; x++) {
        out[outStart + x] = raw[rowStart + x * 4]; // r == g == b
      }
    }
    buffer.unmap();

    if (buffer === this.readBuffer) {
      this.dirty = false;
      this.readValid = true;
    }
    return out;
  }

  destroy() {
    this.srcTexture?.destroy();
    this.toneTex?.destroy();
    this.sharpTex?.destroy();
    this.outTex?.destroy();
    this.readBuffer?.destroy();
    this._blank?.destroy();
  }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
