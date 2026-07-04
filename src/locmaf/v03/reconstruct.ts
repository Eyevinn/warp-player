/**
 * Canonical CMAF reconstruction for LOCMAF v0.3
 * (draft-einarsson-moq-locmaf, "Canonical Reconstruction").
 *
 * Effective values in, byte-exact canonical chunk out: each genBox
 * wrapped as an ISO box, then the moof, then the mdat. This is a
 * byte-for-byte port of the Go reference writer
 * (github.com/Eyevinn/locmaf, reconstruct.go). Per the draft's
 * implementation note, canonical reconstruction is a normalisation
 * pass: it must not rely on incidental serialiser output (box order,
 * tr_flags packing) from a general-purpose ISO BMFF writer, so the
 * boxes are hand-written here with DataView/Uint8Array.
 */
import { EffectiveValues, InitContext, LocmafMalformedError } from "./types";

// tfhd tf_flags bits (ISO/IEC 14496-12).
const TFHD_SAMPLE_DESC_INDEX_PRESENT = 0x000002;
const TFHD_DEFAULT_DURATION_PRESENT = 0x000008;
const TFHD_DEFAULT_SIZE_PRESENT = 0x000010;
const TFHD_DEFAULT_FLAGS_PRESENT = 0x000020;
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;

// trun tr_flags bits (ISO/IEC 14496-12).
const TRUN_DATA_OFFSET_PRESENT = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS_PRESENT = 0x000004;
const TRUN_SAMPLE_DURATION_PRESENT = 0x000100;
const TRUN_SAMPLE_SIZE_PRESENT = 0x000200;
const TRUN_SAMPLE_FLAGS_PRESENT = 0x000400;
const TRUN_SAMPLE_CTO_PRESENT = 0x000800;

/**
 * canonicalLayout captures every presence decision of the canonical
 * reconstruction, derived from the effective values and the trex
 * defaults alone — wire presence plays no part (draft §"tfhd" /
 * §"trun").
 */
interface CanonicalLayout {
  n: number;

  sdixPresent: boolean;
  defDurPresent: boolean;
  defDur: number;
  defSizePresent: boolean;
  defSize: number;
  defFlagsPresent: boolean;
  defFlags: number;

  fsfPresent: boolean;
  durPresent: boolean;
  sizePresent: boolean;
  flagsPresent: boolean;
  ctoPresent: boolean;
  trunVersion: number;

  cenc: boolean;
  auxSizes: number[]; // per-sample aux_info sizes
  auxEqual: boolean;
}

function allEqual(v: number[]): boolean {
  for (let i = 1; i < v.length; i++) {
    if (v[i] !== v[0]) {
      return false;
    }
  }
  return true;
}

/**
 * equalExceptFirst reports whether v[1:] are all equal to each other
 * and v[0] differs from them — the first-sample-flags case of the
 * draft's canonical trun. Requires length > 1.
 */
function equalExceptFirst(v: number[]): boolean {
  if (v.length < 2) {
    return false;
  }
  for (let i = 2; i < v.length; i++) {
    if (v[i] !== v[1]) {
      return false;
    }
  }
  return v[0] !== v[1];
}

