// SPDX-License-Identifier: GPL-3.0-or-later

// Draws a frame of the engine on a 2D canvas: each window into a separate layer at the
// page's scale, masked by its shape, then onto the stack. Pictures come from the skin's files
// as `pictures.mjs` decodes them, tinted as a color theme asks (`Gamma::apply` of the engine),
// and kept per file and tint; text is drawn with the fonts the page registered.

import { decodePicture } from "./pictures.mjs";

/** A path as the engine spells it: lowercase, forward slashes, no leading `./`. */
export function normalize(path) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/**
 * The folder of an archive that holds the skin, as the engine's `skin_folder` finds it: the one
 * with `skin.xml`, else the one with a classic skin's `main.bmp` (`""` at the root); null when
 * there is neither.
 */
export function skinFolder(names) {
  const normalized = [...names].map(normalize);
  for (const file of ["skin.xml", "main.bmp"]) {
    if (normalized.includes(file)) return "";
    const n = normalized.find((x) => x.endsWith(`/${file}`));
    if (n !== undefined) return n.slice(0, -file.length);
  }
  return null;
}

/** `entries` with the skin's folder stripped from their paths, as the engine reads them. */
export function inSkinFolder(entries) {
  const folder = skinFolder(entries.keys());
  if (!folder) return entries;
  const out = new Map();
  for (const [name, data] of entries) {
    const key = normalize(name);
    if (key.startsWith(folder)) out.set(key.slice(folder.length), data);
  }
  return out;
}

/** `argb` tinted, as the engine's `Gamma::apply`. */
export function tint(argb, g) {
  let red = (argb >>> 16) & 0xff;
  let green = (argb >>> 8) & 0xff;
  let blue = argb & 0xff;
  if (g.gray !== 0) {
    red = g.gray === 2 ? Math.trunc((red + green + blue) / 3) : Math.max(red, green, blue);
    green = red;
    blue = red;
  }
  const lifted = (c) => (g.boost === 1 ? c / 2 + 128 : g.boost === 2 ? (c + 32) * 4 : c);
  const ch = (c, f) => Math.min(255, Math.max(0, Math.trunc(lifted(c) * (1 + f / 4096))));
  return ((argb & 0xff000000) | (ch(red, g.r) << 16) | (ch(green, g.g) << 8) | ch(blue, g.b)) >>> 0;
}

/**
 * The picture a made-up name asks for (`$solid/<rrggbb><aa>/<w>x<h>.png`, as the engine's
 * `generated` module spells one color), or null for a real file.
 */
export function solid(key) {
  const m = /^\$solid\/([0-9a-f]{6})([0-9a-f]{2})\/(\d+)x(\d+)\.png$/.exec(key);
  if (!m) return null;
  const w = Number(m[3]);
  const h = Number(m[4]);
  const argb = ((parseInt(m[2], 16) << 24) | parseInt(m[1], 16)) >>> 0;
  return { w, h, argb: new Uint32Array(w * h).fill(argb) };
}

function gammaKey(g) {
  return g ? `${g.r},${g.g},${g.b},${g.boost},${g.gray}` : "";
}

function isIdentity(g) {
  return !g || (g.r === 0 && g.g === 0 && g.b === 0 && g.gray === 0 && g.boost === 0);
}

