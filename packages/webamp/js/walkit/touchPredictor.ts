// Firefox on Android sends fewer touch moves than the screen draws, and late, so a dragged
// window stalls and jumps. Each frame shows the finger moved on at its recent speed instead.

const MAX_AHEAD_MS = 20;
const SPEED_WINDOW_MS = 32;
// no move for this long: the finger stopped, show its real position
const STOPPED_MS = 40;

// t: when the finger was there, at: when the page received it
type Move = { x: number; y: number; t: number; at: number };

export class TouchPredictor {
  private moves: Move[] = [];
  private shown: Move | null = null;

  start(x: number, y: number, t: number, at = t) {
    this.moves = [{ x, y, t, at }];
    this.shown = this.moves[0];
  }

  move(x: number, y: number, t: number, at = t) {
    if (!this.moves.length) return;
    const m = { x, y, t, at };
    this.moves.push(m);
    while (this.moves.length > 2 && t - this.moves[0].t > SPEED_WINDOW_MS) {
      this.moves.shift();
    }
    this.shown = m;
  }

  stop() {
    this.moves = [];
    this.shown = null;
  }

  /** The position to show at `now`, or null if it hasn't changed. */
  predict(now: number): [number, number] | null {
    const last = this.moves[this.moves.length - 1];
    if (!last || !this.shown) return null;
    let x = last.x;
    let y = last.y;
    if (now - last.at <= STOPPED_MS) {
      const first = this.moves[0];
      const span = last.t - first.t;
      if (span <= 0) return null;
      const ahead = Math.min(Math.max(0, now - last.t), MAX_AHEAD_MS);
      x = Math.round(last.x + ((last.x - first.x) / span) * ahead);
      y = Math.round(last.y + ((last.y - first.y) / span) * ahead);
    }
    if (x === this.shown.x && y === this.shown.y) return null;
    this.shown = { x, y, t: now, at: now };
    return [x, y];
  }
}
