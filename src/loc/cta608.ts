// CTA-608 extraction gate for the WebCodecs / LOC video path.
//
// LOC video objects are exactly what `extractCta608DataFromSample` expects:
// 4-byte length-prefixed NALUs, one access unit per object, with AVC 1-byte
// and HEVC 2-byte NAL headers handled by the same walker. So the only thing
// this file adds on top of `Cc608Source` is the *gate*: deciding whether a
// given sample is worth scanning at all.
//
// The gate has three layers, cheapest first:
//
//   1. Codec — AVC and HEVC only. AV1 carries no CTA-608 (cml has no
//      metadata-OBU path either), so an AV1 track never scans a byte.
//   2. `enabled` — an injected predicate, so the CC toggle (#165) can turn
//      the whole thing off. When it returns false nothing is scanned, and the
//      overlay is cleared once.
//   3. First-sight detection — a bounded probe window at the start of a
//      track. If no CTA-608 SEI shows up within it, the track is treated as
//      uncaptioned and scanning stops entirely. The signal is the *presence
//      of 608 SEI*, not the first displayed caption, so a captioned track
//      whose first pop-on lands late still stays awake.
//
// Layer 3 is what makes extraction a genuine no-op on an uncaptioned track:
// after the probe the per-sample cost is one boolean test. The probe re-arms
// on `reset()` (track switch, discontinuity, dispose) and whenever the
// `enabled` predicate flips from false back to true, so turning captions on
// mid-session re-checks the stream.

import { findCta608Nalus } from "@svta/cml-608";

import { Cc608Source } from "../cc608/source";
import { Cc608Sink } from "../cc608/types";
import { ILogger } from "../logger";

/**
 * Number of samples scanned before an apparently uncaptioned track goes
 * dormant. At 25–50 fps this is roughly 4–8 seconds of video, comfortably
 * more than the gap between caption bursts on a live 608 service.
 */
export const CTA608_PROBE_SAMPLES = 200;

/** Whether a catalog codec string can carry CTA-608 in SEI NAL units. */
export function codecCanCarryCta608(codec: string | undefined | null): boolean {
  if (!codec) {
    return false;
  }
  const c = codec.toLowerCase();
  return (
    c.startsWith("avc1") ||
    c.startsWith("avc3") ||
    c.startsWith("hvc1") ||
    c.startsWith("hev1")
  );
}

export interface LocCta608ExtractorOptions {
  /** Where snapshots are pushed. */
  sink: Cc608Sink;
  logger: ILogger;
  /** Catalog codec string of the video track. */
  codec: string | undefined | null;
  /**
   * Gate hook for the CC toggle (#165). Defaults to always-on. Read once per
   * sample, so the caller can flip it at any time.
   */
  enabled?: () => boolean;
  /** Test seam; defaults to CTA608_PROBE_SAMPLES. */
  probeSamples?: number;
}

/**
 * Per-session CTA-608 extractor for LOC video objects.
 *
 * One of these is owned by `WebCodecsLocPipeline`; it is fed every video
 * sample and pushes screen snapshots into the sink.
 */
export class LocCta608Extractor {
  private readonly source: Cc608Source;
  private readonly sink: Cc608Sink;
  private readonly logger: ILogger;
  private readonly enabled: () => boolean;
  private readonly probeSamples: number;
  /** False for AV1 and anything else without SEI-carried 608. */
  private readonly codecSupported: boolean;

  /** Samples scanned since the probe window was armed. */
  private probed = 0;
  /** True once a CTA-608 SEI has been seen on this track. */
  private sawCta608 = false;
  /** True once the probe window expired without seeing cc_data. */
  private dormant = false;
  /** Last value returned by `enabled`, to detect an off -> on transition. */
  private wasEnabled = true;
  /** True while an overlay may be showing something. */
  private pushedAnything = false;

  constructor(options: LocCta608ExtractorOptions) {
    this.sink = options.sink;
    this.logger = options.logger;
    this.enabled = options.enabled ?? (() => true);
    this.probeSamples = options.probeSamples ?? CTA608_PROBE_SAMPLES;
    this.codecSupported = codecCanCarryCta608(options.codec);
    this.source = new Cc608Source(this.countingSink(), options.logger);
    if (!this.codecSupported) {
      this.logger.debug(
        `[cc608] CTA-608 extraction disabled for codec "${options.codec ?? "(none)"}"`,
      );
    }
  }

  /**
   * Wrap the caller's sink so the extractor knows whether an overlay may be
   * showing something, without the caller having to report back.
   */
  private countingSink(): Cc608Sink {
    return {
      push: (timeMs, screen) => {
        if (screen !== null) {
          this.sawCta608 = true;
          this.pushedAnything = true;
        } else {
          this.pushedAnything = false;
        }
        this.sink.push(timeMs, screen);
      },
    };
  }

  /** True when the next sample would actually be scanned. */
  get scanning(): boolean {
    return this.codecSupported && !this.dormant && this.enabled();
  }

  /**
   * Feed one LOC video object.
   *
   * @param timestampUs - presentation time in microseconds (the LOC capture
   *   timestamp, or the pipeline's derived fallback).
   * @param payload - the object payload: 4-byte length-prefixed NALUs.
   */
  addVideoSample(timestampUs: number, payload: Uint8Array): void {
    if (!this.codecSupported) {
      return;
    }

    const isEnabled = this.enabled();
    if (!isEnabled) {
      if (this.wasEnabled) {
        this.wasEnabled = false;
        this.clearOverlay(timestampUs / 1000);
      }
      return;
    }
    if (!this.wasEnabled) {
      // Captions were just turned back on: drop the stale parser state and
      // re-arm the probe so a track that went dormant while they were off
      // gets another look.
      this.wasEnabled = true;
      this.reset();
    }

    if (this.dormant) {
      return;
    }
    if (payload.byteLength === 0) {
      return;
    }

    const view = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    );
    this.source.addSample(timestampUs / 1_000_000, view, 0, payload.byteLength);

    if (!this.sawCta608) {
      if (this.hasCta608Sei(view, payload.byteLength)) {
        this.sawCta608 = true;
      } else if (++this.probed >= this.probeSamples) {
        this.dormant = true;
        this.logger.info(
          `[cc608] no CTA-608 data in the first ${this.probeSamples} samples — ` +
            "extraction disabled for this track",
        );
      }
    }
  }

  /** Probe-window only: does this sample carry a CTA-608 SEI at all? */
  private hasCta608Sei(view: DataView, size: number): boolean {
    try {
      return findCta608Nalus(view, 0, size).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Drop all parser state and re-arm first-sight detection. Call on track
   * switch, discontinuity (including a decoder reconfiguration), and dispose.
   */
  reset(): void {
    this.source.reset();
    this.rearm();
  }

  private rearm(): void {
    this.probed = 0;
    this.sawCta608 = false;
    this.dormant = false;
  }

  private clearOverlay(timeMs: number): void {
    if (!this.pushedAnything) {
      return;
    }
    this.pushedAnything = false;
    this.sink.push(timeMs, null);
  }
}
