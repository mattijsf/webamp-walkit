// SPDX-License-Identifier: GPL-3.0-or-later

// A classic skin's cursors, as Winamp shows them over each part of a window: the
// skin's picture when it has one (animated for an .ani), else the browser's of its kind.

const KINDS = ["default", "move", "ew-resize", "ns-resize", "pointer", "nwse-resize"];

function frameUrl(f, zoom) {
  const small = document.createElement("canvas");
  small.width = f.w;
  small.height = f.h;
  const data = new ImageData(f.w, f.h);
  for (let i = 0; i < f.argb.length; i++) {
    const v = f.argb[i];
    data.data[i * 4] = (v >>> 16) & 255;
    data.data[i * 4 + 1] = (v >>> 8) & 255;
    data.data[i * 4 + 2] = v & 255;
    data.data[i * 4 + 3] = v >>> 24;
  }
  small.getContext("2d").putImageData(data, 0, 0);
  if (zoom === 1) return small.toDataURL();
  const big = document.createElement("canvas");
  big.width = f.w * zoom;
  big.height = f.h * zoom;
  const g = big.getContext("2d");
  g.imageSmoothingEnabled = false;
  g.drawImage(small, 0, 0, big.width, big.height);
  return big.toDataURL();
}

export class SkinCursors {
  constructor(rt) {
    this.rt = rt;
    this.made = new Map();
    this.slot = -2;
    this.el = null;
    this.timer = 0;
  }

  /** The CSS cursors of `slot`'s frames at `zoom`, with the steps; null when the skin has no picture for it. */
  frames(slot, zoom) {
    const key = `${slot}@${zoom}`;
    if (this.made.has(key)) return this.made.get(key);
    const img = this.rt.cursorImage(slot);
    let made = null;
    if (img) {
      const kind = KINDS[this.rt.cursorKind(slot)];
      const urls = img.frames.map((f) => `url(${frameUrl(f, zoom)}) ${f.hx * zoom} ${f.hy * zoom}, ${kind}`);
      made = { urls, steps: img.steps };
    }
    this.made.set(key, made);
    return made;
  }

  /** Shows on `el` the cursor the skin has at `x`, `y` of the stack, its pictures `zoom` times their size. */
  show(el, x, y, zoom = 1) {
    const slot = this.rt.cursorAt(x, y);
    if (slot === this.slot && el === this.el) return;
    this.slot = slot;
    this.el = el;
    clearTimeout(this.timer);
    if (slot < 0) {
      el.style.cursor = "";
      return;
    }
    const z = Math.max(1, Math.min(4, Math.floor(zoom)));
    const made = this.frames(slot, z);
    if (!made) {
      el.style.cursor = KINDS[this.rt.cursorKind(slot)];
      return;
    }
    let step = 0;
    const next = () => {
      const [frame, ms] = made.steps[step];
      el.style.cursor = made.urls[frame] || made.urls[0];
      if (made.steps.length > 1 && this.slot === slot) {
        step = (step + 1) % made.steps.length;
        this.timer = setTimeout(next, Math.max(ms, 16));
      }
    };
    next();
  }

  /** Gives `el` back its CSS cursor, as when the pointer leaves it. */
  hide(el) {
    el.style.cursor = "";
    if (el !== this.el) return;
    this.slot = -2;
    clearTimeout(this.timer);
  }
}
