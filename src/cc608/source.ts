/**
 * Container- and codec-agnostic CTA-608 caption source.
 *
 * Feed it one coded video sample at a time (length-prefixed NALUs, AVC or
 * HEVC) together with the sample's presentation time, and it pushes
 * {@link Cc608Snapshot}s into a {@link Cc608Sink}. Both render engines use
 * it unchanged: the MSE path walks CMAF/LOCMAF `mdat` bodies
 * (`src/buffer/cta608Fragment.ts`), the WebCodecs path feeds LOC objects.
 *
 * ## Emission policy
 *
 * `Cta608Channel.outputDataUpdate` — the library's own emission path — only
 * fires when the displayed screen *changes*, and what it hands over is the
 * *previous* screen. On a stream that flips captions once a second that puts
 * a cue roughly a second behind the frame it belongs to, which is useless
 * for a player targeting 300 ms of latency.
 *
 * `Cta608Parser.cueSplitAtTime(t)` is public and emits the **live** screen
 * instead, so the policy is "split on every sample, dedupe by content":
 *
 * ```
 * for each video sample:
 *     addData(tSec, cc1Bytes)      // no-op when the sample carries no captions
 *     cueSplitAtTime(tSec)         // emits the live screen unless it is empty
 *     resolve the emission and push it if the content changed
 * ```
 *
 * Notes:
 *
 * - `cueSplitAtTime` emits nothing when the live screen is empty. That
 *   non-emission *is* the "clear the overlay" signal, so a sample with no
 *   emission resolves to `null`.
 * - `newCue`'s `startTime`/`endTime` are unusable under this policy —
 *   `cueSplitAtTime` resets `cueStartTime` on every call — so the sample's
 *   own presentation time is authoritative and both arguments are ignored.
 * - **Only cues raised by `cueSplitAtTime` count.** `outputDataUpdate` can
 *   raise its own late `newCue` from inside `addData`, and it hands over the
 *   *previous* screen. Treating any `newCue` as "the live screen is
 *   non-empty" gets the erase case exactly wrong: an EDM makes
 *   `outputDataUpdate` emit the screen being erased while `cueSplitAtTime`
 *   stays silent, so the overlay would keep showing a caption that has just
 *   been taken down. Emissions are therefore only captured while the split
 *   call is in progress.
 * - The content dedupe extends to `null`: once the overlay has been cleared
 *   it is not re-cleared on every subsequent caption-free sample. (The #159
 *   sketch pushed `null` unconditionally; deduping it is the same rule
 *   applied consistently and saves 25-50 redundant pushes a second on
 *   caption-free content.)
 *
 * ## Lifecycle
 *
 * {@link Cc608Source.reset} throws the parser away and builds a new one. A
 * receiver that joins or switches mid-stream can otherwise hit an
 * end-of-caption command without the pop-on build that belongs to it and
 * flip up a *stale* caption from before the switch — worse than showing
 * none. Callers must reset on init-segment change, track switch, namespace
 * switch, engine switch, dispose, and any playback discontinuity.
 */
import {
  Cta608Parser,
  extractCta608DataFromSample,
  type CaptionScreen,
  type CueHandler,
} from "@svta/cml-608";

import type { ILogger } from "../logger";

import { snapshotScreen, snapshotsEqual } from "./snapshot";
import type { Cc608Sink, Cc608Snapshot } from "./types";

/** CC1 lives in field 1; `new Cta608Parser(1, ...)` serves channels 1 and 2. */
const FIELD_1 = 1;

export class Cc608Source {
  private readonly sink: Cc608Sink;
  private readonly logger: ILogger;

  private parser: Cta608Parser;

  /** True only while `cueSplitAtTime` is running, i.e. while a `newCue`
   *  can be trusted to carry the live screen. */
  private capturing = false;
  /** The live screen captured for the sample being processed. */
  private liveScreen: Cc608Snapshot | null = null;

  private hasPushed = false;
  private lastPushed: Cc608Snapshot | null = null;

  private samplesSeen = 0;
  private samplesWithCc = 0;
  private extractionErrors = 0;

  constructor(sink: Cc608Sink, logger: ILogger) {
    this.sink = sink;
    this.logger = logger;
    this.parser = this.createParser();
  }

  /**
   * Feed one coded video sample.
   *
   * @param timeSec - presentation time in SECONDS on the media timeline.
   *   (`Cta608Parser.addData` takes seconds despite its docstring saying
   *   milliseconds; the sink is pushed in milliseconds.)
   * @param view - a DataView over the buffer holding the sample.
   * @param offset - byte offset of the first length prefix.
   * @param size - sample size in bytes.
   */
  public addSample(
    timeSec: number,
    view: DataView,
    offset: number,
    size: number,
  ): void {
    if (!Number.isFinite(timeSec) || size <= 0) {
      return;
    }
    if (offset < 0 || offset + size > view.byteLength) {
      this.logger.warn(
        `[CC608] Sample out of range: offset=${offset} size=${size} buffer=${view.byteLength}`,
      );
      return;
    }

    let fieldData: number[][];
    try {
      fieldData = extractCta608DataFromSample(view, offset, size);
    } catch (err) {
      this.extractionErrors++;
      if (this.extractionErrors <= 3) {
        this.logger.warn(
          `[CC608] Failed to extract CTA-608 data from sample: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }

    const cc1 = fieldData[0] ?? [];
    this.samplesSeen++;
    this.liveScreen = null;

    if (cc1.length > 0) {
      if (this.samplesWithCc === 0) {
        this.logger.info(
          `[CC608] First CTA-608 data seen at ${timeSec.toFixed(3)}s (${cc1.length} bytes)`,
        );
      }
      this.samplesWithCc++;
      // Any newCue raised in here is outputDataUpdate's late, stale one.
      this.parser.addData(timeSec, cc1);
    }

    // Emits the LIVE screen; silent when the live screen is empty.
    this.capturing = true;
    try {
      this.parser.cueSplitAtTime(timeSec);
    } finally {
      this.capturing = false;
    }

    const next = this.liveScreen;
    if (this.hasPushed && snapshotsEqual(next, this.lastPushed)) {
      return;
    }
    this.hasPushed = true;
    this.lastPushed = next;
    this.sink.push(timeSec * 1000, next);
  }

  /**
   * Discard all 608 state. The next sample always produces a push, even if
   * its screen matches what was last pushed, so the overlay re-synchronises
   * immediately after a discontinuity.
   */
  public reset(): void {
    this.parser = this.createParser();
    this.capturing = false;
    this.liveScreen = null;
    this.hasPushed = false;
    this.lastPushed = null;
    this.samplesSeen = 0;
    this.samplesWithCc = 0;
    this.extractionErrors = 0;
  }

  /** Diagnostics for logging and tests. */
  public getStats(): { samplesSeen: number; samplesWithCc: number } {
    return { samplesSeen: this.samplesSeen, samplesWithCc: this.samplesWithCc };
  }

  private createParser(): Cta608Parser {
    const handler: CueHandler = {
      // startTime/endTime are meaningless under the split-every-sample
      // policy; the caller's sample time is used instead.
      newCue: (_startTime: number, _endTime: number, screen: CaptionScreen) => {
        if (!this.capturing) {
          // outputDataUpdate's late cue, carrying the previous screen.
          return;
        }
        // MANDATORY deep copy: `screen` is reused and mutated by the library.
        this.liveScreen = snapshotScreen(screen);
      },
    };
    // out2 is null: mlmpub only emits CC1, and a null filter makes the
    // channel-2 cue path a no-op inside the library.
    return new Cta608Parser(FIELD_1, handler, null);
  }
}
