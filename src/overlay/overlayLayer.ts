// The overlay seam itself: channels, the snapshot timeline, resolution
// against the picture clock, surface binding, and renderer hosting.
//
// See ./index.ts for the contract and Eyevinn/warp-player#159 for why it is
// shaped this way. The two rules that drive the whole implementation:
//
//   1. Resolution is **by search**, never by assuming the clock advanced
//      monotonically since the last tick. Seeks, rate changes, stalls and
//      discontinuities then need no special case.
//   2. Renderers are called **on change only** — when the resolved state or
//      the media rect differs from what was last painted.

import {
  getMediaRect,
  observeSurfaceSize,
  rectsEqual,
  type OverlaySurface,
} from "./mediaRect";

import type {
  ChannelMode,
  CueChannel,
  CuesOf,
  MediaRect,
  OverlayLayer,
  OverlayRenderer,
  PresentationMs,
  StateChannel,
  StateOf,
} from "./index";

/** One point on a channel's timeline: the resolved state from `fromMs` on. */
interface TimelineEntry<S> {
  fromMs: PresentationMs;
  payload: S;
}

/**
 * An ordered list of (time, state) points, resolved by binary search.
 *
 * Both channel modes normalise onto this. Entries are kept sorted by
 * `fromMs`; a push at an existing time replaces that entry rather than
 * appending a duplicate, so a source that re-pushes at the same timestamp
 * cannot grow the timeline without bound.
 */
export class SnapshotTimeline<S> {
  private entries: TimelineEntry<S>[] = [];

  constructor(private readonly emptyState: S) {}

  /** Number of retained points. Test/diagnostic use. */
  get size(): number {
    return this.entries.length;
  }

  /** Insert or replace the point at `fromMs`. */
  set(fromMs: PresentationMs, payload: S): void {
    if (!Number.isFinite(fromMs)) {
      return;
    }
    const idx = this.indexAtOrBefore(fromMs);
    if (idx >= 0 && this.entries[idx].fromMs === fromMs) {
      this.entries[idx] = { fromMs, payload };
      return;
    }
    this.entries.splice(idx + 1, 0, { fromMs, payload });
  }

  /** Replace the whole timeline with an already-sorted list of points. */
  replaceAll(entries: TimelineEntry<S>[]): void {
    this.entries = entries.slice();
  }

  /**
   * State at `nowMs`: the payload of the latest point at or before it.
   * `null` (no picture yet) and a time before the first point both resolve
   * to the empty state.
   */
  resolve(nowMs: PresentationMs | null): S {
    if (nowMs === null || !Number.isFinite(nowMs)) {
      return this.emptyState;
    }
    const idx = this.indexAtOrBefore(nowMs);
    return idx < 0 ? this.emptyState : this.entries[idx].payload;
  }

  /**
   * Retention: keep the point active at `nowMs` plus everything after it,
   * drop everything strictly older. Sources extract well ahead of the
   * playhead (MSE extracts at append time), so future points are retained
   * by design.
   */
  prune(nowMs: PresentationMs | null): void {
    if (nowMs === null || !Number.isFinite(nowMs)) {
      return;
    }
    const idx = this.indexAtOrBefore(nowMs);
    if (idx > 0) {
      this.entries.splice(0, idx);
    }
  }

  clear(): void {
    this.entries = [];
  }

  /** Index of the last entry with `fromMs <= t`, or -1. Binary search. */
  private indexAtOrBefore(t: PresentationMs): number {
    let lo = 0;
    let hi = this.entries.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid].fromMs <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }
}

/** A "state" channel: open-ended state, superseded by the next push. */
export class StateChannelImpl<T> implements StateChannel<T> {
  readonly mode = "state" as const;
  private readonly timeline = new SnapshotTimeline<StateOf<T>>(null);

  push(fromMs: PresentationMs, payload: T | null): void {
    this.timeline.set(fromMs, payload);
  }

  resolve(nowMs: PresentationMs | null): StateOf<T> {
    return this.timeline.resolve(nowMs);
  }

  prune(nowMs: PresentationMs | null): void {
    this.timeline.prune(nowMs);
  }

  clear(): void {
    this.timeline.clear();
  }

  /** Retained timeline points. Test/diagnostic use. */
  get size(): number {
    return this.timeline.size;
  }
}

interface Cue<T> {
  startMs: PresentationMs;
  endMs: PresentationMs;
  payload: T;
}

const NO_CUES: readonly never[] = Object.freeze([]);

