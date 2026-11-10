// SPDX-License-Identifier: GPL-3.0-or-later

// The JS side of the wasm module: loads it with the imports a host provides, moves strings and
// bytes across, and wraps the exports (see crates/walkit-web/src/lib.rs for the surface).
//
// A host gives `imports`: `decode(file, bytes)` -> {w, h, argb: Uint32Array} or null,
// `textWidth(text, font, size, bold)`, `lineMetrics(font, size, bold)` -> [ascent, descent] or
// null, `imageSize(file)` -> [w, h] or null, `pixels(file, x, y, w, h)` -> Uint32Array or null,
// `fontFile(file)` -> Uint8Array or null, `log(text)`, `invalidate()`, `windowOpen(kind)` ->
// true/false/null, `chooseFromMenu(text)` -> id or null, `windowsChanged(ids)`,
// `hostAction(action, param, from)` (from: `{rect: [x, y, w, h], point: [x, y] | null}` in the stack, or null), `player(cmd, arg)`, and `now()` in ms. Everything is optional; what is missing
// answers nothing.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class Walkit {
  /**
   * Instantiates the module from `wasmBytes` with the host `imports`.
   */
  static async load(wasmBytes, imports = {}) {
    const w = new Walkit();
    w.host = imports;
    const { instance } = await WebAssembly.instantiate(wasmBytes, { host: w.imports() });
    w.x = instance.exports;
    return w;
  }

  get memory() {
    return this.x.memory;
  }

  bytes(ptr, len) {
    return new Uint8Array(this.memory.buffer, ptr, len);
  }

  /** Copies `data` (a Uint8Array or a string) into the module; the caller frees it. */
  put(data) {
    const b = typeof data === "string" ? encoder.encode(data) : data;
    const ptr = this.x.wk_alloc(b.length);
    this.bytes(ptr, b.length).set(b);
    return [ptr, b.length];
  }

  free(ptr, len) {
    this.x.wk_free(ptr, len);
  }

  /** The last result the module gave, as a copy of its bytes. */
  resultBytes() {
    return this.bytes(this.x.wk_result_ptr(), this.x.wk_result_len()).slice();
  }

  /** The last result's text. */
  result() {
    return decoder.decode(this.bytes(this.x.wk_result_ptr(), this.x.wk_result_len()));
  }

  /** The last run's timing JSON, parsed. */
  stats() {
    return JSON.parse(decoder.decode(this.bytes(this.x.wk_stats_ptr(), this.x.wk_stats_len())));
  }

  text(ptr, len) {
    return decoder.decode(this.bytes(ptr, len));
  }

  /** Runs `f(ptr, len)` with `s` in the module's memory, then frees it. */
  withString(s, f) {
    const [p, n] = this.put(s);
    try {
      return f(p, n);
    } finally {
      this.free(p, n);
    }
  }

  /** A files set from an object or Map of path -> Uint8Array; the skin's folder stripped. */
  filesFrom(entries) {
    const id = this.x.wk_files_new();
    for (const [path, bytes] of entries instanceof Map ? entries : Object.entries(entries)) {
      const [pp, pn] = this.put(path);
      const [bp, bn] = this.put(bytes);
      this.x.wk_files_add(id, pp, pn, bp, bn);
      this.free(bp, bn);
      this.free(pp, pn);
    }
    this.x.wk_files_strip_folder(id);
    return id;
  }

  /**
   * A stack: the skin's files over its base (or -1: the wasabi base under a modern skin, a base
   * skin under a classic one), with siblings {name: filesId}.
   */
  stack(skinId, baseId = -1, siblings = {}) {
    const id = this.x.wk_stack_new(skinId, baseId);
    for (const [name, files] of Object.entries(siblings)) {
      this.withString(name, (p, n) => this.x.wk_stack_sibling(id, p, n, files));
    }
    return id;
  }

  /** Records a scenario (its spec text) on a stack: {text, stats}. */
  record(stackId, fontsId, spec) {
    const ok = this.withString(spec, (p, n) => this.x.wk_record(stackId, fontsId, p, n));
    if (!ok) throw new Error("record failed");
    return { text: this.result(), stats: this.stats() };
  }

  /** A runtime the page drives; see `Runtime`. */
  runtime(stackId, skinName, haveLibrary = true, startMs = Date.now()) {
    const id = this.withString(skinName, (p, n) => this.x.wk_rt_new(stackId, p, n, haveLibrary ? 1 : 0, startMs));
    if (id < 0) throw new Error("no such stack");
    return new Runtime(this, id);
  }

  /**
   * A runtime on the page's player instead of the demo one: the page tells it the player's
   * state (`setPlayerState`, `setPlaylist`, `setVis`) and hears each button through the
   * `player(command, value)` import: play, pause, stop, next, previous, eject, play_track
   * (index), seek (ms), volume (0..255), pan (-127..127), shuffle, repeat, eq (0/1), preamp
   * and band0..band9 (0..255).
   */
  hostedRuntime(stackId, skinName, haveLibrary = true, startMs = Date.now()) {
    const id = this.withString(skinName, (p, n) => this.x.wk_rt_new_hosted(stackId, p, n, haveLibrary ? 1 : 0, startMs));
    if (id < 0) throw new Error("no such stack");
    return new Runtime(this, id);
  }

  imports() {
    const h = this.host;
    const str = (p, n) => this.text(p, n);
    const u32 = (ptr, len) => new Uint32Array(this.memory.buffer, ptr, len);
    return {
      host_perf_now: () => (h.now ? h.now() : performance.now()),
      host_decode: (fp, fn, bp, bn, out) => {
        if (!h.decode) return 0;
        const pic = h.decode(str(fp, fn), this.bytes(bp, bn));
        if (!pic) return 0;
        const n = pic.w * pic.h;
        const ptr = this.x.wk_alloc(n * 4);
        u32(ptr, n).set(pic.argb);
        const o = u32(out, 3);
        o[0] = pic.w;
        o[1] = pic.h;
        o[2] = ptr;
        return 1;
      },
      host_text_width: (tp, tn, fp, fn, size, bold) => (h.textWidth ? h.textWidth(str(tp, tn), str(fp, fn), size, !!bold) : 0),
      host_line_metrics: (fp, fn, size, bold, out) => {
        const m = h.lineMetrics ? h.lineMetrics(str(fp, fn), size, !!bold) : null;
        if (!m) return 0;
        const o = new Float32Array(this.memory.buffer, out, 2);
        o[0] = m[0];
        o[1] = m[1];
        return 1;
      },
      host_image_size: (fp, fn, out) => {
        const s = h.imageSize ? h.imageSize(str(fp, fn)) : null;
        if (!s) return 0;
        const o = new Int32Array(this.memory.buffer, out, 2);
        o[0] = s[0];
        o[1] = s[1];
        return 1;
      },
      host_pixels: (fp, fn, x, y, w, ht, out) => {
        const px = h.pixels ? h.pixels(str(fp, fn), x, y, w, ht) : null;
        if (!px) return 0;
        u32(out, w * ht).set(px);
        return 1;
      },
      host_font_file: (fp, fn, out) => {
        const b = h.fontFile ? h.fontFile(str(fp, fn)) : null;
        if (!b) return 0;
        const [p, n] = this.put(b);
        const o = u32(out, 2);
        o[0] = p;
        o[1] = n;
        return 1;
      },
      host_log: (p, n) => h.log && h.log(str(p, n)),
      host_invalidate: () => h.invalidate && h.invalidate(),
      host_window_open: (p, n) => {
        const r = h.windowOpen ? h.windowOpen(str(p, n)) : null;
        return r === true ? 1 : r === false ? 0 : -1;
      },
      host_choose_from_menu: (p, n) => {
        const r = h.chooseFromMenu ? h.chooseFromMenu(str(p, n)) : 0;
        return r === null || r === undefined ? -1 : r;
      },
      host_windows_changed: (p, n) => h.windowsChanged && h.windowsChanged(str(p, n).split(",").filter(Boolean).map(Number)),
      host_host_action: (ap, an, pp, pn, fp) => {
        if (!h.hostAction) return;
        const f = new Int32Array(this.memory.buffer, fp, 8);
        const from = f[0] ? { rect: [f[1], f[2], f[3], f[4]], point: f[5] ? [f[6], f[7]] : null } : null;
        h.hostAction(str(ap, an), str(pp, pn), from);
      },
      host_player: (cp, cn, arg) => h.player && h.player(str(cp, cn), arg),
    };
  }
}

