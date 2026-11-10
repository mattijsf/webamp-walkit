// SPDX-License-Identifier: GPL-3.0-or-later

// Reads the packed frame the engine writes (`walkit::packed`, version 3): every window with its
// plan and its commands, of which only the stretches that changed since the frame before cross;
// the reader keeps each window's commands, so a frame that keeps a stretch reuses the very
// objects of the frame before. A command is a plain object with a `k` (kind) and the fields
// the module's documentation names.

const decoder = new TextDecoder();

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = 0;
    this.strings = [];
  }

  u8() {
    return this.b[this.at++];
  }

  i32() {
    const x = this.v.getInt32(this.at, true);
    this.at += 4;
    return x;
  }

  u32() {
    const x = this.v.getUint32(this.at, true);
    this.at += 4;
    return x;
  }

  u64() {
    const x = this.v.getBigUint64(this.at, true);
    this.at += 8;
    return Number(x);
  }

  f32() {
    const x = this.v.getFloat32(this.at, true);
    this.at += 4;
    return x;
  }

  bool() {
    return this.u8() !== 0;
  }

  rect() {
    return { left: this.i32(), top: this.i32(), width: this.i32(), height: this.i32() };
  }

  inlineString() {
    const n = this.i32();
    const s = decoder.decode(this.b.subarray(this.at, this.at + n));
    this.at += n;
    return s;
  }

  header() {
    const magic = decoder.decode(this.b.subarray(0, 4));
    this.at = 4;
    if (magic !== "WKDL") throw new Error("not a walkit packed frame");
    const version = this.i32();
    if (version !== 3) throw new Error(`walkit packed frame version ${version}, expected 3`);
    const n = this.i32();
    this.strings = new Array(n);
    for (let i = 0; i < n; i++) this.strings[i] = this.inlineString();
  }

  string() {
    return this.strings[this.i32()];
  }

  stringOrNull() {
    const i = this.i32();
    return i === -1 ? null : this.strings[i];
  }

  bitmap() {
    const id = this.string();
    const file = this.string();
    const x = this.i32();
    const y = this.i32();
    const w = this.i32();
    const h = this.i32();
    const gammaGroup = this.stringOrNull();
    return { id, file, x, y, w: w < 0 ? null : w, h: h < 0 ? null : h, gammaGroup };
  }

  gamma() {
    if (!this.bool()) return null;
    return { r: this.i32(), g: this.i32(), b: this.i32(), boost: this.i32(), gray: this.i32() };
  }

  image() {
    const bitmap = this.bitmap();
    const dst = this.rect();
    const alpha = this.i32();
    const gamma = this.gamma();
    const smooth = this.bool();
    return { k: "image", bitmap, dst, alpha, gamma, smooth };
  }

  region() {
    const kind = this.u8();
    if (kind === 1) return { k: "pic", image: this.image() };
    if (kind === 2) return { k: "box", rect: this.rect() };
    if (kind === 3) {
      const base = this.bool() ? this.region() : null;
      const add = this.list(() => this.region());
      const keep = this.list(() => this.region());
      const cut = this.list(() => this.region());
      return { k: "op", base, add, keep, cut };
    }
    throw new Error(`walkit packed frame: region kind ${kind}`);
  }

  list(item) {
    const n = this.i32();
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = item();
    return out;
  }

  cmd() {
    const tag = this.u8();
    switch (tag) {
      case 1:
        return this.image();
      case 2:
        return { k: "fill", rect: this.rect(), color: this.i32() & 0xffffff, alpha: this.i32() };
      case 3:
        return { k: "shape", region: this.region() };
      case 4:
        return END_SHAPE;
      case 5: {
        const text = this.string();
        const font = this.bool() ? { id: this.string(), file: this.string() } : null;
        const size = this.i32();
        const color = this.i32() & 0xffffff;
        const rect = this.rect();
        const alpha = this.i32();
        const bold = this.bool();
        let shadow = null;
        let shadowDx = 1;
        let shadowDy = 1;
        if (this.bool()) {
          shadow = this.i32() & 0xffffff;
          shadowDx = this.i32();
          shadowDy = this.i32();
        }
        const x = this.f32();
        const baseline = this.f32();
        return { k: "text", text, font, size, color, rect, alpha, bold, shadow, shadowDx, shadowDy, x, baseline };
      }
      case 6:
        return { k: "bitmaptext", text: this.string(), rect: this.rect() };
      case 7:
        return { k: "clip", rect: this.rect() };
      case 8:
        return UNCLIP;
      case 9: {
        const rect = this.rect();
        const w = this.i32();
        const h = this.i32();
        const alpha = this.i32();
        const stable = this.bool();
        const n = w * h;
        const argb = new Uint32Array(n);
        for (let i = 0; i < n; i++) argb[i] = this.u32();
        return { k: "pixels", rect, w, h, argb, alpha, stable };
      }
      default:
        throw new Error(`walkit packed frame: command tag ${tag}`);
    }
  }

  plan() {
    const id = this.u64();
    const version = this.u64();
    const runs = this.list(() => ({ id: this.u64(), version: this.u64(), from: this.i32(), to: this.i32(), bounds: this.rect() }));
    return { id, version, runs };
  }

  /** A window's commands: as before, or kept and new stretches, in order. */
  commands(before) {
    if (this.u8() === 0) {
      if (!before) throw new Error("walkit packed frame: a window as before, with no frame before");
      return before;
    }
    const out = [];
    let at = 0;
    const segments = this.i32();
    for (let s = 0; s < segments; s++) {
      const kind = this.u8();
      const n = this.i32();
      if (kind === 0) {
        if (!before) throw new Error("walkit packed frame: a stretch kept, with no frame before");
        for (let i = 0; i < n; i++) out.push(before[at + i]);
      } else {
        for (let i = 0; i < n; i++) out.push(this.cmd());
      }
      at += n;
    }
    return out;
  }
}

export const END_SHAPE = Object.freeze({ k: "endshape" });
export const UNCLIP = Object.freeze({ k: "unclip" });

/** Reads frames of one runtime, keeping each window's commands for the next. */
export class FrameReader {
  constructor() {
    this.kept = new Map();
  }

  /** The frame in `bytes`: `{windows: [{id, container, layout, rect, cmds, plan}]}`. */
  decode(bytes) {
    const r = new Reader(bytes);
    r.header();
    const windows = r.list(() => {
      const id = r.i32();
      const container = r.string();
      const layout = r.string();
      const rect = r.rect();
      const plan = r.plan();
      const cmds = r.commands(this.kept.get(id) || null);
      return { id, container, layout, rect, cmds, plan };
    });
    const next = new Map();
    for (const w of windows) next.set(w.id, w.cmds);
    this.kept = next;
    return { windows };
  }
}
