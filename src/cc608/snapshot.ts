/**
 * Turning a live `@svta/cml-608` `CaptionScreen` into an immutable
 * {@link Cc608Snapshot}.
 *
 * Three cml behaviours shape this code; each is covered by a test in
 * `snapshot.test.ts`:
 *
 * 1. `Row.chars` is **100** entries wide (`NR_COLS = 100` in the library),
 *    not the 32 the class docstring claims. CTA-608 is a 32-column grid, so
 *    only columns 0..31 are read and anything beyond is ignored.
 * 2. `StyledUnicodeChar.isEmpty()` is `uchar === " " && penState.isDefault()`,
 *    and `isDefault()` means white-on-black with no attributes. A written
 *    space in default-styled text is therefore indistinguishable from an
 *    untouched cell. We adopt cml's definition rather than inventing a
 *    second one.
 * 3. `CaptionScreen.setPAC` stamps the pen onto the cell under the cursor
 *    *before* any character is written, so a non-default PAC can leave a
 *    stray non-empty cell on an otherwise blank row.
 *
 * Because of (3) the snapshot deliberately records every row that has any
 * non-empty cell, with all 32 cells present, and leaves painting decisions
 * (span fill, background boxes, safe-area placement) to the renderer.
 */
import type { CaptionScreen } from "@svta/cml-608";

import {
  CC608_COLS,
  CC608_ROWS,
  type Cc608Cell,
  type Cc608PenState,
  type Cc608Row,
  type Cc608Snapshot,
} from "./types";

/** cml's `PenState` defaults, i.e. what `PenState.isDefault()` tests for. */
export const CC608_DEFAULT_PEN: Cc608PenState = {
  foreground: "white",
  background: "black",
  underline: false,
  italics: false,
  flash: false,
};

function emptyCell(): Cc608Cell {
  return { uchar: " ", pen: { ...CC608_DEFAULT_PEN } };
}

/**
 * Deep-copy the parts of a `CaptionScreen` a renderer can use.
 *
 * MUST be called synchronously from the `newCue` handler: the screen handed
 * over is either `lastOutputScreen` or the live `displayedMemory`, both of
 * which the library mutates immediately afterwards.
 */
export function snapshotScreen(screen: CaptionScreen): Cc608Snapshot {
  const rows: Cc608Row[] = [];
  const nrRows = Math.min(screen.rows.length, CC608_ROWS);

  for (let r = 0; r < nrRows; r++) {
    const srcChars = screen.rows[r]?.chars;
    if (!srcChars) {
      continue;
    }

    // Cheap occupancy scan first so the common case (13 of 15 rows blank)
    // allocates nothing. Only columns 0..31 count — see trap (1).
    let occupied = false;
    const cols = Math.min(CC608_COLS, srcChars.length);
    for (let c = 0; c < cols; c++) {
      if (!srcChars[c].isEmpty()) {
        occupied = true;
        break;
      }
    }
    if (!occupied) {
      continue;
    }

    const cells: Cc608Cell[] = new Array(CC608_COLS);
    for (let c = 0; c < CC608_COLS; c++) {
      const ch = srcChars[c];
      cells[c] = ch
        ? {
            uchar: ch.uchar,
            pen: {
              foreground: ch.penState.foreground,
              background: ch.penState.background,
              underline: ch.penState.underline,
              italics: ch.penState.italics,
              flash: ch.penState.flash,
            },
          }
        : emptyCell();
    }
    rows.push({ row: r, cells });
  }

  return { rows };
}

/** True when the snapshot has no row worth rendering. */
export function snapshotIsEmpty(snapshot: Cc608Snapshot | null): boolean {
  return snapshot === null || snapshot.rows.length === 0;
}

function pensEqual(a: Cc608PenState, b: Cc608PenState): boolean {
  return (
    a.foreground === b.foreground &&
    a.background === b.background &&
    a.underline === b.underline &&
    a.italics === b.italics &&
    a.flash === b.flash
  );
}

/**
 * Content equality, used to suppress the re-push of a screen identical to
 * the one already displayed. `null` (overlay cleared) equals only `null`.
 */
export function snapshotsEqual(
  a: Cc608Snapshot | null,
  b: Cc608Snapshot | null,
): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null) {
    return false;
  }
  if (a.rows.length !== b.rows.length) {
    return false;
  }
  for (let i = 0; i < a.rows.length; i++) {
    const ra = a.rows[i];
    const rb = b.rows[i];
    if (ra.row !== rb.row || ra.cells.length !== rb.cells.length) {
      return false;
    }
    for (let c = 0; c < ra.cells.length; c++) {
      if (
        ra.cells[c].uchar !== rb.cells[c].uchar ||
        !pensEqual(ra.cells[c].pen, rb.cells[c].pen)
      ) {
        return false;
      }
    }
  }
  return true;
}

/** Plain text of a snapshot row, trailing blanks trimmed. Test/log helper. */
export function snapshotRowText(row: Cc608Row): string {
  return row.cells
    .map((cell) => cell.uchar)
    .join("")
    .replace(/\s+$/, "");
}

/** Plain text of a whole snapshot, one line per non-empty row. */
export function snapshotText(snapshot: Cc608Snapshot): string {
  return snapshot.rows.map(snapshotRowText).join("\n");
}
