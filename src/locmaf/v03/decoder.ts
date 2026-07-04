/**
 * LOCMAF v0.3 wire-format decoder (draft-einarsson-moq-locmaf).
 *
 * Decodes one LOCMAF Object payload — the element sequence of genBox /
 * full header / delta header / rawBoxes plus the untagged mdat bytes —
 * into the chunk's *effective values* (Effective values section of the
 * draft), applying the parity rule, per-group delta state, deletions,
 * the sample-size derivation, and the delta-BMDT derivation. A faithful
 * port of the Go reference decoder (github.com/Eyevinn/locmaf
 * decode.go / locmaf.go); every accept/reject decision mirrors it.
 */

import { readVi64, readZigzagVi64, type Vi64Read } from "../vi64";

import {
  ELEMENT_TYPE_DELTA_HEADER,
  ELEMENT_TYPE_FULL_HEADER,
  ELEMENT_TYPE_GENBOX,
  ELEMENT_TYPE_RAW_BOXES,
  LocmafMalformedError,
  type DecodeResult,
  type EffectiveValues,
  type GenBox,
  type InitContext,
} from "./types";

/** Bound on trunSampleCount (and subsample totals) as a defence
 * against allocation attacks; no real CMAF chunk approaches it. */
const MAX_SAMPLE_COUNT = 1 << 24;

const U32_MAX = 0xffffffffn;
const U64_MAX = (1n << 64n) - 1n;
const I32_MIN = -(1n << 31n);
const I32_MAX = (1n << 31n) - 1n;

/** Header field IDs (Field Reference section). Parity carries the
 * framing: even IDs are single vi64 scalars, odd IDs are
 * length-prefixed bytes. */
export const fieldIDs = {
  trunSampleSizes: 1,
  tfhdSampleDescriptionIndex: 2,
  trunSampleDurations: 3,
  tfhdDefaultSampleDuration: 4,
  trunSampleCompositionTimeOffsets: 5, // signed: zigzag in both contexts
  tfhdDefaultSampleSize: 6,
  trunSampleFlags: 7,
  tfhdDefaultSampleFlags: 8,
  sencInitializationVector: 9, // raw bytes in both contexts
  tfdtBaseMediaDecodeTime: 10, // full-header-only
  sencSubsampleCount: 11,
  trunFirstSampleFlags: 12,
  sencBytesOfClearData: 13,
  trunSampleCount: 14,
  sencBytesOfProtectedData: 15,
  sencPerSampleIVSize: 16,
  deltaDeletedLocmafIDs: 27, // delta-only control list, plain unsigned
} as const;

const KNOWN_SCALARS = new Set<number>([
  fieldIDs.tfhdSampleDescriptionIndex,
  fieldIDs.tfhdDefaultSampleDuration,
  fieldIDs.tfhdDefaultSampleSize,
  fieldIDs.tfhdDefaultSampleFlags,
  fieldIDs.tfdtBaseMediaDecodeTime,
  fieldIDs.trunFirstSampleFlags,
  fieldIDs.trunSampleCount,
  fieldIDs.sencPerSampleIVSize,
]);

const KNOWN_UNSIGNED_LISTS = new Set<number>([
  fieldIDs.trunSampleSizes,
  fieldIDs.trunSampleDurations,
  fieldIDs.trunSampleFlags,
  fieldIDs.sencSubsampleCount,
  fieldIDs.sencBytesOfClearData,
  fieldIDs.sencBytesOfProtectedData,
]);

function isKnown(id: number): boolean {
  return (
    KNOWN_SCALARS.has(id) ||
    KNOWN_UNSIGNED_LISTS.has(id) ||
    id === fieldIDs.trunSampleCompositionTimeOffsets ||
    id === fieldIDs.sencInitializationVector ||
    id === fieldIDs.deltaDeletedLocmafIDs
  );
}

function malformed(msg: string): never {
  throw new LocmafMalformedError(msg);
}

/** readVi64 with truncation mapped to LocmafMalformedError. */
function readVi(bytes: Uint8Array, offset: number, what: string): Vi64Read {
  try {
    return readVi64(bytes, offset);
  } catch {
    malformed(`invalid ${what}`);
  }
}

function readZig(bytes: Uint8Array, offset: number, what: string): Vi64Read {
  try {
    return readZigzagVi64(bytes, offset);
  } catch {
    malformed(`invalid ${what}`);
  }
}

/** The per-field represented content of one chunk: the same shape the
 * group state stores, so both sides keep identical in-group
 * references. Presence is tracked by map key — an empty-but-present
 * list field is DISTINCT from an absent one. */
export interface ChunkFields {
  scalars: Map<number, bigint>;
  lists: Map<number, bigint[]>;
  signedLists: Map<number, bigint[]>;
  rawBlobs: Map<number, Uint8Array>;
}

function newChunkFields(): ChunkFields {
  return {
    scalars: new Map(),
    lists: new Map(),
    signedLists: new Map(),
    rawBlobs: new Map(),
  };
}

