declare const __APP_VERSION__: string;

/**
 * ManagedMediaSource API — available in Safari 17+ (including iOS).
 * On iOS, standard MediaSource is not available; ManagedMediaSource is the
 * only path to MSE playback.
 *
 * Attach via `video.srcObject = mms` (not URL.createObjectURL).
 */
// ManagedSourceBuffer extends SourceBuffer. The browser adds a `bufferedchange`
// event but we model only what we use here.
type ManagedSourceBuffer = SourceBuffer;

interface ManagedMediaSource extends EventTarget {
  readonly readyState: "closed" | "open" | "ended";
  readonly sourceBuffers: SourceBufferList;
  readonly activeSourceBuffers: SourceBufferList;
  duration: number;

  addSourceBuffer(type: string): ManagedSourceBuffer;
  removeSourceBuffer(sourceBuffer: SourceBuffer): void;
  endOfStream(error?: EndOfStreamError): void;

  // Standard MediaSource events
  onstartstreaming: ((this: ManagedMediaSource, ev: Event) => void) | null;
  onendstreaming: ((this: ManagedMediaSource, ev: Event) => void) | null;
  onsourceopen: ((this: ManagedMediaSource, ev: Event) => void) | null;
  onsourceended: ((this: ManagedMediaSource, ev: Event) => void) | null;
  onsourceclose: ((this: ManagedMediaSource, ev: Event) => void) | null;

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

// eslint-disable-next-line no-var -- ambient declarations require `var` (standard TS pattern)
declare var ManagedMediaSource: {
  prototype: ManagedMediaSource;
  new (): ManagedMediaSource;
  isTypeSupported(type: string): boolean;
};