const EMPTY = new Float32Array(0);
const STATUS = { stopped: 0, playing: 1, paused: 2 };
const PLAYER_DEFAULTS = {
  status: "stopped",
  positionMs: 0,
  lengthMs: 0,
  title: "",
  trackIndex: 0,
  kbps: 0,
  khz: 0,
  channels: 2,
  volume: 200,
  pan: 0,
  shuffle: false,
  repeat: false,
  eqOn: false,
  preamp: 128,
  bands: [128, 128, 128, 128, 128, 128, 128, 128, 128, 128],
};

/** A runtime the page drives: the clock stepped by the page, the draw list out as text. */
export class Runtime {
  constructor(w, id) {
    this.w = w;
    this.id = id;
  }

  load() {
    this.w.x.wk_rt_load(this.id);
  }

  setNow(ms) {
    this.w.x.wk_rt_set_now(this.id, ms);
  }

  tick() {
    return this.w.x.wk_rt_tick(this.id) !== 0;
  }

  /** The draw list as text, one command per line in the trace format. */
  draw() {
    this.w.x.wk_rt_draw(this.id);
    return this.w.result();
  }

  /**
   * The frame as the packed bytes of `walkit::packed`, planned at `nowMs`, with only the
   * commands that changed since the frame before (`frame.mjs` reads it).
   */
  drawFrame(nowMs) {
    this.w.x.wk_rt_draw_frame(this.id, nowMs);
    return this.w.resultBytes();
  }

