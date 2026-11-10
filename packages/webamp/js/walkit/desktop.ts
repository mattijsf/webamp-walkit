import { Store } from "redux";
import * as Actions from "../actionCreators";
import * as Selectors from "../selectors";
import { LOAD_STYLE } from "../constants";
import { AppState, Dispatch, WindowId } from "../types";
import {
  ActionFrom,
  Handlers,
  Runtime,
  Skin,
  SkinWindow,
  Walkit,
  loadWalkit,
} from "walkit-web";
import { getSkinBytes, onSkinBytes, SkinBytes } from "./skinBytes";
import { PlayerFeed, playerCommand } from "./player";
import { WindowMirror, WINDOW_OF_CONTAINER } from "./windows";
import { Box, toBox } from "./dock";

export type MenuKind =
  | "main"
  | "options"
  | "presets"
  | "sort"
  | "misc"
  | "playlistAdd"
  | "playlistRemove"
  | "playlistSelect"
  | "playlistMisc"
  | "playlistList";
// where a menu opens on the page: its top left corner, or with `above` its bottom left, or with
// `alignRight` its right edge there instead of its left
export type MenuPlace = {
  kind: MenuKind;
  x: number;
  y: number;
  above?: boolean;
  alignRight?: boolean;
};
type From = ActionFrom | null;
export type Vis = {
  left: number;
  top: number;
  width: number;
  height: number;
  z: number;
};

// a mouse wheel's notch, in pixels of delta (three lines); a trackpad's add up to notches
const WHEEL_NOTCH = 100;
const BASE_SKIN = new URL("../../assets/skins/base-2.91.wsz", import.meta.url);

let walkit: Promise<Walkit> | null = null;
let fonts: Promise<void> | null = null;

// Modern skins lay their text out with the stand-in fonts the dev server serves, when it does.
async function loadFonts(embed: Walkit) {
  const names: string[] = await fetch("/walkit/fonts.json")
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  const files = new Map<string, Uint8Array>();
  for (const name of names) {
    const r = await fetch(`/walkit/fonts/${encodeURIComponent(name)}`);
    if (r.ok) files.set(`fonts/${name}`, new Uint8Array(await r.arrayBuffer()));
  }
  await embed.addFonts(files);
}

/**
 * walkit's classic windows on the page: one canvas each where walkit places it, the pointer,
 * wheel and dropped files sent to it, and webamp's store kept in step.
 */
function acceptDrop(e: DragEvent) {
  e.stopPropagation();
  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = "link";
    e.dataTransfer.effectAllowed = "link";
  }
}

export class Desktop {
  private skin: Skin | null = null;
  private feed: PlayerFeed | null = null;
  private mirror: WindowMirror | null = null;
  private canvases = new Map<number, HTMLCanvasElement>();
  private keys = new Map<number, WindowId>();
  private press = { seq: 0, down: false };
  private frame = 0;
  private timer = 0;
  private alive = true;
  private viewport = "";
  private state: AppState | null = null;
  private layout = "";
  private skins = 0;
  private showing = 0;
  // the mirrored windows of the skin shown, where they are
  private shown = new Map<string, Box>();
  private wheelLeft = 0;
  private painted = 0;
  private input = false;
  private vis = "";
  private unsubscribe: () => void;
  private unsubscribeStore: () => void;

  constructor(
    private root: HTMLElement,
    private store: Store<AppState>,
    private analyser: AnalyserNode,
    private openMenu: (menu: MenuPlace) => void,
    private onVis: (vis: Vis | null) => void
  ) {
    walkit ??= loadWalkit();
    const show = (s: SkinBytes) =>
      s ? this.show(s.bytes, s.modern) : this.show(BASE_SKIN);
    show(getSkinBytes());
    this.unsubscribe = onSkinBytes(show);
    this.unsubscribeStore = store.subscribe(this.wake);
  }