function deriveLayout(eff: EffectiveValues, ctx: InitContext): CanonicalLayout {
  const n = eff.sampleCount;
  const l: CanonicalLayout = {
    n,
    sdixPresent: false,
    defDurPresent: false,
    defDur: 0,
    defSizePresent: false,
    defSize: 0,
    defFlagsPresent: false,
    defFlags: 0,
    fsfPresent: false,
    durPresent: false,
    sizePresent: false,
    flagsPresent: false,
    ctoPresent: false,
    trunVersion: 0,
    cenc: false,
    auxSizes: [],
    auxEqual: false,
  };

  // sample-description-index-present iff the effective index differs
  // from the trex default (draft §"tfhd").
  l.sdixPresent =
    eff.sampleDescriptionIndex !== ctx.trexDefaultSampleDescriptionIndex;

  if (n > 0) {
    // default-sample-duration-present iff all durations are equal AND
    // that value differs from the trex default; per-sample durations
    // otherwise (draft §"tfhd" / §"trun").
    if (allEqual(eff.durations)) {
      if (eff.durations[0] !== ctx.trexDefaultSampleDuration) {
        l.defDurPresent = true;
        l.defDur = eff.durations[0];
      }
    } else {
      l.durPresent = true;
    }

    // Uniform sizes (n == 1 is trivially uniform) ride as a tfhd
    // default when they differ from trex. The wire omits a single
    // sample's size, but the canonical CMAF chunk must still carry
    // it: ISO BMFF has no rule deriving a sample size from the mdat
    // length (draft §"Canonical sample-size layout").
    if (allEqual(eff.sizes)) {
      if (eff.sizes[0] !== ctx.trexDefaultSampleSize) {
        l.defSizePresent = true;
        l.defSize = eff.sizes[0];
      }
    } else {
      l.sizePresent = true;
    }

    // Flags: all equal → tfhd default (iff ≠ trex); equal except the
    // first → first-sample-flags + tfhd default covering the rest
    // (iff ≠ trex); otherwise per-sample flags (draft §"trun").
    if (allEqual(eff.flags)) {
      if (eff.flags[0] !== ctx.trexDefaultSampleFlags) {
        l.defFlagsPresent = true;
        l.defFlags = eff.flags[0];
      }
    } else if (equalExceptFirst(eff.flags)) {
      l.fsfPresent = true;
      if (eff.flags[1] !== ctx.trexDefaultSampleFlags) {
        l.defFlagsPresent = true;
        l.defFlags = eff.flags[1];
      }
    } else {
      l.flagsPresent = true;
    }

    // CTOs present iff any ≠ 0; trun version 1 iff any is negative
    // (draft §"trun").
    for (const c of eff.ctos) {
      if (c !== 0) {
        l.ctoPresent = true;
      }
      if (c < 0) {
        l.trunVersion = 1;
      }
    }
  }

  // CENC aux info: saiz/saio/senc are reconstructed iff the effective
  // values include per-sample auxiliary information (draft §"CENC
  // senc / saiz / saio reconstruction"). An aux_size above 255 does
  // not fit saiz's 8-bit sample_info_size and MUST be rejected.
  if (eff.perSampleIVSize > 0 || eff.hasSubsamples) {
    l.cenc = true;
    l.auxEqual = true;
    for (let i = 0; i < n; i++) {
      let size = eff.perSampleIVSize;
      if (eff.hasSubsamples) {
        size += 2 + 6 * eff.subsampleCounts[i];
      }
      if (size > 255) {
        throw new LocmafMalformedError(
          `aux_info size ${size} exceeds 8-bit saiz limit`,
        );
      }
      l.auxSizes.push(size);
      if (size !== l.auxSizes[0]) {
        l.auxEqual = false;
      }
    }
  }

  return l;
}

function tfhdSize(l: CanonicalLayout): number {
  let k = 0;
  for (const present of [
    l.sdixPresent,
    l.defDurPresent,
    l.defSizePresent,
    l.defFlagsPresent,
  ]) {
    if (present) {
      k++;
    }
  }
  return 16 + 4 * k;
}

function trunSize(l: CanonicalLayout): number {
  let perSample = 0;
  for (const present of [
    l.durPresent,
    l.sizePresent,
    l.flagsPresent,
    l.ctoPresent,
  ]) {
    if (present) {
      perSample += 4;
    }
  }
  // header, version+flags, sample_count, data_offset
  let size = 8 + 4 + 4 + 4;
  if (l.fsfPresent) {
    size += 4;
  }
  return size + l.n * perSample;
}

function sencSize(l: CanonicalLayout, eff: EffectiveValues): number {
  // header, version+flags, sample_count
  let size = 8 + 4 + 4;
  size += l.n * eff.perSampleIVSize;
  if (eff.hasSubsamples) {
    for (const c of eff.subsampleCounts) {
      size += 2 + 6 * c;
    }
  }
  return size;
}