  /**
   * When the windows only moved since the last frame, where each one shows now, bottom to top:
   * `[{id, rect}]`, the move taken as drawn. Null when something needs drawing (`drawFrame`).
   */
  placedOnly() {
    if (!this.w.x.wk_rt_placed_only(this.id)) return null;
    const b = this.w.resultBytes();
    const v = new Int32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    const out = [];
    for (let i = 0; i < v.length; i += 5) out.push({ id: v[i], rect: { left: v[i + 1], top: v[i + 2], width: v[i + 3], height: v[i + 4] } });
    return out;
  }

  /** A right click, or a long press, where the pointer last was. */
  rightClick(seq = 0) {
    this.w.x.wk_rt_right_click(this.id, seq);
  }

  doubleTap(x, y, seq = 0) {
    this.w.x.wk_rt_double_tap(this.id, x, y, seq);
  }

  pointerDown(x, y, seq = 0) {
    this.w.x.wk_rt_pointer_down(this.id, x, y, seq);
  }

  pointerMove(x, y) {
    this.w.x.wk_rt_pointer_move(this.id, x, y);
  }

  pointerUp(x, y) {
    this.w.x.wk_rt_pointer_up(this.id, x, y);
  }

  /** The seq of the last press when a drag from it moves the window, or null (a host that moves its windows itself). */
  moveTarget() {
    const s = this.w.x.wk_rt_move_target(this.id);
    return s < 0 ? null : s;
  }

  /** The classic cursor slot at x, y of the stack, or -1. */
  cursorAt(x, y) {
    return this.w.x.wk_rt_cursor_at(this.id, x, y);
  }