  dispose() {
    this.alive = false;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.timer);
    this.unsubscribe();
    this.unsubscribeStore();
    this.feed?.dispose();
    this.clear();
  }

  // Frames run while something moves (a song, a drag, a change settling); otherwise the loop
  // sleeps until the store or the input changes, or the skin has something due.
  private wake = () => {
    if (this.frame || !this.alive) return;
    clearTimeout(this.timer);
    this.frame = requestAnimationFrame(this.loop);
  };

  private loop = () => {
    this.frame = 0;
    if (this.step()) {
      this.wake();
      return;
    }
    const due = this.skin?.dueAt ?? Infinity;
    if (due !== Infinity) {
      this.timer = window.setTimeout(
        this.wake,
        Math.max(0, due - performance.now())
      );
    }
  };

  private get dispatch(): Dispatch {
    return this.store.dispatch as Dispatch;
  }

  private async show(source: Uint8Array | URL, modern = false) {
    const turn = ++this.showing;
    const embed = await walkit!;
    embed.setHandlers(this.handlers);
    if (modern) await (fonts ??= loadFonts(embed));
    let skin: Skin;
    try {
      skin = await embed.openSkin(source, {
        name: "webamp",
        // a classic skin's missing bitmaps come from the base skin, a modern skin's lists and
        // frames from Winamp's wasabi base, as in Winamp
        ...(modern
          ? { wasabi: "/walkit/wasabi.zip" }
          : { base: BASE_SKIN.href }),
      });
    } catch (e) {
      // a modern skin without the wasabi base to stand on, or a broken archive
      console.warn("walkit could not open the skin", e);
      return;
    }
    // a skin asked for later wins, whichever opens first
    if (!this.alive || turn !== this.showing) {
      skin.free();
      return;
    }
    // the canvases stay: the new skin paints over them in its first frame
    this.skin?.free();
    this.skin = skin;
    this.layout = "";
    this.state = null;
    this.skins++;
    // webamp is Winamp 2.91
    skin.rt.setClassicStyle("2.91");
    skin.rt.setWindowTitle("avs", "Milkdrop");
    this.wake();
    this.feed?.dispose();
    this.feed = new PlayerFeed(skin.rt, this.analyser);
    this.mirror = new WindowMirror(
      skin.rt,
      this.dispatch,
      this.lastLayout(),
      modern,
      this.mirror?.keptDocking()
    );
    this.viewport = "";
  }

  /** Where the mirrored windows were last shown: walkit's, or webamp's own before any skin. */
  private lastLayout(): Map<string, Box> {
    if (this.shown.size) {
      return new Map([...(this.mirror?.folded() ?? []), ...this.shown]);
    }
    const state = this.store.getState();
    const out = new Map<string, Box>();
    for (const w of Selectors.getWindowsInfo(state)) {
      if (state.windows.genWindows[w.key]?.open) out.set(w.key, w);
    }
    return out;
  }

  private clear() {
    this.skin?.free();
    this.skin = null;
    this.canvases.forEach((c) => c.remove());
    this.canvases.clear();
    this.showVis(null);
  }

  // where Milkdrop draws: the inside of walkit's visualizer window, or a modern skin's
  // visualizer holder, just above the window it is in
  private showVis(rect: Omit<Vis, "z"> | null, windows: SkinWindow[] = []) {
    let vis: Vis | null = null;
    if (rect) {
      const z = windows.findIndex(
        (w) =>
          rect.left >= w.rect.left &&
          rect.top >= w.rect.top &&
          rect.left + rect.width <= w.rect.left + w.rect.width &&
          rect.top + rect.height <= w.rect.top + w.rect.height
      );
      vis = { ...rect, z: 2 * (z + 1) + 1 };
    }
    const key = JSON.stringify(vis);
    if (key === this.vis) return;
    this.vis = key;
    this.onVis(vis);
  }

  private handlers: Handlers = {
    invalidate: () => {
      this.skin?.invalidate();
      this.wake();
    },
    windowOpen: (kind: string) => {
      const state = this.store.getState();
      if (kind === "doublesize") return Selectors.getDoubled(state);
      if (kind === "visrandom") return Selectors.getRandomizePresets(state);
      return null;
    },
    player: (cmd: string, arg: number) =>
      playerCommand(this.dispatch, this.store.getState(), cmd, arg),
    action: (action: string, param: string, from: From) =>
      this.action(action, param, from),
  };

  /** One frame's work; whether another frame should follow at once. */
  private step(again = 0): boolean {
    const { skin } = this;
    if (!skin) return false;
    const state = this.store.getState();
    const stored = state !== this.state;
    this.state = state;
    if (stored) {
      const { width, height } = Selectors.getBrowserWindowSize(state);
      if (`${width}x${height}` !== this.viewport) {
        this.viewport = `${width}x${height}`;
        skin.rt.setFree(true, width, height);
      }
      this.feed!.push(state);
      this.mirror!.scale(state);
    }
    const playing = Selectors.getMediaIsPlaying(state);
    const now = performance.now();
    this.feed!.hear(playing, now);
    const changed = skin.tick(now);
    const busy = playing || this.press.down || stored;
    if (!stored && !changed && !this.input) return busy;
    const windows = skin.windows();
    this.shown = new Map(
      windows
        .filter((w) => WINDOW_OF_CONTAINER[w.container])
        .map((w) => [
          WINDOW_OF_CONTAINER[w.container],
          toBox(skin.rt.dockingRect(w.id) ?? w.rect),
        ])
    );
    // a frame in which only the clock drew (the title, time, vis) moved no window
    const layout = windows
      .map(
        (w) =>
          `${w.id}:${w.layout}:${w.rect.left},${w.rect.top},${w.rect.width},${w.rect.height}`
      )
      .join(" ");
    const moved = layout !== this.layout;
    this.layout = layout;
    // while a press drags windows only walkit follows; webamp hears where they went on release
    const dragging = this.press.down;
    if (stored || (!dragging && (moved || this.input))) {
      if (!dragging) this.input = false;
      // windows the store moved or opened are drawn again where they now belong
      if (this.mirror!.update(windows, state, dragging) && again < 2) {
        skin.invalidate();
        this.layout = "";
        return this.step(again + 1);
      }
    }
    if (changed) {
      this.paint(skin, windows, moved);
      if (moved) this.showVis(skin.rt.visRect(), windows);
      if (this.painted !== this.skins) {
        this.painted = this.skins;
        this.root.dataset.skin = String(this.skins);
      }
    }
    // a window that moved may settle on the next frame; the clock alone needs none
    return busy || moved;
  }

  private paint(skin: Skin, windows: SkinWindow[], moved: boolean) {
    const scale = window.devicePixelRatio || 1;
    const shown = new Set<number>();
    windows.forEach((w, z) => {
      const { left, top, width, height } = w.rect;
      if (width <= 0 || height <= 0) return;
      shown.add(w.id);
      const c = this.canvasFor(w.id);
      if (!moved) {
        skin.paint(c, w, scale);
        return;
      }
      this.keys.set(w.id, WINDOW_OF_CONTAINER[w.container]);
      const pw = Math.ceil(width * scale);
      const ph = Math.ceil(height * scale);
      if (c.width !== pw || c.height !== ph) {
        c.width = pw;
        c.height = ph;
        c.style.width = `${pw / scale}px`;
        c.style.height = `${ph / scale}px`;
      }
      const x = Math.round(left * scale) / scale;
      const y = Math.round(top * scale) / scale;
      c.style.transform = `translate(${x}px, ${y}px)`;
      c.style.zIndex = String(2 * (z + 1));
      skin.paint(c, w, scale);
    });
    for (const [id, c] of this.canvases) {
      if (!shown.has(id)) {
        c.remove();
        this.canvases.delete(id);
      }
    }
  }

  private point(e: MouseEvent): [number, number] {
    const r = this.root.getBoundingClientRect();
    return [Math.floor(e.clientX - r.left), Math.floor(e.clientY - r.top)];
  }

  private canvasFor(id: number) {
    const existing = this.canvases.get(id);
    if (existing) return existing;
    const c = document.createElement("canvas");
    Object.assign(c.style, {
      position: "absolute",
      left: "0",
      top: "0",
      imageRendering: "pixelated",
      touchAction: "none",
    });
    c.addEventListener("pointerdown", (e) => this.pointerDown(c, e));
    c.addEventListener("pointermove", (e) => this.pointerMove(c, e));
    c.addEventListener("pointerleave", () => this.skin?.cursors.hide(c));
    c.addEventListener("pointerup", (e) => this.pointerUp(e));
    c.addEventListener("pointercancel", (e) => this.pointerUp(e));
    c.addEventListener("dblclick", (e) =>
      this.withSkin((rt) => rt.doubleTap(...this.point(e), this.press.seq))
    );
    c.addEventListener("wheel", (e) => this.wheel(id, e), { passive: false });
    // as webamp's own windows do: the page may refuse drops everywhere else, and a browser
    // that sees that refusal (Firefox) never delivers the drop
    for (const type of ["dragenter", "dragover"]) {
      c.addEventListener(type, (e) => acceptDrop(e as DragEvent));
    }
    c.addEventListener("drop", (e) => {
      acceptDrop(e);
      this.drop(id, e);
    });
    this.root.appendChild(c);
    this.canvases.set(id, c);
    return c;
  }

  private withSkin(f: (rt: Runtime) => void) {
    if (!this.skin) return;
    f(this.skin.rt);
    this.input = true;
    this.wake();
  }

  private pointerDown(c: HTMLCanvasElement, e: PointerEvent) {
    if (e.button !== 0) return;
    c.setPointerCapture(e.pointerId);
    // a finger takes the nearest control a few pixels off; a mouse only the one under it
    this.skin?.rt.setTouch(e.pointerType !== "mouse");
    this.press.seq++;
    this.press.down = true;
    this.withSkin((rt) => rt.pointerDown(...this.point(e), this.press.seq));
  }

  private pointerMove(c: HTMLCanvasElement, e: PointerEvent) {
    if (!this.skin) return;
    const [x, y] = this.point(e);
    if (this.press.down) {
      this.withSkin((rt) => rt.pointerMove(x, y));
      return;
    }
    this.skin.cursors.show(c, x, y);
  }

  private pointerUp(e: PointerEvent) {
    if (!this.press.down) return;
    this.press.down = false;
    this.withSkin((rt) => rt.pointerUp(...this.point(e)));
  }

  private wheel(id: number, e: WheelEvent) {
    if (this.keys.get(id) === "playlist") {
      e.preventDefault();
      const delta =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? (e.deltaY * WHEEL_NOTCH) / 3
          : e.deltaY;
      this.wheelLeft += delta;
      const notches = Math.trunc(this.wheelLeft / WHEEL_NOTCH);
      if (notches === 0) return;
      this.wheelLeft -= notches * WHEEL_NOTCH;
      this.withSkin((rt) => rt.wheelPlaylist(notches));
    } else {
      this.dispatch(Actions.scrollVolume(e));
    }
  }

  private drop(id: number, e: DragEvent) {
    const key = this.keys.get(id) ?? "main";
    const event = e as unknown as React.DragEvent<HTMLDivElement>;
    this.dispatch(Actions.droppedFiles(event, key));
    if (key === "playlist") {
      const count = this.store.getState().playlist.trackOrder.length;
      this.dispatch(Actions.loadMedia(event, LOAD_STYLE.NONE, count));
    } else {
      this.dispatch(Actions.loadMedia(event, LOAD_STYLE.PLAY));
    }
  }

  // webamp closes its menus on the next click, so one opened by a press waits for it to pass;
  // a menu opens under its button, or above it as Winamp 5 opens a modern skin's playlist menus
  private menuAt(
    kind: MenuKind,
    from: From,
    above = false,
    alignRight = false
  ) {
    const r = this.root.getBoundingClientRect();
    const [x, y, w, h] = from?.rect ?? [0, 0, 0, 0];
    const open = () =>
      setTimeout(() =>
        this.openMenu({
          kind,
          x: r.left + window.scrollX + x + (alignRight ? w : 0),
          y: r.top + window.scrollY + y + (above ? 0 : h),
          above,
          alignRight,
        })
      );
    if (this.press.down)
      window.addEventListener("pointerup", open, { once: true });
    else open();
  }

  private action(action: string, param: string, from: From) {
    const { dispatch } = this;
    const state = this.store.getState();
    const count = state.playlist.trackOrder.length;
    switch (action) {
      case "CLOSE":
        return dispatch(Actions.close());
      case "MINIMIZE":
        return dispatch(Actions.minimize());
      case "DOUBLESIZE":
        return dispatch(Actions.toggleDoubleSizeMode());
      case "MENU":
        return this.menuAt(param === "wa5:options" ? "options" : "main", from);
      case "EQ_PRESETS":
        return this.menuAt("presets", from);
      case "TOGGLE":
        return param === "avs"
          ? dispatch(Actions.toggleWindow("milkdrop"))
          : undefined;
      // the visualizer's preset buttons (Winamp Modern's Prev, Next and Random)
      case "VIS_PREV":
        return dispatch(Actions.selectPreviousPreset());
      case "VIS_NEXT":
        return dispatch(Actions.selectNextPreset());
      case "VIS_RANDOM":
        return (param === "1") !== Selectors.getRandomizePresets(state)
          ? dispatch(Actions.toggleRandomizePresets())
          : undefined;
      // a skin showing the visualizer's own window again (Winamp Modern's Detach)
      case "SHOW":
        if (param !== "avs") return;
        if (!state.windows.genWindows.milkdrop?.open)
          return dispatch(Actions.toggleWindow("milkdrop"));
        return this.withSkin((rt) => rt.openWindow("avs"));
      case "ABOUT":
        return window.open("https://webamp.org/about", "_blank");
      case "PLAYLIST_SELECT":
        return dispatch(
          param === ""
            ? Actions.selectZero()
            : { type: "CLICKED_TRACK", index: Number(param) }
        );
      case "PLAYLIST":
        return this.playlistPick(param, count, from);
      case "PE_ADD":
        return this.menuAt("playlistAdd", from, true);
      case "PE_REM":
        return this.menuAt("playlistRemove", from, true);
      case "PE_SEL":
        return this.menuAt("playlistSelect", from, true);
      case "PE_MISC":
        return this.menuAt("playlistMisc", from, true);
      case "PE_LIST":
        return this.menuAt("playlistList", from, true, true);
    }
  }

  private playlistPick(pick: string, count: number, from: From) {
    const { dispatch } = this;
    switch (pick) {
      case "add_file":
        return dispatch(Actions.addFilesAtIndex(count));
      case "add_dir":
        return dispatch(Actions.addDirAtIndex(count));
      case "add_url":
        return dispatch(Actions.addFilesFromUrl(count));
      case "remove_selected":
        return dispatch(Actions.removeSelectedTracks());
      case "remove_all":
      case "list_new":
        return dispatch(Actions.removeAllTracks());
      case "crop":
        return dispatch(Actions.cropPlaylist());
      case "select_all":
        return dispatch(Actions.selectAll());
      case "select_none":
        return dispatch(Actions.selectZero());
      case "select_invert":
        return dispatch(Actions.invertSelection());
      case "sort":
        return this.menuAt("sort", from);
      case "misc_options":
        return this.menuAt("misc", from);
      case "list_load":
        return dispatch(Actions.addFilesFromList());
      case "list_save":
        return dispatch(Actions.saveFilesToList());
    }
  }
}