function saizSize(l: CanonicalLayout): number {
  let size = 8 + 4 + 1 + 4;
  if (!l.auxEqual) {
    size += l.n;
  }
  return size;
}

/**
 * validateEffective checks the internal consistency of caller-supplied
 * effective values, so the reconstruction below cannot index past a
 * vector. Values produced by the decoder always pass.
 */
function validateEffective(eff: EffectiveValues): void {
  const n = eff.sampleCount;
  if (!Number.isInteger(n) || n < 0) {
    throw new LocmafMalformedError(`invalid sample count ${n}`);
  }
  if (
    eff.durations.length !== n ||
    eff.sizes.length !== n ||
    eff.flags.length !== n ||
    eff.ctos.length !== n
  ) {
    throw new LocmafMalformedError(
      `per-sample vectors (${eff.durations.length}, ${eff.sizes.length}, ` +
        `${eff.flags.length}, ${eff.ctos.length}) do not match sample count ${n}`,
    );
  }
  let sizeSum = 0;
  for (const s of eff.sizes) {
    sizeSum += s;
  }
  if (sizeSum !== eff.mdatPayload.length) {
    throw new LocmafMalformedError(
      `sample sizes sum to ${sizeSum} but the mdat payload is ` +
        `${eff.mdatPayload.length} bytes`,
    );
  }
  const wantIVs = eff.perSampleIVSize * n;
  if (eff.ivs.length !== wantIVs) {
    throw new LocmafMalformedError(
      `IV payload is ${eff.ivs.length} bytes, expected ${wantIVs}`,
    );
  }
  if (eff.hasSubsamples) {
    if (eff.subsampleCounts.length !== n) {
      throw new LocmafMalformedError(
        `subsample count vector has ${eff.subsampleCounts.length} entries ` +
          `for ${n} samples`,
      );
    }
    let total = 0;
    for (const c of eff.subsampleCounts) {
      total += c;
    }
    if (
      eff.clearBytes.length !== total ||
      eff.protectedBytes.length !== total
    ) {
      throw new LocmafMalformedError(
        `subsample byte vectors (${eff.clearBytes.length}, ` +
          `${eff.protectedBytes.length}) do not match total count ${total}`,
      );
    }
  } else if (
    eff.subsampleCounts.length !== 0 ||
    eff.clearBytes.length !== 0 ||
    eff.protectedBytes.length !== 0
  ) {
    throw new LocmafMalformedError(
      "subsample vectors present without hasSubsamples",
    );
  }
  if (eff.bmdt < 0n || eff.bmdt > 0xffffffffffffffffn) {
    throw new LocmafMalformedError(`BMDT ${eff.bmdt} outside uint64 range`);
  }
}

/**
 * Build the canonical CMAF chunk bytes from effective values and the
 * track context. sequenceNumber goes into mfhd.sequence_number: pass 0
 * (the default) for the canonical form used in golden-vector
 * comparison; playback may pass the MoQ group ID (the draft allows it).
 * Throws LocmafMalformedError on inconsistent input (port
 * validateEffective) and on the canonical MUST-rejects (aux_size > 255,
 * mdat > 0xFFFFFFF7, moof overflowing trun.data_offset).
 */