/**
 * Opaque in-group reference state for delta chunks. One per (track,
 * MoQ group); reset (or replaced) at every group boundary. A full
 * header or a rawBoxes Object resets it; a decode error resets it too,
 * so subsequent delta chunks are rejected until a full header
 * re-anchors (the receiver rule for gaps).
 */
export class LocmafGroupState {
  private scalars = new Map<number, bigint>();
  private lists = new Map<number, bigint[]>();
  private signedLists = new Map<number, bigint[]>();
  private rawBlobs = new Map<number, Uint8Array>();
  private anyStored = false;

  reset(): void {
    this.scalars.clear();
    this.lists.clear();
    this.signedLists.clear();
    this.rawBlobs.clear();
    this.anyStored = false;
  }

  /** Internal: whether any chunk has been stored since the last reset
   * (a delta header before any full header in the group rejects). */
  get hasAny(): boolean {
    return this.anyStored;
  }

  /** Internal: replace the state content with cf (deep copy). */
  store(cf: ChunkFields): void {
    this.scalars = new Map(cf.scalars);
    this.lists = new Map();
    for (const [k, v] of cf.lists) {
      this.lists.set(k, v.slice());
    }
    this.signedLists = new Map();
    for (const [k, v] of cf.signedLists) {
      this.signedLists.set(k, v.slice());
    }
    this.rawBlobs = new Map();
    for (const [k, v] of cf.rawBlobs) {
      this.rawBlobs.set(k, v.slice());
    }
    this.anyStored = true;
  }

  /** Internal: a ChunkFields copy of the state — the starting point
   * for applying a delta chunk. */
  snapshot(): ChunkFields {
    const cf = newChunkFields();
    cf.scalars = new Map(this.scalars);
    for (const [k, v] of this.lists) {
      cf.lists.set(k, v.slice());
    }
    for (const [k, v] of this.signedLists) {
      cf.signedLists.set(k, v.slice());
    }
    for (const [k, v] of this.rawBlobs) {
      cf.rawBlobs.set(k, v.slice());
    }
    return cf;
  }

  /** Internal: the BMDT a delta chunk would have (BMDT-derivation
   * section): the previous chunk's BMDT plus the sum of its effective
   * sample durations. Undefined when the state lacks what the
   * derivation needs, or on unsigned-64 overflow. */
  deriveNextBMDT(trexDefaultSampleDuration: number): bigint | undefined {
    const bmdt = this.scalars.get(fieldIDs.tfdtBaseMediaDecodeTime);
    if (bmdt === undefined) {
      return undefined;
    }
    const n = this.scalars.get(fieldIDs.trunSampleCount);
    if (n === undefined) {
      return undefined;
    }
    let total = 0n;
    const durs = this.lists.get(fieldIDs.trunSampleDurations);
    if (durs !== undefined) {
      if (BigInt(durs.length) !== n) {
        return undefined;
      }
      for (const d of durs) {
        total += d;
      }
    } else {
      const def =
        this.scalars.get(fieldIDs.tfhdDefaultSampleDuration) ??
        BigInt(trexDefaultSampleDuration);
      total = def * n;
    }
    const next = bmdt + total;
    if (next > U64_MAX) {
      return undefined;
    }
    return next;
  }
}

// -----------------------------------------------------------------------------
// Element sequence (Element sequence and dispatch section)
// -----------------------------------------------------------------------------

type SplitResult =
  | { kind: "raw"; raw: Uint8Array }
  | {
      kind: "chunk";
      genBoxes: GenBox[];
      headerType: number;
      props: Uint8Array;
      mdat: Uint8Array;
    };

/** Walk the element sequence: either genBoxes, exactly one full or
 * delta header, and the untagged mdat payload, or a single rawBoxes
 * element spanning the whole Object. Unknown element types are not
 * self-delimiting and reject the Object. */
