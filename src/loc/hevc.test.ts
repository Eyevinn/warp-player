import {
  HevcParseError,
  NALU_TYPE_CRA_NUT,
  NALU_TYPE_IDR_N_LP,
  NALU_TYPE_IDR_W_RADL,
  NALU_TYPE_PPS,
  NALU_TYPE_PREFIX_SEI,
  NALU_TYPE_SPS,
  NALU_TYPE_VPS,
  buildHevcDecoderConfigDescription,
  extractParameterSetsAndChunk,
  isIrapNaluType,
  naluType,
  payloadIsKey,
  walkHvccNalus,
} from "./hevc";

// Build a length-prefixed NALU stream from raw NALU bodies.
function hvcc(...nalus: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const n of nalus) {
    total += 4 + n.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const n of nalus) {
    out[off++] = (n.length >>> 24) & 0xff;
    out[off++] = (n.length >>> 16) & 0xff;
    out[off++] = (n.length >>> 8) & 0xff;
    out[off++] = n.length & 0xff;
    out.set(n, off);
    off += n.length;
  }
  return out;
}

// Construct a HEVC NALU with a given type and arbitrary RBSP body. The 2-byte
// header carries nal_unit_type in bits 1-6 of the first byte; nuh_layer_id=0
// and nuh_temporal_id_plus1=1 are the common defaults.
function nalu(type: number, body: number[] = []): Uint8Array {
  const first = (type & 0x3f) << 1;
  const second = 0x01; // layer_id=0, temporal_id_plus1=1
  return new Uint8Array([first, second, ...body]);
}

// Minimal SPS: 2-byte NAL header + 1 byte (vps_id|max_sub_layers|nested) +
// 12 bytes of profile_tier_level. Values picked so the PTL extractor finds
// recognisable bytes.
const PTL_BYTES = [
  0x21, // profile_space=0, tier_flag=1, profile_idc=1 (Main)
  0x60,
  0x00,
  0x00,
  0x00, // profile_compatibility_flags
  0x90,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00, // constraint_indicator_flags
  0x5d, // level_idc = 93 (level 3.1)
];
const SPS_BYTES = nalu(NALU_TYPE_SPS, [0x00, ...PTL_BYTES, 0xab, 0xcd]);
const VPS_BYTES = nalu(NALU_TYPE_VPS, [0x0c, 0x01]);
const PPS_BYTES = nalu(NALU_TYPE_PPS, [0xc1, 0x72]);

describe("naluType / isIrapNaluType", () => {
  it("decodes nal_unit_type from the first byte", () => {
    expect(naluType(0x40)).toBe(32); // 0100 0000 → bits 1-6 = 100000 = 32 (VPS)
    expect(naluType(0x42)).toBe(33); // SPS
    expect(naluType(0x44)).toBe(34); // PPS
    expect(naluType(0x28)).toBe(20); // IDR_N_LP
  });

  it("identifies IRAP types", () => {
    expect(isIrapNaluType(NALU_TYPE_IDR_W_RADL)).toBe(true);
    expect(isIrapNaluType(NALU_TYPE_IDR_N_LP)).toBe(true);
    expect(isIrapNaluType(NALU_TYPE_CRA_NUT)).toBe(true);
    expect(isIrapNaluType(15)).toBe(false);
    expect(isIrapNaluType(24)).toBe(false);
    expect(isIrapNaluType(NALU_TYPE_VPS)).toBe(false);
  });
});

describe("walkHvccNalus", () => {
  it("returns an empty list for an empty payload", () => {
    expect(walkHvccNalus(new Uint8Array())).toEqual([]);
  });

  it("splits a stream of multiple NALUs preserving order", () => {
    const out = walkHvccNalus(
      hvcc(VPS_BYTES, SPS_BYTES, PPS_BYTES, nalu(NALU_TYPE_IDR_W_RADL, [0xff])),
    );
    expect(out.map((n) => n.type)).toEqual([
      NALU_TYPE_VPS,
      NALU_TYPE_SPS,
      NALU_TYPE_PPS,
      NALU_TYPE_IDR_W_RADL,
    ]);
  });

  it("throws on a truncated length prefix", () => {
    expect(() => walkHvccNalus(new Uint8Array([0x00, 0x00]))).toThrow(
      HevcParseError,
    );
  });

  it("throws when a NALU runs past the end", () => {
    const bad = new Uint8Array([0x00, 0x00, 0x00, 0x0a, 0x40, 0x01]);
    expect(() => walkHvccNalus(bad)).toThrow(HevcParseError);
  });

  it("throws on a too-small NALU length", () => {
    const bad = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x40]);
    expect(() => walkHvccNalus(bad)).toThrow(HevcParseError);
  });
});

