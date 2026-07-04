/**
 * LOCMAF packaging support for the MSE pipeline.
 *
 * LOCMAF is a compact CMAF packaging specified by the IETF draft
 * draft-einarsson-moq-locmaf. Only packaging version 0.3 is supported;
 * the codec lives in ./v03/ and this module is a thin version-gating
 * wrapper used by the player.
 */
import type { MediaTrackInfo } from "../buffer/mediaBuffer";
import type { WarpTrack } from "../warpcatalog";

import {
  LocmafGroupState,
  decodeObject,
  parseInitContext,
} from "./v03/decoder";
import { reconstructCanonical } from "./v03/reconstruct";
import { LOCMAF_VERSION, type InitContext } from "./v03/types";

// LOCMAF packaging version this decoder understands. The CMSF catalog
// Track advertises `locmafVersion` whenever packaging == "locmaf".
export const LOCMAF_SUPPORTED_VERSION = LOCMAF_VERSION;
export const LOCMAF_SUPPORTED_VERSIONS: ReadonlySet<string> = new Set([
  LOCMAF_VERSION,
]);

/** Per-track LOCMAF state carried across objects within a group. */
export interface LocmafTrackState {
  /** LOCMAF packaging version ("0.3"). */
  version: string;
  /** The (raw CMAF) init segment handed to MSE. */
  initSegment: Uint8Array;
  /** Track context from the CMAF Header (trex/tenc defaults etc). */
  ctx: InitContext;
  /** In-group delta-decoder state; reset by every full header or
   * rawBoxes Object, and poisoned by any malformed object so stale
   * deltas reject until the next re-anchor. */
  group: LocmafGroupState;
}

export interface InitializedLocmafTrack {
  state: LocmafTrackState;
  /** Always false — LOCMAF init data is raw CMAF, never reconstructed. */
  initWasReconstructed: boolean;
}

export function isLocmafTrack(track: Pick<WarpTrack, "packaging">): boolean {
  return track.packaging === "locmaf";
}

function ensureUint8Array(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function assertLocmafVersion(
  track: Pick<WarpTrack, "name" | "locmafVersion">,
): string {
  const version = track.locmafVersion ?? LOCMAF_SUPPORTED_VERSION;
  if (!LOCMAF_SUPPORTED_VERSIONS.has(version)) {
    throw new Error(
      `unsupported locmafVersion "${version}" on track ${
        track.name ?? "<unnamed>"
      }; this decoder supports "${LOCMAF_SUPPORTED_VERSION}"`,
    );
  }
  return version;
}

export function createLocmafTrackState(
  track: WarpTrack,
  locmafInitSegment: Uint8Array | ArrayBuffer,
): LocmafTrackState {
  const version = assertLocmafVersion(track);
  const initSegment = ensureUint8Array(locmafInitSegment);
  return {
    version,
    initSegment,
    ctx: parseInitContext(initSegment),
    group: new LocmafGroupState(),
  };
}

export function initializeLocmafTrack(
  track: WarpTrack,
  initSegment: Uint8Array | ArrayBuffer,
): InitializedLocmafTrack {
  return {
    state: createLocmafTrackState(track, initSegment),
    // LOCMAF init is raw CMAF — handed to MSE unchanged.
    initWasReconstructed: false,
  };
}

/**
 * Decode one LOCMAF Object and rebuild the CMAF chunk for MSE.
 *
 * A moof-carrying Object reconstructs canonically (with the MoQ group's
 * sequenceNumber in mfhd, as the draft permits for playback); a
 * rawBoxes Object passes its complete boxes through verbatim. A
 * malformed object is dropped with a warning — the group state is then
 * poisoned, so subsequent delta objects are also dropped until the
 * next full header or rawBoxes Object re-anchors.
 */
export function decompressMoofWithTrackInfo(
  payload: Uint8Array | ArrayBuffer,
  sequenceNumber: number,
  state: LocmafTrackState,
): { bytes: Uint8Array; trackInfo: MediaTrackInfo } | undefined {
  let result;
  try {
    result = decodeObject(ensureUint8Array(payload), state.group, state.ctx);
  } catch (err) {
    console.warn(`locmaf: dropping object (seq ${sequenceNumber}):`, err);
    return undefined;
  }

  if (result.raw !== undefined) {
    return {
      bytes: result.raw,
      trackInfo: { timescale: state.ctx.timescale, sequenceNumber },
    };
  }
  const eff = result.eff;
  if (eff === undefined) {
    return undefined;
  }

  let bytes;
  try {
    bytes = reconstructCanonical(state.ctx, eff, sequenceNumber);
  } catch (err) {
    console.warn(`locmaf: dropping unreconstructable object:`, err);
    return undefined;
  }

  let duration = 0;
  for (const d of eff.durations) {
    duration += d;
  }
  return {
    bytes,
    trackInfo: {
      timescale: state.ctx.timescale,
      baseMediaDecodeTime: Number(eff.bmdt),
      duration,
      sequenceNumber,
    },
  };
}

export function decompressMoof(
  payload: Uint8Array | ArrayBuffer,
  sequenceNumber: number,
  state: LocmafTrackState,
): Uint8Array | undefined {
  return decompressMoofWithTrackInfo(payload, sequenceNumber, state)?.bytes;
}
