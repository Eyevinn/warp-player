// CTA-608 → DOM on the true 32×15 grid.
//
// Technique settled by prototype and measurement in Eyevinn/warp-player#160
// (variant D of four that were built and compared):
//
//   per-run boxes at exact widths + ONE probe-derived scaleX per paint
//
//   once per paint:
//     fontSize = cellH * 0.82
//     advance  = probe(font, fontSize)    // offsetWidth of "MMMMMMMMMM" / 10
//     scale    = cellW / advance
//   per style run:
//     box.left  = safe.x + col * cellW;   box.width  = len * cellW
//     box.top   = safe.y + row * cellH;   box.height = cellH
//     box.background = pen.background     // the box IS the background
//     inner.transform = scaleX(scale)
//
// Column positions are *never* measured — they are arithmetic — so they stay
// exact under any font. dash.js #5078's whole-row scaleX was rejected: it
// holds only under a uniform glyph advance and drifted −0.54 cell under Arial.
// A CSS grid with one node per cell was rejected at 466 nodes / 1.20 ms
// against this technique's 30 nodes / 0.40 ms.
//
// Two cml-608 traps this file exists to survive:
//
//   * `StyledUnicodeChar.isEmpty()` is `uchar === " " && penState.isDefault()`,
//     and `isDefault()` means white-on-black. A *written* space in default-
//     styled text is therefore indistinguishable from untouched padding, so
//     painting per non-empty cell tears the background box at every space —
//     exactly mlmpub's white-on-black clock row. Rule: paint the whole span
//     from a row's first to its last non-empty cell.
//   * `setPAC` stamps a pen onto the cell under the cursor before any
//     character is written, so a PAC *creates* a non-empty cell that can sit
//     far from the caption. A naive first..last span then bars the whole row.
//     Guard: split the span at gaps of more than MAX_EMPTY_GAP empty cells.

import {
  CC608_COLS,
  CC608_ROWS,
  type Cc608Cell,
  type Cc608PenState,
  type Cc608Snapshot,
} from "../../cc608/types";
import type { MediaRect, OverlayRenderer, PresentationMs } from "../index";

/** CTA-608 safe area: the centred 80% of the picture. */
export const SAFE_AREA_FRACTION = 0.8;

/** Glyph height as a fraction of the cell height. */
export const FONT_SIZE_RATIO = 0.82;

/**
 * A span is split when more than this many consecutive empty cells appear.
 * Guards the stray cell a non-indent PAC leaves behind.
 */
export const MAX_EMPTY_GAP = 2;

/**
 * Monospace stack. Positions do not depend on it, but glyphs only *fill*
 * their cells under a uniform advance; a proportional fallback degrades
 * typographically and nothing else.
 */
export const CC608_FONT_STACK =
  'ui-monospace, "Cascadia Mono", "Segoe UI Mono", "Roboto Mono", Menlo, Monaco, Consolas, "Courier New", monospace';

/** cml colour names → CSS. */
const FOREGROUND_COLORS: Record<string, string> = {
  white: "#ffffff",
  green: "#00ff00",
  blue: "#0000ff",
  cyan: "#00ffff",
  red: "#ff0000",
  yellow: "#ffff00",
  magenta: "#ff00ff",
  black: "#000000",
};

const BACKGROUND_COLORS: Record<string, string> = {
  ...FOREGROUND_COLORS,
  transparent: "transparent",
};

export function foregroundCss(name: string): string {
  return FOREGROUND_COLORS[name] ?? FOREGROUND_COLORS.white;
}

export function backgroundCss(name: string): string {
  return BACKGROUND_COLORS[name] ?? "transparent";
}

/** The 32×15 caption grid over the safe area of a picture rect. */
export interface Cc608Grid {
  x: number;
  y: number;
  w: number;
  h: number;
  cellW: number;
  cellH: number;
}

/** The safe-area grid for a picture rect. */
export function computeGrid(rect: MediaRect): Cc608Grid {
  const w = rect.w * SAFE_AREA_FRACTION;
  const h = rect.h * SAFE_AREA_FRACTION;
  return {
    x: rect.x + (rect.w - w) / 2,
    y: rect.y + (rect.h - h) / 2,
    w,
    h,
    cellW: w / CC608_COLS,
    cellH: h / CC608_ROWS,
  };
}

/**
 * cml's emptiness test, reproduced on the snapshot: a cell is empty only if
 * it is a space *and* fully default-styled (white on black, no decoration).
 */
