// AVC (H.264) helpers for the LOC payload path.
//
// LOC AVC objects are length-prefixed NALUs (4-byte big-endian length per
// NALU). At IDR boundaries mlmpub prepends SPS+PPS NALUs to the payload, so
// the player can build a fresh AVCDecoderConfigurationRecord on first
// keyframe and re-validate on parameter-set changes.
//
// References:
//   - ISO/IEC 14496-10 §7.4.1.2 (NAL unit syntax / nal_unit_type)
//   - ISO/IEC 14496-15 §5.3.3.1 (AVCDecoderConfigurationRecord)
//   - draft-mzanaty-moq-loc-05 §3 (length-prefixed NALU format)
//   - moqlivemock/internal/sub/loc.go for the wire layout we consume

export const NALU_TYPE_NON_IDR_SLICE = 1;
export const NALU_TYPE_IDR_SLICE = 5;
export const NALU_TYPE_SEI = 6;
export const NALU_TYPE_SPS = 7;
export const NALU_TYPE_PPS = 8;

export interface NaluView {
  /** nal_unit_type (5 LSBs of the first byte). */
  type: number;
  /** The NALU payload — the type byte plus all RBSP bytes. */
  data: Uint8Array;
}

export class AvcParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvcParseError";
  }
}

/**
 * Split a length-prefixed NALU stream into its NALUs. Each prefix is a 4-byte
 * big-endian length. Empty payload yields an empty array.
 */
export function walkAvccNalus(payload: Uint8Array): NaluView[] {
  const result: NaluView[] = [];
  let offset = 0;
  while (offset < payload.length) {
    if (offset + 4 > payload.length) {
      throw new AvcParseError(
        `truncated NALU length prefix at offset ${offset} (have ${payload.length - offset} bytes)`,
      );
    }
    const len =
      (payload[offset] << 24) |
      (payload[offset + 1] << 16) |
      (payload[offset + 2] << 8) |
      payload[offset + 3];
    offset += 4;
    if (len < 1) {
      throw new AvcParseError(`zero-length NALU at offset ${offset}`);
    }
    if (offset + len > payload.length) {
      throw new AvcParseError(
        `NALU of length ${len} extends past end (offset ${offset}, payload ${payload.length})`,
      );
    }
    const data = payload.subarray(offset, offset + len);
    const type = data[0] & 0x1f;
    result.push({ type, data });
    offset += len;
  }
  return result;
}

/** True when any NALU in `payload` is an IDR slice. */
export function payloadIsKey(payload: Uint8Array): boolean {
  for (const nalu of walkAvccNalus(payload)) {
    if (nalu.type === NALU_TYPE_IDR_SLICE) {
      return true;
    }
  }
  return false;
}

export interface AvcSplitResult {
  /** Parameter sets discovered in the payload, in arrival order. */
  sps: Uint8Array[];
  /** Picture parameter sets discovered in the payload, in arrival order. */
  pps: Uint8Array[];
  /**
   * Length-prefixed picture NALUs (slice + SEI + AUD ...) suitable for
   * EncodedVideoChunk.data. Empty when the object only carried parameter
   * sets.
   */
  chunk: Uint8Array;
  /** True when the picture NALUs include at least one IDR slice. */
  isKey: boolean;
}

/**
 * Walk an LOC AVC payload, peel off any leading/trailing SPS+PPS NALUs, and
 * return the picture NALUs as a fresh length-prefixed buffer. Order is
 * preserved among picture NALUs.
 */
export function extractParameterSetsAndChunk(
  payload: Uint8Array,
): AvcSplitResult {
  const sps: Uint8Array[] = [];
  const pps: Uint8Array[] = [];
  const picture: Uint8Array[] = [];
  let isKey = false;
  for (const nalu of walkAvccNalus(payload)) {
    if (nalu.type === NALU_TYPE_SPS) {
      sps.push(copy(nalu.data));
    } else if (nalu.type === NALU_TYPE_PPS) {
      pps.push(copy(nalu.data));
    } else {
      picture.push(nalu.data);
      if (nalu.type === NALU_TYPE_IDR_SLICE) {
        isKey = true;
      }
    }
  }
  let chunkLength = 0;
  for (const n of picture) {
    chunkLength += 4 + n.length;
  }
  const chunk = new Uint8Array(chunkLength);
  let offset = 0;
  for (const n of picture) {
    chunk[offset] = (n.length >>> 24) & 0xff;
    chunk[offset + 1] = (n.length >>> 16) & 0xff;
    chunk[offset + 2] = (n.length >>> 8) & 0xff;
    chunk[offset + 3] = n.length & 0xff;
    chunk.set(n, offset + 4);
    offset += 4 + n.length;
  }
  return { sps, pps, chunk, isKey };
}

/**
 * Build an AVCDecoderConfigurationRecord (the avcC box content, which is
 * what WebCodecs expects in `VideoDecoderConfig.description`) from at least
 * one SPS and one PPS. Length size is fixed at 4 bytes — matches the LOC
 * wire format and what we re-emit in `chunk`.
 */
export function buildAvcDecoderConfigDescription(
  sps: Uint8Array[],
  pps: Uint8Array[],
): Uint8Array {
  if (sps.length === 0) {
    throw new AvcParseError("at least one SPS is required");
  }
  if (pps.length === 0) {
    throw new AvcParseError("at least one PPS is required");
  }
  if (sps.length > 31) {
    throw new AvcParseError(`too many SPS (${sps.length}, max 31)`);
  }
  if (pps.length > 255) {
    throw new AvcParseError(`too many PPS (${pps.length}, max 255)`);
  }
  const firstSps = sps[0];
  if (firstSps.length < 4) {
    throw new AvcParseError("SPS too short to read profile/level");
  }
  let size = 6; // header bytes through numOfSequenceParameterSets
  for (const s of sps) {
    size += 2 + s.length;
  }
  size += 1; // numOfPictureParameterSets
  for (const p of pps) {
    size += 2 + p.length;
  }
  const out = new Uint8Array(size);
  let off = 0;
  out[off++] = 1; // configurationVersion
  out[off++] = firstSps[1]; // AVCProfileIndication
  out[off++] = firstSps[2]; // profile_compatibility
  out[off++] = firstSps[3]; // AVCLevelIndication
  out[off++] = 0xfc | 3; // reserved 6 bits | lengthSizeMinusOne (3 = 4 bytes)
  out[off++] = 0xe0 | sps.length; // reserved 3 bits | numOfSequenceParameterSets
  for (const s of sps) {
    out[off++] = (s.length >> 8) & 0xff;
    out[off++] = s.length & 0xff;
    out.set(s, off);
    off += s.length;
  }
  out[off++] = pps.length;
  for (const p of pps) {
    out[off++] = (p.length >> 8) & 0xff;
    out[off++] = p.length & 0xff;
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function copy(src: Uint8Array): Uint8Array {
  return new Uint8Array(src);
}
