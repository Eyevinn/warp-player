// The overlay seam — the single contract between anything that produces
// timed presentation state (CTA-608, WebVTT, IMSC-1, ograf) and anything
// that paints it over the picture.
//
// Settled in Eyevinn/warp-player#159. The shape in one paragraph:
//
//   A *channel* is how a source feeds the seam. It comes in two modes.
//   "state" channels (`push`) carry open-ended state that is superseded by
//   the next push — CTA-608 has no end times, so this is its only option.
//   "cues" channels (`addCue`) carry intervals, and the seam composes
//   overlapping cues into an active set. Both normalise onto one internal
//   snapshot timeline that is resolved **by search** at the playhead, so
//   pauses, rate changes, seeks and discontinuities need no special case.
//
//   The clock is the *picture clock* — the presentation time of the frame
//   actually on screen (`IPlaybackPipeline.getPresentationTimeMs()`). It
//   freezes on a stall, so both render engines behave identically.
//
//   A *renderer* owns a DOM subtree and is called on change only, never per
//   frame. It lays out inside the `MediaRect` — the letterboxed picture box
//   inside the active surface — and never inside the element box.

/** Presentation time in ms on the media timeline (UTC-epoch under mlmpub). */
export type PresentationMs = number;

/**
 * The picture box inside the overlay container, in CSS pixels relative to
 * the container's top-left corner. Derived from the active surface's
 * intrinsic size under `object-fit: contain`, so it excludes letterbox and
 * pillarbox bars.
 */
export interface MediaRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Channel modes. See the file header. */
export type ChannelMode = "state" | "cues";

/**
 * Open-ended state: each push supersedes the previous one from `fromMs`
 * onward. `null` clears. Used by CTA-608 and (in future) ograf.
 */
export interface StateChannel<T> {
  readonly mode: "state";
  push(fromMs: PresentationMs, payload: T | null): void;
  clear(): void;
}

/**
 * Interval cues: the seam composes overlapping cues into the active set at
 * every change point. Used by WebVTT and IMSC-1.
 */
export interface CueChannel<T> {
  readonly mode: "cues";
  addCue(startMs: PresentationMs, endMs: PresentationMs, payload: T): void;
  clear(): void;
}

export type Channel<T> = StateChannel<T> | CueChannel<T>;

/** Resolved state handed to a "state" renderer. */
export type StateOf<T> = T | null;
/** Resolved state handed to a "cues" renderer. */
export type CuesOf<T> = readonly T[];

/**
 * A renderer owns one DOM subtree under the overlay and touches nothing
 * outside it.
 */
export interface OverlayRenderer<S> {
  /** Called once on attach, and again after `OverlayLayer.reset()`. */
  mount(root: HTMLElement): void;
  /**
   * Called when the resolved state changes or the media rect changes.
   * **Not** per frame. A renderer needing continuous animation runs its own
   * rAF inside its own subtree.
   *
   * `nowMs` lets a renderer position itself correctly when a snapshot
   * activates mid-interval.
   */
  render(state: S, rect: MediaRect, nowMs: PresentationMs): void;
  /** Called on detach/dispose. Must leave the root empty. */
  unmount(): void;
}

export interface OverlayLayer {
  /** Attach a renderer fed by an open-ended state channel. */
  attach<T>(
    id: string,
    renderer: OverlayRenderer<StateOf<T>>,
    mode: "state",
  ): StateChannel<T>;
  /** Attach a renderer fed by an interval-cue channel. */
  attach<T>(
    id: string,
    renderer: OverlayRenderer<CuesOf<T>>,
    mode: "cues",
  ): CueChannel<T>;

  detach(id: string): void;

  /** Bind to whichever surface the active pipeline draws into. */
  setSurface(surface: HTMLVideoElement | HTMLCanvasElement | null): void;

  /** Wire the picture clock, normally `() => pipeline.getPresentationTimeMs()`. */
  setClock(clock: (() => PresentationMs | null) | null): void;

  /**
   * Show or hide the whole overlay without losing channel state. The
   * entry point the CC toggle (#165) drives.
   */
  setEnabled(enabled: boolean): void;

  /** True when the overlay is currently showing. */
  isEnabled(): boolean;

  /**
   * Drop every channel timeline and re-mount renderers to an empty state.
   * Called on engine switch, namespace switch, track switch and pipeline
   * dispose. Parser reset is the *source's* business — the seam has no parser.
   */
  reset(): void;

  /** Unmount renderers, drop the DOM subtrees, stop the resolution loop. */
  dispose(): void;
}
