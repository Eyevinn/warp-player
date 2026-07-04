/**
 * Shared types for the LOCMAF v0.3 codec (draft-einarsson-moq-locmaf).
 *
 * The decoder (decoder.ts) turns one LOCMAF Object into its *effective
 * values* — the per-sample vectors after applying deltas, deletions,
 * and the sample-size / BMDT derivations — and the canonical
 * reconstruction (reconstruct.ts) turns effective values into CMAF
 * chunk bytes. These mirror the Go reference implementation
 * (github.com/Eyevinn/locmaf) type for type.
 */

/** LOCMAF packaging version implemented by this codec. */
export const LOCMAF_VERSION = "0.3";

/** Element types: each element of an Object payload starts with an
 * element_type vi64; the mdat payload after the header is untagged.
 * A rawBoxes element (4) is the sole element of its Object and has no
 * length of its own — the Object length delimits it. */
export const ELEMENT_TYPE_GENBOX = 1;
export const ELEMENT_TYPE_FULL_HEADER = 2;
export const ELEMENT_TYPE_DELTA_HEADER = 3;
export const ELEMENT_TYPE_RAW_BOXES = 4;

/** One generic pre-moof box carried verbatim: the ISO box type FourCC
 * and the box contents WITHOUT the 8-byte ISO box header. For a uuid
 * box the 16-byte usertype is the first 16 bytes of payload. */
export interface GenBox {
  name: string;
  payload: Uint8Array;
}

/**
 * A decoded chunk's meaning: the effective per-sample vectors. This is
 * the only chunk-derived input to reconstructCanonical; the remaining
 * inputs come from the CMAF Header (InitContext).
 *
 * All vectors have exactly sampleCount entries (clearBytes and
 * protectedBytes have sum(subsampleCounts) entries, flattened in chunk
 * order). Values are plain numbers except BMDT, which can exceed 2^53.
 */
export interface EffectiveValues {
  sampleCount: number;
  bmdt: bigint;
  sampleDescriptionIndex: number;

  durations: number[];
  sizes: number[];
  /** Full 32-bit ISO sample_flags values (unsigned). */
  flags: number[];
  /** Signed composition-time offsets (32-bit range). */
  ctos: number[];

  /** CENC per-sample auxiliary information. ivs is the concatenation
   * of per-sample IVs, perSampleIVSize bytes each (empty when 0). */
  perSampleIVSize: number;
  ivs: Uint8Array;
  hasSubsamples: boolean;
  subsampleCounts: number[];
  clearBytes: number[];
  protectedBytes: number[];

  /** genBoxes render before the moof, in payload order. */
  genBoxes: GenBox[];
  /** Raw sample data (a subarray of the decoded object payload). */
  mdatPayload: Uint8Array;
}

/** Track context extracted once from the CMAF Header (ftyp+moov):
 * everything reconstruction and decoding need beyond the wire bytes. */
export interface InitContext {
  trackId: number;
  timescale: number;
  trexDefaultSampleDescriptionIndex: number;
  trexDefaultSampleDuration: number;
  trexDefaultSampleSize: number;
  trexDefaultSampleFlags: number;
  /** true iff the moov carries a tenc box with default_isProtected=1. */
  protected: boolean;
  /** tenc.default_Per_Sample_IV_Size, 0 when unprotected. */
  tencDefaultPerSampleIVSize: number;
}

/** Result of decoding one LOCMAF Object: either a moof-carrying chunk
 * (eff set) or a rawBoxes Object (raw set, verbatim complete ISO boxes
 * — also their own canonical form). Exactly one of the two is set. */
export interface DecodeResult {
  eff?: EffectiveValues;
  raw?: Uint8Array;
}

/** Error thrown for wire-level violations a receiver MUST reject. */
export class LocmafMalformedError extends Error {
  constructor(message: string) {
    super(`locmaf: malformed object: ${message}`);
    this.name = "LocmafMalformedError";
  }
}
