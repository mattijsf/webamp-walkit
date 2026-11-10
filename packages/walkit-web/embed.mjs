// SPDX-License-Identifier: GPL-3.0-or-later

// The engine for a page that brings a player and places the windows: load it once, open a skin
// archive, and each frame tick it, take its windows and paint each one on a canvas.
//
//   const walkit = await loadWalkit({
//     invalidate() {},                  // something changed: draw a frame soon
//     windowOpen(kind) { return null }, // "doublesize", "ontop", "pl", "eq": true, false or null
//     player(command, value) {},        // a button for the page's player (see Walkit.hostedRuntime)
//     action(action, param, from) {},   // MENU, CLOSE, PLAYLIST, ...; from: {rect, point} in the viewport
//   });                                 // the module next to this file, or { wasm: url } after
//   const skin = await walkit.openSkin(skinBytes, { base, wasabi });  // base under a .wsz, wasabi under a .wal
//   skin.rt.setFree(true, innerWidth, innerHeight);
//   // each animation frame:
//   skin.rt.setPlayerState({ status: "playing", positionMs, lengthMs, title });
//   if (skin.tick(performance.now())) for (const w of skin.windows()) skin.paint(canvasOf(w.id), w, devicePixelRatio);
//
// `player` and `action` run once the engine call that raised them has returned, so a handler
// may call back into the engine. One skin draws at a time.

import { Walkit } from "./walkit.mjs";
import { FrameReader } from "./frame.mjs";
import { Pictures, Renderer, emPixels, normalize, inSkinFolder, familyOf, cmdRect } from "./render.mjs";
import { unzipAsync } from "./zip.mjs";
import { SkinCursors } from "./cursor.mjs";