export function isEmptyCell(cell: Cc608Cell | undefined): boolean {
  if (!cell) {
    return true;
  }
  const pen = cell.pen;
  return (
    cell.uchar === " " &&
    pen.foreground === "white" &&
    pen.background === "black" &&
    !pen.underline &&
    !pen.italics &&
    !pen.flash
  );
}

/** A painted stretch of a row, inclusive of both ends. */
export interface Cc608Segment {
  first: number;
  last: number;
}

/**
 * The painted segments of a row: first..last non-empty cell as ONE segment
 * (so default-styled spaces inside the caption keep their background), split
 * wherever more than MAX_EMPTY_GAP consecutive empty cells appear.
 */
export function rowSegments(
  cells: Cc608Cell[],
  maxGap: number = MAX_EMPTY_GAP,
): Cc608Segment[] {
  const painted: number[] = [];
  for (let col = 0; col < CC608_COLS; col++) {
    if (!isEmptyCell(cells[col])) {
      painted.push(col);
    }
  }
  if (painted.length === 0) {
    return [];
  }
  const segments: Cc608Segment[] = [];
  let first = painted[0];
  let prev = painted[0];
  for (let i = 1; i < painted.length; i++) {
    const col = painted[i];
    if (col - prev - 1 > maxGap) {
      segments.push({ first, last: prev });
      first = col;
    }
    prev = col;
  }
  segments.push({ first, last: prev });
  return segments;
}

/** True when two pen states paint identically. */
export function samePen(a: Cc608PenState, b: Cc608PenState): boolean {
  return (
    a.foreground === b.foreground &&
    a.background === b.background &&
    a.underline === b.underline &&
    a.italics === b.italics &&
    a.flash === b.flash
  );
}

/** A maximal stretch of cells sharing one pen state. */
export interface Cc608Run {
  col: number;
  len: number;
  text: string;
  pen: Cc608PenState;
}

/** Split `[first..last]` into runs of identical pen state. */
export function styleRuns(
  cells: Cc608Cell[],
  first: number,
  last: number,
): Cc608Run[] {
  const runs: Cc608Run[] = [];
  let current: Cc608Run | null = null;
  for (let col = first; col <= last; col++) {
    const cell = cells[col];
    if (!cell) {
      continue;
    }
    if (current && samePen(current.pen, cell.pen)) {
      current.text += cell.uchar;
      current.len += 1;
      continue;
    }
    current = { col, len: 1, text: cell.uchar, pen: cell.pen };
    runs.push(current);
  }
  return runs;
}

/** One absolutely-positioned run box, fully resolved to CSS pixels. */
export interface Cc608Box {
  row: number;
  col: number;
  len: number;
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  color: string;
  background: string;
  italics: boolean;
  underline: boolean;
}

/**
 * Turn a snapshot into positioned run boxes. Pure arithmetic — no DOM, no
 * measurement — which is why the column geometry is unit-testable and why it
 * cannot drift with the font.
 */
export function layoutSnapshot(
  snapshot: Cc608Snapshot | null,
  rect: MediaRect,
  maxGap: number = MAX_EMPTY_GAP,
): Cc608Box[] {
  if (!snapshot || snapshot.rows.length === 0) {
    return [];
  }
  const grid = computeGrid(rect);
  const boxes: Cc608Box[] = [];
  for (const { row, cells } of snapshot.rows) {
    if (row < 0 || row >= CC608_ROWS) {
      continue;
    }
    for (const segment of rowSegments(cells, maxGap)) {
      for (const run of styleRuns(cells, segment.first, segment.last)) {
        boxes.push({
          row,
          col: run.col,
          len: run.len,
          text: run.text,
          left: grid.x + run.col * grid.cellW,
          top: grid.y + row * grid.cellH,
          width: run.len * grid.cellW,
          height: grid.cellH,
          color: foregroundCss(run.pen.foreground),
          background: backgroundCss(run.pen.background),
          italics: run.pen.italics,
          underline: run.pen.underline,
        });
      }
    }
  }
  return boxes;
}

const PROBE_TEXT = "MMMMMMMMMM";

/**
 * Measures the mean glyph advance of a font at a size, using one hidden
 * span. Cached on (font, fontSize) because the only thing that changes it is
 * a resize, which changes cellH and therefore fontSize.
 */
class AdvanceProbe {
  private span: HTMLSpanElement | null = null;
  private cacheKey = "";
  private cachedAdvance = 0;

  constructor(private readonly doc: Document) {}

