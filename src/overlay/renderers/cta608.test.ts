import {
  CC608_COLS,
  type Cc608Cell,
  type Cc608PenState,
  type Cc608Row,
  type Cc608Snapshot,
} from "../../cc608/types";
import type { MediaRect } from "../index";

import {
  computeGrid,
  isEmptyCell,
  layoutSnapshot,
  rowSegments,
  styleRuns,
} from "./cta608";

/* --- fixtures ---------------------------------------------------------- */

const DEFAULT_PEN: Cc608PenState = {
  foreground: "white",
  background: "black",
  underline: false,
  italics: false,
  flash: false,
};

function pen(overrides: Partial<Cc608PenState> = {}): Cc608PenState {
  return { ...DEFAULT_PEN, ...overrides };
}

function blankCells(): Cc608Cell[] {
  return Array.from({ length: CC608_COLS }, () => ({
    uchar: " ",
    pen: DEFAULT_PEN,
  }));
}

/** Write `text` at `col` with `p`, mimicking cml's per-cell pen stamping. */
function write(
  cells: Cc608Cell[],
  col: number,
  text: string,
  p: Cc608PenState = DEFAULT_PEN,
): Cc608Cell[] {
  for (let i = 0; i < text.length; i++) {
    cells[col + i] = { uchar: text[i], pen: p };
  }
  return cells;
}

function row(index: number, cells: Cc608Cell[]): Cc608Row {
  return { row: index, cells };
}

function screen(...rows: Cc608Row[]): Cc608Snapshot {
  return { rows };
}

/** A 16:9 picture at the origin: whole numbers make the grid maths readable. */
const RECT: MediaRect = { x: 0, y: 0, w: 1280, h: 720 };
const GRID = computeGrid(RECT);

/* --- geometry ---------------------------------------------------------- */

describe("computeGrid", () => {
  it("is the centred 80% of the picture, divided 32 x 15", () => {
    expect(GRID.w).toBeCloseTo(1024, 6);
    expect(GRID.h).toBeCloseTo(576, 6);
    expect(GRID.x).toBeCloseTo(128, 6);
    expect(GRID.y).toBeCloseTo(72, 6);
    expect(GRID.cellW).toBeCloseTo(32, 6);
    expect(GRID.cellH).toBeCloseTo(38.4, 6);
  });

  it("tracks a letterboxed picture rather than the element box", () => {
    // 4:3 picture inside a 16:9 surface (the #160 verification case).
    const rect: MediaRect = { x: 139, y: 0, w: 823, h: 617 };
    const grid = computeGrid(rect);
    expect(grid.x).toBeCloseTo(139 + 823 * 0.1, 6);
    expect(grid.x).toBeCloseTo(221.3, 1);
    // The leftmost caption box starts exactly on the safe-area edge.
    const boxes = layoutSnapshot(
      screen(row(14, write(blankCells(), 0, "X"))),
      rect,
    );
    expect(boxes[0].left).toBeCloseTo(grid.x, 6);
  });
});

/* --- cml emptiness ----------------------------------------------------- */

describe("isEmptyCell", () => {
  it("treats a default-styled space as empty", () => {
    expect(isEmptyCell({ uchar: " ", pen: DEFAULT_PEN })).toBe(true);
    expect(isEmptyCell(undefined)).toBe(true);
  });

  it("treats a styled space as non-empty", () => {
    // This is the trap: cml cannot distinguish a written default-styled
    // space from padding, but a *styled* space is unambiguous.
    expect(isEmptyCell({ uchar: " ", pen: pen({ background: "red" }) })).toBe(
      false,
    );
    expect(isEmptyCell({ uchar: " ", pen: pen({ underline: true }) })).toBe(
      false,
    );
    expect(isEmptyCell({ uchar: "A", pen: DEFAULT_PEN })).toBe(false);
  });
});

/* --- span fill and the max-gap guard ----------------------------------- */

describe("rowSegments", () => {
  it("spans first..last non-empty cell as one segment", () => {
    // mlmpub's clock row: white-on-black text containing real spaces.
    // Painting per non-empty cell would tear the background box at every
    // space, because a default-styled space *is* isEmpty().
    const cells = write(blankCells(), 4, "2026-08-02 11:22:33");
    expect(rowSegments(cells)).toEqual([{ first: 4, last: 22 }]);
  });

  it("returns nothing for an untouched row", () => {
    expect(rowSegments(blankCells())).toEqual([]);
  });

  it("keeps a gap of two empty cells inside one segment", () => {
    const cells = write(blankCells(), 0, "AB");
    write(cells, 4, "CD");
    expect(rowSegments(cells)).toEqual([{ first: 0, last: 5 }]);
  });

  it("splits at a gap wider than the max", () => {
    // A stray cell left by setPAC stamping the pen under the cursor: a
    // naive first..last span would bar the whole row.
    const cells = write(blankCells(), 0, "CAPTION");
    write(cells, 28, " ", pen({ background: "red" }));
    expect(rowSegments(cells)).toEqual([
      { first: 0, last: 6 },
      { first: 28, last: 28 },
    ]);
  });

  it("honours a caller-supplied max gap", () => {
    const cells = write(blankCells(), 0, "CAPTION");
    write(cells, 28, " ", pen({ background: "red" }));
    expect(rowSegments(cells, 100)).toEqual([{ first: 0, last: 28 }]);
  });
});

