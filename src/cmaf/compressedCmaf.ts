import type { WarpTrack } from "../warpcatalog";

import {
  assembleCmafFile,
  createLocMdatBox,
  decompressLocInit,
  extractInitContextFromInitSegment,
  getLocHeaderConstants,
  locTrackMetadataFromWarpTrack,
  LocInitContext,
  LocMoofDeltaDecoder,
} from "./loc";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export interface CompressedCmafTrackState {
  initContext: LocInitContext;
  initSegment: Uint8Array;
  moofDecoder: LocMoofDeltaDecoder;
}

export interface InitializedCompressedCmafTrack {
  state: CompressedCmafTrackState;
  initWasReconstructed: boolean;
}

function ensureUint8Array(payload: Uint8Array | ArrayBuffer): Uint8Array {
  return payload instanceof Uint8Array ? payload : new Uint8Array(payload);
}

function toSafeInteger(value: bigint, fieldName: string): number {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    throw new Error(`${fieldName} exceeds JavaScript safe integer range`);
  }
  return Number(value);
}

function decodeGoVarint(
  payload: Uint8Array,
  offset: number,
): { value: number; bytesRead: number } {
  let ux = 0n;
  let shift = 0n;

  for (let i = 0; i < 10; i++) {
    const index = offset + i;
    if (index >= payload.byteLength) {
      throw new Error("truncated Go varint");
    }

    const byte = payload[index];
    if (byte < 0x80) {
      if (i === 9 && byte > 1) {
        throw new Error("Go varint overflows 64 bits");
      }

      ux |= BigInt(byte) << shift;
      let value = ux >> 1n;
      if ((ux & 1n) !== 0n) {
        value = ~value;
      }

      return {
        value: toSafeInteger(value, "Go varint"),
        bytesRead: i + 1,
      };
    }

    ux |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  }

  throw new Error("invalid Go varint");
}

function parseCompressedCmafObject(payload: Uint8Array | ArrayBuffer): {
  headerId: number;
  locPayload: Uint8Array;
  mdatPayload: Uint8Array;
} {
  const bytes = ensureUint8Array(payload);

  const header = decodeGoVarint(bytes, 0);
  const locLength = decodeGoVarint(bytes, header.bytesRead);
  const locStart = header.bytesRead + locLength.bytesRead;
  const locEnd = locStart + locLength.value;

  if (locLength.value < 0 || locEnd > bytes.byteLength) {
    throw new Error("compressed CMAF LOC payload exceeds object length");
  }

  return {
    headerId: header.value,
    locPayload: bytes.subarray(locStart, locEnd),
    mdatPayload: bytes.subarray(locEnd),
  };
}

function parseCompressedCmafInit(payload: Uint8Array | ArrayBuffer): {
  headerId: number;
  locPayload: Uint8Array;
} {
  const bytes = ensureUint8Array(payload);

  const header = decodeGoVarint(bytes, 0);
  const locLength = decodeGoVarint(bytes, header.bytesRead);
  const locStart = header.bytesRead + locLength.bytesRead;
  const locEnd = locStart + locLength.value;

  if (locLength.value < 0 || locEnd > bytes.byteLength) {
    throw new Error("compressed CMAF init payload exceeds object length");
  }

  return {
    headerId: header.value,
    locPayload: bytes.subarray(locStart, locEnd),
  };
}

export function isCompressedCmafTrack(
  track: Pick<WarpTrack, "packaging">,
): boolean {
  return track.packaging === "compressed-cmaf";
}

export function createCompressedCmafTrackState(
  track: WarpTrack,
  compressedInitSegment: Uint8Array | ArrayBuffer,
): CompressedCmafTrackState {
  const headers = getLocHeaderConstants();
  let locPayload = ensureUint8Array(compressedInitSegment);

  try {
    const parsedInit = parseCompressedCmafInit(compressedInitSegment);
    if (parsedInit.headerId !== headers.moov) {
      throw new Error(
        `unsupported compressed CMAF init header ${parsedInit.headerId}`,
      );
    }
    locPayload = parsedInit.locPayload;
  } catch {
    // Backward compatibility for pre-framed test fixtures / older catalogs.
  }

  const reconstructedInit = decompressLocInit(
    locPayload,
    locTrackMetadataFromWarpTrack(track),
  );

  return {
    initContext: reconstructedInit.context,
    initSegment: reconstructedInit.bytes,
    moofDecoder: new LocMoofDeltaDecoder(),
  };
}

export function initializeCompressedCmafTrack(
  track: WarpTrack,
  initSegment: Uint8Array | ArrayBuffer,
): InitializedCompressedCmafTrack {
  const initBytes = ensureUint8Array(initSegment);

  try {
    const parsedInit = parseCompressedCmafInit(initBytes);
    if (parsedInit.headerId === getLocHeaderConstants().moov) {
      return {
        state: createCompressedCmafTrackState(track, initBytes),
        initWasReconstructed: true,
      };
    }
  } catch {
    // Not a framed compressed init.
  }

  try {
    return {
      state: {
        initContext: extractInitContextFromInitSegment(initBytes),
        initSegment: initBytes,
        moofDecoder: new LocMoofDeltaDecoder(),
      },
      initWasReconstructed: false,
    };
  } catch {
    return {
      state: createCompressedCmafTrackState(track, initBytes),
      initWasReconstructed: true,
    };
  }
}

export function decompressCompressedCmafFragment(
  payload: Uint8Array | ArrayBuffer,
  sequenceNumber: number,
  state: CompressedCmafTrackState,
): Uint8Array {
  const { headerId, locPayload, mdatPayload } =
    parseCompressedCmafObject(payload);
  const headers = getLocHeaderConstants();

  if (headerId !== headers.moof && headerId !== headers.moofDelta) {
    throw new Error(`unsupported compressed CMAF moof header ${headerId}`);
  }

  const moof = state.moofDecoder.decode(
    headerId,
    locPayload,
    sequenceNumber,
    state.initContext,
  );
  const mdat = createLocMdatBox(mdatPayload);

  return assembleCmafFile({
    initSegment: new Uint8Array(),
    moof: moof.box,
    mdat,
  });
}
