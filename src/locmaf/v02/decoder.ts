/**
 * LOCMAF v0.2 wire-format decoder.
 *
 * Implements draft-einarsson-moq-locmaf §12 (Object Framing),
 * §13 (Field Reference), §15 (Full Chunk), §16 (Delta Chunk),
 * and §14 (Compact sample_flags).
 *
 * v0.2 is intentionally independent of v0.1:
 * - Init data is raw CMAF — no LOCMAF wrapping. The init bytes are
 *   handed to MSE unchanged; we only parse them once to derive the
 *   track context (track_id, timescale, trex defaults, tenc IV size).
 * - Media chunks carry one of two top-level header IDs:
 *     23 = LocmafFullHeader, 25 = LocmafDeltaHeader
 *   Inside the property block, field IDs 1–16 are moof fields,
 *   18/20/22/24 are prft fields, 23 is styp, 25 is emsg, and 27 is
 *   the delta deletion marker.
 */

import {
  IsoBoxStreamable,
  ProducerReferenceTimeBox,
  TrackExtendsBox,
  TrackFragmentBaseMediaDecodeTimeBox,
  TrackFragmentBox,
  TrackFragmentHeaderBox,
  TrackRunBox,
  TrackRunSample,
  defaultReaderConfig,
  defaultWriterConfig,
  readIsoBoxes,
  writeIsoBox,
  type MovieBox,
  type MovieFragmentBox,
  type ParsedIsoBox,
} from "@svta/cml-iso-bmff";

import type { MediaTrackInfo } from "../../buffer/mediaBuffer";
import {
  SENC_USE_SUBSAMPLE_ENCRYPTION,
  writeSenc,
  type ExtendedSampleEncryptionBox,
  type SampleEncryptionEntry,
} from "../senc";

const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;
const TFHD_SAMPLE_DESCRIPTION_INDEX_PRESENT = 0x000002;
const TFHD_DEFAULT_SAMPLE_DURATION_PRESENT = 0x000008;
const TFHD_DEFAULT_SAMPLE_SIZE_PRESENT = 0x000010;
const TFHD_DEFAULT_SAMPLE_FLAGS_PRESENT = 0x000020;
const TRUN_DATA_OFFSET_PRESENT = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS_PRESENT = 0x000004;
const TRUN_SAMPLE_DURATION_PRESENT = 0x000100;
const TRUN_SAMPLE_SIZE_PRESENT = 0x000200;
const TRUN_SAMPLE_FLAGS_PRESENT = 0x000400;
const TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT = 0x000800;

export const LOCMAF_V02_FULL = 23;
export const LOCMAF_V02_DELTA = 25;

/** Field IDs drawn from `moof.traf` child boxes (1–16). The key
 * prefix names the source box: `trun`, `tfhd`, `tfdt`, or `senc`. */
export const fieldV02IDs = {
  trunSampleSizes: 1,
  tfhdSampleDescriptionIndex: 2,
  trunSampleDurations: 3,
  tfhdDefaultSampleDuration: 4,
  trunSampleCompositionTimeOffsets: 5,
  tfhdDefaultSampleSize: 6,
  trunSampleFlags: 7,
  tfhdDefaultSampleFlags: 8,
  sencInitializationVector: 9,
  tfdtBaseMediaDecodeTime: 10,
  sencSubsampleCount: 11,
  trunFirstSampleFlags: 12,
  sencBytesOfClearData: 13,
  trunSampleCount: 14,
  sencBytesOfProtectedData: 15,
  sencPerSampleIVSize: 16,
} as const;

/** prft, styp, emsg field IDs and the delta deletion marker, all
 * carried inside the property block alongside the moof child-box
 * fields above. */
export const auxV02IDs = {
  prftNtpTimestamp: 18,
  prftMediaTime: 20,
  prftVersion: 22,
  prftFlags: 24,
  stypBrandList: 23,
  emsgList: 25,
  deltaDeletedLocmafIDs: 27,
} as const;

const SAMPLE_FLAGS_FIELDS = new Set<number>([
  fieldV02IDs.trunSampleFlags,
  fieldV02IDs.tfhdDefaultSampleFlags,
  fieldV02IDs.trunFirstSampleFlags,
]);

const RAW_BYTE_FIELDS = new Set<number>([
  fieldV02IDs.sencInitializationVector,
  auxV02IDs.stypBrandList,
  auxV02IDs.emsgList,
]);

const PER_SAMPLE_LIST_FIELDS = new Set<number>([
  fieldV02IDs.trunSampleSizes,
  fieldV02IDs.trunSampleDurations,
  fieldV02IDs.trunSampleCompositionTimeOffsets,
  fieldV02IDs.trunSampleFlags,
  fieldV02IDs.sencSubsampleCount,
]);

// Odd-ID list fields whose elements are signed quantities and are therefore
// zigzag-encoded in BOTH Full and Delta chunks (unlike the other odd lists,
// which are plain unsigned varints in a Full chunk). The only such field is
// trunSampleCompositionTimeOffsets (ID 5): composition time offsets are
// signed in trun version 1 — the common CMAF case, where B-frames make the
// composition/decode relation non-monotonic.
const SIGNED_LIST_FIELDS = new Set<number>([
  fieldV02IDs.trunSampleCompositionTimeOffsets,
]);

export interface LocmafV02InitContext {
  trackId: number;
  timescale: number;
  defaultSampleDescriptionIndex: number;
  defaultSampleDuration: number;
  defaultSampleSize: number;
  defaultSampleFlags: number;
  defaultPerSampleIVSize: number;
}

