// SPDX-License-Identifier: GPL-3.0-or-later

/** A rectangle in viewport pixels. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where a button that asks the page for something sits, in the viewport. */
export interface ActionFrom {
  rect: [x: number, y: number, width: number, height: number];
  point: [x: number, y: number] | null;
}

/** What the page answers for the engine. Every handler is optional. */
export interface Handlers {
  /** Something changed: draw a frame soon. */
  invalidate?(): void;
  /** Whether one of the page's windows or switches is on: "doublesize", "ontop", "pl", "eq"; null leaves it to the skin. */
  windowOpen?(kind: string): boolean | null;
  /**
   * A button for the page's player: play, pause, stop, next, previous, eject, play_track
   * (index), seek (ms), volume (0..255), pan (-127..127), shuffle, repeat, eq (0/1), preamp and
   * band0..band9 (0..255).
   */
  player?(command: string, value: number): void;
  /** MENU, CLOSE, MINIMIZE, DOUBLESIZE, EQ_PRESETS, PLAYLIST, PLAYLIST_SELECT, TOGGLE, ABOUT, ... */
  action?(action: string, param: string, from: ActionFrom | null): void;
  /** The windows on screen changed. */
  windowsChanged?(ids: number[]): void;
  /** A line the skin logs. */
  log?(line: string): void;
}

/** What the page's player is doing; any field left out stays as it was. */
export interface PlayerState {
  status?: "stopped" | "playing" | "paused";
  positionMs?: number;
  lengthMs?: number;
  title?: string;
  /** The playlist entry playing, from 0. */
  trackIndex?: number;
  kbps?: number;
  khz?: number;
  channels?: number;
  /** 0..255 */
  volume?: number;
  /** -127..127 */
  pan?: number;
  shuffle?: boolean;
  repeat?: boolean;
  eqOn?: boolean;
  /** 0..255, 128 flat */
  preamp?: number;
  /** Ten bands, 0..255, 128 flat. */
  bands?: number[];
}

/** A skin running on the engine. Coordinates are viewport pixels. */
export interface Runtime {
  setFree(on: boolean, width?: number, height?: number): void;
  setPlayerState(state: PlayerState): void;
  setPlaylist(tracks: { title: string; lengthMs: number }[]): void;
  setVis(vis?: { spectrum?: Float32Array; waveform?: Float32Array; vu?: [number, number] }): void;
  pointerDown(x: number, y: number, seq?: number): void;
  pointerMove(x: number, y: number): void;
  pointerUp(x: number, y: number): void;
  doubleTap(x: number, y: number, seq?: number): void;
  rightClick(seq?: number): void;
  /** The seq of the last press when a drag from it moves its window and the page moves windows itself. */
  moveTarget(): number | null;
  cursorAt(x: number, y: number): number;
  /** 0 arrow, 1 move, 2 sideways, 3 up and down, 4 close, 5 size. */
  cursorKind(slot: number): number;
  openWindow(container: string): boolean;
  closeWindow(container: string): boolean;
  placeWindow(window: number, x: number, y: number): void;
  resizeWindow(window: number, width: number, height: number): void;
  setWindowLayout(window: number, layout: string): void;
  /** Screen pixels per layout pixel, 0.25..8; the windows docked to it stay docked. */
  setWindowScale(container: string, scale: number): boolean;
  windowScale(container: string): number;
  setWindowTitle(container: string, title: string): boolean;
  /** The part of a window that docks to others: its rect inside its skin's snap margins. */
  dockingRect(window: number): Rect | null;
  /** Where the page draws its visualizer, or null when no window shows a place for it. */
  visRect(): Rect | null;
  mainWindow(): number | null;
  /** When the windows only moved since the last frame, where each one shows now; null when something needs drawing. */
  placedOnly(): { id: number; rect: Rect }[] | null;
  /** When (clock ms) something on the skin next changes by itself, or null. */
  nextDueAt(): number | null;
  focusedWindow(): number | null;
  timeRemaining(): boolean;
  setTimeRemaining(on: boolean): void;
  eqAuto(): boolean;
  setEqAuto(on: boolean): void;
  /** Shows playlist entry `index` (from 0) as selected, or none for null; the page is not told back. */
  setPlaylistSelection(index: number | null): void;
  scrollPlaylist(rows: number): void;
  /** Whether a finger drives the skin (a press takes the nearest control a few pixels off) or a mouse (only the one under it). */
  setTouch(on: boolean): void;
  /** Scrolls a classic playlist for notches of the mouse wheel, as far as the classic style's Winamp does. */
  wheelPlaylist(notches: number): void;
  /** Shows the classic windows as that Winamp does: "5.666" at first, or "2.91" (webamp's). */
  setClassicStyle(version: "2.91" | "5.666"): boolean;
  /** A classic playlist's font size, pixels to the em (the style's at first); its rows follow. */
  setListFontSize(px: number): void;
}

