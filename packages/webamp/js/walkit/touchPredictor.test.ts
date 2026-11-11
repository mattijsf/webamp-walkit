import { TouchPredictor } from "./touchPredictor";

test("a frame between moves shows the finger carried on at its speed", () => {
  const g = new TouchPredictor();
  g.start(100, 50, 0);
  g.move(110, 50, 10);
  g.move(120, 50, 20);
  // 1 px a ms to the right, 8 ms after the last move
  expect(g.predict(28)).toEqual([128, 50]);
});

test("it shows no further ahead than 20 ms", () => {
  const g = new TouchPredictor();
  g.start(100, 50, 0);
  g.move(100, 70, 10);
  expect(g.predict(35)).toEqual([100, 110]);
});

test("a frame right at the last move shows nothing new", () => {
  const g = new TouchPredictor();
  g.start(100, 50, 0);
  g.move(110, 50, 10);
  expect(g.predict(10)).toBeNull();
});

test("a finger that stopped shows where it really is again", () => {
  const g = new TouchPredictor();
  g.start(100, 50, 0);
  g.move(110, 50, 10);
  expect(g.predict(20)).toEqual([120, 50]);
  expect(g.predict(60)).toEqual([110, 50]);
  expect(g.predict(70)).toBeNull();
});

test("a press that has not moved, or has let go, shows nothing", () => {
  const g = new TouchPredictor();
  g.start(100, 50, 0);
  expect(g.predict(8)).toBeNull();
  g.move(110, 50, 10);
  g.stop();
  expect(g.predict(18)).toBeNull();
});

test("moves without a start, as a mouse's, show nothing", () => {
  const g = new TouchPredictor();
  g.move(100, 50, 0);
  g.move(110, 50, 10);
  expect(g.predict(18)).toBeNull();
});

test("a move the page heard of late shows where the finger has gone on to since", () => {
  const g = new TouchPredictor();
  g.start(100, 50, 0, 10);
  g.move(110, 50, 10, 20);
  // heard of at 20, made at 10: the finger is 10 px on by now
  expect(g.predict(20)).toEqual([120, 50]);
  expect(g.predict(28)).toEqual([128, 50]);
});