/** Reconstructed previous chunk's effective field values (after parity / list-length / sample-flags expansion). */
interface PrevChunkState {
  /** Scalar values keyed by field_id; bigint to hold 64-bit varints. */
  scalars: Map<number, bigint>;
  /** Per-sample list values (decoded element values, already in the "32-bit reconstructed" space for sample_flags). */
  lists: Map<number, bigint[]>;
  /** Raw-byte field bytes. */
  raw: Map<number, Uint8Array>;
  /** Sample count of the prior chunk (used for BMDT derivation and list-length math). */
  sampleCount: number;
  /** Per-sample sample_durations of the prior chunk (used for BMDT derivation). */
  sampleDurations: bigint[];
  /** Effective BMDT used for the prior chunk's reconstruction. */
  baseMediaDecodeTime: bigint;
}

export interface LocmafV02TrackState {
  initContext: LocmafV02InitContext;
  initSegment: Uint8Array;
  /** In-group delta-decoder state; reset whenever a Full chunk arrives. */
  prev?: PrevChunkState;
}

export interface InitializedLocmafV02Track {
  state: LocmafV02TrackState;
  /** Always false for v0.2 — init is raw CMAF, never reconstructed. */
  initWasReconstructed: boolean;
}

export interface LocmafV02MoofDecompressionResult {
  bytes: Uint8Array;
  trackInfo: MediaTrackInfo;
}

const readerConfig = defaultReaderConfig();
const writerConfig = (() => {
  const config = defaultWriterConfig();
  return {
    ...config,
    writers: {
      ...config.writers,
      // The library has no native senc writer; reuse v0.1's serializer
      // so v0.2 moofs carry per-sample CENC metadata into MSE.
      senc: (box: ExtendedSampleEncryptionBox) => writeSenc(box),
    },
  };
})();

// -----------------------------------------------------------------------------
// QUIC varint helpers (same algorithm as v0.1; duplicated to keep modules
// independent and to avoid exporting v0.1 internals across the version
// boundary).
// -----------------------------------------------------------------------------