function splitElements(payload: Uint8Array): SplitResult {
  const genBoxes: GenBox[] = [];
  let pos = 0;
  for (;;) {
    if (pos >= payload.length) {
      malformed("object ends before a header element");
    }
    const et = readVi(payload, pos, "element_type");
    pos += et.bytesRead;

    if (et.value === BigInt(ELEMENT_TYPE_GENBOX)) {
      const sz = readVi(payload, pos, "genBox box_size");
      pos += sz.bytesRead;
      // box_size covers box_name + payload; 4 + box_size must fit an
      // ISO 32-bit size field on reconstruction (genBox section).
      if (sz.value < 4n || sz.value > 0xfffffffbn) {
        malformed(`genBox box_size ${sz.value} out of range`);
      }
      const boxSize = Number(sz.value);
      if (boxSize > payload.length - pos) {
        malformed("genBox exceeds object payload");
      }
      genBoxes.push({
        name: String.fromCharCode(
          payload[pos],
          payload[pos + 1],
          payload[pos + 2],
          payload[pos + 3],
        ),
        payload: payload.slice(pos + 4, pos + boxSize),
      });
      pos += boxSize;
    } else if (
      et.value === BigInt(ELEMENT_TYPE_FULL_HEADER) ||
      et.value === BigInt(ELEMENT_TYPE_DELTA_HEADER)
    ) {
      const pl = readVi(payload, pos, "properties_length");
      pos += pl.bytesRead;
      if (pl.value > BigInt(payload.length - pos)) {
        malformed("property block exceeds object payload");
      }
      const propsLen = Number(pl.value);
      return {
        kind: "chunk",
        genBoxes,
        headerType: Number(et.value),
        props: payload.subarray(pos, pos + propsLen),
        mdat: payload.subarray(pos + propsLen),
      };
    } else if (et.value === BigInt(ELEMENT_TYPE_RAW_BOXES)) {
      if (genBoxes.length > 0) {
        malformed("rawBoxes element after a genBox");
      }
      // A rawBoxes element carries no length of its own: as the sole
      // element of its Object, the Object length delimits it, like the
      // untagged mdat payload of a moof-carrying Object.
      const raw = payload.subarray(pos);
      validateRawBoxes(raw);
      return { kind: "raw", raw };
    } else {
      // Not self-delimiting: the Object cannot be skipped past.
      malformed(`unknown element_type ${et.value}`);
    }
  }
}

/** Check that data is the concatenation of one or more complete ISO
 * BMFF boxes: each declared size at least 8, neither ISO size escape
 * (0 or 1) used, and the sizes summing to exactly data.length
 * (rawBoxes section; Security Considerations). */
function validateRawBoxes(data: Uint8Array): void {
  if (data.length === 0) {
    malformed("empty rawBoxes content");
  }
  let pos = 0;
  while (pos < data.length) {
    if (data.length - pos < 8) {
      malformed(`truncated box header at offset ${pos} in rawBoxes`);
    }
    const size =
      data[pos] * 0x1000000 +
      data[pos + 1] * 0x10000 +
      data[pos + 2] * 0x100 +
      data[pos + 3];
    if (size < 8) {
      malformed(
        `box size ${size} at offset ${pos} in rawBoxes ` +
          "(ISO size escapes and sub-header sizes not allowed)",
      );
    }
    if (size > data.length - pos) {
      malformed(`box at offset ${pos} exceeds rawBoxes content`);
    }
    pos += size;
  }
}

// -----------------------------------------------------------------------------
// Property blocks (Property encoding / parity rule section)
// -----------------------------------------------------------------------------

/** Split a property block into raw bytes per field ID via the parity
 * rule. Unknown field IDs are skipped (their framing is still parsed);
 * a repeated field ID rejects the block. */
function rawProperties(data: Uint8Array): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  const seen = new Set<bigint>();
  let pos = 0;
  while (pos < data.length) {
    const idv = readVi(data, pos, `field id at offset ${pos}`);
    pos += idv.bytesRead;
    if (seen.has(idv.value)) {
      malformed(`field id ${idv.value} repeated in one property block`);
    }
    seen.add(idv.value);

    let value: Uint8Array;
    if (idv.value % 2n === 0n) {
      // Even ID — scalar: a single vi64, no length prefix.
      const sv = readVi(data, pos, `scalar value for id ${idv.value}`);
      value = data.subarray(pos, pos + sv.bytesRead);
      pos += sv.bytesRead;
    } else {
      // Odd ID — length-prefixed bytes.
      const len = readVi(data, pos, `byte length for id ${idv.value}`);
      pos += len.bytesRead;
      if (len.value > BigInt(data.length - pos)) {
        malformed(`field id ${idv.value} exceeds property block`);
      }
      const byteLen = Number(len.value);
      value = data.subarray(pos, pos + byteLen);
      pos += byteLen;
    }
    const id = Number(idv.value);
    if (isKnown(id)) {
      out.set(id, value);
    }
  }
  return out;
}

function parseScalar(raw: Uint8Array, id: number): bigint {
  return readVi(raw, 0, `scalar id ${id}`).value;
}

function parseUnsignedList(raw: Uint8Array, id: number): bigint[] {
  const out: bigint[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const v = readVi(raw, pos, `vi64 list for id ${id}`);
    out.push(v.value);
    pos += v.bytesRead;
  }
  return out;
}

function parseZigzagList(raw: Uint8Array, id: number): bigint[] {
  const out: bigint[] = [];
  let pos = 0;
  while (pos < raw.length) {
    const v = readZig(raw, pos, `zigzag list for id ${id}`);
    out.push(v.value);
    pos += v.bytesRead;
  }
  return out;
}

/** Interpret a full header's property block: every value absolute
 * (Full Chunk Encoding section). */