  measure(font: string, fontSizePx: number): number {
    const key = `${font}@${fontSizePx}`;
    if (key === this.cacheKey) {
      return this.cachedAdvance;
    }
    if (!this.span) {
      const span = this.doc.createElement("span");
      span.style.cssText =
        "position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0;";
      span.setAttribute("aria-hidden", "true");
      this.doc.body.appendChild(span);
      this.span = span;
    }
    this.span.style.fontFamily = font;
    this.span.style.fontSize = `${fontSizePx}px`;
    this.span.textContent = PROBE_TEXT;
    this.cachedAdvance = this.span.offsetWidth / PROBE_TEXT.length;
    this.cacheKey = key;
    return this.cachedAdvance;
  }

  dispose(): void {
    this.span?.remove();
    this.span = null;
    this.cacheKey = "";
    this.cachedAdvance = 0;
  }
}

export interface Cta608RendererOptions {
  /** Font stack for the caption glyphs. Must be monospace to fill cells. */
  fontFamily?: string;
  /** Split spans at gaps wider than this many empty cells. */
  maxEmptyGap?: number;
}

/**
 * Paints a `Cc608Snapshot` as positioned DOM. Stateless with respect to
 * caption modes: pop-on, roll-up and paint-on all arrive as complete screens
 * from the decoder, so each screen is painted whole. Screens are never
 * merged or de-duplicated here (dash.js #5078's first lesson).
 */
export class Cta608Renderer implements OverlayRenderer<Cc608Snapshot | null> {
  private root: HTMLElement | null = null;
  private probe: AdvanceProbe | null = null;
  private readonly fontFamily: string;
  private readonly maxEmptyGap: number;

  constructor(options: Cta608RendererOptions = {}) {
    this.fontFamily = options.fontFamily ?? CC608_FONT_STACK;
    this.maxEmptyGap = options.maxEmptyGap ?? MAX_EMPTY_GAP;
  }

  mount(root: HTMLElement): void {
    this.root = root;
    root.style.position = "absolute";
    root.style.inset = "0";
    root.style.pointerEvents = "none";
    root.style.fontFamily = this.fontFamily;
    this.probe = new AdvanceProbe(root.ownerDocument);
  }

  render(
    snapshot: Cc608Snapshot | null,
    rect: MediaRect,
    _nowMs: PresentationMs,
  ): void {
    const root = this.root;
    if (!root) {
      return;
    }
    const boxes = layoutSnapshot(snapshot, rect, this.maxEmptyGap);
    if (boxes.length === 0) {
      root.replaceChildren();
      return;
    }

    const grid = computeGrid(rect);
    const fontSize = grid.cellH * FONT_SIZE_RATIO;
    const advance = this.probe?.measure(this.fontFamily, fontSize) ?? 0;
    // One scale for the whole paint, so letterforms stay uniform across runs
    // — which per-run fitting (prototype variant C) does not achieve.
    const scale = advance > 0 ? grid.cellW / advance : 1;

    const doc = root.ownerDocument;
    const fragment = doc.createDocumentFragment();
    for (const box of boxes) {
      fragment.appendChild(this.buildBox(doc, box, fontSize, scale));
    }
    root.replaceChildren(fragment);
  }

  unmount(): void {
    this.root?.replaceChildren();
    this.probe?.dispose();
    this.probe = null;
    this.root = null;
  }

  private buildBox(
    doc: Document,
    box: Cc608Box,
    fontSize: number,
    scale: number,
  ): HTMLElement {
    const el = doc.createElement("div");
    el.style.position = "absolute";
    // The box IS the background: its width is len * cellW by construction, so
    // contiguity never depends on a text measurement.
    el.style.overflow = "hidden";
    el.style.left = `${box.left}px`;
    el.style.top = `${box.top}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    el.style.background = box.background;

    const inner = doc.createElement("span");
    inner.style.position = "absolute";
    inner.style.left = "0";
    inner.style.top = "0";
    inner.style.whiteSpace = "pre";
    inner.style.transformOrigin = "left top";
    inner.style.transform = `scaleX(${scale})`;
    inner.style.fontFamily = this.fontFamily;
    inner.style.fontSize = `${fontSize}px`;
    inner.style.lineHeight = `${box.height}px`;
    inner.style.color = box.color;
    if (box.italics) {
      inner.style.fontStyle = "italic";
    }
    if (box.underline) {
      inner.style.textDecoration = "underline";
    }
    inner.textContent = box.text;
    el.appendChild(inner);
    return el;
  }
}
