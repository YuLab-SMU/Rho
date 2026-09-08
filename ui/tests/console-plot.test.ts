import { expect, it } from "vitest";
import { TerminalText } from "../src/console-text";
import { zoomAt, fitScale, constrain } from "../src/plot-viewport";
it("interprets terminal overwrites and split ANSI without allowing markup execution", () => {
  const terminal = new TerminalText();
  terminal.write("long progress\rDone\x1b[K\n\x1b[3");
  terminal.write(
    "1m<svg onload=evil>\x1b[0m\nabc\bX\x1b]8;;https://example.test\x07safe\x1b]8;;\x07",
  );
  expect(terminal.result().text).toBe("Done\n<svg onload=evil>\nabXsafe");
  expect(terminal.result().colors[0].class).toBe("ansi-31");
});
it("keeps the pointer's plot coordinate fixed during unclamped zoom", () => {
  const image = { width: 1000, height: 800 },
    canvas = { width: 400, height: 300 },
    p = { zoom: 1, x: 0, y: 0 };
  const next = zoomAt(p, 2, { x: 60, y: 25 }, image, canvas);
  expect((60 - next.x) / next.zoom!).toBe(60);
  expect((25 - next.y) / next.zoom!).toBe(25);
  expect(next.zoom).toBe(2);
});
it("bounds zoom and pan while Fit can fall below one percent", () => {
  const image = { width: 100000, height: 100000 },
    canvas = { width: 200, height: 120 };
  expect(fitScale(image, canvas)).toBeLessThan(0.01);
  expect(
    zoomAt({ zoom: 1, x: 0, y: 0 }, 50, { x: 0, y: 0 }, image, canvas).zoom,
  ).toBe(8);
  expect(constrain({ zoom: 1, x: 1e9, y: -1e9 }, image, canvas).x).toBeLessThan(
    1e9,
  );
});