function colorOf(rgb) {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, "0")}`;
}

/** A canvas of `w` x `h` device pixels. */
function surface(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

/** The box a drawing command paints in, or null for one that paints nothing itself (a clip, a shape's ends). */
export function cmdRect(c) {
  switch (c.k) {
    case "image":
      return c.dst;
    case "fill":
    case "text":
    case "pixels":
    case "bitmaptext":
      return c.rect;
    default:
      return null;
  }
}

/** Whether box `r` (or a command with no box) reaches into `part`. */
/**
 * `r` (layout pixels, either way round) with its edges on whole device pixels at `scale`: an
 * edge between pixels takes in a sliver of the bitmap next to the one drawn.
 */
function onPixels(r, scale) {
  const x0 = Math.round(Math.min(r.left, r.left + r.width) * scale);
  const y0 = Math.round(Math.min(r.top, r.top + r.height) * scale);
  const x1 = Math.round(Math.max(r.left, r.left + r.width) * scale);
  const y1 = Math.round(Math.max(r.top, r.top + r.height) * scale);
  return [x0 / scale, y0 / scale, (x1 - x0) / scale, (y1 - y0) / scale];
}

function meets(r, part) {
  if (!r) return true;
  const left = Math.min(r.left, r.left + r.width);
  const top = Math.min(r.top, r.top + r.height);
  return (
    left < part.left + part.width &&
    part.left < left + Math.abs(r.width) &&
    top < part.top + part.height &&
    part.top < top + Math.abs(r.height)
  );
}

/** A canvas holding `argb` (`w` x `h`, rows top first), optionally only where a pixel is opaque. */
function canvasOf(w, h, argb, hard = false) {
  return fillCanvas(surface(w, h), argb, hard);
}

/** Writes `argb` into canvas `c`, which is as large as the picture. */
function fillCanvas(c, argb, hard = false) {
  const w = c.width;
  const h = c.height;
  const ctx = c.getContext("2d");
  // a canvas filled again and again keeps its pixel buffer
  const img = c.pixelBuffer ?? ctx.createImageData(w, h);
  c.pixelBuffer = img;
  const d = img.data;
  for (let i = 0, j = 0; i < argb.length; i++, j += 4) {
    const v = argb[i];
    const a = v >>> 24;
    d[j] = (v >>> 16) & 0xff;
    d[j + 1] = (v >>> 8) & 0xff;
    d[j + 2] = v & 0xff;
    d[j + 3] = hard ? (a >= 128 ? 255 : 0) : a;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * The pictures of a stack of files (the skin's over the wasabi base's), decoded ahead so the
 * engine's questions (a picture's size, its pixels) are answered at once.
 */
export class Pictures {
  /** `elsewhere(file)` answers a path the stack has no picture for (a sibling skin's), with a picture or null. */
  constructor(elsewhere = () => null) {
    this.pics = new Map();
    this.canvases = new Map();
    this.elsewhere = elsewhere;
  }

  /** Decodes every picture in `entries` (path -> bytes) that an earlier layer did not give. */
  async add(entries, inflate) {
    const wanted = [...entries].filter(([name]) => /\.(png|bmp|gif)$/i.test(name) && !this.pics.has(normalize(name)));
    const pics = await Promise.all(wanted.map(([, data]) => decodePicture(data, inflate)));
    wanted.forEach(([name], i) => {
      const key = normalize(name);
      if (pics[i] && !this.pics.has(key)) this.pics.set(key, pics[i]);
    });
  }

  get(file) {
    const key = normalize(file);
    let p = this.pics.get(key);
    if (p === undefined) {
      p = solid(key) || this.elsewhere(key) || null;
      this.pics.set(key, p);
    }
    return p;
  }

  size(file) {
    const p = this.get(file);
    return p ? [p.w, p.h] : null;
  }

  pixels(file, x, y, w, h) {
    const p = this.get(file);
    if (!p) return null;
    const out = new Uint32Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const px = x + i;
        const py = y + j;
        out[j * w + i] = px >= 0 && py >= 0 && px < p.w && py < p.h ? p.argb[py * p.w + px] : 0;
      }
    }
    return out;
  }

  /** The picture as a canvas, tinted by `gamma`, opaque pixels only when `hard`; null when the skin has no such file. */
  canvas(file, gamma, hard = false) {
    const p = this.get(file);
    if (!p) return null;
    const key = `${normalize(file)}|${isIdentity(gamma) ? "" : gammaKey(gamma)}|${hard ? "h" : ""}`;
    let c = this.canvases.get(key);
    if (!c) {
      let argb = p.argb;
      if (!isIdentity(gamma)) {
        argb = new Uint32Array(p.argb.length);
        for (let i = 0; i < argb.length; i++) argb[i] = tint(p.argb[i], gamma);
      }
      c = canvasOf(p.w, p.h, argb, hard);
      this.canvases.set(key, c);
    }
    return c;
  }
}

/** The font the page draws `font` (the engine's, or null for the default) with, as a CSS family. */
export function familyOf(font, families) {
  if (!font) return families.get("") || "sans-serif";
  const byFile = font.file ? families.get(normalize(font.file)) : null;
  if (byFile) return byFile;
  const byId = families.get(`id:${font.id.toLowerCase()}`);
  if (byId) return byId;
  return families.get("") || "sans-serif";
}

/**
 * The em in pixels of a text the engine sizes `size`: a skin's `fontsize`, which Winamp draws at
 * three quarters, rounded to whole pixels as Windows sizes fonts (Big Bento's 14 draws at 11).
 */
export const emPixels = (size) => Math.round((size * 3) / 4);

/** Draws frames. `families` maps a font file (normalized) or `id:<name>` to a CSS family. */
export class Renderer {
  constructor(pictures, families) {
    this.pictures = pictures;
    this.families = families;
    this.layers = new Map();
    // the commands each layer was drawn from
    this.drawn = new Map();
    // a window's shape as a mask, by the region it was made from and its size
    this.masks = new WeakMap();
    // the canvas each size of changing pixels (a vis) is written into, frame after frame
    this.scratch = new Map();
  }

  fontOf(cmd) {
    return `${cmd.bold ? "bold " : ""}${emPixels(cmd.size)}px ${JSON.stringify(familyOf(cmd.font, this.families))}`;
  }

  /**
   * Draws `frame`'s windows onto `ctx` at `scale` (device pixels per skin pixel), the stack's
   * corner at the canvas's.
   */
  draw(ctx, frame, scale) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    for (const w of frame.windows) {
      const r = w.rect;
      if (r.width <= 0 || r.height <= 0) continue;
      // a window whose commands are the frame reader's same array as last time drew nothing
      // new: its layer is blitted where it is now, as during a drag
      const had = this.layers.get(w.id);
      const layer = this.layer(w.id, r.width, r.height, scale);
      if (layer !== had || this.drawn.get(w.id) !== w.cmds) {
        this.drawWindow(layer, w.cmds, r.width, r.height, scale);
        this.drawn.set(w.id, w.cmds);
      }
      ctx.drawImage(layer, Math.round(r.left * scale), Math.round(r.top * scale));
    }
    ctx.restore();
  }

  layer(id, w, h, scale) {
    const pw = Math.ceil(w * scale);
    const ph = Math.ceil(h * scale);
    let l = this.layers.get(id);
    if (!l || l.width !== pw || l.height !== ph) {
      l = surface(pw, ph);
      this.layers.set(id, l);
    }
    return l;
  }

  /** One window's commands into `layer`, a canvas of its size at `scale`. */
  drawWindow(layer, cmds, w, h, scale, part = null) {
    const ctx = layer.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    // only `part` (layout pixels) drawn again: everything else on the layer stays
    ctx.save();
    // what is cleared, in layout pixels: `part` and a device pixel round it, so every command
    // reaching into that margin is drawn again too (the picture under a hovered menu item)
    let cleared = null;
    if (part) {
      const x0 = Math.max(0, Math.floor(part.left * scale) - 1);
      const y0 = Math.max(0, Math.floor(part.top * scale) - 1);
      const x1 = Math.min(layer.width, Math.ceil((part.left + part.width) * scale) + 1);
      const y1 = Math.min(layer.height, Math.ceil((part.top + part.height) * scale) + 1);
      cleared = { left: x0 / scale, top: y0 / scale, width: (x1 - x0) / scale, height: (y1 - y0) / scale };
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip();
      ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    } else {
      ctx.clearRect(0, 0, layer.width, layer.height);
    }
    ctx.save();
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = false;
    let depth = 0;
    let shape = null;
    for (const c of cmds) {
      if (cleared && !meets(cmdRect(c), cleared)) continue;
      switch (c.k) {
        case "shape":
          // what follows is masked by the region at the end
          shape = c.region;
          break;
        case "endshape":
          break;
        case "clip":
          ctx.save();
          depth++;
          ctx.beginPath();
          ctx.rect(...onPixels(c.rect, scale));
          ctx.clip();
          break;
        case "unclip":
          if (depth > 0) {
            ctx.restore();
            depth--;
          }
          break;
        case "image":
          this.image(ctx, c, scale);
          break;
        case "fill":
          ctx.globalAlpha = c.alpha / 255;
          ctx.fillStyle = colorOf(c.color);
          ctx.fillRect(...onPixels(c.rect, scale));
          ctx.globalAlpha = 1;
          break;
        case "text":
          this.text(ctx, c, scale);
          break;
        case "pixels":
          this.pixels(ctx, c, scale);
          break;
        default:
          break;
      }
    }
    while (depth-- > 0) ctx.restore();
    ctx.restore();
    if (shape) {
      const mask = this.mask(shape, w, h, scale);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(mask, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  image(ctx, c, scale) {
    const d = c.dst;
    if (d.width <= 0 || d.height <= 0) return;
    const src = this.pictures.canvas(c.bitmap.file, c.gamma);
    if (!src) return;
    const b = c.bitmap;
    const sw = b.w === null ? src.width - b.x : b.w;
    const sh = b.h === null ? src.height - b.y : b.h;
    if (sw <= 0 || sh <= 0) return;
    ctx.globalAlpha = c.alpha / 255;
    ctx.imageSmoothingEnabled = !!c.smooth;
    ctx.drawImage(src, b.x, b.y, sw, sh, ...onPixels(d, scale));
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
  }

  text(ctx, c, scale) {
    const r = c.rect;
    ctx.save();
    ctx.beginPath();
    ctx.rect(...onPixels(r, scale));
    ctx.clip();
    ctx.font = this.fontOf(c);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.globalAlpha = c.alpha / 255;
    if (c.shadow !== null) {
      ctx.fillStyle = colorOf(c.shadow);
      ctx.fillText(c.text, c.x + c.shadowDx, c.baseline + c.shadowDy);
    }
    ctx.fillStyle = colorOf(c.color);
    ctx.fillText(c.text, c.x, c.baseline);
    ctx.restore();
  }

  pixels(ctx, c, scale) {
    if (c.rect.width <= 0 || c.rect.height <= 0 || c.w <= 0 || c.h <= 0) return;
    let src = c.stable ? c.canvas : null;
    if (!src && c.stable) {
      src = c.canvas = canvasOf(c.w, c.h, c.argb);
    } else if (!src) {
      const key = `${c.w}x${c.h}`;
      src = this.scratch.get(key);
      if (!src) this.scratch.set(key, (src = surface(c.w, c.h)));
      fillCanvas(src, c.argb);
    }
    ctx.globalAlpha = c.alpha / 255;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, c.w, c.h, ...onPixels(c.rect, scale));
    ctx.globalAlpha = 1;
  }

  /** A window's shape as a mask canvas: opaque where the window shows. */
  mask(region, w, h, scale) {
    const key = `${w}x${h}@${scale}`;
    const kept = this.masks.get(region);
    if (kept && kept.key === key) return kept.mask;
    const m = surface(Math.ceil(w * scale), Math.ceil(h * scale));
    this.masks.set(region, { key, mask: m });
    const ctx = m.getContext("2d");
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = false;
    this.region(ctx, region, false, w, h, scale);
    return m;
  }

  /** Draws `region` into `ctx`. */
  region(ctx, region, hard, w, h, scale) {
    switch (region.k) {
      case "pic": {
        const img = region.image;
        const src = this.pictures.canvas(img.bitmap.file, img.gamma, hard);
        if (!src) return;
        const b = img.bitmap;
        const sw = b.w === null ? src.width - b.x : b.w;
        const sh = b.h === null ? src.height - b.y : b.h;
        if (sw <= 0 || sh <= 0 || img.dst.width <= 0 || img.dst.height <= 0) return;
        ctx.drawImage(src, b.x, b.y, sw, sh, ...onPixels(img.dst, scale));
        return;
      }
      case "box":
        ctx.fillStyle = "#000";
        ctx.fillRect(...onPixels(region.rect, scale));
        return;
      case "op": {
        if (region.base) this.region(ctx, region.base, hard, w, h, scale);
        if (region.keep.length) this.blended(ctx, "destination-in", w, h, scale, (c) => region.keep.forEach((r) => this.region(c, r, true, w, h, scale)));
        for (const a of region.add) {
          if (a.k === "op" && (a.keep.length || a.cut.length)) this.blended(ctx, "source-over", w, h, scale, (c) => this.region(c, a, hard, w, h, scale));
          else this.region(ctx, a, hard, w, h, scale);
        }
        if (region.cut.length) this.blended(ctx, "destination-out", w, h, scale, (c) => region.cut.forEach((r) => this.region(c, r, true, w, h, scale)));
        return;
      }
      default:
        return;
    }
  }

  /** Runs `body` on a fresh layer of the window's size and merges it into `ctx` with `op`. */
  blended(ctx, op, w, h, scale, body) {
    const l = surface(Math.ceil(w * scale), Math.ceil(h * scale));
    const lc = l.getContext("2d");
    lc.scale(scale, scale);
    lc.imageSmoothingEnabled = false;
    body(lc);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = op;
    ctx.drawImage(l, 0, 0);
    ctx.restore();
  }
}
