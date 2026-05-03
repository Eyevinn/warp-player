// HEVC (H.265) helpers for the LOC payload path.
//
// LOC HEVC objects are length-prefixed NALUs (4-byte big-endian length per
// NALU). At IRAP boundaries mlmpub prepends VPS+SPS+PPS NALUs to the payload,
// so the player can build a fresh HEVCDecoderConfigurationRecord on first
// keyframe and re-validate on parameter-set changes.
//
// References:
//   - ISO/IEC 23008-2 §7.4.2.2 (NAL unit syntax / nal_unit_type)
//   - ISO/IEC 14496-15 §8.3.3.1 (HEVCDecoderConfigurationRecord)
//   - draft-ietf-moq-loc-02 §2.1 (length-prefixed NALU format)
//   - moqlivemock/internal/media.go (HEVCData.GenLOCVideoConfig)

// IRAP picture NAL unit types (ISO/IEC 23008-2 §7.4.2.2 Table 7-1).
export const NALU_TYPE_BLA_W_LP = 16;
export const NALU_TYPE_BLA_W_RADL = 17;
export const NALU_TYPE_BLA_N_LP = 18;
export const NALU_TYPE_IDR_W_RADL = 19;
export const NALU_TYPE_IDR_N_LP = 20;
export const NALU_TYPE_CRA_NUT = 21;

// Parameter set NAL unit types.
export const NALU_TYPE_VPS = 32;
export const NALU_TYPE_SPS = 33;
export const NALU_TYPE_PPS = 34;

export const NALU_TYPE_AUD = 35;
export const NALU_TYPE_PREFIX_SEI = 39;
export const NALU_TYPE_SUFFIX_SEI = 40;

export interface NaluView {
  /** nal_unit_type (bits 1-6 of the first byte). */
  type: number;
  /** The NALU payload — the two header bytes plus all RBSP bytes. */
  data: Uint8Array;
}

export class HevcParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HevcParseError";
  }
}

/** True for IRAP NAL unit types (BLA / IDR / CRA). */
export function isIrapNaluType(type: number): boolean {
  return type >= NALU_TYPE_BLA_W_LP && type <= NALU_TYPE_CRA_NUT;
}

/** Read nal_unit_type from the first byte of a HEVC NALU. */
export function naluType(firstByte: number): number {
  return (firstByte >> 1) & 0x3f;
}

/**
 * Split a length-prefixed NALU stream into its NALUs. Each prefix is a 4-byte
 * big-endian length. Empty payload yields an empty array.
 */
export function walkHvccNalus(payload: Uint8Array): NaluView[] {
  const result: NaluView[] = [];
  let offset = 0;
  while (offset < payload.length) {
    if (offset + 4 > payload.length) {
      throw new HevcParseError(
        `truncated NALU length prefix at offset ${offset} (have ${payload.length - offset} bytes)`,
      );
    }
    const len =
      (payload[offset] << 24) |
      (payload[offset + 1] << 16) |
      (payload[offset + 2] << 8) |
      payload[offset + 3];
    offset += 4;
    if (len < 2) {
      throw new HevcParseError(
        `NALU length ${len} too small at offset ${offset}`,
      );
    }
    if (offset + len > payload.length) {
      throw new HevcParseError(
        `NALU of length ${len} extends past end (offset ${offset}, payload ${payload.length})`,
      );
    }
    const data = payload.subarray(offset, offset + len);
    result.push({ type: naluType(data[0]), data });
    offset += len;
  }
  return result;
}

/** True when any NALU in `payload` is an IRAP slice. */
export function payloadIsKey(payload: Uint8Array): boolean {
  for (const n of walkHvccNalus(payload)) {
    if (isIrapNaluType(n.type)) {
      return true;
    }
  }
  return false;
}

export interface HevcSplitResult {
  /** Video parameter sets discovered in the payload, in arrival order. */
  vps: Uint8Array[];
  /** Sequence parameter sets discovered in the payload, in arrival order. */
  sps: Uint8Array[];
  /** Picture parameter sets discovered in the payload, in arrival order. */
  pps: Uint8Array[];
  /**
   * Length-prefixed picture NALUs (slice + SEI + AUD ...) suitable for
   * EncodedVideoChunk.data. Empty when the object only carried parameter sets.
   */
  chunk: Uint8Array;
  /** True when the picture NALUs include at least one IRAP slice. */
  isKey: boolean;
}

