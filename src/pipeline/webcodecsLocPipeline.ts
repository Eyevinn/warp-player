// WebCodecs LOC playback pipeline.
//
// Phase 1: clear-AVC video.
// Phase 2: clear-AAC and Opus audio, sharing the wallclock anchor with video.
//
// Render strategy: a canvas is overlaid on the existing <video> element
// (the video element is hidden while this pipeline is active, then restored
// on dispose). VideoFrames flow into a queue keyed by their capture
// timestamp; a requestAnimationFrame loop draws frames whose timestamp is
// at or before a wallclock-anchored playhead, then closes them.
//
// Audio strategy: a single AudioContext is created in setup(); the AAC/Opus
// AudioDecoder is configured immediately from catalog metadata. Each decoded
// AudioData is converted to an AudioBuffer and scheduled on a fresh
// AudioBufferSourceNode at the AudioContext-time computed from the same
// wallclock anchor used by the video render loop.

import { buildAacConfigFromCatalog } from "../loc/aac";
import {
  buildAvcDecoderConfigDescription,
  extractParameterSetsAndChunk,
} from "../loc/avc";
import { getLocCaptureTimestampUs } from "../loc/extensions";
import { buildOpusHeadFromCatalog } from "../loc/opus";
import { ILogger } from "../logger";
import { MOQObject } from "../transport/tracks";
import { WarpTrack } from "../warpcatalog";

import {
  IPlaybackPipeline,
  PipelineBufferConfig,
  PipelineLatencySnapshot,
  PipelineSetupOptions,
  TrackRole,
} from "./index";

/** A frame waiting to be drawn, keyed by its presentation time in ms. */
interface QueuedFrame {
  /** Presentation time in ms relative to the wallclock anchor. */
  presentationMs: number;
  frame: VideoFrame;
}

export class WebCodecsLocPipeline implements IPlaybackPipeline {
  readonly engine = "webcodecs" as const;

  private logger!: ILogger;
  private videoTrack: WarpTrack | null = null;
  private audioTrack: WarpTrack | null = null;
  private videoEl!: HTMLVideoElement;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  private decoder: VideoDecoder | null = null;
  /** Last SPS bytes used to configure the decoder, to detect parameter changes. */
  private lastSps: Uint8Array | null = null;
  private lastPps: Uint8Array | null = null;

  private audioDecoder: AudioDecoder | null = null;
  private audioContext: AudioContext | null = null;
  /**
   * GainNode sitting between every AudioBufferSourceNode and the
   * destination. Driven by setMuted(): 1 when audible, 0 when muted.
   */
  private audioGain: GainNode | null = null;
  /**
   * Start muted to mirror the MSE path, where the <video muted> attribute
   * makes the legacy session start silent until the user unmutes. Both
   * engines keep the same Mute / Unmute UX this way.
   */
  private muted = true;
  /**
   * Wallclock ms at which AudioContext.currentTime was 0. Used to convert
   * wallclock-anchored presentation times into AudioContext schedule times.
   */
  private audioCtxStartWallMs: number | null = null;
  /**
   * The latest AudioContext-time at which an audio chunk has been scheduled
   * to *end*. Used to back-fill the schedule for chunks whose target time
   * falls in the past so audio plays gap-free instead of being dropped.
   */
  private audioNextScheduleSec: number | null = null;
  /** Newest scheduled audio presentation time in ms — for buffer-ahead. */
  private audioNewestScheduledMs: number | null = null;

  /** Wallclock ms at which presentationMs == anchorPresentationMs. */
  private anchorWallMs: number | null = null;
  private anchorPresentationMs = 0;
  /** Playback-rate multiplier; 1.0 = real-time. */
  private playbackRate = 1.0;

  /** Queue of decoded frames, sorted by presentation time. */
  private frameQueue: QueuedFrame[] = [];
  private rafHandle: number | null = null;
  private disposed = false;

  /** Counters surfaced via getLatencySnapshot. */
  private lastPresentedMs: number | null = null;

  private bufferConfig: PipelineBufferConfig = {
    minimalBufferMs: 200,
    targetLatencyMs: 300,
  };