  /** What cursor slot stands for (0 arrow, 1 move, 2 sideways, 3 up and down, 4 close, 5 size). */
  cursorKind(slot) {
    return this.w.x.wk_cursor_kind(slot);
  }

  /** The skin's picture for cursor slot: { steps: [[frame, ms]], frames: [{w, h, hx, hy, argb}] }, or null. */
  cursorImage(slot) {
    if (!this.w.x.wk_rt_cursor_image(this.id, slot)) return null;
    const b = this.w.resultBytes();
    const u = new Uint32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
    let i = 0;
    const steps = [];
    for (let n = u[i++]; n > 0; n--) steps.push([u[i++], u[i++]]);
    const frames = [];
    for (let n = u[i++]; n > 0; n--) {
      const w = u[i++], h = u[i++], hx = u[i++], hy = u[i++];
      frames.push({ w, h, hx, hy, argb: u.slice(i, i + w * h) });
      i += w * h;
    }
    return { steps, frames };
  }

  openWindow(name) {
    return this.w.withString(name, (p, n) => this.w.x.wk_rt_open_window(this.id, p, n)) !== 0;
  }

  closeWindow(name) {
    return this.w.withString(name, (p, n) => this.w.x.wk_rt_close_window(this.id, p, n)) !== 0;
  }

  /** Puts a window at x, y of the viewport while the windows are apart. */
  placeWindow(window, x, y) {
    this.w.x.wk_rt_place_window(this.id, window, x, y);
  }

  /** Shows the windows of a container `scale` times as large (2 for Winamp's double size). */
  setWindowScale(container, scale) {
    return this.w.withString(container, (p, n) => this.w.x.wk_rt_set_window_scale(this.id, p, n, scale)) !== 0;
  }

  /** Screen pixels per layout pixel of the windows of a container. */
  windowScale(container) {
    return this.w.withString(container, (p, n) => this.w.x.wk_rt_window_scale(this.id, p, n));
  }

  /** Names the windows of a container: the title a classic frame shows. */
  setWindowTitle(container, title) {
    return this.w.withString(container, (cp, cn) => this.w.withString(title, (tp, tn) => this.w.x.wk_rt_set_window_title(this.id, cp, cn, tp, tn))) !== 0;
  }

  /**
   * Where the page draws its visualizer, `{left, top, width, height}` in the viewport: the
   * classic visualizer window's inside, or a modern skin's visualizer holder; null when none shows.
   */
  visRect() {
    if (!this.w.x.wk_rt_vis_rect(this.id)) return null;
    const b = this.w.resultBytes();
    const [left, top, width, height] = new Int32Array(b.buffer, b.byteOffset, 4);
    return { left, top, width, height };
  }

  /** The part of window `window` that docks to others: its rect inside its skin's snap margins. */
  dockingRect(window) {
    if (!this.w.x.wk_rt_docking_rect(this.id, window)) return null;
    const b = this.w.resultBytes();
    const [left, top, width, height] = new Int32Array(b.buffer, b.byteOffset, 4);
    return { left, top, width, height };
  }

  /** The window that has the focus, or null. */
  focusedWindow() {
    const w = this.w.x.wk_rt_focused_window(this.id);
    return w < 0 ? null : w;
  }

  /** Whether a classic skin's time displays count down. */
  timeRemaining() {
    return this.w.x.wk_rt_time_remaining(this.id) !== 0;
  }

  setTimeRemaining(on) {
    this.w.x.wk_rt_set_time_remaining(this.id, on ? 1 : 0);
  }

  /** Whether a classic equalizer's auto button is on. */
  eqAuto() {
    return this.w.x.wk_rt_eq_auto(this.id) !== 0;
  }

  setEqAuto(on) {
    this.w.x.wk_rt_set_eq_auto(this.id, on ? 1 : 0);
  }

  /** Shows the classic windows as Winamp `version` ("2.91" or "5.666", the first) does; false for another. */
  setClassicStyle(version) {
    return this.w.withString(version, (p, n) => this.w.x.wk_rt_set_classic_style(this.id, p, n)) !== 0;
  }

