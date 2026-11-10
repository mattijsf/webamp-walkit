// Windows docked in one skin stay docked in the next: each keeps the edge of the window it
// hung off and its offset along that edge, whatever sizes the new skin gives them.

export type Box = { x: number; y: number; width: number; height: number };
type Edge = "below" | "above" | "right" | "left";

export function toBox(r: {
  left: number;
  top: number;
  width: number;
  height: number;
}): Box {
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

export type Hang = { parent: string; edge: Edge; along: number };

function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 <= b1 && b0 <= a1;
}

/** How `w` touches `p`: the edge of `p` it hangs off and its offset along it, or null. */
function touching(w: Box, p: Box): Omit<Hang, "parent"> | null {
  const across = overlaps(w.x, w.x + w.width, p.x, p.x + p.width);
  const along = overlaps(w.y, w.y + w.height, p.y, p.y + p.height);
  if (across && w.y === p.y + p.height)
    return { edge: "below", along: w.x - p.x };
  if (across && w.y + w.height === p.y)
    return { edge: "above", along: w.x - p.x };
  if (along && w.x === p.x + p.width)
    return { edge: "right", along: w.y - p.y };
  if (along && w.x + w.width === p.x) return { edge: "left", along: w.y - p.y };
  return null;
}

/**
 * The windows hanging off others, outwards from `root`: each with the one it touched first. A
 * window folded to nothing (a skin had none) keeps what touched its spot: a window there
 * hangs off it rather than off the one it folded against.
 */
export function hangers(
  boxes: Map<string, Box>,
  root: string
): Map<string, Hang> {
  const out = new Map<string, Hang>();
  if (!boxes.has(root)) return out;
  const reached = [root];
  for (let i = 0; i < reached.length; i++) {
    const parent = reached[i];
    const p = boxes.get(parent)!;
    const folded = (b: Box) => b.width === 0 || b.height === 0;
    const near = [...boxes].filter(
      ([key, w]) => !reached.includes(key) && touching(w, p)
    );
    near.sort(([, a], [, b]) => Number(folded(b)) - Number(folded(a)));
    for (const [key, w] of near) {
      if (reached.includes(key)) continue;
      // a window on the edge a folded one hangs off sits on the folded one
      const edge = touching(w, p)!.edge;
      const under = near.find(
        ([k, f]) =>
          k !== key &&
          folded(f) &&
          out.get(k)?.parent === parent &&
          out.get(k)?.edge === edge &&
          touching(w, f)?.edge === edge
      );
      const [from, box] = under ?? [parent, p];
      out.set(key, { parent: from, ...touching(w, box)! });
      reached.push(key);
    }
  }
  return out;
}

/**
 * Where `key` goes in the new skin: against the same edge of the window it hung off before,
 * at its new size. A window the new skin lacks (`size` null) folds to nothing along that
 * edge, so the windows docked to it close up; one that hung off nothing stays where it was.
 */
export function docked(
  key: string,
  before: Map<string, Box>,
  hang: Map<string, Hang>,
  size: (of: string) => { width: number; height: number } | null,
  placed: Map<string, Box>
): Box {
  const own = placed.get(key);
  if (own) return own;
  const was = before.get(key)!;
  const h = hang.get(key);
  const s = size(key);
  const vertical = h?.edge === "below" || h?.edge === "above";
  const wh = s ?? {
    width: vertical ? was.width : 0,
    height: vertical ? 0 : was.height,
  };
  let box: Box;
  if (!h) {
    box = { x: was.x, y: was.y, ...wh };
  } else {
    const p = docked(h.parent, before, hang, size, placed);
    const at = {
      below: { x: p.x + h.along, y: p.y + p.height },
      above: { x: p.x + h.along, y: p.y - wh.height },
      right: { x: p.x + p.width, y: p.y + h.along },
      left: { x: p.x - wh.width, y: p.y + h.along },
    }[h.edge];
    box = { ...at, ...wh };
  }
  // a folded window keeps its spot, for the windows docked to it and the next skin
  if (!s) placed.set(key, box);
  return box;
}

function overlapping(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Moves each of `keys` that hangs off a side of its window out past any window it would lie
 * on, the windows hanging off it moving along: a skin whose playlist is wider than its main
 * window pushes the window docked to the main window's right out to the playlist's right.
 * Windows hanging above or below move up or down the same way. Answers the windows it moved.
 */
export function separate(
  boxes: Map<string, Box>,
  hang: Map<string, Hang>,
  keys: string[]
): Set<string> {
  const moved = new Set<string>();
  const under = (key: string, root: string): boolean => {
    for (let k: string | undefined = key; k; k = hang.get(k)?.parent) {
      if (k === root) return true;
    }
    return false;
  };
  // the windows on a side move first, so a stack under the main window keeps its place
  const side = (k: string) =>
    hang.get(k)?.edge === "right" || hang.get(k)?.edge === "left" ? 0 : 1;
  for (const key of [...keys].sort((a, b) => side(a) - side(b))) {
    const h = hang.get(key);
    if (!h) continue;
    // a bounded number of steps: each one moves the window past one other
    for (let step = 0; step < boxes.size; step++) {
      const b = boxes.get(key)!;
      const other = [...boxes].find(
        ([k, o]) =>
          !under(k, key) && o.width > 0 && o.height > 0 && overlapping(b, o)
      );
      if (!other) break;
      const o = other[1];
      const dx = {
        right: o.x + o.width - b.x,
        left: o.x - b.width - b.x,
        below: 0,
        above: 0,
      }[h.edge];
      const dy = {
        below: o.y + o.height - b.y,
        above: o.y - b.height - b.y,
        right: 0,
        left: 0,
      }[h.edge];
      for (const [k, w] of boxes) {
        if (under(k, key)) boxes.set(k, { ...w, x: w.x + dx, y: w.y + dy });
      }
      moved.add(key);
    }
  }
  return moved;
}