/**
 * A "cues" channel: intervals composed into an active set.
 *
 * Overlapping cues are the reason this lives in the seam rather than in
 * each interval renderer. The materialised timeline holds one point per
 * change point (every cue start and every cue end), whose payload is the
 * set of cues active from that point on, ordered by start time.
 */
export class CueChannelImpl<T> implements CueChannel<T> {
  readonly mode = "cues" as const;
  private cues: Cue<T>[] = [];
  private readonly timeline = new SnapshotTimeline<CuesOf<T>>(
    NO_CUES as CuesOf<T>,
  );

  addCue(startMs: PresentationMs, endMs: PresentationMs, payload: T): void {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return;
    }
    if (endMs <= startMs) {
      return;
    }
    this.cues.push({ startMs, endMs, payload });
    this.rebuild();
  }

  resolve(nowMs: PresentationMs | null): CuesOf<T> {
    return this.timeline.resolve(nowMs);
  }

  /**
   * Retention on an interval set: drop cues that ended at or before the
   * playhead, then rematerialise. Nothing active now or later is lost.
   */
  prune(nowMs: PresentationMs | null): void {
    if (nowMs === null || !Number.isFinite(nowMs)) {
      return;
    }
    const kept = this.cues.filter((cue) => cue.endMs > nowMs);
    if (kept.length !== this.cues.length) {
      this.cues = kept;
      this.rebuild();
    }
  }

  clear(): void {
    this.cues = [];
    this.timeline.clear();
  }

  /** Retained cue count. Test/diagnostic use. */
  get size(): number {
    return this.cues.length;
  }

  private rebuild(): void {
    const boundaries = new Set<number>();
    for (const cue of this.cues) {
      boundaries.add(cue.startMs);
      boundaries.add(cue.endMs);
    }
    const sorted = Array.from(boundaries).sort((a, b) => a - b);
    const entries: TimelineEntry<CuesOf<T>>[] = [];
    for (const at of sorted) {
      const active = this.cues
        .filter((cue) => cue.startMs <= at && at < cue.endMs)
        .sort((a, b) => a.startMs - b.startMs)
        .map((cue) => cue.payload);
      const payload: CuesOf<T> =
        active.length === 0 ? (NO_CUES as CuesOf<T>) : active;
      const previous = entries.length
        ? entries[entries.length - 1].payload
        : undefined;
      // Collapse a boundary that changes nothing (a cue ending exactly where
      // an identical-length one starts still produces two boundaries).
      if (previous !== undefined && sameSet(previous, payload)) {
        continue;
      }
      entries.push({ fromMs: at, payload });
    }
    this.timeline.replaceAll(entries);
  }
}

function sameSet<T>(a: CuesOf<T>, b: CuesOf<T>): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Everything the layer needs to know about one attached renderer. */
interface Attachment {
  id: string;
  root: HTMLElement;
  renderer: OverlayRenderer<unknown>;
  channel: StateChannelImpl<unknown> | CueChannelImpl<unknown>;
  /** Last painted state, compared by reference to decide "on change only". */
  lastState: unknown;
  lastRect: MediaRect | null;
  painted: boolean;
}