  /** Sets a classic playlist's font size, pixels to the em (the style's at first); its rows follow. */
  setListFontSize(px) {
    this.w.x.wk_rt_set_list_font_size(this.id, px);
  }

  /** Whether a finger drives the skin (a press takes the nearest control a few pixels off) or a mouse (only the one under it). */
  setTouch(on) {
    this.w.x.wk_rt_set_touch(this.id, on ? 1 : 0);
  }

  /** Scrolls a classic playlist for notches of the mouse wheel, down for more than 0, as far as the classic style's Winamp does. */
  wheelPlaylist(notches) {
    this.w.x.wk_rt_wheel_playlist(this.id, notches);
  }

  /** Shows playlist entry `index` (from 0) as selected, or none for null, as the page's playlist has it. */
  setPlaylistSelection(index) {
    this.w.x.wk_rt_playlist_selection(this.id, index == null ? -1 : index);
  }

  /** Scrolls a classic playlist by rows, down for more than 0. */
  scrollPlaylist(rows) {
    this.w.x.wk_rt_scroll_playlist(this.id, rows);
  }

  /** Stages a song on the page's fake player: `title`, `lengthMs` long. */
  setTrack(title, lengthMs) {
    this.w.withString(title, (p, n) => this.w.x.wk_rt_set_track(this.id, p, n, lengthMs));
  }

  /** Shows a window's container in the layout named ("normal", "shade"). */
  setWindowLayout(window, name) {
    this.w.withString(name, (p, n) => this.w.x.wk_rt_set_window_layout(this.id, window, p, n));
  }

  /** Makes the page's fake player hand out silence, or not. */
  setSilent(silent) {
    this.w.x.wk_rt_set_silent(this.id, silent ? 1 : 0);
  }

  /** Stages the song's format on the page's fake player: kbps, kHz, channels. */
  setFormat(kbps, khz, channels) {
    this.w.x.wk_rt_set_format(this.id, kbps, khz, channels);
  }

  /** Sets the page's fake player's volume (0..255) and balance (-127..127). */
  setLevels(volume, pan) {
    this.w.x.wk_rt_set_levels(this.id, volume, pan);
  }

  selectTheme(name) {
    this.w.withString(name, (p, n) => this.w.x.wk_rt_select_theme(this.id, p, n));
  }

  // the windows set out apart in a viewport w x h, moved by a drag and docked as on Winamp's
  // desktop; off, they are one stack
  setFree(on, w = 0, h = 0) {
    this.w.x.wk_rt_set_free(this.id, on ? 1 : 0, w, h);
  }

  setView(w, h) {
    this.w.x.wk_rt_set_view(this.id, w, h);
  }

  /** The main window's id, or null. */
  mainWindow() {
    const w = this.w.x.wk_rt_main_window(this.id);
    return w < 0 ? null : w;
  }

  windowResizable(window) {
    return this.w.x.wk_rt_window_resizable(this.id, window) !== 0;
  }

  resizeWindow(window, w, h) {
    this.w.x.wk_rt_resize_window(this.id, window, w, h);
  }

  /** 1 play, 2 pause, 3 stop, 4 next, 5 previous. */
  player(action) {
    this.w.x.wk_rt_player(this.id, action);
  }