/** A window on screen, bottom to top. */
export interface SkinWindow {
  id: number;
  container: string;
  layout: string;
  rect: Rect;
}

/** A classic skin's cursors over its windows. */
export interface SkinCursors {
  /** Shows on `el` the skin's cursor at `x`, `y` of the stack, its pictures `zoom` times their size. */
  show(el: HTMLElement, x: number, y: number, zoom?: number): void;
  /** Gives `el` back its CSS cursor, as when the pointer leaves it. */
  hide(el: HTMLElement): void;
}

export interface Skin {
  rt: Runtime;
  cursors: SkinCursors;
  /** A classic .wsz skin rather than a modern .wal one. */
  classic: boolean;
  /** When (in `tick`'s clock) the skin next changes by itself; Infinity when nothing will until the page changes something. */
  readonly dueAt: number;
  /**
   * Steps the clock to `now` (ms); whether the windows need painting again. Does nothing until
   * the engine has something due or `invalidate` was called.
   */
  tick(now: number): boolean;
  windows(): SkinWindow[];
  /** Asks for the windows again on the next `tick`: call it after changing the player, a window or the input. */
  invalidate(): void;
  /** Paints `window` on `canvas`, its corner at the canvas's, `scale` device pixels per pixel. */
  paint(canvas: HTMLCanvasElement, window: SkinWindow, scale?: number): void;
  free(): void;
}

export type Source = string | URL | ArrayBuffer | Uint8Array;

/** How `openSkin` opens a skin. An archive given as a URL or bytes is kept once opened. */
export interface OpenOptions {
  /** The skin's folder name, as its scripts know it. */
  name?: string;
  /**
   * A classic base skin (such as Winamp's base skin), used only under a classic skin: it gives
   * every bitmap the skin leaves out, as Winamp takes them from its base skin.
   */
  base?: Source | Map<string, Uint8Array> | null;
  /**
   * Winamp's wasabi base, used only under a modern skin: the lists, scrollbars and frames the
   * skin does not define. Give the stand-in fonts to `addFonts` as well.
   */
  wasabi?: Source | Map<string, Uint8Array> | null;
  /** Runs the engine's own demo player instead of the page's. */
  demoPlayer?: boolean;
}

export interface Walkit {
  setHandlers(handlers: Handlers): void;
  /** The stand-in fonts a modern skin lays out text with: path ("fonts/LiberationSans.ttf") to bytes. */
  addFonts(fonts: Map<string, Uint8Array>): Promise<void>;
  /**
   * Opens a skin. The skin's own files tell a classic skin (.wsz) from a modern one (.wal), and
   * that picks what lies under it: `base` under a classic skin, `wasabi` under a modern one.
   */
  openSkin(source: Source, options?: OpenOptions): Promise<Skin>;
}

/** Loads the engine, from `walkit.wasm` next to this module unless `wasm` says otherwise. */
export function loadWalkit(handlers?: Handlers, options?: { wasm?: Source }): Promise<Walkit>;