export function reconstructCanonical(
  ctx: InitContext,
  eff: EffectiveValues,
  sequenceNumber = 0,
): Uint8Array {
  validateEffective(eff);
  // The mdat header is always 8 bytes; the ISO size escapes 0 and 1
  // are not allowed, so a payload that does not fit the 32-bit box
  // size MUST be rejected (draft §"data_offset and the mdat header").
  if (eff.mdatPayload.length > 0xfffffff7) {
    throw new LocmafMalformedError("mdat payload exceeds 32-bit box size");
  }

  const l = deriveLayout(eff, ctx);

  // Box sizes, bottom-up, so trun.data_offset and saio.offset are
  // known before any byte is written — no second serialization pass.
  const mfhdSize = 16;
  const tfdtSize = 20;
  const tfhdSz = tfhdSize(l);
  const trunSz = trunSize(l);
  let trafSize = 8 + tfhdSz + tfdtSize + trunSz;
  let sencOffsetInMoof = 0;
  const saizSz = saizSize(l);
  const saioSize = 20;
  const sencSz = sencSize(l, eff);
  if (l.cenc) {
    sencOffsetInMoof =
      8 + mfhdSize + 8 + tfhdSz + tfdtSize + trunSz + saizSz + saioSize;
    trafSize += saizSz + saioSize + sencSz;
  }
  const moofSize = 8 + mfhdSize + trafSize;
  // data_offset is a signed 32-bit field; a moof anywhere near that
  // bound is far outside any real chunk.
  if (moofSize + 8 > 0x7fffffff) {
    throw new LocmafMalformedError(
      `moof size ${moofSize} overflows trun.data_offset`,
    );
  }

  let total = moofSize + 8 + eff.mdatPayload.length;
  for (const gb of eff.genBoxes) {
    // A genBox reconstructs as uint32be(8 + payload) | name | payload;
    // the name is a FourCC and the size must fit 32 bits with no ISO
    // size escapes (draft §"Generic Boxes", Reconstruction).
    if (gb.name.length !== 4) {
      throw new LocmafMalformedError(
        `genBox name "${gb.name}" is not a FourCC`,
      );
    }
    if (8 + gb.payload.length > 0xffffffff) {
      throw new LocmafMalformedError(
        `genBox "${gb.name}" exceeds 32-bit box size`,
      );
    }
    total += 8 + gb.payload.length;
  }

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let pos = 0;

  const u16 = (v: number): void => {
    dv.setUint16(pos, v);
    pos += 2;
  };
  const u32 = (v: number): void => {
    dv.setUint32(pos, v);
    pos += 4;
  };
  const u64 = (v: bigint): void => {
    dv.setBigUint64(pos, v);
    pos += 8;
  };
  const bytes = (b: Uint8Array): void => {
    out.set(b, pos);
    pos += b.length;
  };
  const boxHeader = (size: number, name: string): void => {
    u32(size);
    for (let i = 0; i < 4; i++) {
      out[pos++] = name.charCodeAt(i) & 0xff;
    }
  };

  // genBoxes, wrapped byte-for-byte, in payload order, before the moof.
  for (const gb of eff.genBoxes) {
    boxHeader(8 + gb.payload.length, gb.name);
    bytes(gb.payload);
  }

  // moof
  boxHeader(moofSize, "moof");

  // mfhd: version 0, flags 0. The canonical sequence_number is 0; an
  // implementation may derive the real one from the MOQT object
  // identity (draft §"mfhd").
  boxHeader(mfhdSize, "mfhd");
  u32(0);
  u32(sequenceNumber);

  // traf
  boxHeader(trafSize, "traf");

  // tfhd: version 0; always default-base-is-moof, never
  // base-data-offset; optionals in flag-bit order after track_ID
  // (draft §"tfhd").
  let tfFlags = TFHD_DEFAULT_BASE_IS_MOOF;
  if (l.sdixPresent) {
    tfFlags |= TFHD_SAMPLE_DESC_INDEX_PRESENT;
  }
  if (l.defDurPresent) {
    tfFlags |= TFHD_DEFAULT_DURATION_PRESENT;
  }
  if (l.defSizePresent) {
    tfFlags |= TFHD_DEFAULT_SIZE_PRESENT;
  }
  if (l.defFlagsPresent) {
    tfFlags |= TFHD_DEFAULT_FLAGS_PRESENT;
  }
  boxHeader(tfhdSz, "tfhd");
  u32(tfFlags); // version 0 in the top byte
  u32(ctx.trackId);
  if (l.sdixPresent) {
    u32(eff.sampleDescriptionIndex);
  }
  if (l.defDurPresent) {
    u32(l.defDur);
  }
  if (l.defSizePresent) {
    u32(l.defSize);
  }
  if (l.defFlagsPresent) {
    u32(l.defFlags);
  }

  // tfdt: version 1 always (64-bit BMDT), flags 0 (draft §"tfdt").
  boxHeader(tfdtSize, "tfdt");
  u32(1 << 24);
  u64(eff.bmdt);

  // trun (draft §"trun").
  let trFlags = TRUN_DATA_OFFSET_PRESENT;
  if (l.fsfPresent) {
    trFlags |= TRUN_FIRST_SAMPLE_FLAGS_PRESENT;
  }
  if (l.durPresent) {
    trFlags |= TRUN_SAMPLE_DURATION_PRESENT;
  }
  if (l.sizePresent) {
    trFlags |= TRUN_SAMPLE_SIZE_PRESENT;
  }
  if (l.flagsPresent) {
    trFlags |= TRUN_SAMPLE_FLAGS_PRESENT;
  }
  if (l.ctoPresent) {
    trFlags |= TRUN_SAMPLE_CTO_PRESENT;
  }
  boxHeader(trunSz, "trun");
  u32((l.trunVersion << 24) | trFlags);
  u32(l.n);
  // data_offset = moof_size + 8: the first byte of the mdat sample
  // data, just past the 8-byte mdat header (draft §"data_offset and
  // the mdat header").
  u32(moofSize + 8);
  if (l.fsfPresent) {
    u32(eff.flags[0]);
  }
  for (let i = 0; i < l.n; i++) {
    if (l.durPresent) {
      u32(eff.durations[i]);
    }
    if (l.sizePresent) {
      u32(eff.sizes[i]);
    }
    if (l.flagsPresent) {
      u32(eff.flags[i]);
    }
    if (l.ctoPresent) {
      // Two's-complement uint32; signed only under trun version 1.
      u32(eff.ctos[i] >>> 0);
    }
  }

  if (l.cenc) {
    // saiz: version 0, flags 0 (aux_info_type omitted). All-equal aux
    // sizes ride as default_sample_info_size with an empty array;
    // otherwise default 0 + the per-sample array (draft §"CENC ...",
    // saiz).
    boxHeader(saizSz, "saiz");
    u32(0);
    if (l.auxEqual) {
      out[pos++] = l.n > 0 ? l.auxSizes[0] : 0;
      u32(l.n);
    } else {
      out[pos++] = 0;
      u32(l.n);
      for (const s of l.auxSizes) {
        out[pos++] = s;
      }
    }

    // saio: version 0, flags 0, entry_count 1; the single offset is
    // moof-relative (default-base-is-moof) and skips the senc box
    // header, FullBox version+flags, and sample_count — 16 bytes
    // (draft §"CENC ...", saio).
    boxHeader(saioSize, "saio");
    u32(0);
    u32(1);
    u32(sencOffsetInMoof + 16);

    // senc: version 0; flags 0x000002 iff the effective subsample map
    // is present. Per sample: the IV, then (when flagged) uint16
    // subsample_count and (uint16 clear, uint32 protected) pairs
    // (draft §"CENC ...", senc).
    const sencFlags = eff.hasSubsamples ? 0x000002 : 0;
    boxHeader(sencSz, "senc");
    u32(sencFlags);
    u32(l.n);
    const ivSize = eff.perSampleIVSize;
    let subIdx = 0;
    for (let i = 0; i < l.n; i++) {
      if (ivSize > 0) {
        bytes(eff.ivs.subarray(i * ivSize, (i + 1) * ivSize));
      }
      if (eff.hasSubsamples) {
        const cnt = eff.subsampleCounts[i];
        u16(cnt);
        for (let j = 0; j < cnt; j++) {
          u16(eff.clearBytes[subIdx]);
          u32(eff.protectedBytes[subIdx]);
          subIdx++;
        }
      }
    }
  }

  // mdat: always an 8-byte header (draft §"data_offset and the mdat
  // header").
  boxHeader(8 + eff.mdatPayload.length, "mdat");
  bytes(eff.mdatPayload);

  return out;
}
