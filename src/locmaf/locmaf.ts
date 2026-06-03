/**
 * LOCMAF packaging support for the MSE pipeline.
 *
 * LOCMAF is a compressed CMAF wire format. Only v0.2 (the current IETF draft
 * draft-einarsson-moq-locmaf) is supported; the legacy v0.1 wire format has
 * been removed. The actual codec lives in ./v02/decoder; this module is a thin
 * version-gating wrapper used by the player.
 */
import type { MediaTrackInfo } from "../buffer/mediaBuffer";
import type { WarpTrack } from "../warpcatalog";

import {
  decompressMoofV02WithTrackInfo,
  initializeLocmafV02Track,
  type LocmafV02TrackState,
} from "./v02/decoder";

// LOCMAF wire-format version this decoder understands. The CMSF catalog Track
// advertises `locmafVersion` whenever packaging == "locmaf".
export const LOCMAF_SUPPORTED_VERSION = "0.2";
export const LOCMAF_SUPPORTED_VERSIONS: ReadonlySet<string> = new Set(["0.2"]);

/** Per-track LOCMAF state carried across objects within a group. */
export interface LocmafTrackState {
  /** LOCMAF wire-format version ("0.2"). */
  version: string;
  /** The (raw CMAF) init segment handed to MSE. */
  initSegment: Uint8Array;
  /** v0.2 decoder substate. */
  v02: LocmafV02TrackState;
}

export interface InitializedLocmafTrack {
  state: LocmafTrackState;
  /** Always false for v0.2 — init is raw CMAF, never reconstructed. */
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
  const initialized = initializeLocmafV02Track(
    ensureUint8Array(locmafInitSegment),
  );
  return {
    version,
    initSegment: initialized.state.initSegment,
    v02: initialized.state,
  };
}

export function initializeLocmafTrack(
  track: WarpTrack,
  initSegment: Uint8Array | ArrayBuffer,
): InitializedLocmafTrack {
  return {
    state: createLocmafTrackState(track, initSegment),
    // v0.2 init is raw CMAF — handed to MSE unchanged.
    initWasReconstructed: false,
  };
}

export function decompressMoofWithTrackInfo(
  payload: Uint8Array | ArrayBuffer,
  sequenceNumber: number,
  state: LocmafTrackState,
): { bytes: Uint8Array; trackInfo: MediaTrackInfo } | undefined {
  return decompressMoofV02WithTrackInfo(payload, sequenceNumber, state.v02);
}

export function decompressMoof(
  payload: Uint8Array | ArrayBuffer,
  sequenceNumber: number,
  state: LocmafTrackState,
): Uint8Array | undefined {
  return decompressMoofWithTrackInfo(payload, sequenceNumber, state)?.bytes;
}