/** Injection seam so the resolution loop can be driven from a test. */
export interface OverlayLayerOptions {
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

/**
 * The DOM implementation of the seam. `player.ts` owns exactly one of these
 * for the session.
 */
export class DomOverlayLayer implements OverlayLayer {
  private readonly attachments = new Map<string, Attachment>();
  private surface: OverlaySurface | null = null;
  private unobserve: (() => void) | null = null;
  private clock: (() => PresentationMs | null) | null = null;
  private rect: MediaRect | null = null;
  private frameHandle: number | null = null;
  private enabled = true;
  private disposed = false;
  private readonly requestFrame: (cb: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;

  constructor(
    private readonly container: HTMLElement,
    options: OverlayLayerOptions = {},
  ) {
    this.requestFrame =
      options.requestFrame ??
      ((cb) => globalThis.requestAnimationFrame(() => cb()));
    this.cancelFrame =
      options.cancelFrame ?? ((h) => globalThis.cancelAnimationFrame(h));
  }

  attach<T>(
    id: string,
    renderer: OverlayRenderer<StateOf<T>>,
    mode: "state",
  ): StateChannel<T>;
  attach<T>(
    id: string,
    renderer: OverlayRenderer<CuesOf<T>>,
    mode: "cues",
  ): CueChannel<T>;
  attach(id: string, renderer: OverlayRenderer<any>, mode: ChannelMode): any {
    this.detach(id);
    const root = this.container.ownerDocument.createElement("div");
    root.dataset.overlayRenderer = id;
    root.style.position = "absolute";
    root.style.inset = "0";
    root.style.pointerEvents = "none";
    this.container.appendChild(root);

    const channel =
      mode === "state"
        ? new StateChannelImpl<unknown>()
        : new CueChannelImpl<unknown>();
    const attachment: Attachment = {
      id,
      root,
      renderer: renderer as unknown as OverlayRenderer<unknown>,
      channel,
      lastState: undefined,
      lastRect: null,
      painted: false,
    };
    attachment.renderer.mount(root);
    this.attachments.set(id, attachment);
    this.startLoop();
    return channel;
  }

  detach(id: string): void {
    const attachment = this.attachments.get(id);
    if (!attachment) {
      return;
    }
    attachment.renderer.unmount();
    attachment.root.remove();
    this.attachments.delete(id);
    if (this.attachments.size === 0) {
      this.stopLoop();
    }
  }

  setSurface(surface: OverlaySurface | null): void {
    if (this.unobserve) {
      this.unobserve();
      this.unobserve = null;
    }
    this.surface = surface;
    this.rect = null;
    this.invalidate();
    if (surface) {
      this.unobserve = observeSurfaceSize(surface, this.container, () =>
        this.invalidate(),
      );
    }
  }

  setClock(clock: (() => PresentationMs | null) | null): void {
    this.clock = clock;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    this.enabled = enabled;
    this.container.style.display = enabled ? "" : "none";
    // Force a repaint on re-enable: the resolved state may be unchanged but
    // the DOM was hidden while it moved.
    this.invalidate();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  reset(): void {
    for (const attachment of this.attachments.values()) {
      attachment.channel.clear();
      attachment.renderer.unmount();
      attachment.root.replaceChildren();
      attachment.renderer.mount(attachment.root);
      attachment.lastState = undefined;
      attachment.lastRect = null;
      attachment.painted = false;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopLoop();
    if (this.unobserve) {
      this.unobserve();
      this.unobserve = null;
    }
    for (const id of Array.from(this.attachments.keys())) {
      this.detach(id);
    }
    this.surface = null;
    this.clock = null;
    this.rect = null;
  }

  /**
   * Run one resolution pass. Public so a host without rAF (and the tests)
   * can drive the seam explicitly.
   */
  tick(): void {
    if (this.disposed || !this.enabled || this.attachments.size === 0) {
      return;
    }
    const nowMs = this.clock ? this.clock() : null;
    const rect = this.currentRect();
    for (const attachment of this.attachments.values()) {
      attachment.channel.prune(nowMs);
      const state = attachment.channel.resolve(nowMs);
      const stateChanged =
        !attachment.painted || state !== attachment.lastState;
      const rectChanged = !rectsEqual(rect, attachment.lastRect);
      if (!stateChanged && !rectChanged) {
        continue;
      }
      attachment.lastState = state;
      attachment.lastRect = rect;
      attachment.painted = true;
      if (!rect) {
        // No picture box to lay out against — leave the subtree empty.
        attachment.root.replaceChildren();
        continue;
      }
      attachment.renderer.render(state, rect, nowMs ?? 0);
    }
  }

  /** Drop the cached rect so the next tick re-measures and repaints. */
  private invalidate(): void {
    this.rect = null;
    for (const attachment of this.attachments.values()) {
      attachment.lastRect = null;
      attachment.painted = false;
    }
  }

  private currentRect(): MediaRect | null {
    if (!this.surface) {
      return null;
    }
    // Re-measured every tick: cheap (two getBoundingClientRect calls) and it
    // covers layout changes that no ResizeObserver reports, such as the
    // surface moving because a sibling above it grew.
    const rect = getMediaRect(this.surface, this.container);
    if (rect && rectsEqual(rect, this.rect)) {
      return this.rect;
    }
    this.rect = rect;
    return rect;
  }

  private startLoop(): void {
    if (this.frameHandle !== null || this.disposed) {
      return;
    }
    const step = (): void => {
      this.frameHandle = null;
      this.tick();
      if (!this.disposed && this.attachments.size > 0) {
        this.frameHandle = this.requestFrame(step);
      }
    };
    this.frameHandle = this.requestFrame(step);
  }

  private stopLoop(): void {
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
  }
}