function applyFullProperties(props: Uint8Array): ChunkFields {
  const raw = rawProperties(props);
  if (raw.has(fieldIDs.deltaDeletedLocmafIDs)) {
    malformed("field 27 in a full header");
  }
  const cf = newChunkFields();
  for (const [id, bytes] of raw) {
    if (KNOWN_SCALARS.has(id)) {
      cf.scalars.set(id, parseScalar(bytes, id));
    } else if (id === fieldIDs.trunSampleCompositionTimeOffsets) {
      cf.signedLists.set(id, parseZigzagList(bytes, id));
    } else if (id === fieldIDs.sencInitializationVector) {
      cf.rawBlobs.set(id, bytes.slice());
    } else if (KNOWN_UNSIGNED_LISTS.has(id)) {
      cf.lists.set(id, parseUnsignedList(bytes, id));
    }
  }
  if (!cf.scalars.has(fieldIDs.trunSampleCount)) {
    malformed("full header lacks trunSampleCount");
  }
  if (!cf.scalars.has(fieldIDs.tfdtBaseMediaDecodeTime)) {
    malformed("full header lacks tfdtBaseMediaDecodeTime");
  }
  return cf;
}

/** Apply a delta header to the in-group reference: deletions first,
 * then per-field deltas; the BMDT is always derived (Delta Chunk
 * Encoding section). */
function applyDeltaProperties(
  props: Uint8Array,
  prev: LocmafGroupState,
  trexDefaultSampleDuration: number,
): ChunkFields {
  const raw = rawProperties(props);
  if (raw.has(fieldIDs.tfdtBaseMediaDecodeTime)) {
    malformed("field 10 in a delta header");
  }

  const cf = prev.snapshot();

  // Deletions apply before deltas (Deletions section).
  const delBytes = raw.get(fieldIDs.deltaDeletedLocmafIDs);
  if (delBytes !== undefined) {
    const ids = parseUnsignedList(delBytes, fieldIDs.deltaDeletedLocmafIDs);
    for (const idv of ids) {
      const id = Number(idv);
      cf.scalars.delete(id);
      cf.lists.delete(id);
      cf.signedLists.delete(id);
      cf.rawBlobs.delete(id);
    }
    raw.delete(fieldIDs.deltaDeletedLocmafIDs);
  }

  // Scalars, with sample count first so list lengths are known.
  const applyScalarDelta = (id: number): void => {
    const bytes = raw.get(id);
    if (bytes === undefined) {
      return;
    }
    const delta = readZig(bytes, 0, `delta scalar id ${id}`).value;
    // An absent previous value counts as 0.
    const newV = (cf.scalars.get(id) ?? 0n) + delta;
    if (newV < 0n) {
      malformed(`negative value for id ${id} after delta`);
    }
    cf.scalars.set(id, newV);
    raw.delete(id);
  };
  applyScalarDelta(fieldIDs.trunSampleCount);
  const n64 = cf.scalars.get(fieldIDs.trunSampleCount) ?? 0n;
  if (n64 > BigInt(MAX_SAMPLE_COUNT)) {
    malformed(`sample count ${n64} exceeds implementation limit`);
  }
  const n = Number(n64);
  for (const id of [
    fieldIDs.tfhdSampleDescriptionIndex,
    fieldIDs.tfhdDefaultSampleDuration,
    fieldIDs.tfhdDefaultSampleSize,
    fieldIDs.tfhdDefaultSampleFlags,
    fieldIDs.trunFirstSampleFlags,
    fieldIDs.sencPerSampleIVSize,
  ]) {
    applyScalarDelta(id);
  }

  // Unsigned lists; subsample counts before the per-subsample lists so
  // their expected total is known (List length changes section).
  const applyListDelta = (id: number, want: number): void => {
    const bytes = raw.get(id);
    if (bytes === undefined) {
      // Inherited: resize to the current expected length. Truncation
      // keeps the map key — the list stays present-but-shorter.
      const list = cf.lists.get(id);
      if (list === undefined) {
        return;
      }
      if (list.length > want) {
        cf.lists.set(id, list.slice(0, want));
      } else if (list.length < want) {
        malformed(
          `inherited list id ${id} has ${list.length} elements, need ${want}`,
        );
      }
      return;
    }
    const deltas = parseZigzagList(bytes, id);
    if (deltas.length !== want) {
      malformed(
        `list id ${id} carries ${deltas.length} elements, expected ${want}`,
      );
    }
    const prevList = cf.lists.get(id) ?? [];
    const out: bigint[] = new Array(deltas.length);
    for (let i = 0; i < deltas.length; i++) {
      // A missing previous element counts as 0 (grown list).
      const p = i < prevList.length ? prevList[i] : 0n;
      const v = p + deltas[i];
      if (v < 0n) {
        malformed(`negative element in list id ${id}`);
      }
      out[i] = v;
    }
    cf.lists.set(id, out);
    raw.delete(id);
  };

  applyListDelta(fieldIDs.trunSampleDurations, n);
  applyListDelta(fieldIDs.trunSampleFlags, n);
  // trunSampleSizes carries n-1 entries (the last size derives from P).
  applyListDelta(fieldIDs.trunSampleSizes, n > 0 ? n - 1 : 0);
  applyListDelta(fieldIDs.sencSubsampleCount, n);
  let totalSubs = 0;
  for (const c of cf.lists.get(fieldIDs.sencSubsampleCount) ?? []) {
    totalSubs += Number(c);
    if (totalSubs > MAX_SAMPLE_COUNT) {
      malformed("subsample total exceeds implementation limit");
    }
  }
  applyListDelta(fieldIDs.sencBytesOfClearData, totalSubs);
  applyListDelta(fieldIDs.sencBytesOfProtectedData, totalSubs);

  // Signed list (composition-time offsets): zigzag in both contexts.
  const ctoBytes = raw.get(fieldIDs.trunSampleCompositionTimeOffsets);
  if (ctoBytes !== undefined) {
    const deltas = parseZigzagList(
      ctoBytes,
      fieldIDs.trunSampleCompositionTimeOffsets,
    );
    if (deltas.length !== n) {
      malformed(`cto list carries ${deltas.length} elements, expected ${n}`);
    }
    const prevList =
      cf.signedLists.get(fieldIDs.trunSampleCompositionTimeOffsets) ?? [];
    const out: bigint[] = new Array(deltas.length);
    for (let i = 0; i < deltas.length; i++) {
      out[i] = (i < prevList.length ? prevList[i] : 0n) + deltas[i];
    }
    cf.signedLists.set(fieldIDs.trunSampleCompositionTimeOffsets, out);
    raw.delete(fieldIDs.trunSampleCompositionTimeOffsets);
  } else {
    const list = cf.signedLists.get(fieldIDs.trunSampleCompositionTimeOffsets);
    if (list !== undefined) {
      if (list.length > n) {
        cf.signedLists.set(
          fieldIDs.trunSampleCompositionTimeOffsets,
          list.slice(0, n),
        );
      } else if (list.length < n) {
        malformed(`inherited cto list has ${list.length} elements, need ${n}`);
      }
    }
  }

  // Raw bytes (IVs): overwrite, never a delta.
  const ivBytes = raw.get(fieldIDs.sencInitializationVector);
  if (ivBytes !== undefined) {
    cf.rawBlobs.set(fieldIDs.sencInitializationVector, ivBytes.slice());
  }

  // Derived BMDT becomes the chunk's BMDT and the next reference.
  const derived = prev.deriveNextBMDT(trexDefaultSampleDuration);
  if (derived === undefined) {
    malformed("cannot derive BMDT for delta chunk");
  }
  cf.scalars.set(fieldIDs.tfdtBaseMediaDecodeTime, derived);

  return cf;
}