/**
 * Walk an LOC HEVC payload, peel off any leading/trailing VPS+SPS+PPS NALUs,
 * and return the picture NALUs as a fresh length-prefixed buffer. Order is
 * preserved among picture NALUs.
 */
export function extractParameterSetsAndChunk(
  payload: Uint8Array,
): HevcSplitResult {
  const vps: Uint8Array[] = [];
  const sps: Uint8Array[] = [];
  const pps: Uint8Array[] = [];
  const picture: Uint8Array[] = [];
  let isKey = false;
  for (const n of walkHvccNalus(payload)) {
    if (n.type === NALU_TYPE_VPS) {
      vps.push(copy(n.data));
    } else if (n.type === NALU_TYPE_SPS) {
      sps.push(copy(n.data));
    } else if (n.type === NALU_TYPE_PPS) {
      pps.push(copy(n.data));
    } else {
      picture.push(n.data);
      if (isIrapNaluType(n.type)) {
        isKey = true;
      }
    }
  }
  let chunkLength = 0;
  for (const p of picture) {
    chunkLength += 4 + p.length;
  }
  const chunk = new Uint8Array(chunkLength);
  let offset = 0;
  for (const p of picture) {
    chunk[offset] = (p.length >>> 24) & 0xff;
    chunk[offset + 1] = (p.length >>> 16) & 0xff;
    chunk[offset + 2] = (p.length >>> 8) & 0xff;
    chunk[offset + 3] = p.length & 0xff;
    chunk.set(p, offset + 4);
    offset += 4 + p.length;
  }
  return { vps, sps, pps, chunk, isKey };
}

/**
 * Strip emulation prevention bytes (0x000003 → 0x0000) from a NALU RBSP slice.
 * HEVC, like AVC, escapes byte sequences that could be confused with start
 * codes. We only need this for the 12-byte profile_tier_level region of the
 * SPS — emulation-prevention bytes there are rare but legal.
 */
function stripEmulationPrevention(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length);
  let outLen = 0;
  let zeroRun = 0;
  for (let i = 0; i < input.length; i++) {
    const b = input[i];
    if (zeroRun >= 2 && b === 0x03) {
      zeroRun = 0;
      continue;
    }
    out[outLen++] = b;
    zeroRun = b === 0 ? zeroRun + 1 : 0;
  }
  return out.subarray(0, outLen);
}

/**
 * Profile/Tier/Level fields extracted from the first 12 bytes of an HEVC SPS
 * profile_tier_level structure.
 */
interface ProfileTierLevel {
  profileSpace: number; // 2 bits
  tierFlag: number; // 1 bit
  profileIdc: number; // 5 bits
  profileCompatibilityFlags: Uint8Array; // 4 bytes
  constraintIndicatorFlags: Uint8Array; // 6 bytes
  levelIdc: number; // 8 bits
}

/**
 * Pull the profile_tier_level prefix out of an SPS NALU.
 *
 * SPS layout (ISO/IEC 23008-2 §7.3.2.2):
 *   bytes 0-1: NAL header (2 bytes)
 *   byte 2:    sps_video_parameter_set_id(4) | sps_max_sub_layers_minus1(3)
 *              | sps_temporal_id_nesting_flag(1)
 *   bytes 3-14: profile_tier_level (12 bytes for the base layer prefix)
 */
function extractPtl(spsNalu: Uint8Array): ProfileTierLevel {
  if (spsNalu.length < 15) {
    throw new HevcParseError(
      `SPS too short to read profile_tier_level (${spsNalu.length} bytes)`,
    );
  }
  const stripped = stripEmulationPrevention(spsNalu);
  if (stripped.length < 15) {
    throw new HevcParseError(
      `SPS too short after emulation strip (${stripped.length} bytes)`,
    );
  }
  const ptl = stripped.subarray(3, 15);
  return {
    profileSpace: (ptl[0] >> 6) & 0x03,
    tierFlag: (ptl[0] >> 5) & 0x01,
    profileIdc: ptl[0] & 0x1f,
    profileCompatibilityFlags: ptl.subarray(1, 5),
    constraintIndicatorFlags: ptl.subarray(5, 11),
    levelIdc: ptl[11],
  };
}