async function inflateWith(format, bytes) {
  const stream = new DecompressionStream(format);
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
const inflate = (b) => inflateWith("deflate", b);
const inflateRaw = (b) => inflateWith("deflate-raw", b);

async function bytesOf(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  const r = await fetch(source);
  if (!r.ok) throw new Error(`walkit: ${source}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

const isClassic = (names) => names.has("main.bmp") && !names.has("skin.xml");

// where the engine names the files of what lies under the skin (walkit::files::BASE_PREFIX)
const BASE_PREFIX = "wasabi-base/";

// the free fonts that stand in for the Windows fonts skins name
const STAND_INS = {
  arial: "fonts/liberationsans.ttf",
  "arial black": "fonts/liberationsans.ttf",
  tahoma: "fonts/liberationsans.ttf",
  verdana: "fonts/dejavusanscondensed.ttf",
  "ms sans serif": "fonts/liberationsans.ttf",
  "microsoft sans serif": "fonts/liberationsans.ttf",
  "trebuchet ms": "fonts/dejavusanscondensed.ttf",
};

// the commands that only mark out the drawing: when one of them changes, everything is drawn again
const FRAMING = new Set(["clip", "unclip", "shape", "endshape"]);
const NOTHING = Object.freeze({ left: 0, top: 0, width: 0, height: 0 });

/**
 * The box (layout pixels) covering what changed between two drawings of a window: NOTHING
 * when nothing did, null when the whole window should be drawn again (the commands differ in
 * number or in framing, or the change covers most of it).
 */
function changedPart(before, after, rect) {
  if (before.length !== after.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < after.length; i++) {
    const a = before[i];
    const b = after[i];
    if (a === b) continue;
    if (a.k !== b.k || FRAMING.has(b.k)) return null;
    for (const r of [cmdRect(a), cmdRect(b)]) {
      if (!r) return null;
      left = Math.min(left, r.left, r.left + r.width);
      top = Math.min(top, r.top, r.top + r.height);
      right = Math.max(right, r.left, r.left + r.width);
      bottom = Math.max(bottom, r.top, r.top + r.height);
    }
  }
  if (left === Infinity) return NOTHING;
  const part = { left, top, width: right - left, height: bottom - top };
  return part.width * part.height > rect.width * rect.height * 0.6 ? null : part;
}

/**
 * Loads the engine with the page's `handlers`, from `walkit.wasm` next to this file unless
 * `wasm` names another URL or gives the module's bytes.
 */
export async function loadWalkit(handlers = {}, { wasm = new URL("./walkit.wasm", import.meta.url) } = {}) {
  const embed = new Embed(handlers);
  await embed.load(await bytesOf(wasm));
  return embed;
}

class Embed {
  constructor(handlers) {
    this.handlers = handlers;
    this.pictures = null;
    this.classic = false;
    this.fonts = new Map();
    this.skinFiles = new Map();
    this.families = new Map([["", "Arial"]]);
    this.registered = new Set();
    this.measures = new Map();
    this.bases = new Map();
    this.measure = document.createElement("canvas").getContext("2d");
  }

  // the engine measures the same text on every redraw; the browser would lay it out again each time
  measured(key, measure) {
    if (this.measures.has(key)) return this.measures.get(key);
    if (this.measures.size > 20000) this.measures.clear();
    const value = measure();
    this.measures.set(key, value);
    return value;
  }

  /**
   * What lies under a skin (a base skin, the wasabi base), opened once: its files in the engine,
   * its pictures decoded. An archive is kept by its source; path -> bytes is opened each time.
   */
  baseLayer(source) {
    const open = async () => {
      const entries = source instanceof Map ? source : inSkinFolder(await unzipAsync(await bytesOf(source), inflateRaw));
      const pictures = new Pictures();
      await pictures.add(entries, inflate);
      return { pics: pictures.pics, id: this.w.filesFrom(entries) };
    };
    if (source instanceof Map) return open();
    if (!this.bases.has(source)) this.bases.set(source, open());
    return this.bases.get(source);
  }

  /** Replaces the page's handlers, as when another part of the page takes the engine over. */
  setHandlers(handlers) {
    this.handlers = handlers;
  }

  /** Registers `bytes` as the font family named by its normalized path, once. */
  async registerFont(path, bytes) {
    const key = normalize(path);
    if (this.registered.has(key)) return;
    this.registered.add(key);
    try {
      const face = new FontFace(key, bytes);
      await face.load();
      document.fonts.add(face);
      this.families.set(key, key);
      this.measures.clear();
    } catch {
      this.registered.delete(key);
    }
  }

  /**
   * The stand-in fonts (path -> bytes, `fonts/LiberationSans.ttf` and the like) a modern skin
   * lays its text out with where it names a Windows font.
   */
  async addFonts(fonts) {
    for (const [path, bytes] of fonts) {
      this.fonts.set(normalize(path), bytes);
      await this.registerFont(path, bytes);
    }
    for (const [id, file] of Object.entries(STAND_INS)) {
      if (this.families.has(file)) this.families.set(`id:${id}`, file);
    }
    if (this.families.has(STAND_INS.arial)) this.families.set("", STAND_INS.arial);
    this.measures.clear();
  }

  cssFont(name, size, bold) {
    const [id, file] = name ? name.split("|") : ["", ""];
    const family = familyOf(name ? { id, file } : null, this.families);
    return `${bold ? "bold " : ""}${emPixels(size)}px ${JSON.stringify(family)}`;
  }

  async load(wasm) {
    const later = (f) => queueMicrotask(f);
    const h = () => this.handlers;
    this.w = await Walkit.load(wasm, {
      imageSize: (f) => this.pictures?.size(f) ?? null,
      pixels: (f, x, y, w, ht) => this.pictures?.pixels(f, x, y, w, ht) ?? null,
      textWidth: (text, font, size, bold) =>
        this.measured(`w${font}|${size}|${bold}|${text}`, () => {
          this.measure.font = this.cssFont(font, size, bold);
          return Math.round(this.measure.measureText(text).width);
        }),
      lineMetrics: (font, size, bold) =>
        this.measured(`m${font}|${size}|${bold}`, () => {
          this.measure.font = this.cssFont(font, size, bold);
          const m = this.measure.measureText("Hg");
          return m.fontBoundingBoxAscent ? [m.fontBoundingBoxAscent, m.fontBoundingBoxDescent] : null;
        }),
      fontFile: (file) => this.skinFiles.get(normalize(file)) ?? this.fonts.get(normalize(file)) ?? null,
      log: (line) => h().log?.(line),
      invalidate: () => h().invalidate?.(),
      windowOpen: (kind) => h().windowOpen?.(kind) ?? null,
      chooseFromMenu: () => null,
      windowsChanged: (ids) => later(() => h().windowsChanged?.(ids)),
      hostAction: (action, param, from) => later(() => h().action?.(action, param, from)),
      player: (command, value) => later(() => h().player?.(command, value)),
    });
  }

  /**
   * Opens a skin archive (a URL, an ArrayBuffer or bytes). What lies under it is an archive like
   * the skin (kept once opened) or path -> bytes, and depends on the skin's own files: under a
   * classic skin (.wsz) `base`, a classic base skin (such as Winamp's base skin) that gives every
   * bitmap the skin leaves out, as Winamp takes them from its base skin; under a modern skin
   * (.wal) `wasabi`, Winamp's wasabi base, with the fonts given to `addFonts`. The other one is
   * not used. On the page's player unless `demoPlayer`.
   */
  async openSkin(source, { name = "skin", wasabi = null, base = null, demoPlayer = false } = {}) {
    const entries = inSkinFolder(await unzipAsync(await bytesOf(source), inflateRaw));
    const names = new Set([...entries.keys()].map(normalize));
    const classic = isClassic(names);
    const underSource = classic ? base : wasabi;
    const pictures = new Pictures();
    const [under] = await Promise.all([underSource ? this.baseLayer(underSource) : null, pictures.add(entries, inflate)]);
    // the engine names the files under the skin by the prefix, as every host reads them
    for (const [key, pic] of under?.pics ?? []) pictures.pics.set(BASE_PREFIX + key, pic);
    this.pictures = pictures;
    this.classic = classic;
    this.measures.clear();
    // the engine has the archive; the page keeps only the fonts it may ask for again
    this.skinFiles = new Map(
      [...entries].filter(([path]) => /\.(ttf|otf)$/i.test(path)).map(([path, bytes]) => [normalize(path), bytes]),
    );
    for (const [path, bytes] of entries) {
      if (/\.ttf$/i.test(path)) await this.registerFont(path, bytes);
    }
    const stack = this.w.stack(this.w.filesFrom(entries), under ? under.id : -1);
    const make = demoPlayer ? "runtime" : "hostedRuntime";
    const rt = this.w[make](stack, name, false, performance.now());
    rt.load();
    const families = this.families;
    const renderer = new Renderer(pictures, families);
    return new Skin(rt, renderer, this.classic);
  }
}

/**
 * An open skin: its runtime (`rt`, see `Runtime` in walkit.mjs), whether it is a classic
 * skin, and its windows to paint.
 */
// the runtime's calls that change what the skin shows: each wakes the next `tick`
const CHANGES = [
  "setPlayerState", "setPlaylist", "setVis", "pointerDown", "pointerMove", "pointerUp", "doubleTap",
  "rightClick", "openWindow", "closeWindow", "placeWindow", "resizeWindow", "setWindowLayout",
  "setWindowScale", "setWindowTitle", "setFree", "setView", "setTimeRemaining", "setEqAuto",
  "setPlaylistSelection", "scrollPlaylist", "wheelPlaylist", "setListFontSize", "setClassicStyle",
  "selectTheme", "player",
];

export class Skin {
  constructor(rt, renderer, classic) {
    for (const name of CHANGES) {
      const call = rt[name].bind(rt);
      rt[name] = (...args) => {
        this.dirty = true;
        return call(...args);
      };
    }
    this.rt = rt;
    this.cursors = new SkinCursors(rt);
    this.classic = classic;
    this.renderer = renderer;
    this.reader = new FrameReader();
    this.painted = new WeakMap();
    this.dueAt = 0;
    this.shown = [];
    this.dirty = true;
  }

  /**
   * Steps the clock to `now` (ms); whether the windows need painting again. Until the engine
   * has something due, or `invalidate` says the page changed something, it costs nothing.
   */
  tick(now) {
    if (!this.dirty && now < this.dueAt) return false;
    this.rt.setNow(now);
    const changed = this.rt.tick() || this.dirty;
    this.dirty = false;
    if (changed) this.shown = this.moved(this.rt.placedOnly()) ?? this.reader.decode(this.rt.drawFrame(now)).windows;
    this.dueAt = this.rt.nextDueAt() ?? Infinity;
    return changed;
  }

  /** The windows shown, at the places `placed` gives, or null when they are not the same windows. */
  moved(placed) {
    if (!placed || placed.length !== this.shown.length) return null;
    const out = [];
    for (let i = 0; i < placed.length; i++) {
      const w = this.shown[i];
      if (w.id !== placed[i].id) return null;
      out.push({ ...w, rect: placed[i].rect });
    }
    return out;
  }

  /** The windows on screen, bottom to top: `{id, container, layout, rect}`, rect in the viewport. */
  windows() {
    return this.shown;
  }

  /** Asks for the windows again on the next `tick`: after the page changed the player, a window or the input. */
  invalidate() {
    this.dirty = true;
  }

  /**
   * Paints `window` on `canvas` at `scale` device pixels per skin pixel, its corner at the
   * canvas's: only the part whose drawing changed since the canvas last showed this window.
   */
  paint(canvas, window, scale = 1) {
    const last = this.painted.get(canvas);
    const same = last && last.scale === scale && last.w === canvas.width && last.h === canvas.height;
    if (same && last.cmds === window.cmds) return;
    const part = same ? changedPart(last.cmds, window.cmds, window.rect) : null;
    this.painted.set(canvas, { cmds: window.cmds, scale, w: canvas.width, h: canvas.height });
    if (part === NOTHING) return;
    // a window's canvas is its layer: drawn straight into, nothing to copy
    this.renderer.drawWindow(canvas, window.cmds, window.rect.width, window.rect.height, scale, part);
  }

  free() {
    this.rt.free();
  }
}
