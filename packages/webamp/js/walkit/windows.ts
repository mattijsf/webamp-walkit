import * as Actions from "../actionCreators";
import * as Selectors from "../selectors";
import { TIME_MODE } from "../constants";
import { AppState, Dispatch, WindowId } from "../types";
import { Rect, Runtime, SkinWindow } from "walkit-web";
import { Box, Hang, docked, hangers, separate } from "./dock";

export const WINDOW_OF_CONTAINER: { [container: string]: WindowId } = {
  main: "main",
  equalizer: "equalizer",
  pledit: "playlist",
  avs: "milkdrop",
};

const CONTAINER_OF_WINDOW: [WindowId, string][] = [
  ["equalizer", "equalizer"],
  ["playlist", "pledit"],
  ["milkdrop", "avs"],
];

// Winamp doubles these, and only these, in double size
const DOUBLED = ["main", "equalizer"];

// the windows webamp sizes in steps of 25 x 29 beyond 275 x 116
const SIZED: WindowId[] = ["playlist", "milkdrop"];
const steps = (r: Rect): [number, number] => [
  Math.max(0, Math.round((r.width - 275) / 25)),
  Math.max(0, Math.round((r.height - 116) / 29)),
];

/**
 * Keeps webamp's window state and walkit's the same: walkit places, docks, scales and shades
 * the classic windows; webamp's menus, hotkeys and API change them too. Whichever side changed
 * a value since the last frame wins.
 */
export class WindowMirror {
  private last = new Map<string, { walkit: string; webamp: string }>();
  private placed = new Set<WindowId>();
  private doubled: boolean | null = null;
  private rescaled = false;
  private changedWalkit = false;
  // windows webamp has open that this skin has no window for
  private missing = new Set<WindowId>();
  private hang: ReturnType<typeof hangers>;
  private boxes = new Map<string, Box>();

  /**
   * `before`: where the windows were in the skin before this one, which docking it keeps.
   * `modern`: a modern skin, whose windows open at their own size as in Winamp, not at
   * webamp's classic size steps. `kept`: the docking of windows the skin before moved aside
   * (`keptDocking`), which they take up again here.
   */
  constructor(
    private rt: Runtime,
    private dispatch: Dispatch,
    private before: Map<string, Box> = new Map(),
    private modern = false,
    kept: Map<string, Hang> = new Map()
  ) {
    this.hang = hangers(before, "main");
    for (const [key, h] of kept) {
      if (before.has(key) && before.has(h.parent)) this.hang.set(key, h);
    }
  }

  /** The windows this skin moved aside to keep them off others, with the docking they had. */
  private pushed = new Map<string, Hang>();

  keptDocking(): Map<string, Hang> {
    return new Map(this.pushed);
  }

  // before the engine draws the frame, so the windows come out at their new size
  scale(state: AppState) {
    const doubled = Selectors.getDoubled(state);
    if (doubled === this.doubled) return;
    this.rescaled = this.doubled !== null;
    this.doubled = doubled;
    for (const c of DOUBLED) this.rt.setWindowScale(c, doubled ? 2 : 1);
  }

