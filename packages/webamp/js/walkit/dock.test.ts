import { Box, docked, hangers, separate } from "./dock";

// webamp's classic stack: the equalizer and the playlist under the main window, Milkdrop to
// its right
const classic = new Map<string, Box>([
  ["main", { x: 0, y: 0, width: 275, height: 116 }],
  ["equalizer", { x: 0, y: 116, width: 275, height: 116 }],
  ["playlist", { x: 0, y: 232, width: 275, height: 232 }],
  ["milkdrop", { x: 275, y: 0, width: 275, height: 232 }],
]);

function place(sizes: { [key: string]: { width: number; height: number } }) {
  const hang = hangers(classic, "main");
  const placed = new Map<string, Box>();
  const size = (key: string) => sizes[key] ?? null;
  for (const key of ["main", "playlist", "milkdrop"]) {
    if (sizes[key]) placed.set(key, docked(key, classic, hang, size, placed));
  }
  return placed;
}

test("windows keep their docking at a new skin's sizes", () => {
  const placed = place({
    main: { width: 354, height: 280 },
    equalizer: { width: 354, height: 116 },
    playlist: { width: 354, height: 232 },
    milkdrop: { width: 450, height: 464 },
  });
  expect(placed.get("main")).toEqual({ x: 0, y: 0, width: 354, height: 280 });
  expect(placed.get("playlist")).toMatchObject({ x: 0, y: 396 });
  expect(placed.get("milkdrop")).toMatchObject({ x: 354, y: 0 });
});

test("a window the new skin lacks folds up and its neighbors close in", () => {
  // Winamp Modern keeps the equalizer in the main window's drawer
  const placed = place({
    main: { width: 354, height: 280 },
    playlist: { width: 354, height: 232 },
    milkdrop: { width: 450, height: 464 },
  });
  expect(placed.get("playlist")).toMatchObject({ x: 0, y: 280 });
});

test("a window that hung off nothing stays where it was", () => {
  const apart = new Map(classic).set("milkdrop", {
    x: 600,
    y: 300,
    width: 275,
    height: 232,
  });
  const hang = hangers(apart, "main");
  const size = () => ({ width: 450, height: 464 });
  expect(docked("milkdrop", apart, hang, size, new Map())).toMatchObject({
    x: 600,
    y: 300,
  });
});

test("a folded window unfolds where it folded, the windows under it moving down", () => {
  // Winamp Modern: the equalizer folded under the main window, the playlist on its spot
  const modern = new Map<string, Box>([
    ["equalizer", { x: 0, y: 280, width: 354, height: 0 }],
    ["main", { x: 0, y: 0, width: 354, height: 280 }],
    ["playlist", { x: 0, y: 280, width: 354, height: 232 }],
    ["milkdrop", { x: 354, y: 0, width: 450, height: 464 }],
  ]);
  const hang = hangers(modern, "main");
  const sizes: { [key: string]: { width: number; height: number } } = {
    main: { width: 275, height: 116 },
    equalizer: { width: 275, height: 116 },
    playlist: { width: 275, height: 232 },
    milkdrop: { width: 275, height: 232 },
  };
  const placed = new Map<string, Box>();
  for (const key of ["main", "equalizer", "playlist", "milkdrop"]) {
    placed.set(
      key,
      docked(key, modern, hang, (k) => sizes[k], placed)
    );
  }
  expect(placed.get("equalizer")).toMatchObject({ x: 0, y: 116 });
  expect(placed.get("playlist")).toMatchObject({ x: 0, y: 232 });
  expect(placed.get("milkdrop")).toMatchObject({ x: 275, y: 0 });
});

test("a window docked to a side moves out past a wider window under its neighbor", () => {
  // Winamp Modern: the playlist under the main window is wider than it, and the visualizer
  // hangs off the main window's right
  const before = new Map<string, Box>([
    ["main", { x: 0, y: 0, width: 275, height: 116 }],
    ["playlist", { x: 0, y: 116, width: 275, height: 232 }],
    ["milkdrop", { x: 275, y: 0, width: 275, height: 232 }],
  ]);
  const hang = hangers(before, "main");
  const sizes: { [key: string]: { width: number; height: number } } = {
    main: { width: 354, height: 164 },
    playlist: { width: 436, height: 164 },
    milkdrop: { width: 354, height: 280 },
  };
  const boxes = new Map<string, Box>();
  for (const key of ["main", "playlist", "milkdrop"]) {
    boxes.set(
      key,
      docked(key, before, hang, (k) => sizes[k], boxes)
    );
  }
  separate(boxes, hang, ["main", "playlist", "milkdrop"]);
  expect(boxes.get("playlist")).toMatchObject({ x: 0, y: 164 });
  expect(boxes.get("milkdrop")).toMatchObject({ x: 436, y: 0 });
});
