/**
 * The cue payloads a text source hands the overlay seam: an imscJS
 * presentation state for TTML, and lines of styled runs for WebVTT.
 *
 * Payloads are immutable, and a receiver hands the *same object* for a cue
 * that continues from one sample to the next. The seam's cue channel compares
 * payloads by reference, so a cue restated in every chunk still paints once.
 */

/** Inline style of a WebVTT run, from its markup and classes. */
export interface RunStyle {
  color?: string;
  backgroundColor?: string;
  fontStyle?: string;
  fontWeight?: string;
  textDecoration?: string;
}

/** A run of text with one style. */
export interface TextRun {
  text: string;
  style: RunStyle;
}

/** One rendered line. */
export type TextLine = TextRun[];

/**
 * A TTML presentation state: the imscJS Intermediate Synchronic Document shown
 * over the cue's interval, painted by imscJS's own HTML renderer.
 */
export interface TtmlCue {
  kind: "ttml";
  /** Content identity: equal keys mean the same thing on screen. */
  key: string;
  isd: ImscIsd;
}

/** WebVTT cue settings (the `sttg` box), as parsed. */
export interface VttSettings {
  /** Line position: an integer line number, or a percentage from the top. */
  line?: { value: number; percent: boolean };
  /** Horizontal position of the cue box, in percent of the picture width. */
  position?: number;
  /** Width of the cue box, in percent of the picture width. */
  size: number;
  align: "start" | "center" | "end" | "left" | "right";
}

/** One WebVTT cue. */
export interface VttCue {
  kind: "vtt";
  key: string;
  id?: string;
  settings: VttSettings;
  lines: TextLine[];
}

export type SubtitleCue = TtmlCue | VttCue;