/* --- style runs -------------------------------------------------------- */

describe("styleRuns", () => {
  it("splits a segment on every pen change", () => {
    const cells = blankCells();
    write(cells, 0, "RED ", pen({ foreground: "red" }));
    write(cells, 4, "GREEN ", pen({ foreground: "green" }));
    write(cells, 10, "CYAN ", pen({ foreground: "cyan" }));
    write(cells, 15, "YELLOW", pen({ foreground: "yellow" }));

    const runs = styleRuns(cells, 0, 20);
    expect(runs.map((r) => [r.col, r.len, r.text])).toEqual([
      [0, 4, "RED "],
      [4, 6, "GREEN "],
      [10, 5, "CYAN "],
      [15, 6, "YELLOW"],
    ]);
  });

  it("keeps one run when the pen never changes", () => {
    const cells = write(blankCells(), 3, "A B C");
    const runs = styleRuns(cells, 3, 7);
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe("A B C");
  });
});

/* --- layout ------------------------------------------------------------ */

describe("layoutSnapshot", () => {
  it("clears on an empty or absent screen", () => {
    expect(layoutSnapshot(null, RECT)).toEqual([]);
    expect(layoutSnapshot(screen(), RECT)).toEqual([]);
    expect(layoutSnapshot(screen(row(0, blankCells())), RECT)).toEqual([]);
  });

  it("places a centred row on exact column boundaries", () => {
    // "HELLO WORLD" (11 chars) centred: col 10..20.
    const boxes = layoutSnapshot(
      screen(row(14, write(blankCells(), 10, "HELLO WORLD"))),
      RECT,
    );
    expect(boxes).toHaveLength(1);
    const box = boxes[0];
    expect(box.col).toBe(10);
    expect(box.len).toBe(11);
    expect(box.left).toBeCloseTo(GRID.x + 10 * GRID.cellW, 6);
    expect(box.width).toBeCloseTo(11 * GRID.cellW, 6);
    expect(box.top).toBeCloseTo(GRID.y + 14 * GRID.cellH, 6);
    expect(box.height).toBeCloseTo(GRID.cellH, 6);
    // The interior space is inside the box, so the background is contiguous.
    expect(box.text).toBe("HELLO WORLD");
  });

  it("puts a left-positioned row on the safe-area left edge", () => {
    const boxes = layoutSnapshot(
      screen(row(0, write(blankCells(), 0, "LEFT"))),
      RECT,
    );
    expect(boxes[0].left).toBeCloseTo(GRID.x, 6);
    expect(boxes[0].top).toBeCloseTo(GRID.y, 6);
  });

  it("ends a right-positioned row exactly on the safe-area right edge", () => {
    const boxes = layoutSnapshot(
      screen(row(14, write(blankCells(), 27, "RIGHT"))),
      RECT,
    );
    const box = boxes[0];
    expect(box.left + box.width).toBeCloseTo(GRID.x + GRID.w, 6);
    expect(box.top + box.height).toBeCloseTo(GRID.y + GRID.h, 6);
  });

  it("spans the full safe-area width for a 32-character row", () => {
    const boxes = layoutSnapshot(
      screen(row(7, write(blankCells(), 0, "X".repeat(CC608_COLS)))),
      RECT,
    );
    expect(boxes).toHaveLength(1);
    expect(boxes[0].left).toBeCloseTo(GRID.x, 6);
    expect(boxes[0].width).toBeCloseTo(GRID.w, 6);
  });

  it("lays multi-run rows out edge to edge with no seams", () => {
    const cells = blankCells();
    write(cells, 0, "RED ", pen({ foreground: "red", background: "black" }));
    write(cells, 4, "GREEN ", pen({ foreground: "green" }));
    write(cells, 10, "CYAN ", pen({ foreground: "cyan" }));
    write(cells, 15, "YELLOW", pen({ foreground: "yellow" }));

    const boxes = layoutSnapshot(screen(row(12, cells)), RECT);
    expect(boxes).toHaveLength(4);
    expect(boxes.map((b) => b.color)).toEqual([
      "#ff0000",
      "#00ff00",
      "#00ffff",
      "#ffff00",
    ]);
    for (let i = 1; i < boxes.length; i++) {
      // Backgrounds are structural: each box starts exactly where the
      // previous one ends, so contiguity never depends on text measurement.
      expect(boxes[i].left).toBeCloseTo(
        boxes[i - 1].left + boxes[i - 1].width,
        6,
      );
      expect(boxes[i].left).toBeCloseTo(GRID.x + boxes[i].col * GRID.cellW, 6);
    }
  });

  it("carries colour, italics and underline onto the box", () => {
    const cells = blankCells();
    write(cells, 0, "IT", pen({ italics: true, foreground: "cyan" }));
    write(cells, 2, "UL", pen({ underline: true }));
    write(cells, 4, "BG", pen({ background: "magenta" }));
    write(cells, 6, "TR", pen({ background: "transparent" }));

    const boxes = layoutSnapshot(screen(row(3, cells)), RECT);
    expect(boxes).toHaveLength(4);
    expect(boxes[0]).toMatchObject({
      text: "IT",
      color: "#00ffff",
      italics: true,
      underline: false,
      background: "#000000",
    });
    expect(boxes[1]).toMatchObject({
      text: "UL",
      underline: true,
      italics: false,
      color: "#ffffff",
    });
    expect(boxes[2].background).toBe("#ff00ff");
    expect(boxes[3].background).toBe("transparent");
  });

  it("falls back safely on an unknown colour name", () => {
    const cells = write(
      blankCells(),
      0,
      "?",
      pen({ foreground: "chartreuse", background: "chartreuse" }),
    );
    const boxes = layoutSnapshot(screen(row(0, cells)), RECT);
    expect(boxes[0].color).toBe("#ffffff");
    expect(boxes[0].background).toBe("transparent");
  });

  it("paints a stray PAC cell as its own box, not a bar across the row", () => {
    const cells = write(blankCells(), 0, "CAPTION TEXT");
    write(cells, 30, " ", pen({ background: "blue" }));

    const boxes = layoutSnapshot(screen(row(14, cells)), RECT);
    expect(boxes).toHaveLength(2);
    expect(boxes[0].len).toBe(12);
    expect(boxes[1]).toMatchObject({ col: 30, len: 1 });
    expect(boxes[1].width).toBeCloseTo(GRID.cellW, 6);
  });

  it("ignores rows outside the 15-row grid", () => {
    const cells = write(blankCells(), 0, "OFF");
    expect(layoutSnapshot(screen(row(15, cells)), RECT)).toEqual([]);
    expect(layoutSnapshot(screen(row(-1, cells)), RECT)).toEqual([]);
  });

  it("paints each roll-up step as a complete screen", () => {
    // Roll-up arrives from the decoder as whole screens; the renderer is
    // stateless and never merges or de-duplicates them (dash.js #5078).
    const step = (lines: string[]): Cc608Snapshot =>
      screen(
        ...lines.map((text, i) =>
          row(15 - lines.length + i, write(blankCells(), 0, text)),
        ),
      );

    const first = layoutSnapshot(step(["LINE ONE"]), RECT);
    expect(first.map((b) => b.row)).toEqual([14]);
    expect(first.map((b) => b.text)).toEqual(["LINE ONE"]);

    const second = layoutSnapshot(step(["LINE ONE", "LINE TWO"]), RECT);
    expect(second.map((b) => b.row)).toEqual([13, 14]);
    expect(second.map((b) => b.text)).toEqual(["LINE ONE", "LINE TWO"]);

    const third = layoutSnapshot(
      step(["LINE ONE", "LINE TWO", "LINE THREE"]),
      RECT,
    );
    expect(third.map((b) => b.row)).toEqual([12, 13, 14]);
    // Each step is laid out independently: row 14 moved up two rows and the
    // vertical positions follow, with no state carried between paints.
    expect(third[0].top).toBeCloseTo(GRID.y + 12 * GRID.cellH, 6);
    expect(third[2].top).toBeCloseTo(GRID.y + 14 * GRID.cellH, 6);
  });

  it("scales with the picture rect on resize", () => {
    const half: MediaRect = { x: 0, y: 0, w: 640, h: 360 };
    const snapshot = screen(row(14, write(blankCells(), 4, "ABC")));
    const big = layoutSnapshot(snapshot, RECT)[0];
    const small = layoutSnapshot(snapshot, half)[0];
    expect(small.left).toBeCloseTo(big.left / 2, 6);
    expect(small.width).toBeCloseTo(big.width / 2, 6);
    expect(small.height).toBeCloseTo(big.height / 2, 6);
  });
});