  /**
   * Brings both sides together; whether it changed walkit's windows, which then draw again.
   * While walkit's windows are `dragging`, where they are waits for the release.
   */
  update(windows: SkinWindow[], state: AppState, dragging = false): boolean {
    this.changedWalkit = false;
    const shown = new Map<WindowId, SkinWindow>();
    for (const w of windows) {
      const key = WINDOW_OF_CONTAINER[w.container];
      if (key) shown.set(key, w);
    }
    const gen = state.windows.genWindows;
    const hidden = Selectors.getWindowHidden(state);

    // webamp re-docks the windows for double size as well; walkit's docking wins
    const rescaled = this.rescaled;
    this.rescaled = false;

    for (const [key, container] of CONTAINER_OF_WINDOW) {
      const open = (gen[key]?.open ?? false) && !hidden(key);
      // Milkdrop is on while walkit shows the visualizer anywhere: its own window, or a
      // skin's drawer that took it in
      const on =
        shown.has(key) || (key === "milkdrop" && this.rt.visRect() != null);
      this.sync(
        `open:${key}`,
        String(on),
        String(open),
        () => this.dispatch(Actions.toggleWindow(key)),
        () => {
          if (!open) this.rt.closeWindow(container);
          else if (!this.rt.openWindow(container)) this.missing.add(key);
        }
      );
    }
    const size = (key: string) => {
      const w = shown.get(key as WindowId);
      const g = gen[key];
      if (w && g) return this.newSize(key as WindowId, w, g.size);
      if (this.missing.has(key as WindowId) || !g?.open) return null;
      return this.before.get(key) ?? null;
    };

    // the windows new to this skin find their spots together, so one that would land on
    // another (a wider playlist under a window docked to the main window's side) moves aside;
    // docking goes by the part of each window inside its snap margins
    const fresh: string[] = [];
    for (const [key, w] of shown) {
      const g = gen[key];
      if (!g || this.placed.has(key)) continue;
      const m = this.margins(w);
      fresh.push(key);
      this.boxes.set(
        key,
        this.before.has(key)
          ? docked(key, this.before, this.hang, size, this.boxes)
          : {
              x: g.position.x + m.left,
              y: g.position.y + m.top,
              ...this.newSize(key, w, g.size),
            }
      );
    }
    for (const key of separate(this.boxes, this.hang, fresh)) {
      this.pushed.set(key, this.hang.get(key)!);
    }

    const moved: { [key: string]: { x: number; y: number } } = {};
    for (const [key, w] of shown) {
      const g = gen[key];
      if (!g) continue;
      if (!this.placed.has(key)) {
        this.placed.add(key);
        this.changedWalkit = true;
        const m = this.margins(w);
        const dock = this.boxes.get(key)!;
        const x = dock.x - m.left;
        const y = dock.y - m.top;
        this.rt.placeWindow(w.id, x, y);
        if (SIZED.includes(key)) {
          this.rt.resizeWindow(
            w.id,
            dock.width + m.left + m.right,
            dock.height + m.top + m.bottom
          );
        }
        if (x !== g.position.x || y !== g.position.y) moved[key] = { x, y };
        this.last.set(`position:${key}`, {
          walkit: `${x},${y}`,
          webamp: `${x},${y}`,
        });
        continue;
      }
      const at = `${w.rect.left},${w.rect.top}`;
      const toWebamp = () => {
        // a window moved by hand docks where it now is
        this.pushed.delete(key);
        moved[key] = { x: w.rect.left, y: w.rect.top };
      };
      if (rescaled) {
        moved[key] = { x: w.rect.left, y: w.rect.top };
        this.last.set(`position:${key}`, { walkit: at, webamp: at });
      } else if (!dragging) {
        this.sync(
          `position:${key}`,
          at,
          `${g.position.x},${g.position.y}`,
          toWebamp,
          () => this.rt.placeWindow(w.id, g.position.x, g.position.y)
        );
      }
      const shaded = w.layout === "shade";
      this.sync(
        `shade:${key}`,
        String(shaded),
        String(!!g.shade),
        () =>
          this.dispatch({ type: "TOGGLE_WINDOW_SHADE_MODE", windowId: key }),
        () => this.rt.setWindowLayout(w.id, g.shade ? "shade" : "normal")
      );
      // webamp keeps its classic size while a modern skin sizes its own windows
      if (SIZED.includes(key) && !shaded && !this.modern) {
        const scale = this.rt.windowScale(containerOf(key));
        const layoutRect = {
          ...w.rect,
          width: w.rect.width / scale,
          height: w.rect.height / scale,
        };
        const [cols, rows] = steps(layoutRect);
        if (cols !== g.size[0] || rows !== g.size[1]) {
          this.dispatch(Actions.setWindowSize(key, [cols, rows]));
        }
      }
    }
    // the windows this skin has none of keep their spot, folded, for the next skin
    for (const key of this.before.keys()) {
      if (!this.boxes.has(key) && size(key) === null) {
        docked(key, this.before, this.hang, size, this.boxes);
      }
    }
    if (Object.keys(moved).length) {
      this.dispatch(Actions.updateWindowPositions(moved, false));
    }

    const focusedId = this.rt.focusedWindow();
    const focused = windows.find((w) => w.id === focusedId);
    const focusedKey = focused && WINDOW_OF_CONTAINER[focused.container];
    if (focusedKey) {
      this.sync(
        "focus",
        focusedKey,
        String(Selectors.getFocusedWindow(state)),
        () => this.dispatch(Actions.setFocusedWindow(focusedKey)),
        () => {}
      );
    }

    const remaining = state.media.timeMode === TIME_MODE.REMAINING;
    this.sync(
      "remaining",
      String(this.rt.timeRemaining()),
      String(remaining),
      () => this.dispatch(Actions.toggleTimeMode()),
      () => this.rt.setTimeRemaining(remaining)
    );
    const eqAuto = Selectors.getEqualizerAuto(state);
    this.sync(
      "eqAuto",
      String(this.rt.eqAuto()),
      String(eqAuto),
      () => this.dispatch(Actions.toggleEqAuto()),
      () => this.rt.setEqAuto(eqAuto)
    );
    return this.changedWalkit;
  }

  /** The windows this skin has none of, folded to nothing where they were docked. */
  folded(): [string, Box][] {
    return [...this.boxes].filter(([, b]) => b.width === 0 || b.height === 0);
  }

  /**
   * The size of the part of `w` that docks once placed: webamp's size steps for the classic
   * windows it sizes, a modern skin's own size otherwise.
   */
  private newSize(key: WindowId, w: SkinWindow, size: [number, number]) {
    const m = this.margins(w);
    const full =
      SIZED.includes(key) && !this.modern
        ? { width: 275 + 25 * size[0], height: 116 + 29 * size[1] }
        : { width: w.rect.width, height: w.rect.height };
    return {
      width: full.width - m.left - m.right,
      height: full.height - m.top - m.bottom,
    };
  }

  /** The snap margins of `w`: what lies outside the part of it that docks. */
  private margins(w: SkinWindow) {
    const d = this.rt.dockingRect(w.id) ?? w.rect;
    const r = w.rect;
    return {
      left: d.left - r.left,
      top: d.top - r.top,
      right: r.left + r.width - (d.left + d.width),
      bottom: r.top + r.height - (d.top + d.height),
    };
  }

  private sync(
    name: string,
    walkit: string,
    webamp: string,
    toWebamp: () => void,
    toWalkit: () => void
  ) {
    const last = this.last.get(name);
    this.last.set(name, { walkit, webamp });
    if (walkit === webamp) return;
    if (last == null || webamp !== last.webamp) {
      this.changedWalkit = true;
      toWalkit();
    } else if (walkit !== last.walkit) {
      toWebamp();
      // webamp now holds walkit's value: only a change from there is webamp's
      this.last.set(name, { walkit, webamp: walkit });
    }
  }
}

function containerOf(key: WindowId): string {
  return (
    Object.keys(WINDOW_OF_CONTAINER).find(
      (c) => WINDOW_OF_CONTAINER[c] === key
    ) ?? key
  );
}