function ensureUint8Array(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function decodeVarint(
  bytes: Uint8Array,
  offset: number,
): { value: bigint; bytesRead: number } {
  const first = bytes[offset];
  if (first === undefined) {
    throw new Error("locmaf v0.2: unexpected end of payload");
  }
  const bytesRead = 1 << (first >> 6);
  if (offset + bytesRead > bytes.byteLength) {
    throw new Error("locmaf v0.2: truncated varint");
  }
  let value = BigInt(first & 0x3f);
  for (let i = 1; i < bytesRead; i++) {
    value = (value << 8n) | BigInt(bytes[offset + i]);
  }
  return { value, bytesRead };
}

// (The Full/Delta decoder only reads varints; encoding is needed exclusively
// in the test helpers — see ./testEncoder.ts. We intentionally do NOT export
// an encodeVarint from this production module to keep the decoder surface
// minimal.)

/** Zigzag decode per §11 of the draft: n = (z >> 1) ^ -(z & 1). */
function unzigzag(z: bigint): bigint {
  return (z >> 1n) ^ -(z & 1n);
}

function asSafeNumber(value: bigint, label: string): number {
  const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (value < minSafe || value > maxSafe) {
    throw new Error(
      `locmaf v0.2: ${label} exceeds JavaScript safe integer range`,
    );
  }
  return Number(value);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Object framing
// -----------------------------------------------------------------------------

interface ParsedObject {
  headerId: number;
  propertyBytes: Uint8Array;
  mdatPayload: Uint8Array;
}

function parseObject(payload: Uint8Array | ArrayBuffer): ParsedObject {
  const bytes = ensureUint8Array(payload);
  const header = decodeVarint(bytes, 0);
  const propsLen = decodeVarint(bytes, header.bytesRead);
  const propsStart = header.bytesRead + propsLen.bytesRead;
  const propsEnd =
    propsStart + asSafeNumber(propsLen.value, "properties_length");
  if (propsEnd > bytes.byteLength) {
    throw new Error("locmaf v0.2: properties_length exceeds object size");
  }
  return {
    headerId: asSafeNumber(header.value, "header_id"),
    propertyBytes: bytes.subarray(propsStart, propsEnd),
    mdatPayload: bytes.subarray(propsEnd),
  };
}

/** Raw, undecoded (field_id, bytes) tuples in wire order. */
interface RawProperty {
  fieldId: number;
  /** For even IDs this is the encoded scalar varint bytes; for odd IDs it is the value_bytes (length already stripped). */
  bytes: Uint8Array;
}

function parseProperties(bytes: Uint8Array): RawProperty[] {
  const result: RawProperty[] = [];
  let off = 0;
  while (off < bytes.byteLength) {
    const fid = decodeVarint(bytes, off);
    off += fid.bytesRead;
    const fieldId = asSafeNumber(fid.value, "field_id");
    if (fieldId % 2 === 0) {
      // Scalar varint, no length prefix. Capture the encoded varint bytes.
      const scalar = decodeVarint(bytes, off);
      result.push({
        fieldId,
        bytes: bytes.subarray(off, off + scalar.bytesRead),
      });
      off += scalar.bytesRead;
    } else {
      const len = decodeVarint(bytes, off);
      off += len.bytesRead;
      const valLen = asSafeNumber(len.value, `field ${fieldId} length`);
      const end = off + valLen;
      if (end > bytes.byteLength) {
        throw new Error(
          `locmaf v0.2: field ${fieldId} payload overruns properties block`,
        );
      }
      result.push({ fieldId, bytes: bytes.subarray(off, end) });
      off = end;
    }
  }
  return result;
}

function decodeScalar(bytes: Uint8Array): bigint {
  const dec = decodeVarint(bytes, 0);
  if (dec.bytesRead !== bytes.byteLength) {
    throw new Error("locmaf v0.2: scalar field has trailing bytes");
  }
  return dec.value;
}

function decodeVarintList(bytes: Uint8Array): bigint[] {
  const out: bigint[] = [];
  let off = 0;
  while (off < bytes.byteLength) {
    const v = decodeVarint(bytes, off);
    out.push(v.value);
    off += v.bytesRead;
  }
  return out;
}

// -----------------------------------------------------------------------------
// sample_flags 5-bit packing (§14)
// -----------------------------------------------------------------------------

/** Expand the 5-bit transport value (0..31) into a 32-bit `sample_flags`. */
function expandSampleFlags(packed: bigint): bigint {
  const v = packed & 0x1fn;
  const nonSync = v & 0x1n;
  const dependsOn = (v >> 1n) & 0x3n;
  const isDependedOn = (v >> 3n) & 0x3n;
  return (isDependedOn << 22n) | (dependsOn << 24n) | (nonSync << 16n);
}

// -----------------------------------------------------------------------------
// Init parse
// -----------------------------------------------------------------------------

function findBoxRecursive(
  boxes: Array<{ type: string; boxes?: any[] }> | undefined,
  type: string,
): any | undefined {
  if (!boxes) {
    return undefined;
  }
  for (const box of boxes) {
    if (box.type === type) {
      return box;
    }
    if (box.boxes) {
      const nested = findBoxRecursive(box.boxes, type);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

export function initializeLocmafV02Track(
  initBytes: Uint8Array | ArrayBuffer,
): InitializedLocmafV02Track {
  const init = ensureUint8Array(initBytes);
  const parsed = readIsoBoxes(init, readerConfig) as ParsedIsoBox[];
  const moov = parsed.find((b) => b.type === "moov") as MovieBox | undefined;
  if (!moov) {
    throw new Error("locmaf v0.2: init data does not contain moov");
  }
  const trex = findBoxRecursive(moov.boxes, "trex") as
    | TrackExtendsBox
    | undefined;
  if (!trex) {
    throw new Error("locmaf v0.2: init data does not contain trex");
  }
  // The reconstructed moof's tfhd.track_ID is taken from the track's
  // tkhd.track_ID — the authoritative track identifier — falling back to
  // trex.track_ID. In conformant CMAF the two are equal; preferring tkhd
  // matches the Go reference decoder (internal/locmafv02 reconstructMoof).
  const tkhd = findBoxRecursive(moov.boxes, "tkhd") as
    | { trackId?: number }
    | undefined;
  const mdhd = findBoxRecursive(moov.boxes, "mdhd") as
    | { timescale: number }
    | undefined;
  if (!mdhd) {
    throw new Error("locmaf v0.2: init data does not contain mdhd");
  }
  const tenc = findBoxRecursive(moov.boxes, "tenc") as
    | { defaultIvSize?: number }
    | undefined;

  return {
    state: {
      initContext: {
        trackId: tkhd?.trackId ?? trex.trackId,
        timescale: mdhd.timescale,
        defaultSampleDescriptionIndex: trex.defaultSampleDescriptionIndex,
        defaultSampleDuration: trex.defaultSampleDuration,
        defaultSampleSize: trex.defaultSampleSize,
        defaultSampleFlags: trex.defaultSampleFlags,
        defaultPerSampleIVSize: tenc?.defaultIvSize ?? 0,
      },
      // v0.2 init is raw CMAF — hand it back unchanged for MSE.
      initSegment: new Uint8Array(init),
    },
    initWasReconstructed: false,
  };
}

// -----------------------------------------------------------------------------
// Full / Delta decoding
// -----------------------------------------------------------------------------

interface DecodedFields {
  scalars: Map<number, bigint>;
  lists: Map<number, bigint[]>;
  raw: Map<number, Uint8Array>;
  /** ordered field IDs present after decoding (Full) or after merge (Delta). */
  presentIds: Set<number>;
}

/** Read a Full chunk: even = absolute unsigned varint; odd lists = unsigned
 * varint per element, EXCEPT the signed lists (ID 5,
 * trunSampleCompositionTimeOffsets), which are zigzag-encoded in full chunks
 * too because composition time offsets are signed (trun version 1). */
function decodeFullProperties(props: RawProperty[]): DecodedFields {
  const out: DecodedFields = {
    scalars: new Map(),
    lists: new Map(),
    raw: new Map(),
    presentIds: new Set(),
  };
  for (const p of props) {
    out.presentIds.add(p.fieldId);
    if (RAW_BYTE_FIELDS.has(p.fieldId)) {
      out.raw.set(p.fieldId, new Uint8Array(p.bytes));
      continue;
    }
    if (p.fieldId === auxV02IDs.deltaDeletedLocmafIDs) {
      // Should not occur in a Full chunk; tolerate by storing the parsed list.
      out.lists.set(p.fieldId, decodeVarintList(p.bytes));
      continue;
    }
    if (p.fieldId % 2 === 0) {
      const raw = decodeScalar(p.bytes);
      out.scalars.set(
        p.fieldId,
        SAMPLE_FLAGS_FIELDS.has(p.fieldId) ? expandSampleFlags(raw) : raw,
      );
    } else {
      // Odd-ID list elements are absolute unsigned MOQT varints in a Full
      // chunk, with one exception: signed lists (ID 5,
      // trunSampleCompositionTimeOffsets) carry zigzag-encoded signed values
      // in both Full and Delta chunks, since composition time offsets are
      // signed in trun version 1.
      let values = SIGNED_LIST_FIELDS.has(p.fieldId)
        ? decodeVarintList(p.bytes).map(unzigzag)
        : decodeVarintList(p.bytes);
      if (SAMPLE_FLAGS_FIELDS.has(p.fieldId)) {
        values = values.map(expandSampleFlags);
      }
      out.lists.set(p.fieldId, values);
    }
  }
  return out;
}

/**
 * Apply a Delta chunk on top of `prev`.
 *
 * Rules (§16):
 *  - Even ID scalars: wire = zigzag(current - previous); current = previous + delta.
 *  - Odd ID varint lists: wire elements are zigzag deltas with §16.1 length rules.
 *  - Odd ID raw-bytes (IDs 9, 23, 25): full overwrite.
 *  - ID 27 (deletion marker): plain unsigned varints, applied BEFORE deltas.
 *  - BMDT: if absent, derive previous_bmdt + sum(previous_sample_durations);
 *    if present, decoded as an ABSOLUTE unsigned varint (re-anchor).
 */
function decodeDeltaProperties(
  props: RawProperty[],
  prev: PrevChunkState,
): DecodedFields {
  // 1) Apply deletions first.
  const deletions: Set<number> = new Set();
  for (const p of props) {
    if (p.fieldId === auxV02IDs.deltaDeletedLocmafIDs) {
      for (const id of decodeVarintList(p.bytes)) {
        deletions.add(asSafeNumber(id, "deletion field id"));
      }
    }
  }

  // Seed the merge from the previous state, minus deletions.
  const scalars = new Map<number, bigint>(prev.scalars);
  const lists = new Map<number, bigint[]>();
  for (const [k, v] of prev.lists.entries()) {
    lists.set(k, v.slice());
  }
  const raw = new Map<number, Uint8Array>();
  for (const [k, v] of prev.raw.entries()) {
    raw.set(k, new Uint8Array(v));
  }
  for (const id of deletions) {
    scalars.delete(id);
    lists.delete(id);
    raw.delete(id);
  }

  // 2) Determine the new sample_count up-front (it's always emitted in deltas
  //    too, so we can size lists correctly per §16.1).
  let newSampleCount = prev.sampleCount;
  for (const p of props) {
    if (p.fieldId === fieldV02IDs.trunSampleCount) {
      // sampleCount is even / scalar: in Delta it's a ZIGZAG delta.
      const delta = unzigzag(decodeScalar(p.bytes));
      newSampleCount = asSafeNumber(
        BigInt(prev.sampleCount) + delta,
        "sample count",
      );
      break;
    }
  }

  // 3) Walk delta fields.
  const presentIds = new Set<number>();
  // Carry over all non-deleted previous IDs initially; they remain effective.
  for (const id of prev.scalars.keys()) {
    presentIds.add(id);
  }
  for (const id of prev.lists.keys()) {
    presentIds.add(id);
  }
  for (const id of prev.raw.keys()) {
    presentIds.add(id);
  }
  for (const id of deletions) {
    presentIds.delete(id);
  }

  for (const p of props) {
    if (p.fieldId === auxV02IDs.deltaDeletedLocmafIDs) {
      continue;
    }
    presentIds.add(p.fieldId);

    if (RAW_BYTE_FIELDS.has(p.fieldId)) {
      raw.set(p.fieldId, new Uint8Array(p.bytes));
      continue;
    }
    if (p.fieldId % 2 === 0) {
      // Even / scalar — zigzag delta unless it's an explicit absolute BMDT.
      if (p.fieldId === fieldV02IDs.tfdtBaseMediaDecodeTime) {
        // §16.2: absolute unsigned varint (re-anchor).
        scalars.set(p.fieldId, decodeScalar(p.bytes));
        continue;
      }
      const delta = unzigzag(decodeScalar(p.bytes));
      const previous = prev.scalars.get(p.fieldId) ?? 0n;
      let combined = previous + delta;
      if (SAMPLE_FLAGS_FIELDS.has(p.fieldId)) {
        // The 5-bit packed value is what was delta-encoded on the wire.
        // We stored the previous as a 32-bit expanded value; collapse the
        // previous back to its 5-bit form before applying the delta, then
        // re-expand.
        const prevPacked = collapseSampleFlags(previous);
        combined = expandSampleFlags(prevPacked + delta);
      }
      scalars.set(p.fieldId, combined);
      continue;
    }

    // Odd / list — per-element zigzag delta with §16.1 length rules.
    const elements = decodeVarintList(p.bytes).map(unzigzag);
    const previousList = lists.get(p.fieldId) ?? [];
    // Determine target length:
    //   per-sample lists (1, 3, 5, 7, 11)         → newSampleCount
    //   per-subsample lists (13, 15)              → sum(subsampleCount) — we'll
    //   resolve those by trusting len(elements) (encoder knows it; receiver too).
    let targetLen: number;
    if (p.fieldId === fieldV02IDs.trunSampleSizes) {
      // §15.1: sampleSizes carries n−1 entries; the last is derived
      // from the mdat payload length at reconstruction time.
      targetLen = Math.max(newSampleCount - 1, 0);
    } else if (PER_SAMPLE_LIST_FIELDS.has(p.fieldId)) {
      targetLen = newSampleCount;
    } else {
      targetLen = elements.length;
    }

    const merged: bigint[] = [];
    for (let i = 0; i < targetLen; i++) {
      const previousElement = previousList[i];
      const wireDelta = elements[i] ?? 0n;
      if (previousElement === undefined) {
        // §16.1: longer current — missing previous treated as 0.
        merged.push(
          SAMPLE_FLAGS_FIELDS.has(p.fieldId)
            ? expandSampleFlags(wireDelta)
            : wireDelta,
        );
      } else if (SAMPLE_FLAGS_FIELDS.has(p.fieldId)) {
        const prevPacked = collapseSampleFlags(previousElement);
        merged.push(expandSampleFlags(prevPacked + wireDelta));
      } else {
        merged.push(previousElement + wireDelta);
      }
    }
    // §16.1: shorter current — truncation is implicit in targetLen.
    lists.set(p.fieldId, merged);
  }

  // If the property block did not mention a per-sample list at all but the
  // sample_count changed, truncate or extend (with previous-as-0) lists that
  // were carried over from the previous state.
  for (const fid of PER_SAMPLE_LIST_FIELDS) {
    if (!lists.has(fid)) {
      continue;
    }
    const list = lists.get(fid)!;
    // sampleSizes (ID 1) carries n−1 entries per §15.1; every other
    // per-sample list carries n.
    const want =
      fid === fieldV02IDs.trunSampleSizes
        ? Math.max(newSampleCount - 1, 0)
        : newSampleCount;
    if (list.length === want) {
      continue;
    }
    if (list.length > want) {
      lists.set(fid, list.slice(0, want));
    } else {
      const extended = list.slice();
      while (extended.length < want) {
        extended.push(0n);
      }
      lists.set(fid, extended);
    }
  }

  // 4) BMDT derivation: if no explicit value emerged from the merge — i.e.
  //    the previous BMDT was unchanged in the delta — derive the new BMDT
  //    from previous_bmdt + sum(previous_sample_durations).
  if (!hasExplicitBmdt(props)) {
    const derived = prev.baseMediaDecodeTime + sumBigInts(prev.sampleDurations);
    scalars.set(fieldV02IDs.tfdtBaseMediaDecodeTime, derived);
    presentIds.add(fieldV02IDs.tfdtBaseMediaDecodeTime);
  }

  return { scalars, lists, raw, presentIds };
}

function hasExplicitBmdt(props: RawProperty[]): boolean {
  return props.some((p) => p.fieldId === fieldV02IDs.tfdtBaseMediaDecodeTime);
}

function sumBigInts(values: bigint[]): bigint {
  let s = 0n;
  for (const v of values) {
    s += v;
  }
  return s;
}

/** Reverse the 32-bit expansion to recover the 5-bit packed value for delta math. */
function collapseSampleFlags(expanded: bigint): bigint {
  const nonSync = (expanded >> 16n) & 0x1n;
  const dependsOn = (expanded >> 24n) & 0x3n;
  const isDependedOn = (expanded >> 22n) & 0x3n;
  return nonSync | (dependsOn << 1n) | (isDependedOn << 3n);
}

// -----------------------------------------------------------------------------
// CMAF box reconstruction
// -----------------------------------------------------------------------------

function reconstructMoof(
  decoded: DecodedFields,
  ctx: LocmafV02InitContext,
  sequenceNumber: number,
  mdatPayloadLen: number,
): {
  box: MovieFragmentBox;
  trackInfo: MediaTrackInfo;
  sampleDurations: bigint[];
} {
  const scalars = decoded.scalars;
  const lists = decoded.lists;

  const sampleCountVal = scalars.get(fieldV02IDs.trunSampleCount);
  if (sampleCountVal === undefined) {
    throw new Error("locmaf v0.2: moof missing sampleCount");
  }
  const sampleCount = asSafeNumber(sampleCountVal, "sample count");

  const bmdtVal = scalars.get(fieldV02IDs.tfdtBaseMediaDecodeTime);
  if (bmdtVal === undefined) {
    throw new Error("locmaf v0.2: moof missing baseMediaDecodeTime");
  }

  // tfhd defaults (only emit fields the wire explicitly carried).
  const wireHas = (id: number) => decoded.presentIds.has(id);

  const tfhdDefaultSampleDuration =
    scalars.get(fieldV02IDs.tfhdDefaultSampleDuration) ??
    BigInt(ctx.defaultSampleDuration);
  const tfhdDefaultSampleSize =
    scalars.get(fieldV02IDs.tfhdDefaultSampleSize) ??
    BigInt(ctx.defaultSampleSize);
  const tfhdDefaultSampleFlags =
    scalars.get(fieldV02IDs.tfhdDefaultSampleFlags) ??
    BigInt(ctx.defaultSampleFlags);

  // Resolve per-sample lists, falling back to "repeat default" or single-sample
  // derivation from mdat length.
  const sampleSizes = ((): bigint[] => {
    const list = lists.get(fieldV02IDs.trunSampleSizes);
    if (list && list.length > 0) {
      // §15.1: list carries n−1 entries; derive the last from the
      // mdat payload length.
      if (list.length !== sampleCount - 1) {
        throw new Error(
          `locmaf v0.2: sample_sizes list has ${list.length} entries, expected ${sampleCount - 1}`,
        );
      }
      if (mdatPayloadLen < 0) {
        throw new Error(
          "locmaf v0.2: variable-sized samples need mdat payload length",
        );
      }
      let sum = 0n;
      for (const v of list) {
        sum += v;
      }
      if (BigInt(mdatPayloadLen) < sum) {
        throw new Error(
          `locmaf v0.2: mdat payload length ${mdatPayloadLen} < sum of listed sample sizes ${sum}`,
        );
      }
      return [...list, BigInt(mdatPayloadLen) - sum];
    }
    if (sampleCount === 1) {
      // Single-sample chunk — derive from mdat payload length.
      if (mdatPayloadLen <= 0) {
        throw new Error(
          "locmaf v0.2: single-sample moof has empty mdat payload",
        );
      }
      return [BigInt(mdatPayloadLen)];
    }
    // Uniform sizes: moofDefaultSampleSize (already merged into ctx)
    // or trex.default_sample_size.
    return new Array(sampleCount).fill(tfhdDefaultSampleSize);
  })();

  const sampleDurations = ((): bigint[] => {
    const list = lists.get(fieldV02IDs.trunSampleDurations);
    if (list) {
      return list;
    }
    return new Array(sampleCount).fill(tfhdDefaultSampleDuration);
  })();

  const sampleFlagsList = ((): bigint[] => {
    const list = lists.get(fieldV02IDs.trunSampleFlags);
    if (list) {
      return list;
    }
    return new Array(sampleCount).fill(tfhdDefaultSampleFlags);
  })();

  const compositionList = lists.get(
    fieldV02IDs.trunSampleCompositionTimeOffsets,
  );
  const hasCompositionOffsets = compositionList !== undefined;
  const compositionOffsets = compositionList ?? new Array(sampleCount).fill(0n);

  if (
    sampleSizes.length !== sampleCount ||
    sampleDurations.length !== sampleCount ||
    sampleFlagsList.length !== sampleCount ||
    compositionOffsets.length !== sampleCount
  ) {
    throw new Error("locmaf v0.2: moof per-sample list length mismatch");
  }

  const tfhdFlags =
    TFHD_DEFAULT_BASE_IS_MOOF |
    (wireHas(fieldV02IDs.tfhdSampleDescriptionIndex)
      ? TFHD_SAMPLE_DESCRIPTION_INDEX_PRESENT
      : 0) |
    (wireHas(fieldV02IDs.tfhdDefaultSampleDuration)
      ? TFHD_DEFAULT_SAMPLE_DURATION_PRESENT
      : 0) |
    (wireHas(fieldV02IDs.tfhdDefaultSampleSize)
      ? TFHD_DEFAULT_SAMPLE_SIZE_PRESENT
      : 0) |
    (wireHas(fieldV02IDs.tfhdDefaultSampleFlags)
      ? TFHD_DEFAULT_SAMPLE_FLAGS_PRESENT
      : 0);

  const tfhd: TrackFragmentHeaderBox = {
    type: "tfhd",
    version: 0,
    flags: tfhdFlags,
    trackId: ctx.trackId,
  };
  const sdiVal = scalars.get(fieldV02IDs.tfhdSampleDescriptionIndex);
  if (sdiVal !== undefined && wireHas(fieldV02IDs.tfhdSampleDescriptionIndex)) {
    tfhd.sampleDescriptionIndex = asSafeNumber(
      sdiVal,
      "sample description index",
    );
  }
  if (wireHas(fieldV02IDs.tfhdDefaultSampleDuration)) {
    tfhd.defaultSampleDuration = asSafeNumber(
      tfhdDefaultSampleDuration,
      "default sample duration",
    );
  }
  if (wireHas(fieldV02IDs.tfhdDefaultSampleSize)) {
    tfhd.defaultSampleSize = asSafeNumber(
      tfhdDefaultSampleSize,
      "default sample size",
    );
  }
  if (wireHas(fieldV02IDs.tfhdDefaultSampleFlags)) {
    tfhd.defaultSampleFlags = asSafeNumber(
      tfhdDefaultSampleFlags,
      "default sample flags",
    );
  }

  const samples: TrackRunSample[] = Array.from(
    { length: sampleCount },
    (_, i) => ({
      sampleDuration: asSafeNumber(sampleDurations[i], `sample ${i} duration`),
      sampleSize: asSafeNumber(sampleSizes[i], `sample ${i} size`),
      sampleFlags: asSafeNumber(sampleFlagsList[i], `sample ${i} flags`),
      sampleCompositionTimeOffset: asSafeNumber(
        compositionOffsets[i],
        `sample ${i} composition offset`,
      ),
    }),
  );

  const firstSampleFlags = scalars.get(fieldV02IDs.trunFirstSampleFlags);

  const trun: TrackRunBox = {
    type: "trun",
    version: samples.some((s) => (s.sampleCompositionTimeOffset ?? 0) < 0)
      ? 1
      : 0,
    flags:
      TRUN_DATA_OFFSET_PRESENT |
      (firstSampleFlags !== undefined &&
      wireHas(fieldV02IDs.trunFirstSampleFlags)
        ? TRUN_FIRST_SAMPLE_FLAGS_PRESENT
        : 0) |
      TRUN_SAMPLE_DURATION_PRESENT |
      TRUN_SAMPLE_SIZE_PRESENT |
      TRUN_SAMPLE_FLAGS_PRESENT |
      (hasCompositionOffsets ? TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT : 0),
    sampleCount,
    dataOffset: 0,
    samples,
  };
  if (
    firstSampleFlags !== undefined &&
    wireHas(fieldV02IDs.trunFirstSampleFlags)
  ) {
    trun.firstSampleFlags = asSafeNumber(
      firstSampleFlags,
      "first sample flags",
    );
  }

  const tfdt: TrackFragmentBaseMediaDecodeTimeBox = {
    type: "tfdt",
    version: bmdtVal > 0xffffffffn ? 1 : 0,
    flags: 0,
    baseMediaDecodeTime: asSafeNumber(bmdtVal, "base media decode time"),
  };

  const trafBoxes: TrackFragmentBox["boxes"] = [tfhd, tfdt, trun];

  // Reconstruct senc from the encryption fields (IDs 9, 11, 13, 15, 16)
  // if any are present. Without it MSE/EME sees the moof as carrying
  // cleartext samples and the decoder rejects the scrambled bytes.
  const ivOverride = scalars.get(fieldV02IDs.sencPerSampleIVSize);
  const perSampleIVSize =
    ivOverride !== undefined
      ? asSafeNumber(ivOverride, "per_sample_iv_size")
      : ctx.defaultPerSampleIVSize;
  const senc = buildSencV02(decoded, sampleCount, perSampleIVSize);
  if (senc) {
    trafBoxes.push(senc as TrackFragmentBox["boxes"][number]);
  }

  const totalDuration = sampleDurations.reduce(
    (sum, d) => sum + asSafeNumber(d, "sample duration"),
    0,
  );

  return {
    box: {
      type: "moof",
      boxes: [
        { type: "mfhd", version: 0, flags: 0, sequenceNumber },
        { type: "traf", boxes: trafBoxes },
      ],
    },
    trackInfo: {
      timescale: ctx.timescale,
      baseMediaDecodeTime: tfdt.baseMediaDecodeTime,
      duration: totalDuration,
      sequenceNumber,
    },
    sampleDurations,
  };
}

function encodeMoof(box: MovieFragmentBox): Uint8Array {
  const draft = writeIsoBox(box as IsoBoxStreamable, writerConfig);
  const traf = box.boxes.find(
    (b: { type: string }) => b.type === "traf",
  ) as TrackFragmentBox;
  const trun = traf.boxes.find(
    (b: { type: string }) => b.type === "trun",
  ) as TrackRunBox;
  trun.dataOffset = draft.byteLength + 8;
  return writeIsoBox(box as IsoBoxStreamable, writerConfig);
}

function makeMdat(payload: Uint8Array): Uint8Array {
  const useLarge = payload.byteLength > 0xfffffff7;
  const headerLen = useLarge ? 16 : 8;
  const out = new Uint8Array(headerLen + payload.byteLength);
  const view = new DataView(out.buffer);
  if (useLarge) {
    view.setUint32(0, 1);
    view.setBigUint64(8, BigInt(out.byteLength));
  } else {
    view.setUint32(0, out.byteLength);
  }
  out[4] = 0x6d;
  out[5] = 0x64;
  out[6] = 0x61;
  out[7] = 0x74;
  out.set(payload, headerLen);
  return out;
}

/** Build the optional `prft` box from prft fields, if any. */
function maybeBuildPrft(
  decoded: DecodedFields,
  ctx: LocmafV02InitContext,
): Uint8Array | undefined {
  const hasAny =
    decoded.scalars.has(auxV02IDs.prftNtpTimestamp) ||
    decoded.scalars.has(auxV02IDs.prftMediaTime) ||
    decoded.scalars.has(auxV02IDs.prftVersion) ||
    decoded.scalars.has(auxV02IDs.prftFlags);
  if (!hasAny) {
    return undefined;
  }

  const ntp64 = decoded.scalars.get(auxV02IDs.prftNtpTimestamp) ?? 0n;
  const mediaTime = decoded.scalars.get(auxV02IDs.prftMediaTime) ?? 0n;
  const version = asSafeNumber(
    decoded.scalars.get(auxV02IDs.prftVersion) ?? 1n,
    "prft version",
  );
  const flags = asSafeNumber(
    decoded.scalars.get(auxV02IDs.prftFlags) ?? 0n,
    "prft flags",
  );

  const ntpTimestampSec = asSafeNumber(
    (ntp64 >> 32n) & 0xffffffffn,
    "prft ntp seconds",
  );
  const ntpTimestampFrac = asSafeNumber(
    ntp64 & 0xffffffffn,
    "prft ntp fraction",
  );

  const box: ProducerReferenceTimeBox = {
    type: "prft",
    version,
    flags,
    referenceTrackId: ctx.trackId,
    ntpTimestampSec,
    ntpTimestampFrac,
    mediaTime: asSafeNumber(mediaTime, "prft media time"),
  };
  return writeIsoBox(box as IsoBoxStreamable, writerConfig);
}

// -----------------------------------------------------------------------------
// Public chunk decode
// -----------------------------------------------------------------------------

export function decompressMoofV02WithTrackInfo(
  payload: Uint8Array | ArrayBuffer,
  sequenceNumber: number,
  state: LocmafV02TrackState,
): LocmafV02MoofDecompressionResult | undefined {
  const obj = parseObject(payload);
  if (obj.headerId !== LOCMAF_V02_FULL && obj.headerId !== LOCMAF_V02_DELTA) {
    console.warn(
      `[locmaf v0.2] skipping unknown top-level header_id=${obj.headerId}`,
    );
    return undefined;
  }

  const rawProps = parseProperties(obj.propertyBytes);

  let decoded: DecodedFields;
  if (obj.headerId === LOCMAF_V02_FULL) {
    decoded = decodeFullProperties(rawProps);
  } else {
    if (!state.prev) {
      throw new Error(
        "locmaf v0.2: cannot decode delta chunk without prior full chunk",
      );
    }
    decoded = decodeDeltaProperties(rawProps, state.prev);
  }

  const moof = reconstructMoof(
    decoded,
    state.initContext,
    sequenceNumber,
    obj.mdatPayload.byteLength,
  );
  const moofBytes = encodeMoof(moof.box);
  const mdat = makeMdat(obj.mdatPayload);
  const prft = maybeBuildPrft(decoded, state.initContext);

  // Update in-group reference for the next delta chunk.
  state.prev = {
    scalars: new Map(decoded.scalars),
    lists: new Map(
      Array.from(decoded.lists.entries(), ([k, v]) => [k, v.slice()]),
    ),
    raw: new Map(
      Array.from(decoded.raw.entries(), ([k, v]) => [k, new Uint8Array(v)]),
    ),
    sampleCount: asSafeNumber(
      decoded.scalars.get(fieldV02IDs.trunSampleCount) ?? 0n,
      "sample count",
    ),
    sampleDurations: moof.sampleDurations.slice(),
    baseMediaDecodeTime:
      decoded.scalars.get(fieldV02IDs.tfdtBaseMediaDecodeTime) ?? 0n,
  };

  return {
    bytes: prft
      ? concatBytes(prft, moofBytes, mdat)
      : concatBytes(moofBytes, mdat),
    trackInfo: moof.trackInfo,
  };
}

// -----------------------------------------------------------------------------
// senc reconstruction (CENC per-sample encryption metadata)
// -----------------------------------------------------------------------------

/**
 * Build a SampleEncryptionBox from the encryption fields decoded out of the
 * v0.2 wire format. Returns undefined when no encryption metadata was emitted
 * (clear track). Mirrors v0.1's createSencBox but consumes the decoded
 * lists/raw maps instead of raw varint blobs.
 */
function buildSencV02(
  decoded: DecodedFields,
  sampleCount: number,
  perSampleIVSize: number,
): ExtendedSampleEncryptionBox | undefined {
  const ivBytes = decoded.raw.get(fieldV02IDs.sencInitializationVector);
  const subsampleCounts = decoded.lists.get(fieldV02IDs.sencSubsampleCount);
  const bytesOfClearData = decoded.lists.get(fieldV02IDs.sencBytesOfClearData);
  const bytesOfProtectedData = decoded.lists.get(
    fieldV02IDs.sencBytesOfProtectedData,
  );

  if (
    !ivBytes &&
    (!subsampleCounts || subsampleCounts.length === 0) &&
    (!bytesOfClearData || bytesOfClearData.length === 0) &&
    (!bytesOfProtectedData || bytesOfProtectedData.length === 0)
  ) {
    return undefined;
  }

  if (ivBytes) {
    if (perSampleIVSize === 0) {
      throw new Error(
        "locmaf v0.2: senc carries IVs but per_sample_iv_size is 0",
      );
    }
    if (ivBytes.byteLength !== sampleCount * perSampleIVSize) {
      throw new Error(
        `locmaf v0.2: IV field length ${ivBytes.byteLength} ≠ sample_count (${sampleCount}) × per_sample_iv_size (${perSampleIVSize})`,
      );
    }
  }

  if (subsampleCounts && subsampleCounts.length !== sampleCount) {
    throw new Error(
      `locmaf v0.2: subsample_count length ${subsampleCounts.length} ≠ sample_count ${sampleCount}`,
    );
  }
  if ((bytesOfClearData || bytesOfProtectedData) && !subsampleCounts) {
    throw new Error(
      "locmaf v0.2: subsample byte counts require subsample_count",
    );
  }

  let clearIdx = 0;
  let protIdx = 0;
  const samples: SampleEncryptionEntry[] = [];

  for (let i = 0; i < sampleCount; i++) {
    const entry: SampleEncryptionEntry = {};
    if (ivBytes) {
      const start = i * perSampleIVSize;
      entry.initializationVector = ivBytes.slice(
        start,
        start + perSampleIVSize,
      );
    }
    const subCount = subsampleCounts
      ? asSafeNumber(subsampleCounts[i], `subsample_count[${i}]`)
      : 0;
    if (subCount > 0) {
      entry.subsampleEncryption = [];
      for (let j = 0; j < subCount; j++) {
        const clear = bytesOfClearData?.[clearIdx] ?? 0n;
        const prot = bytesOfProtectedData?.[protIdx] ?? 0n;
        entry.subsampleEncryption.push({
          bytesOfClearData: asSafeNumber(clear, "bytes_of_clear_data"),
          bytesOfProtectedData: asSafeNumber(prot, "bytes_of_protected_data"),
        });
        clearIdx++;
        protIdx++;
      }
    }
    samples.push(entry);
  }

  return {
    type: "senc",
    version: 0,
    flags: samples.some((s) => s.subsampleEncryption?.length)
      ? SENC_USE_SUBSAMPLE_ENCRYPTION
      : 0,
    sampleCount,
    samples,
  } as ExtendedSampleEncryptionBox;
}
