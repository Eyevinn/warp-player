// Playback pipeline abstraction.
//
// The render path has two orthogonal axes:
//
//   1. Engine            — MSE (with optional EME) | WebCodecs
//   2. Packaging         — cmaf | loc | locmaf | ... (per-track on the wire)
//
// Most engine/packaging combinations are valid; some require reconstruction.
// Encrypted content can only flow through the MSE engine because production
// browsers don't expose Encrypted WebCodecs.
//
//      capability matrix       cmaf      loc       locmaf
//      ────────────────────    ────      ───       ──────
//      mse (clear)              ✓        future    future
//      mse (encrypted/EME)      ✓        n/a       future
//      webcodecs (clear)        future   ✓ Phase3  future
//      webcodecs (encrypted)    ✗        ✗         ✗
//
// `MsePipeline` owns MediaSource, SourceBuffer, and (eventually) MediaKeys/EME.
// `WebCodecsLocPipeline` (Phase 3) will own VideoDecoder/AudioDecoder + canvas.
// LOCMAF lands as additional packaging support: a payload adapter that
// reconstructs CMAF for MSE and (clear-only) raw chunks for WebCodecs.

import { ILogger } from "../logger";
import { MOQObject } from "../transport/tracks";
import { WarpTrack } from "../warpcatalog";

/** Render engine identifiers. */
export type Engine = "mse" | "webcodecs";

/**
 * User preference for engine selection. "auto" picks the best engine for the
 * selected tracks; the explicit choices override and let the namespace UI
 * filter to compatible namespaces only.
 */
export type EngineChoice = "auto" | "mse" | "webcodecs";

/** Which media role a delivered MOQObject belongs to. */
export type TrackRole = "video" | "audio";

/** Buffer/latency knobs forwarded from the user-facing config. */
export interface PipelineBufferConfig {
  minimalBufferMs: number;
  targetLatencyMs: number;
}

/** Snapshot read by the rate-control loop in player.ts. */
export interface PipelineLatencySnapshot {
  /**
   * End-to-end latency in ms (wallclock now − presentation time of the frame
   * currently on screen). null when no frame has been presented yet.
   */
  currentLatencyMs: number | null;
  /** Buffered seconds ahead of the playhead in the video pipeline. */
  videoBufferedAheadS: number;
  /** Buffered seconds ahead of the playhead in the audio pipeline. */
  audioBufferedAheadS: number;
}

/** What a pipeline needs to render into. Different pipelines use different parts. */
export interface PipelineRenderTargets {
  /** Used by MSE for both video and audio playback. */
  videoElement: HTMLVideoElement;
  /** Used by WebCodecs to draw decoded VideoFrames. May be hidden for MSE. */
  canvasElement?: HTMLCanvasElement;
}

export interface PipelineSetupOptions {
  videoTrack: WarpTrack | null;
  audioTrack: WarpTrack | null;
  targets: PipelineRenderTargets;
  buffer: PipelineBufferConfig;
  logger: ILogger;
}

/**
 * A pipeline owns the render path from received MOQObjects to playback.
 *
 * Lifecycle: create → setup() → routeObject()* → dispose().
 *
 * Implementations must be idempotent under repeated dispose() and tolerate
 * setup() being called only once per instance.
 */
export interface IPlaybackPipeline {
  readonly engine: Engine;

  /** Wire up decoders/source buffers and attach to the render targets. */
  setup(options: PipelineSetupOptions): Promise<void>;

  /** Hand off a freshly received object to the pipeline for the given role. */
  routeObject(role: TrackRole, obj: MOQObject): void;

  /** Snapshot for the rate-control loop. */
  getLatencySnapshot(): PipelineLatencySnapshot;

  /** Update the buffer/latency targets at runtime. */
  setBufferConfig(config: PipelineBufferConfig): void;

  /** Apply a playback-rate multiplier (1.0 = real-time). */
  setPlaybackRate(rate: number): void;

  /** Current playback-rate multiplier surfaced to the UI. */
  getPlaybackRate(): number;

  /** Tear down decoders, source buffers, render scheduling. */
  dispose(): Promise<void>;
}

/** Returns true when the track has any content protection (DRM/ECCP). */
export function trackIsEncrypted(track: WarpTrack | null | undefined): boolean {
  if (!track) {
    return false;
  }
  return Boolean(
    track.contentProtectionRefIDs && track.contentProtectionRefIDs.length > 0,
  );
}

/**
 * Capability table — kept as a function so it stays grep-able when LOCMAF or
 * other packagings land. Returns true when the engine can play the
 * (packaging, encrypted) combination today.
 */
export function engineSupports(
  engine: Engine,
  packaging: string | undefined,
  encrypted: boolean,
): boolean {
  if (engine === "mse") {
    // MSE handles CMAF natively today. LOC/LOCMAF reconstruction is future
    // work but the encrypted path is reserved for MSE+EME regardless.
    if (packaging === "cmaf") {
      return true;
    }
    return false;
  }
  // webcodecs
  if (encrypted) {
    return false;
  }
  if (packaging === "loc") {
    return true;
  }
  return false;
}

/**
 * True when the engine can play every present track. Used by namespace
 * filtering to highlight/enable only compatible namespaces once the user has
 * picked an engine.
 */
export function engineCanPlayTracks(
  engine: Engine,
  videoTrack: WarpTrack | null,
  audioTrack: WarpTrack | null,
): boolean {
  for (const track of [videoTrack, audioTrack]) {
    if (!track) {
      continue;
    }
    if (!engineSupports(engine, track.packaging, trackIsEncrypted(track))) {
      return false;
    }
  }
  return true;
}

/**
 * Pick the engine that should play the given tracks when the user has not
 * forced a choice. Prefers MSE for CMAF / encrypted content; prefers
 * WebCodecs for clear LOC. Throws on mixed packagings.
 */
export function defaultEngineForTracks(
  videoTrack: WarpTrack | null,
  audioTrack: WarpTrack | null,
): Engine {
  const packagings = new Set<string>();
  let anyEncrypted = false;
  for (const track of [videoTrack, audioTrack]) {
    if (!track) {
      continue;
    }
    if (track.packaging) {
      packagings.add(track.packaging);
    }
    if (trackIsEncrypted(track)) {
      anyEncrypted = true;
    }
  }
  if (packagings.size === 0) {
    return "mse";
  }
  if (packagings.size > 1) {
    throw new Error(
      `Mixed packagings not supported: ${Array.from(packagings).join(", ")}`,
    );
  }
  if (anyEncrypted) {
    return "mse";
  }
  const [packaging] = packagings;
  if (packaging === "loc") {
    return "webcodecs";
  }
  if (packaging === "cmaf") {
    return "mse";
  }
  throw new Error(`Unsupported track packaging: ${packaging}`);
}

/**
 * Resolve the engine the player should actually use based on the user's
 * choice and what the tracks support. Throws when the user forced an engine
 * that can't play these tracks — the namespace UI is expected to prevent that.
 */
export function resolveEngine(
  choice: EngineChoice,
  videoTrack: WarpTrack | null,
  audioTrack: WarpTrack | null,
): Engine {
  if (choice === "auto") {
    return defaultEngineForTracks(videoTrack, audioTrack);
  }
  if (!engineCanPlayTracks(choice, videoTrack, audioTrack)) {
    throw new Error(
      `Engine "${choice}" cannot play the selected tracks (incompatible packaging or encryption)`,
    );
  }
  return choice;
}