  /**
   * Tells a runtime on the page's player (`Walkit.hostedRuntime`) what the player is doing.
   * Give any of: `status` ("stopped", "playing", "paused"), `positionMs`, `lengthMs`, `title`,
   * `trackIndex` (from 0), `kbps`, `khz`, `channels`, `volume` (0..255), `pan` (-127..127),
   * `shuffle`, `repeat`, `eqOn`, `preamp` (0..255), `bands` (ten, 0..255); the rest stays.
   */
  setPlayerState(changes) {
    const s = (this.playerSeen = { ...PLAYER_DEFAULTS, ...this.playerSeen, ...changes });
    const ints = new Int32Array(23);
    ints.set([STATUS[s.status] ?? s.status, s.positionMs, s.lengthMs, s.kbps, s.khz, s.channels, s.volume, s.pan, +!!s.shuffle, +!!s.repeat, +!!s.eqOn, s.preamp]);
    ints.set(s.bands.slice(0, 10), 12);
    ints[22] = s.trackIndex;
    const [ip, il] = this.w.put(new Uint8Array(ints.buffer));
    try {
      this.w.withString(s.title, (tp, tn) => this.w.x.wk_rt_host_player_state(this.id, ip, 23, tp, tn));
    } finally {
      this.w.free(ip, il);
    }
  }

  /** The page's playlist for a runtime on the page's player: `[{title, lengthMs}]`. */
  setPlaylist(tracks) {
    const text = tracks.map((t) => `${Math.round(t.lengthMs) || 0}\t${String(t.title).replace(/[\t\n]/g, " ")}`).join("\n");
    this.w.withString(text, (p, n) => this.w.x.wk_rt_host_player_tracks(this.id, p, n));
  }

  /**
   * What the page's player is heard as now, for the skin's visualizers: `spectrum` (75 levels
   * 0..1, low to high), `waveform` (576 samples -1..1) and `vu` ([left, right], 0..255). Call
   * with nothing while nothing plays.
   */
  setVis({ spectrum = EMPTY, waveform = EMPTY, vu = [0, 0] } = {}) {
    const [sp, sl] = this.w.put(new Uint8Array(spectrum.buffer, spectrum.byteOffset, spectrum.byteLength));
    const [wp, wl] = this.w.put(new Uint8Array(waveform.buffer, waveform.byteOffset, waveform.byteLength));
    try {
      this.w.x.wk_rt_host_player_vis(this.id, sp, spectrum.length, wp, waveform.length, vu[0], vu[1]);
    } finally {
      this.w.free(sp, sl);
      this.w.free(wp, wl);
    }
  }

  nextDueAt() {
    const d = this.w.x.wk_rt_next_due_at(this.id);
    return d < 0 ? null : d;
  }

  free() {
    this.w.x.wk_rt_free(this.id);
  }
}

/** The scenario spec text the module reads, from a scenario object of scenarios.json. */
export function specOf(sc) {
  const lines = [`name=${sc.name}`, `wal=${sc.wal}`, `skin=${sc.skin.replace(/\.wal$/, "")}`];
  lines.push(`playlist=${(sc.playlist || ["Andamp"]).join("|")}`);
  if (sc.theme) lines.push(`theme=${sc.theme}`);
  if (sc.view && sc.view.length === 2) lines.push(`view=${sc.view[0]}x${sc.view[1]}`);
  if (sc.show && sc.show.length) lines.push(`show=${sc.show.join("|")}`);
  if (sc.mainsize && sc.mainsize.length === 2) lines.push(`mainsize=${sc.mainsize[0]}x${sc.mainsize[1]}`);
  if (sc.taps && sc.taps.length) lines.push(`taps=${sc.taps.join("|")}`);
  if (sc.noLibrary) lines.push("nolibrary=1");
  if (sc.noDefaults) lines.push("nodefaults=1");
  if (sc.noSiblings) lines.push("nosiblings=1");
  return lines.join("\n") + "\n";
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

/** CRC-32 (IEEE) of bytes, as 8 hex digits. */
export function crc32Bytes(b) {
  let crc = 0xffffffff;
  for (let i = 0; i < b.length; i++) crc = crcTable[(crc ^ b[i]) & 0xff] ^ (crc >>> 8);
  return ((~crc) >>> 0).toString(16).padStart(8, "0");
}

/** CRC-32 (IEEE) of a string's UTF-8, as 8 hex digits: the parity check of a trace. */
export function crc32(text) {
  return crc32Bytes(encoder.encode(text));
}