// -----------------------------------------------------------------------------
// Effective values (Effective values / Sample-size derivation sections)
// -----------------------------------------------------------------------------

/** Turn the represented fields plus the CMAF Header defaults and the
 * mdat payload into the chunk's effective values, applying the
 * sample-size derivation and its MUST-reject rules. */
function expandEffective(
  cf: ChunkFields,
  genBoxes: GenBox[],
  mdat: Uint8Array,
  ctx: InitContext,
): EffectiveValues {
  const n64 = cf.scalars.get(fieldIDs.trunSampleCount);
  if (n64 === undefined) {
    malformed("no trunSampleCount in chunk state");
  }
  if (n64 > BigInt(MAX_SAMPLE_COUNT)) {
    malformed(`sample count ${n64} exceeds implementation limit`);
  }
  const n = Number(n64);
  const bmdt = cf.scalars.get(fieldIDs.tfdtBaseMediaDecodeTime);
  if (bmdt === undefined) {
    malformed("no BMDT in chunk state");
  }
  const P = BigInt(mdat.length);
  if (n === 0 && P !== 0n) {
    malformed("zero samples with non-empty mdat payload");
  }

  const scalar32 = (id: number, def: number): number => {
    const v = cf.scalars.get(id);
    if (v === undefined) {
      return def;
    }
    if (v > U32_MAX) {
      malformed(`scalar id ${id} overflows 32 bits`);
    }
    return Number(v);
  };

  const sampleDescriptionIndex = scalar32(
    fieldIDs.tfhdSampleDescriptionIndex,
    ctx.trexDefaultSampleDescriptionIndex,
  );

  // Durations: field 3's element, else field 4, else the trex default.
  const defDur = scalar32(
    fieldIDs.tfhdDefaultSampleDuration,
    ctx.trexDefaultSampleDuration,
  );
  const durations: number[] = new Array(n);
  const durList = cf.lists.get(fieldIDs.trunSampleDurations);
  if (durList !== undefined) {
    if (durList.length !== n) {
      malformed(
        `duration list has ${durList.length} elements for ${n} samples`,
      );
    }
    for (let i = 0; i < n; i++) {
      if (durList[i] > U32_MAX) {
        malformed("sample duration overflows 32 bits");
      }
      durations[i] = Number(durList[i]);
    }
  } else {
    durations.fill(defDur);
  }

  // Sizes per the sample-size derivation. Presence of the listed field
  // is tracked by map key: a present-but-empty ID 1 selects the listed
  // branch (and rejects unless it carries exactly n-1 entries).
  const sizes: number[] = new Array(n).fill(0);
  const listed = cf.lists.get(fieldIDs.trunSampleSizes);
  if (listed !== undefined) {
    const want = n === 0 ? 0 : n - 1;
    if (listed.length !== want) {
      malformed(`size list has ${listed.length} elements, expected ${want}`);
    }
    let sum = 0n;
    for (let i = 0; i < listed.length; i++) {
      if (listed[i] > U32_MAX) {
        malformed("sample size overflows 32 bits");
      }
      sizes[i] = Number(listed[i]);
      sum += listed[i];
    }
    if (n > 0) {
      if (sum > P) {
        malformed("listed sample sizes exceed mdat payload");
      }
      const last = P - sum;
      if (last > U32_MAX) {
        malformed("derived last sample size overflows 32 bits");
      }
      sizes[n - 1] = Number(last);
    }
  } else {
    // Derivation order: an explicit tfhd default wins; then the n == 1
    // rule (the encoder MUST omit all size information for a single
    // sample, so its size is always P — checked before the trex
    // fallback, which could otherwise contradict P); then a non-zero
    // trex default; then the all-zero-size case (P == 0).
    let size = cf.scalars.get(fieldIDs.tfhdDefaultSampleSize);
    if (size === undefined && n !== 1 && ctx.trexDefaultSampleSize !== 0) {
      size = BigInt(ctx.trexDefaultSampleSize);
    }
    if (size !== undefined) {
      if (size > U32_MAX) {
        malformed("default sample size overflows 32 bits");
      }
      if (BigInt(n) * size !== P) {
        malformed(
          `${n} samples of size ${size} do not match mdat payload of ${P} bytes`,
        );
      }
      sizes.fill(Number(size));
    } else if (n === 1) {
      if (P > U32_MAX) {
        malformed("single sample size overflows 32 bits");
      }
      sizes[0] = Number(P);
    } else if (P === 0n) {
      // Uniform zero-size samples (e.g. an event track with several
      // zero-size samples per chunk): all sizes are 0.
    } else if (n > 1) {
      malformed(`no sample size information for ${n} samples`);
    }
  }

  // Flags: field 7's element, else field 12 for the first sample, else
  // field 8, else the trex default.
  const defFlags = scalar32(
    fieldIDs.tfhdDefaultSampleFlags,
    ctx.trexDefaultSampleFlags,
  );
  const firstFlags64 = cf.scalars.get(fieldIDs.trunFirstSampleFlags);
  if (firstFlags64 !== undefined && firstFlags64 > U32_MAX) {
    malformed("first sample flags overflow 32 bits");
  }
  const flags: number[] = new Array(n);
  const flagList = cf.lists.get(fieldIDs.trunSampleFlags);
  if (flagList !== undefined) {
    if (flagList.length !== n) {
      malformed(`flags list has ${flagList.length} elements for ${n} samples`);
    }
    for (let i = 0; i < n; i++) {
      if (flagList[i] > U32_MAX) {
        malformed("sample flags overflow 32 bits");
      }
      flags[i] = Number(flagList[i]);
    }
  } else {
    flags.fill(defFlags);
    if (n > 0 && firstFlags64 !== undefined) {
      flags[0] = Number(firstFlags64);
    }
  }

  // Composition-time offsets: signed, 32-bit range.
  const ctos: number[] = new Array(n).fill(0);
  const ctoList = cf.signedLists.get(fieldIDs.trunSampleCompositionTimeOffsets);
  if (ctoList !== undefined) {
    if (ctoList.length !== n) {
      malformed(`cto list has ${ctoList.length} elements for ${n} samples`);
    }
    for (let i = 0; i < n; i++) {
      if (ctoList[i] < I32_MIN || ctoList[i] > I32_MAX) {
        malformed("composition-time offset outside 32-bit range");
      }
      ctos[i] = Number(ctoList[i]);
    }
  }

  // CENC auxiliary information. The CENC fields apply only to
  // protected tracks: reject them outright when the CMAF Header does
  // not signal protection (tenc.default_isProtected = 1), since the
  // canonical senc/saiz/saio reconstruction is defined only for
  // protected tracks (Field Reference section).
  if (!ctx.protected) {
    if (
      cf.scalars.has(fieldIDs.sencPerSampleIVSize) ||
      cf.rawBlobs.has(fieldIDs.sencInitializationVector) ||
      cf.lists.has(fieldIDs.sencSubsampleCount) ||
      cf.lists.has(fieldIDs.sencBytesOfClearData) ||
      cf.lists.has(fieldIDs.sencBytesOfProtectedData)
    ) {
      malformed("CENC fields on an unprotected track");
    }
  }
  let ivSize64 = BigInt(ctx.tencDefaultPerSampleIVSize);
  const ivSizeField = cf.scalars.get(fieldIDs.sencPerSampleIVSize);
  if (ivSizeField !== undefined) {
    ivSize64 = ivSizeField;
  }
  if (ivSize64 > 255n) {
    malformed(`per-sample IV size ${ivSize64} out of range`);
  }
  const perSampleIVSize = Number(ivSize64);
  let ivs: Uint8Array = new Uint8Array(0);
  const ivBlob = cf.rawBlobs.get(fieldIDs.sencInitializationVector);
  if (ivBlob !== undefined && ivBlob.length > 0) {
    if (perSampleIVSize === 0) {
      malformed("IVs present with per-sample IV size 0");
    }
    if (ivBlob.length !== perSampleIVSize * n) {
      malformed(
        `IV payload is ${ivBlob.length} bytes for ${n} samples of ${perSampleIVSize}`,
      );
    }
    ivs = ivBlob;
  } else if (perSampleIVSize > 0 && n > 0) {
    malformed(`per-sample IV size ${perSampleIVSize} but no IVs`);
  }

  let hasSubsamples = false;
  let subsampleCounts: number[] = [];
  let clearBytes: number[] = [];
  let protectedBytes: number[] = [];
  const counts = cf.lists.get(fieldIDs.sencSubsampleCount);
  if (counts !== undefined) {
    if (counts.length !== n) {
      malformed(
        `subsample count list has ${counts.length} elements for ${n} samples`,
      );
    }
    hasSubsamples = true;
    subsampleCounts = new Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (counts[i] > 0xffffn) {
        malformed("subsample count overflows 16 bits");
      }
      subsampleCounts[i] = Number(counts[i]);
      total += subsampleCounts[i];
    }
    const clear = cf.lists.get(fieldIDs.sencBytesOfClearData) ?? [];
    const prot = cf.lists.get(fieldIDs.sencBytesOfProtectedData) ?? [];
    if (clear.length !== total || prot.length !== total) {
      malformed(
        `subsample byte lists (${clear.length}, ${prot.length}) do not match total count ${total}`,
      );
    }
    clearBytes = new Array(total);
    protectedBytes = new Array(total);
    for (let i = 0; i < total; i++) {
      if (clear[i] > 0xffffn) {
        malformed("bytes of clear data overflow 16 bits");
      }
      if (prot[i] > U32_MAX) {
        malformed("bytes of protected data overflow 32 bits");
      }
      clearBytes[i] = Number(clear[i]);
      protectedBytes[i] = Number(prot[i]);
    }
    // The subsample map of a sample with a non-zero count must cover
    // the sample exactly (a zero-count sample carries no map and is
    // unconstrained) — Security Considerations.
    let subIdx = 0;
    for (let i = 0; i < n; i++) {
      const cnt = subsampleCounts[i];
      if (cnt === 0) {
        continue;
      }
      let sum = 0;
      for (let j = 0; j < cnt; j++) {
        sum += clearBytes[subIdx] + protectedBytes[subIdx];
        subIdx++;
      }
      if (sum !== sizes[i]) {
        malformed(
          `subsample bytes sum to ${sum} for sample ${i} of size ${sizes[i]}`,
        );
      }
    }
  } else if (
    cf.lists.has(fieldIDs.sencBytesOfClearData) ||
    cf.lists.has(fieldIDs.sencBytesOfProtectedData)
  ) {
    malformed("subsample byte lists without subsample counts");
  }

  return {
    sampleCount: n,
    bmdt,
    sampleDescriptionIndex,
    durations,
    sizes,
    flags,
    ctos,
    perSampleIVSize,
    ivs,
    hasSubsamples,
    subsampleCounts,
    clearBytes,
    protectedBytes,
    genBoxes,
    mdatPayload: mdat,
  };
}

