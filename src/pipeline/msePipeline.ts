import { MediaBuffer, MediaSegmentBuffer } from "../buffer";
import { ILogger } from "../logger";
import { MOQObject } from "../transport/tracks";

import {
  IPlaybackPipeline,
  PipelineBufferConfig,
  PipelineLatencySnapshot,
  PipelineSetupOptions,
  TrackRole,
} from "./index";

/**
 * Owns the MSE state for a single playback session: the shared MediaSource,
 * the per-track SourceBuffers, and the segment + box parsers that feed them.
 *
 * State fields are public so the cutover from inlined state on Player can
 * happen without touching every read-site. Player exposes private getter
 * delegates that forward to these fields, which keeps the diff small. Future
 * phases will route setup/teardown through the methods on this class and
 * tighten visibility once that's done.
 *
 * Phase 4: MsePipeline now also implements IPlaybackPipeline, exposing
 * getLatencySnapshot() and getPlaybackRate() so the metric panels can read
 * MSE and WebCodecs sessions through one interface. setup() / routeObject()
 * are no-ops on this pipeline today — the legacy player.ts flow continues
 * to drive the MediaSource and SourceBuffers directly. They exist so the
 * polymorphic surface compiles and to give us a hook for the future
 * setup/teardown migration without breaking callers.
 *
 * MediaKeys / EME setup will land here too — the (engine, packaging,
 * encryption) capability matrix in pipeline/index.ts assumes that encrypted
 * playback is owned by the MSE engine.
 */
export class MsePipeline implements IPlaybackPipeline {
  readonly engine = "mse" as const;

  sharedMediaSource: MediaSource | ManagedMediaSource | null = null;
  usingManagedMediaSource = false;
  videoSourceBuffer: SourceBuffer | null = null;
  audioSourceBuffer: SourceBuffer | null = null;
  videoMediaSegmentBuffer: MediaSegmentBuffer | null = null;
  audioMediaSegmentBuffer: MediaSegmentBuffer | null = null;
  videoMediaBuffer: MediaBuffer | null = null;
  audioMediaBuffer: MediaBuffer | null = null;

  /** Set by Player when MSE playback engages, cleared on dispose. */
  private videoElement: HTMLVideoElement | null = null;
  private bufferConfig: PipelineBufferConfig = {
    minimalBufferMs: 200,
    targetLatencyMs: 300,
  };

  constructor(private readonly logger: ILogger) {}

  generateVideoMimeType(codec?: string): string {
    if (!codec) {
      throw new Error("Video codec is required but was not provided");
    }
    return `video/mp4; codecs="${codec}"`;
  }

  generateAudioMimeType(codec?: string): string {
    if (!codec) {
      throw new Error("Audio codec is required but was not provided");
    }
    return `audio/mp4; codecs="${codec}"`;
  }

  /**
   * Parse a CMAF init segment, attach the source buffer to the segment buffer,
   * and append it. Used for both video and audio at setup time.
   */
  processInitSegment(
    initData: ArrayBuffer,
    mediaBuffer: MediaBuffer,
    mediaSegmentBuffer: MediaSegmentBuffer,
    sourceBuffer: SourceBuffer | ManagedSourceBuffer,
    type: string,
  ): void {
    this.logger.info(`[${type}MediaBuffer] Processing init segment`);

    const trackInfo = mediaBuffer.parseInitSegment(initData);
    this.logger.info(
      `[${type}MediaBuffer] Parsed init segment, timescale: ${trackInfo.timescale}`,
    );
    mediaSegmentBuffer.setSourceBuffer(sourceBuffer);
    const initSegmentObj = mediaSegmentBuffer.addInitSegment(initData);
    mediaSegmentBuffer.appendToSourceBuffer(initSegmentObj);

    this.logger.info(
      `[${type}MediaBuffer] Added CMAF init segment to MediaSegmentBuffer and SourceBuffer`,
    );
  }

  /** Reset the audio half of the pipeline — used by the audio-fallback path. */
  clearAudio(): void {
    this.audioSourceBuffer = null;
    this.audioMediaSegmentBuffer = null;
    this.audioMediaBuffer = null;
  }

  /** Reset the video half of the pipeline — used by the video-fallback path. */
  clearVideo(): void {
    this.videoSourceBuffer = null;
    this.videoMediaSegmentBuffer = null;
    this.videoMediaBuffer = null;
  }

  /**
   * Attach the <video> element used by the legacy MSE flow. Stored so
   * getLatencySnapshot() / getPlaybackRate() can read playback state without
   * touching the DOM directly.
   */
  attachVideoElement(el: HTMLVideoElement | null): void {
    this.videoElement = el;
  }

  /* --- IPlaybackPipeline ------------------------------------------------ */

  /** No-op: MSE setup is currently inlined in Player.setupVideoPlayback. */
  async setup(_options: PipelineSetupOptions): Promise<void> {
    // Reserved for the future MSE setup migration; today the legacy flow
    // owns the MediaSource lifecycle.
    return;
  }

  /** No-op: MSE objects flow through the legacy buffer pipeline today. */
  routeObject(_role: TrackRole, _obj: MOQObject): void {
    // Reserved for the future routeObject migration.
  }

  getLatencySnapshot(): PipelineLatencySnapshot {
    const videoEl = this.videoElement;
    let videoBufferedAheadS = 0;
    let audioBufferedAheadS = 0;
    let currentLatencyMs: number | null = null;

    if (videoEl) {
      const t = videoEl.currentTime;
      if (this.videoSourceBuffer) {
        videoBufferedAheadS = bufferedAhead(this.videoSourceBuffer.buffered, t);
      }
      if (this.audioSourceBuffer) {
        audioBufferedAheadS = bufferedAhead(this.audioSourceBuffer.buffered, t);
      }
      // Latency presumes the publisher's media time is wallclock-aligned
      // (mlmpub anchors to UTC). Negative or wildly large values are
      // surfaced as null so the UI shows N/A rather than nonsense.
      const raw = Date.now() - t * 1000;
      if (Number.isFinite(raw) && raw >= 0 && raw < 30_000) {
        currentLatencyMs = raw;
      }
    }

    return {
      currentLatencyMs,
      videoBufferedAheadS,
      audioBufferedAheadS,
    };
  }

  getPlaybackRate(): number {
    return this.videoElement?.playbackRate ?? 1.0;
  }

  setBufferConfig(config: PipelineBufferConfig): void {
    this.bufferConfig = config;
  }

  setPlaybackRate(rate: number): void {
    if (this.videoElement) {
      this.videoElement.playbackRate = rate;
    }
  }

  setMuted(muted: boolean): void {
    if (this.videoElement) {
      this.videoElement.muted = muted;
    }
  }

  getMuted(): boolean {
    return this.videoElement?.muted ?? true;
  }

  /** Drop all references — used during disconnect/reset. */
  async dispose(): Promise<void> {
    this.clearVideo();
    this.clearAudio();
    this.sharedMediaSource = null;
    this.usingManagedMediaSource = false;
    this.videoElement = null;
  }
}

function bufferedAhead(ranges: TimeRanges, currentTime: number): number {
  for (let i = 0; i < ranges.length; i++) {
    if (currentTime >= ranges.start(i) && currentTime < ranges.end(i)) {
      return ranges.end(i) - currentTime;
    }
  }
  return 0;
}