describe("payloadIsKey", () => {
  it("returns true when an IRAP slice is present", () => {
    expect(payloadIsKey(hvcc(nalu(NALU_TYPE_IDR_W_RADL, [0])))).toBe(true);
    expect(payloadIsKey(hvcc(nalu(NALU_TYPE_CRA_NUT)))).toBe(true);
    expect(
      payloadIsKey(
        hvcc(VPS_BYTES, SPS_BYTES, PPS_BYTES, nalu(NALU_TYPE_IDR_N_LP)),
      ),
    ).toBe(true);
  });

  it("returns false for non-IRAP slices only", () => {
    expect(payloadIsKey(hvcc(nalu(1, [0])))).toBe(false);
    expect(payloadIsKey(hvcc(VPS_BYTES, SPS_BYTES, PPS_BYTES))).toBe(false);
  });

  it("returns false for empty payload", () => {
    expect(payloadIsKey(new Uint8Array())).toBe(false);
  });
});

describe("extractParameterSetsAndChunk", () => {
  it("separates VPS+SPS+PPS at IRAP and rebuilds the chunk", () => {
    const idr = nalu(NALU_TYPE_IDR_W_RADL, [0xa1, 0xa2, 0xa3]);
    const r = extractParameterSetsAndChunk(
      hvcc(VPS_BYTES, SPS_BYTES, PPS_BYTES, idr),
    );
    expect(r.vps).toHaveLength(1);
    expect(Array.from(r.vps[0])).toEqual(Array.from(VPS_BYTES));
    expect(r.sps).toHaveLength(1);
    expect(Array.from(r.sps[0])).toEqual(Array.from(SPS_BYTES));
    expect(r.pps).toHaveLength(1);
    expect(Array.from(r.pps[0])).toEqual(Array.from(PPS_BYTES));
    expect(r.isKey).toBe(true);
    expect(Array.from(r.chunk)).toEqual([
      0,
      0,
      0,
      idr.length,
      ...Array.from(idr),
    ]);
  });

  it("passes through delta frames without parameter sets", () => {
    const slice = nalu(1, [0x10, 0x20]);
    const r = extractParameterSetsAndChunk(hvcc(slice));
    expect(r.vps).toEqual([]);
    expect(r.sps).toEqual([]);
    expect(r.pps).toEqual([]);
    expect(r.isKey).toBe(false);
    expect(Array.from(r.chunk)).toEqual([
      0,
      0,
      0,
      slice.length,
      ...Array.from(slice),
    ]);
  });

  it("preserves picture-NALU order even if parameter sets are interleaved", () => {
    const sei = nalu(NALU_TYPE_PREFIX_SEI, [0x99]);
    const idr = nalu(NALU_TYPE_IDR_W_RADL, [0xff, 0xff]);
    const r = extractParameterSetsAndChunk(
      hvcc(sei, VPS_BYTES, SPS_BYTES, PPS_BYTES, idr),
    );
    expect(r.isKey).toBe(true);
    expect(Array.from(r.chunk)).toEqual([
      0,
      0,
      0,
      sei.length,
      ...Array.from(sei),
      0,
      0,
      0,
      idr.length,
      ...Array.from(idr),
    ]);
  });

  it("returns an empty chunk for parameter-set-only payloads", () => {
    const r = extractParameterSetsAndChunk(
      hvcc(VPS_BYTES, SPS_BYTES, PPS_BYTES),
    );
    expect(r.chunk).toHaveLength(0);
    expect(r.isKey).toBe(false);
  });
});