// -----------------------------------------------------------------------------
// Public decode entry point
// -----------------------------------------------------------------------------

/**
 * Decode one LOCMAF Object payload, using state as the in-group
 * reference for delta chunks. A full header or a rawBoxes Object
 * resets the state; on error the state is reset too — a malformed
 * Object is a loss of in-group sync, so subsequent delta chunks are
 * rejected until the next full header re-anchors. Throws
 * LocmafMalformedError on wire-level violations.
 */
export function decodeObject(
  payload: Uint8Array,
  state: LocmafGroupState,
  ctx: InitContext,
): DecodeResult {
  try {
    return decodeObjectInner(payload, state, ctx);
  } catch (err) {
    state.reset();
    throw err;
  }
}

function decodeObjectInner(
  payload: Uint8Array,
  state: LocmafGroupState,
  ctx: InitContext,
): DecodeResult {
  const elements = splitElements(payload);
  if (elements.kind === "raw") {
    state.reset();
    return { raw: elements.raw };
  }

  let cf: ChunkFields;
  if (elements.headerType === ELEMENT_TYPE_FULL_HEADER) {
    cf = applyFullProperties(elements.props);
    state.reset();
  } else {
    if (!state.hasAny) {
      malformed("delta header before any full header in the group");
    }
    cf = applyDeltaProperties(
      elements.props,
      state,
      ctx.trexDefaultSampleDuration,
    );
  }

  const eff = expandEffective(cf, elements.genBoxes, elements.mdat, ctx);
  state.store(cf);
  return { eff };
}