  async setup(options: PipelineSetupOptions): Promise<void> {
    this.logger = options.logger;
    this.videoTrack = options.videoTrack;
    this.audioTrack = options.audioTrack;
    this.videoEl = options.targets.videoElement;
    this.bufferConfig = options.buffer;

    if (!this.videoTrack) {
      throw new Error("WebCodecsLocPipeline requires a video track");
    }
    if (typeof VideoDecoder === "undefined") {
      throw new Error("VideoDecoder is not available in this browser");
    }

    const width = this.videoTrack.width ?? 1280;
    const height = this.videoTrack.height ?? 720;

    // Create a canvas the same size as the video container and overlay it
    // on top of the <video> element. The video element is hidden while
    // this pipeline runs.
    const canvas =
      options.targets.canvasElement ?? document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.id = canvas.id || "webcodecsCanvas";
    canvas.style.width = "100%";
    canvas.style.maxHeight = "100%";
    canvas.style.background = "#000";
    canvas.style.objectFit = "contain";

    if (!canvas.isConnected) {
      const parent = this.videoEl.parentElement;
      if (!parent) {
        throw new Error("Video element has no parent to host the canvas");
      }
      parent.insertBefore(canvas, this.videoEl);
    }
    this.videoEl.style.display = "none";

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Could not get 2D context from canvas");
    }
    this.canvas = canvas;
    this.ctx = ctx;

    this.decoder = new VideoDecoder({
      output: (frame) => this.onDecodedFrame(frame),
      error: (e) => {
        this.logger.error(`[WebCodecsLoc] VideoDecoder error: ${e.message}`);
      },
    });

    this.startRenderLoop();

    if (this.audioTrack) {
      this.setupAudio();
    }