describe("buildHevcDecoderConfigDescription", () => {
  it("produces a valid HEVCDecoderConfigurationRecord", () => {
    const out = buildHevcDecoderConfigDescription(
      [VPS_BYTES],
      [SPS_BYTES],
      [PPS_BYTES],
    );
    let off = 0;
    expect(out[off++]).toBe(1); // configurationVersion
    expect(out[off++]).toBe(PTL_BYTES[0]); // profile_space|tier|profile_idc
    expect(Array.from(out.slice(off, off + 4))).toEqual(PTL_BYTES.slice(1, 5));
    off += 4;
    expect(Array.from(out.slice(off, off + 6))).toEqual(PTL_BYTES.slice(5, 11));
    off += 6;
    expect(out[off++]).toBe(PTL_BYTES[11]); // level_idc
    expect(out[off++]).toBe(0xf0); // reserved | min_spatial_segmentation_idc high
    expect(out[off++]).toBe(0x00); // min_spatial_segmentation_idc low
    expect(out[off++]).toBe(0xfc); // reserved | parallelismType
    expect(out[off++]).toBe(0xfd); // reserved | chromaFormat (4:2:0)
    expect(out[off++]).toBe(0xf8); // reserved | bitDepthLumaMinus8
    expect(out[off++]).toBe(0xf8); // reserved | bitDepthChromaMinus8
    expect(out[off++]).toBe(0x00); // avgFrameRate hi
    expect(out[off++]).toBe(0x00); // avgFrameRate lo
    expect(out[off++]).toBe(0x0b); // constantFrameRate|numTemporalLayers|temporalIdNested|lengthSizeMinusOne
    expect(out[off++]).toBe(3); // numOfArrays

    // VPS array
    expect(out[off++]).toBe(0x80 | NALU_TYPE_VPS);
    expect((out[off] << 8) | out[off + 1]).toBe(1);
    off += 2;
    expect((out[off] << 8) | out[off + 1]).toBe(VPS_BYTES.length);
    off += 2;
    expect(Array.from(out.slice(off, off + VPS_BYTES.length))).toEqual(
      Array.from(VPS_BYTES),
    );
    off += VPS_BYTES.length;

    // SPS array
    expect(out[off++]).toBe(0x80 | NALU_TYPE_SPS);
    expect((out[off] << 8) | out[off + 1]).toBe(1);
    off += 2;
    expect((out[off] << 8) | out[off + 1]).toBe(SPS_BYTES.length);
    off += 2;
    expect(Array.from(out.slice(off, off + SPS_BYTES.length))).toEqual(
      Array.from(SPS_BYTES),
    );
    off += SPS_BYTES.length;

    // PPS array
    expect(out[off++]).toBe(0x80 | NALU_TYPE_PPS);
    expect((out[off] << 8) | out[off + 1]).toBe(1);
    off += 2;
    expect((out[off] << 8) | out[off + 1]).toBe(PPS_BYTES.length);
    off += 2;
    expect(Array.from(out.slice(off, off + PPS_BYTES.length))).toEqual(
      Array.from(PPS_BYTES),
    );
    off += PPS_BYTES.length;

    expect(off).toBe(out.length);
  });

  it("handles emulation-prevention bytes in the SPS PTL region", () => {
    // PTL_BYTES has 00 00 90 at indices 3..5 (compat[2..3] + constraint[0]).
    // In the bitstream that's escaped to 00 00 03 90 — the decoder must
    // strip the 0x03 so the recovered PTL matches the original 12 bytes.
    // PTL[3..4] sit at SPS indices 6..7; the 0x03 is inserted before SPS[8].
    const sps = new Uint8Array([
      ...SPS_BYTES.subarray(0, 8), // through PTL[4] = 0x00
      0x03, // emulation prevention byte
      ...SPS_BYTES.subarray(8), // PTL[5]=0x90 onwards
    ]);
    const out = buildHevcDecoderConfigDescription(
      [VPS_BYTES],
      [sps],
      [PPS_BYTES],
    );
    expect(out[1]).toBe(PTL_BYTES[0]); // profile byte preserved
    // profile_compatibility_flags (4 bytes after profile byte)
    expect(Array.from(out.slice(2, 6))).toEqual(PTL_BYTES.slice(1, 5));
    // constraint_indicator_flags (6 bytes) — first 3 of which include the
    // stripped 0x00 0x00 (originally 0x00 0x00 03 90 in the bitstream).
    expect(Array.from(out.slice(6, 12))).toEqual(PTL_BYTES.slice(5, 11));
    expect(out[12]).toBe(PTL_BYTES[11]); // level_idc preserved
  });

  it("throws when a parameter-set list is empty", () => {
    expect(() =>
      buildHevcDecoderConfigDescription([], [SPS_BYTES], [PPS_BYTES]),
    ).toThrow(HevcParseError);
    expect(() =>
      buildHevcDecoderConfigDescription([VPS_BYTES], [], [PPS_BYTES]),
    ).toThrow(HevcParseError);
    expect(() =>
      buildHevcDecoderConfigDescription([VPS_BYTES], [SPS_BYTES], []),
    ).toThrow(HevcParseError);
  });

  it("throws when the SPS is too short to read profile_tier_level", () => {
    const shortSps = new Uint8Array([0x42, 0x01, 0x00, 0x00]);
    expect(() =>
      buildHevcDecoderConfigDescription([VPS_BYTES], [shortSps], [PPS_BYTES]),
    ).toThrow(HevcParseError);
  });
});