/**
 * Build an HEVCDecoderConfigurationRecord (the hvcC box content, which is
 * what WebCodecs expects in `VideoDecoderConfig.description`) from VPS, SPS
 * and PPS NALUs. Length size is fixed at 4 bytes — matches the LOC wire
 * format and what we re-emit in `chunk`.
 *
 * Profile/tier/level is taken from the first SPS. Other fields (chroma
 * format, bit depths, parallelism) are set to common 4:2:0 8-bit defaults
 * — sufficient for the test content; would need SPS bitstream parsing to
 * generalise.
 */
export function buildHevcDecoderConfigDescription(
  vps: Uint8Array[],
  sps: Uint8Array[],
  pps: Uint8Array[],
): Uint8Array {
  if (vps.length === 0) {
    throw new HevcParseError("at least one VPS is required");
  }
  if (sps.length === 0) {
    throw new HevcParseError("at least one SPS is required");
  }
  if (pps.length === 0) {
    throw new HevcParseError("at least one PPS is required");
  }
  const ptl = extractPtl(sps[0]);

  const arrays: { type: number; nalus: Uint8Array[] }[] = [
    { type: NALU_TYPE_VPS, nalus: vps },
    { type: NALU_TYPE_SPS, nalus: sps },
    { type: NALU_TYPE_PPS, nalus: pps },
  ];

  let size = 23; // fixed-length header
  for (const arr of arrays) {
    size += 3; // array header (1 byte type + 2 bytes numNalus)
    for (const n of arr.nalus) {
      size += 2 + n.length;
    }
  }

  const out = new Uint8Array(size);
  let off = 0;
  out[off++] = 1; // configurationVersion
  out[off++] =
    ((ptl.profileSpace & 0x03) << 6) |
    ((ptl.tierFlag & 0x01) << 5) |
    (ptl.profileIdc & 0x1f);
  out.set(ptl.profileCompatibilityFlags, off);
  off += 4;
  out.set(ptl.constraintIndicatorFlags, off);
  off += 6;
  out[off++] = ptl.levelIdc;
  // reserved (4 bits, all 1s) | min_spatial_segmentation_idc (12 bits, 0)
  out[off++] = 0xf0;
  out[off++] = 0x00;
  // reserved (6 bits, all 1s) | parallelismType (2 bits, 0 = mixed)
  out[off++] = 0xfc;
  // reserved (6 bits, all 1s) | chromaFormat (2 bits, 1 = 4:2:0)
  out[off++] = 0xfc | 0x01;
  // reserved (5 bits, all 1s) | bitDepthLumaMinus8 (3 bits, 0)
  out[off++] = 0xf8;
  // reserved (5 bits, all 1s) | bitDepthChromaMinus8 (3 bits, 0)
  out[off++] = 0xf8;
  // avgFrameRate (16 bits, 0 = unspecified)
  out[off++] = 0x00;
  out[off++] = 0x00;
  // constantFrameRate (2) | numTemporalLayers (3) | temporalIdNested (1) | lengthSizeMinusOne (2)
  // 0 | 1 | 0 | 3 → 0b00 001 0 11 = 0x0b
  out[off++] = 0x0b;
  out[off++] = arrays.length; // numOfArrays
  for (const arr of arrays) {
    // array_completeness=1 | reserved=0 | NAL_unit_type (6 bits)
    out[off++] = 0x80 | (arr.type & 0x3f);
    out[off++] = (arr.nalus.length >> 8) & 0xff;
    out[off++] = arr.nalus.length & 0xff;
    for (const n of arr.nalus) {
      out[off++] = (n.length >> 8) & 0xff;
      out[off++] = n.length & 0xff;
      out.set(n, off);
      off += n.length;
    }
  }
  return out;
}

function copy(src: Uint8Array): Uint8Array {
  return new Uint8Array(src);
}