    this.logger.info(
      `[WebCodecsLoc] setup complete; canvas ${width}x${height}, video codec=${this.videoTrack.codec}, audio codec=${this.audioTrack?.codec ?? "(none)"}`,
    );
  }

  private setupAudio(): void {
    const track = this.audioTrack;
    if (!track) {
      return;
    }
    if (typeof AudioDecoder === "undefined") {
      this.logger.warn(
        "[WebCodecsLoc] AudioDecoder not available; audio disabled",
      );
      return;
    }
    if (typeof AudioContext === "undefined") {
      this.logger.warn(
        "[WebCodecsLoc] AudioContext not available; audio disabled",
      );
      return;
    }

    const sampleRate = track.samplerate ?? 48000;
    const channelConfig = track.channelConfig ?? "2";
    const numberOfChannels = parseInt(channelConfig, 10);
    if (!Number.isInteger(numberOfChannels) || numberOfChannels <= 0) {
      this.logger.warn(
        `[WebCodecsLoc] invalid channelConfig "${channelConfig}" — audio disabled`,
      );
      return;
    }

    const codec = track.codec ?? "";
    let description: Uint8Array;
    let configCodec: string;
    let configSampleRate = sampleRate;
    if (codec.startsWith("mp4a") || codec.startsWith("MP4A")) {
      description = buildAacConfigFromCatalog(codec, sampleRate, channelConfig);
      configCodec = codec;
    } else if (codec.toLowerCase() === "opus") {
      description = buildOpusHeadFromCatalog(sampleRate, channelConfig);
      configCodec = "opus";
      // Opus decoders always output at 48 kHz regardless of input sample rate.
      configSampleRate = 48000;
    } else {
      this.logger.warn(
        `[WebCodecsLoc] unsupported audio codec "${codec}" — audio disabled`,
      );
      return;
    }

    this.audioContext = new AudioContext({ sampleRate: configSampleRate });
    if (this.audioContext.state === "suspended") {
      this.audioContext.resume().catch(() => {
        // Autoplay policy may block this; we'll retry on the first scheduled
        // chunk where currentTime is captured.
      });
    }
    this.audioGain = this.audioContext.createGain();
    this.audioGain.gain.value = this.muted ? 0 : 1;
    this.audioGain.connect(this.audioContext.destination);

    this.audioDecoder = new AudioDecoder({
      output: (data) => this.onDecodedAudio(data),
      error: (e) => {
        this.logger.error(`[WebCodecsLoc] AudioDecoder error: ${e.message}`);
      },
    });

    this.audioDecoder.configure({
      codec: configCodec,
      sampleRate: configSampleRate,
      numberOfChannels,
      description,
    });

    this.logger.info(
      `[WebCodecsLoc] AudioDecoder configured (codec=${configCodec}, sampleRate=${configSampleRate}, channels=${numberOfChannels})`,
    );
  }

  routeObject(role: TrackRole, obj: MOQObject): void {
    if (this.disposed) {
      return;
    }
    if (role === "audio") {
      this.routeAudio(obj);
      return;
    }
    if (role !== "video") {
      return;
    }
    const decoder = this.decoder;
    if (!decoder) {
      return;
    }

    const payload = this.toUint8(obj.data);
    if (payload.byteLength === 0) {
      return;
    }

    const captureUsBig = getLocCaptureTimestampUs(obj.extensions);
    const captureUs = captureUsBig === null ? null : Number(captureUsBig);

    const extracted = extractParameterSetsAndChunk(payload);
    const isKey = extracted.isKey;

    if (isKey) {
      if (extracted.sps.length === 0 || extracted.pps.length === 0) {
        this.logger.warn("[WebCodecsLoc] Keyframe missing SPS/PPS — dropping");
        return;
      }
      const newSps = extracted.sps[0];
      const newPps = extracted.pps[0];
      const needsConfigure =
        decoder.state === "unconfigured" ||
        !this.bytesEqual(this.lastSps, newSps) ||
        !this.bytesEqual(this.lastPps, newPps);
      if (needsConfigure) {
        const description = buildAvcDecoderConfigDescription(
          extracted.sps,
          extracted.pps,
        );
        // Normalise avc3 -> avc1 for WebCodecs. Both describe identical
        // bitstreams; they differ only in whether parameter sets travel
        // in the sample stream (avc3) or in the avcC box (avc1). Since
        // we feed SPS+PPS via `description` (the avcC equivalent), avc1
        // is the correct label and is the one Safari's WebCodecs accepts
        // — Safari rejects avc3 codec strings as unsupported.
        const catalogCodec = this.videoTrack?.codec ?? "avc1.4D401F";
        const codec = catalogCodec.replace(/^avc3\./i, "avc1.");
        const config: VideoDecoderConfig = {
          codec,
          codedWidth: this.videoTrack?.width,
          codedHeight: this.videoTrack?.height,
          description,
          optimizeForLatency: true,
        };
        decoder.configure(config);
        this.lastSps = newSps;
        this.lastPps = newPps;
        this.logger.info(
          `[WebCodecsLoc] VideoDecoder configured (codec=${codec}` +
            (catalogCodec !== codec
              ? `, normalised from ${catalogCodec}`
              : "") +
            ")",
        );
      }
    }

    if (decoder.state !== "configured") {
      // Still waiting for the first keyframe.
      return;
    }

    const chunkBytes = isKey ? extracted.chunk : payload;
    if (chunkBytes.byteLength === 0) {
      return;
    }

    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: isKey ? "key" : "delta",
          timestamp: captureUs ?? this.deriveTimestampUs(obj),
          data: chunkBytes,
        }),
      );
    } catch (e) {
      this.logger.error(
        `[WebCodecsLoc] decode failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  getLatencySnapshot(): PipelineLatencySnapshot {
    const newest = this.frameQueue.length
      ? this.frameQueue[this.frameQueue.length - 1].presentationMs
      : this.lastPresentedMs;
    const playheadMs = this.playheadMs();
    let videoBufferedAheadS = 0;
    if (newest !== null && playheadMs !== null) {
      videoBufferedAheadS = Math.max(0, (newest - playheadMs) / 1000);
    }

    let audioBufferedAheadS = 0;
    if (this.audioNewestScheduledMs !== null && playheadMs !== null) {
      audioBufferedAheadS = Math.max(
        0,
        (this.audioNewestScheduledMs - playheadMs) / 1000,
      );
    }

    let currentLatencyMs: number | null = null;
    if (this.lastPresentedMs !== null) {
      currentLatencyMs = Date.now() - this.lastPresentedMs;
    }

    return {
      currentLatencyMs,
      videoBufferedAheadS,
      audioBufferedAheadS,
    };
  }

  setBufferConfig(config: PipelineBufferConfig): void {
    this.bufferConfig = config;
  }

  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) {
      this.logger?.warn(
        `[WebCodecsLoc] ignoring invalid playback rate ${rate}`,
      );
      return;
    }
    // Re-anchor at the current playhead so the rate change takes effect
    // smoothly without a jump.
    const head = this.playheadMs();
    if (head !== null) {
      this.anchorWallMs = Date.now();
      this.anchorPresentationMs = head;
    }
    this.playbackRate = rate;
  }

  getPlaybackRate(): number {
    return this.playbackRate;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.audioGain) {
      this.audioGain.gain.value = muted ? 0 : 1;
    }
  }

  getMuted(): boolean {
    return this.muted;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    for (const q of this.frameQueue) {
      q.frame.close();
    }
    this.frameQueue = [];

    if (this.decoder && this.decoder.state !== "closed") {
      try {
        this.decoder.close();
      } catch {
        // ignore
      }
    }
    this.decoder = null;

    if (this.audioDecoder && this.audioDecoder.state !== "closed") {
      try {
        this.audioDecoder.close();
      } catch {
        // ignore
      }
    }
    this.audioDecoder = null;

    if (this.audioGain) {
      try {
        this.audioGain.disconnect();
      } catch {
        // ignore
      }
      this.audioGain = null;
    }
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        // ignore
      }
      this.audioContext = null;
    }
    this.audioCtxStartWallMs = null;
    this.audioNextScheduleSec = null;
    this.audioNewestScheduledMs = null;

    if (this.canvas && this.canvas.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }
    this.canvas = null;
    this.ctx = null;
    if (this.videoEl) {
      this.videoEl.style.display = "";
    }
    this.lastSps = null;
    this.lastPps = null;
    this.anchorWallMs = null;
    this.lastPresentedMs = null;
  }

  /* -------------------------------------------------------------------- */

  private onDecodedFrame(frame: VideoFrame): void {
    if (this.disposed) {
      frame.close();
      return;
    }
    // VideoFrame.timestamp is microseconds.
    const presentationMs = frame.timestamp / 1000;
    this.ensureAnchor(presentationMs);
    this.frameQueue.push({ presentationMs, frame });
    // Keep the queue sorted in case decoder emits slightly out of order.
    this.frameQueue.sort((a, b) => a.presentationMs - b.presentationMs);
  }

  /**
   * Set the wallclock anchor on the very first sample seen (video or audio).
   * The first sample is delayed by the configured minimal-buffer offset so
   * the queue has a small head-start on the playhead.
   */
  private ensureAnchor(presentationMs: number): void {
    if (this.anchorWallMs !== null) {
      return;
    }
    this.anchorWallMs = Date.now() + this.bufferConfig.minimalBufferMs;
    this.anchorPresentationMs = presentationMs;
  }

  private playheadMs(): number | null {
    if (this.anchorWallMs === null) {
      return null;
    }
    return (
      this.anchorPresentationMs +
      (Date.now() - this.anchorWallMs) * this.playbackRate
    );
  }

  private startRenderLoop(): void {
    const tick = () => {
      if (this.disposed) {
        return;
      }
      this.rafHandle = requestAnimationFrame(tick);
      this.drawDueFrames();
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private drawDueFrames(): void {
    const playhead = this.playheadMs();
    if (playhead === null || !this.ctx || !this.canvas) {
      return;
    }

    let toDraw: QueuedFrame | null = null;
    while (
      this.frameQueue.length > 0 &&
      this.frameQueue[0].presentationMs <= playhead
    ) {
      // If we're behind, the most recent due frame wins; close older ones.
      if (toDraw) {
        toDraw.frame.close();
      }
      const next = this.frameQueue.shift();
      toDraw = next ?? toDraw;
    }
    if (!toDraw) {
      return;
    }
    try {
      this.ctx.drawImage(
        toDraw.frame,
        0,
        0,
        this.canvas.width,
        this.canvas.height,
      );
      this.lastPresentedMs = toDraw.presentationMs;
    } catch (e) {
      this.logger.error(
        `[WebCodecsLoc] drawImage failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      toDraw.frame.close();
    }
  }

  private routeAudio(obj: MOQObject): void {
    const decoder = this.audioDecoder;
    if (!decoder) {
      return;
    }
    const payload = this.toUint8(obj.data);
    if (payload.byteLength === 0) {
      return;
    }
    const captureUsBig = getLocCaptureTimestampUs(obj.extensions);
    const timestamp =
      captureUsBig === null
        ? this.deriveAudioTimestampUs(obj)
        : Number(captureUsBig);

    try {
      decoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp,
          data: payload,
        }),
      );
    } catch (e) {
      this.logger.error(
        `[WebCodecsLoc] audio decode failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private onDecodedAudio(data: AudioData): void {
    if (this.disposed || !this.audioContext) {
      data.close();
      return;
    }
    const audioCtx = this.audioContext;
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {
        // ignore
      });
    }

    // Capture timing fields before closing the AudioData.
    const presentationMs = data.timestamp / 1000;
    const numberOfChannels = data.numberOfChannels;
    const numberOfFrames = data.numberOfFrames;
    const sampleRate = data.sampleRate;

    if (this.audioCtxStartWallMs === null) {
      this.audioCtxStartWallMs = Date.now() - audioCtx.currentTime * 1000;
    }
    const audioCtxStartWallMs = this.audioCtxStartWallMs;
    // Anchor on the first sample so audio-only sessions still play in
    // real time.
    this.ensureAnchor(presentationMs);
    const anchorWallMs = this.anchorWallMs;
    if (anchorWallMs === null) {
      // ensureAnchor must have set this; defensive guard for TS narrowing.
      data.close();
      return;
    }

    const buffer = audioCtx.createBuffer(
      numberOfChannels,
      numberOfFrames,
      sampleRate,
    );
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const channelData = new Float32Array(numberOfFrames);
      data.copyTo(channelData, { planeIndex: ch, format: "f32-planar" });
      buffer.copyToChannel(channelData, ch);
    }
    data.close();

    // Wallclock at this chunk's presentation: 1 ms of media advances by
    // 1/playbackRate ms of wallclock when rate ≠ 1.0. This mirrors the
    // formula in playheadMs() so video and audio stay aligned under rate
    // control.
    const wallAtPresentation =
      anchorWallMs +
      (presentationMs - this.anchorPresentationMs) / this.playbackRate;
    let when = (wallAtPresentation - audioCtxStartWallMs) / 1000;

    // If the chunk's scheduled time has slipped into the past, queue it
    // immediately after the previous chunk so audio stays gap-free.
    const earliest = audioCtx.currentTime + 0.005;
    if (when < earliest) {
      when = Math.max(this.audioNextScheduleSec ?? earliest, earliest);
    }

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = this.playbackRate;
    source.connect(this.audioGain ?? audioCtx.destination);
    try {
      source.start(when);
    } catch (e) {
      this.logger.warn(
        `[WebCodecsLoc] audio start(${when.toFixed(3)}) failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    // The source plays for buffer.duration / playbackRate seconds of
    // wallclock, so the next back-to-back chunk should start there.
    const wallDurationSec = buffer.duration / this.playbackRate;
    this.audioNextScheduleSec = when + wallDurationSec;
    this.audioNewestScheduledMs = presentationMs + buffer.duration * 1000;
  }

  private deriveAudioTimestampUs(obj: MOQObject): number {
    // Fallback for audio when the publisher omits the LOC capture timestamp.
    const sampleRate = this.audioTrack?.samplerate ?? 48000;
    // AAC: 1024 samples/frame; Opus typical: 960 samples/frame at 48kHz.
    // mlmpub's LOC path emits one frame per object, so just use object index.
    const samplesPerFrame =
      this.audioTrack?.codec?.toLowerCase() === "opus" ? 960 : 1024;
    const groupId = Number(obj.location?.group ?? 0n);
    const objectId = Number(obj.location?.object ?? 0n);
    const frameIndex = groupId + objectId;
    return Math.round((frameIndex * samplesPerFrame * 1_000_000) / sampleRate);
  }

  private deriveTimestampUs(obj: MOQObject): number {
    // Fallback when the publisher didn't include a capture timestamp:
    // derive from group/object id with the catalog framerate. This keeps
    // the decoder happy even if it'll drift relative to wallclock.
    const fps = this.videoTrack?.framerate ?? 25;
    const objsPerGroup = 1; // one object per frame for AVC LOC video
    const groupId = Number(obj.location?.group ?? 0n);
    const objectId = Number(obj.location?.object ?? 0n);
    const frameIndex = groupId * objsPerGroup + objectId;
    return Math.round((frameIndex * 1_000_000) / fps);
  }

  private toUint8(data: Uint8Array | ArrayBuffer | undefined): Uint8Array {
    if (!data) {
      return new Uint8Array(0);
    }
    return data instanceof Uint8Array ? data : new Uint8Array(data);
  }

  private bytesEqual(
    a: Uint8Array | null,
    b: Uint8Array | null | undefined,
  ): boolean {
    if (!a || !b) {
      return false;
    }
    if (a.byteLength !== b.byteLength) {
      return false;
    }
    for (let i = 0; i < a.byteLength; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }
}
