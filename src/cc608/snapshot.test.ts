/**
 * Snapshot semantics, plus the three @svta/cml-608 behaviours the snapshot
 * exists to absorb. Each trap is asserted against the live library so the
 * tests fail loudly if a future cml release changes the contract.
 */
import { CaptionScreen, PenState, Row, type PACData } from "@svta/cml-608";

import {
  CC608_DEFAULT_PEN,
  snapshotIsEmpty,
  snapshotRowText,
  snapshotScreen,
  snapshotsEqual,
  snapshotText,
} from "./snapshot";
import { CC608_COLS, CC608_ROWS } from "./types";

/**
 * Note on `indent`: when it is non-null cml *overwrites* `color` with the
 * foreground already present at the preceding cell, so tests that care about
 * the colour must pass `indent: null`.
 */
function pac(row: number, overrides: Partial<PACData> = {}): PACData {
  return {
    row: row + 1, // cml subtracts one: PAC row numbers are 1-based
    indent: null,
    color: "white",
    underline: false,
    italics: false,
    ...overrides,
  };
}

function writeText(screen: CaptionScreen, row: number, text: string): void {
  screen.setPAC(pac(row));
  for (const ch of text) {
    screen.insertChar(ch.charCodeAt(0));
  }
}

describe("cc608 snapshot", () => {
  test("an untouched screen snapshots to no rows", () => {
    const snapshot = snapshotScreen(new CaptionScreen());
    expect(snapshot.rows).toEqual([]);
    expect(snapshotIsEmpty(snapshot)).toBe(true);
    expect(snapshotIsEmpty(null)).toBe(true);
  });

  test("a written row is captured with all 32 cells and its row index", () => {
    const screen = new CaptionScreen();
    writeText(screen, 10, "HELLO");

    const snapshot = snapshotScreen(screen);
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].row).toBe(10);
    expect(snapshot.rows[0].cells).toHaveLength(CC608_COLS);
    expect(snapshotRowText(snapshot.rows[0])).toBe("HELLO");
    expect(snapshotText(snapshot)).toBe("HELLO");
    expect(snapshotIsEmpty(snapshot)).toBe(false);
  });

  test("the snapshot does not alias the live screen", () => {
    const screen = new CaptionScreen();
    writeText(screen, 3, "FIRST");
    const snapshot = snapshotScreen(screen);

    // The library reuses and mutates its CaptionScreen objects; the very
    // thing snapshotScreen() exists to defend against.
    screen.reset();
    writeText(screen, 3, "SECOND");

    expect(snapshotRowText(snapshot.rows[0])).toBe("FIRST");
  });

  describe("cml trap 1: Row.chars is 100 wide, not 32", () => {
    test("the library really does allocate 100 columns", () => {
      expect(new Row().chars.length).toBe(100);
      expect(new CaptionScreen().rows.length).toBe(CC608_ROWS);
    });

    test("only columns 0..31 are snapshotted", () => {
      const screen = new CaptionScreen();
      writeText(screen, 0, "X");
      // Poke a cell outside the 608 grid directly; a 32-column renderer
      // must never see it.
      const pen = new PenState();
      pen.setStyles({ foreground: "red" });
      screen.rows[1].chars[40].setChar("Z", pen);

      const snapshot = snapshotScreen(screen);
      expect(snapshot.rows.map((r) => r.row)).toEqual([0]);
      expect(snapshot.rows[0].cells).toHaveLength(CC608_COLS);
    });
  });

  describe("cml trap 2: a default-styled space is indistinguishable from an untouched cell", () => {
    test("isEmpty() is uchar === ' ' && penState.isDefault()", () => {
      const screen = new CaptionScreen();
      writeText(screen, 5, "  ");
      // Two written spaces in default style: cml calls the row empty, and
      // so do we — adopting the library's definition rather than a second
      // one that would disagree with row.isEmpty() / screen.isEmpty().
      expect(screen.isEmpty()).toBe(true);
      expect(snapshotScreen(screen).rows).toEqual([]);
    });

    test("a space with a non-default pen is NOT empty", () => {
      const screen = new CaptionScreen();
      screen.setPAC(pac(5, { color: "blue" }));
      screen.insertChar(" ".charCodeAt(0));

      const snapshot = snapshotScreen(screen);
      expect(snapshot.rows).toHaveLength(1);
      expect(snapshot.rows[0].row).toBe(5);
      expect(snapshot.rows[0].cells[0]).toEqual({
        uchar: " ",
        pen: { ...CC608_DEFAULT_PEN, foreground: "blue" },
      });
    });
  });

  describe("cml trap 3: setPAC stamps the pen before any character is written", () => {
    test("a bare non-default PAC leaves a stray non-empty cell", () => {
      const screen = new CaptionScreen();
      screen.setPAC(pac(11, { indent: 8, underline: true }));
      // Not a single character written, yet the row is occupied.
      expect(screen.isEmpty()).toBe(false);

      const snapshot = snapshotScreen(screen);
      expect(snapshot.rows).toHaveLength(1);
      expect(snapshot.rows[0].row).toBe(11);

      const occupied = snapshot.rows[0].cells
        .map((cell, col) => ({ cell, col }))
        .filter(({ cell }) => cell.uchar !== " " || cell.pen.underline);
      expect(occupied).toHaveLength(1);
      expect(occupied[0].col).toBe(8);
      expect(occupied[0].cell.pen.underline).toBe(true);
      // Painting decisions (span fill, where the caption box starts) belong
      // to the renderer, so the snapshot keeps the stray cell rather than
      // guessing it away.
      expect(snapshotRowText(snapshot.rows[0])).toBe("");
    });
  });

  describe("snapshotsEqual", () => {
    test("null equals only null", () => {
      const screen = new CaptionScreen();
      writeText(screen, 1, "A");
      expect(snapshotsEqual(null, null)).toBe(true);
      expect(snapshotsEqual(null, snapshotScreen(screen))).toBe(false);
      expect(snapshotsEqual(snapshotScreen(screen), null)).toBe(false);
    });

    test("same text on the same row is equal, different row is not", () => {
      const a = new CaptionScreen();
      writeText(a, 4, "SAME");
      const b = new CaptionScreen();
      writeText(b, 4, "SAME");
      const c = new CaptionScreen();
      writeText(c, 5, "SAME");

      expect(snapshotsEqual(snapshotScreen(a), snapshotScreen(b))).toBe(true);
      expect(snapshotsEqual(snapshotScreen(a), snapshotScreen(c))).toBe(false);
    });

    test("pen differences are content differences", () => {
      const a = new CaptionScreen();
      writeText(a, 4, "SAME");
      const b = new CaptionScreen();
      b.setPAC(pac(4, { color: "green" }));
      for (const ch of "SAME") {
        b.insertChar(ch.charCodeAt(0));
      }

      const sa = snapshotScreen(a);
      const sb = snapshotScreen(b);
      expect(snapshotRowText(sa.rows[0])).toBe(snapshotRowText(sb.rows[0]));
      expect(snapshotsEqual(sa, sb)).toBe(false);
    });
  });
});