// -----------------------------------------------------------------------------
// CMAF Header (init segment) parsing
// -----------------------------------------------------------------------------

/**
 * Parse the CMAF Header (ftyp+moov bytes) into the track context: the
 * tkhd track_ID (fallback trex), mdhd timescale, trex defaults, and
 * the tenc protection defaults. The init bytes themselves are raw CMAF
 * and are handed to MSE unchanged.
 *
 * This is a deliberate fixed-layout scanner rather than a general box
 * parser: only four boxes matter, their layouts are pinned by ISO
 * 14496-12 / 23001-7, and general-purpose readers have been observed
 * to silently drop the tenc inside protected sample entries.
 */
export function parseInitContext(initSegment: Uint8Array): InitContext {
  return parseInitManually(initSegment);
}

/** Plain container boxes on the paths to tkhd, mdhd, trex, and tenc. */
const INIT_CONTAINERS = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "mvex",
  "sinf",
  "schi",
]);

function u32be(data: Uint8Array, off: number): number {
  return (
    data[off] * 0x1000000 +
    data[off + 1] * 0x10000 +
    data[off + 2] * 0x100 +
    data[off + 3]
  );
}

/** Recursively collect the payloads (contents after the 8-byte box
 * header) of the first tkhd, mdhd, trex, and tenc boxes. Descends
 * plain containers, stsd (FullBox + entry_count), and the protected
 * sample entries encv / enca (fixed visual / audio entry headers).
 * A declared size overrunning the available bytes is clamped rather
 * than rejected — init parsing is deliberately liberal, unlike the
 * Object decoder. */
