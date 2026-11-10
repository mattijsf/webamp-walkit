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

type From = ActionFrom | null;

// a mouse wheel's notch, in pixels of delta (three lines); a trackpad's add up to notches
const WHEEL_NOTCH = 100;
const BASE_SKIN = new URL("../../assets/skins/base-2.91.wsz", import.meta.url);

let walkit: Promise<Walkit> | null = null;

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
  private unsubscribe: () => void;
  private unsubscribeStore: () => void;

  constructor(
    private root: HTMLElement,
    private store: Store<AppState>,
    private analyser: AnalyserNode
  ) {
    walkit ??= loadWalkit();
    const show = (s: SkinBytes) =>
      s ? this.show(s.bytes) : this.show(BASE_SKIN);
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

  private async show(source: Uint8Array | URL) {
    const turn = ++this.showing;
    const embed = await walkit!;
    embed.setHandlers(this.handlers);
    let skin: Skin;
    try {
      skin = await embed.openSkin(source, {
        name: "webamp",
        // a classic skin's missing bitmaps come from the base skin, as in Winamp
        base: BASE_SKIN.href,
      });
    } catch (e) {
      // a broken archive
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
    this.wake();
    this.feed?.dispose();
    this.feed = new PlayerFeed(skin.rt, this.analyser);
    this.mirror = new WindowMirror(
      skin.rt,
      this.dispatch,
      this.lastLayout(),
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
  }

  private handlers: Handlers = {
    invalidate: () => {
      this.skin?.invalidate();
      this.wake();
    },
    windowOpen: (kind: string) => {
      const state = this.store.getState();
      if (kind === "doublesize") return Selectors.getDoubled(state);
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
      case "TOGGLE":
        return param === "avs"
          ? dispatch(Actions.toggleWindow("milkdrop"))
          : undefined;
      case "ABOUT":
        return window.open("https://webamp.org/about", "_blank");
      case "PLAYLIST_SELECT":
        return dispatch(
          param === ""
            ? Actions.selectZero()
            : { type: "CLICKED_TRACK", index: Number(param) }
        );
      case "PLAYLIST":
        return this.playlistPick(param, count);
    }
  }

  private playlistPick(pick: string, count: number) {
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
      case "list_load":
        return dispatch(Actions.addFilesFromList());
      case "list_save":
        return dispatch(Actions.saveFilesToList());
    }
  }
}
