import { MediaBuffer, MediaSegmentBuffer } from "../buffer";
import { ILogger } from "../logger";

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
 * MediaKeys / EME setup will land here too — the (engine, packaging,
 * encryption) capability matrix in pipeline/index.ts assumes that encrypted
 * playback is owned by the MSE engine.
 */
export class MsePipeline {
  sharedMediaSource: MediaSource | ManagedMediaSource | null = null;
  usingManagedMediaSource = false;
  videoSourceBuffer: SourceBuffer | null = null;
  audioSourceBuffer: SourceBuffer | null = null;
  videoMediaSegmentBuffer: MediaSegmentBuffer | null = null;
  audioMediaSegmentBuffer: MediaSegmentBuffer | null = null;
  videoMediaBuffer: MediaBuffer | null = null;
  audioMediaBuffer: MediaBuffer | null = null;

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

  /** Drop all references — used during disconnect/reset. */
  dispose(): void {
    this.clearVideo();
    this.clearAudio();
    this.sharedMediaSource = null;
    this.usingManagedMediaSource = false;
  }
}