function scanInitBoxes(data: Uint8Array): Map<string, Uint8Array> {
  const found = new Map<string, Uint8Array>();
  const walk = (start: number, end: number): void => {
    let pos = start;
    while (pos + 8 <= end) {
      const size = u32be(data, pos);
      if (size < 8) {
        return; // ISO size escape or ill-formed box: stop this level
      }
      const boxEnd = Math.min(pos + size, end);
      const type = String.fromCharCode(
        data[pos + 4],
        data[pos + 5],
        data[pos + 6],
        data[pos + 7],
      );
      const body = pos + 8;
      if (
        !found.has(type) &&
        (type === "tkhd" ||
          type === "mdhd" ||
          type === "trex" ||
          type === "tenc")
      ) {
        found.set(type, data.subarray(body, boxEnd));
      }
      if (INIT_CONTAINERS.has(type)) {
        walk(body, boxEnd);
      } else if (type === "stsd") {
        walk(body + 8, boxEnd); // version/flags + entry_count
      } else if (type === "encv") {
        walk(body + 78, boxEnd); // VisualSampleEntry fixed header
      } else if (type === "enca") {
        walk(body + 28, boxEnd); // AudioSampleEntry fixed header
      }
      pos += size;
    }
  };
  walk(0, data.length);
  return found;
}

function parseInitManually(initSegment: Uint8Array): InitContext {
  const boxes = scanInitBoxes(initSegment);
  const trex = boxes.get("trex");
  if (trex === undefined || trex.length < 24) {
    malformed("init data does not contain trex");
  }
  const mdhd = boxes.get("mdhd");
  if (mdhd === undefined || mdhd.length < 16) {
    malformed("init data does not contain mdhd");
  }
  // trex payload: version/flags, track_ID, default_sample_description_
  // index, default_sample_duration, default_sample_size,
  // default_sample_flags — five uint32s after the FullBox header.
  const trexTrackId = u32be(trex, 4);
  // tkhd / mdhd: the interesting uint32 sits after version/flags plus
  // the creation and modification times (4+4 in version 0, 8+8 in 1).
  const tkhd = boxes.get("tkhd");
  let trackId = trexTrackId;
  if (tkhd !== undefined && tkhd.length >= 24) {
    trackId = u32be(tkhd, tkhd[0] === 1 ? 20 : 12);
  }
  const timescale = u32be(mdhd, mdhd[0] === 1 ? 20 : 12);
  // tenc payload: version/flags, reserved, (reserved | pattern),
  // default_isProtected, default_Per_Sample_IV_Size, default_KID(16).
  // Only the two single-byte fields are needed here, so a tenc with a
  // truncated KID still yields the protection flags.
  const tenc = boxes.get("tenc");
  const isProtected = tenc !== undefined && tenc.length >= 8 && tenc[6] === 1;

  return {
    trackId,
    timescale,
    trexDefaultSampleDescriptionIndex: u32be(trex, 8),
    trexDefaultSampleDuration: u32be(trex, 12),
    trexDefaultSampleSize: u32be(trex, 16),
    trexDefaultSampleFlags: u32be(trex, 20),
    protected: isProtected,
    tencDefaultPerSampleIVSize: isProtected && tenc !== undefined ? tenc[7] : 0,
  };
}
