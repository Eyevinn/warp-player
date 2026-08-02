/**
 * Shared CTA-608 seam types.
 *
 * These are the container- and engine-agnostic types every 608 producer
 * (MSE fragments, WebCodecs LOC samples) and every consumer (the overlay
 * layer's caption channel) speaks. Nothing here holds a live
 * `@svta/cml-608` object: the library reuses and mutates its
 * `CaptionScreen` instances, so everything that crosses this seam is a
 * plain immutable snapshot.
 */

export const CC608_COLS = 32;
export const CC608_ROWS = 15;

/** One CTA-608 pen state, copied out of cml's PenState. */
export interface Cc608PenState {
  foreground: string;
  background: string;
  underline: boolean;
  italics: boolean;
  flash: boolean;
}

/** One grid cell. */
export interface Cc608Cell {
  uchar: string;
  pen: Cc608PenState;
}

/** A row with at least one non-empty cell. `cells` is always CC608_COLS long. */
export interface Cc608Row {
  row: number;
  cells: Cc608Cell[];
}

/** Immutable snapshot of a CaptionScreen. Never holds a live cml object. */
export interface Cc608Snapshot {
  rows: Cc608Row[];
}

/** Where a caption source pushes. #164's overlay channel adapts to this. */
export interface Cc608Sink {
  /** `screen === null` clears the overlay from `timeMs` onward. */
  push(timeMs: number, screen: Cc608Snapshot | null): void;
}
