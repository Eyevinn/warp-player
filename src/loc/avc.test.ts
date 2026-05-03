import {
  AvcParseError,
  NALU_TYPE_IDR_SLICE,
  NALU_TYPE_NON_IDR_SLICE,
  NALU_TYPE_PPS,
  NALU_TYPE_SEI,
  NALU_TYPE_SPS,
  buildAvcDecoderConfigDescription,
  extractParameterSetsAndChunk,
  payloadIsKey,
  walkAvccNalus,
} from "./avc";

// Build a length-prefixed NALU stream from raw NALU bodies.
function avcc(...nalus: Uint8Array[]): Uint8Array {
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

// Construct a NALU with a given type and arbitrary payload bytes.
function nalu(type: number, body: number[] = []): Uint8Array {
  return new Uint8Array([type & 0x1f, ...body]);
}

// Minimal SPS: type byte + 3 bytes profile/compat/level. Real SPSs are
// longer but the AVCDecoderConfigurationRecord builder only reads the first
// four bytes.
const SPS_BYTES = nalu(NALU_TYPE_SPS, [0x42, 0xc0, 0x1f, 0x00, 0x00]);
const PPS_BYTES = nalu(NALU_TYPE_PPS, [0x12, 0x34]);

describe("walkAvccNalus", () => {
  it("returns an empty list for an empty payload", () => {
    expect(walkAvccNalus(new Uint8Array())).toEqual([]);
  });

  it("splits a single NALU", () => {
    const out = walkAvccNalus(avcc(nalu(NALU_TYPE_NON_IDR_SLICE, [1, 2, 3])));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe(NALU_TYPE_NON_IDR_SLICE);
    expect(Array.from(out[0].data)).toEqual([NALU_TYPE_NON_IDR_SLICE, 1, 2, 3]);
  });

  it("splits a stream of multiple NALUs preserving order", () => {
    const out = walkAvccNalus(
      avcc(SPS_BYTES, PPS_BYTES, nalu(NALU_TYPE_IDR_SLICE, [0xff])),
    );
    expect(out.map((n) => n.type)).toEqual([
      NALU_TYPE_SPS,
      NALU_TYPE_PPS,
      NALU_TYPE_IDR_SLICE,
    ]);
  });

  it("throws on a truncated length prefix", () => {
    expect(() => walkAvccNalus(new Uint8Array([0x00, 0x00]))).toThrow(
      AvcParseError,
    );
  });

  it("throws when a NALU runs past the end", () => {
    // Length prefix says 10 bytes but only 2 bytes follow.
    const bad = new Uint8Array([0x00, 0x00, 0x00, 0x0a, 0x67, 0x42]);
    expect(() => walkAvccNalus(bad)).toThrow(AvcParseError);
  });

  it("throws on a zero-length NALU", () => {
    const bad = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
    expect(() => walkAvccNalus(bad)).toThrow(AvcParseError);
  });
});

describe("payloadIsKey", () => {
  it("returns true when an IDR slice is present", () => {
    expect(payloadIsKey(avcc(nalu(NALU_TYPE_IDR_SLICE, [0])))).toBe(true);
    expect(
      payloadIsKey(avcc(SPS_BYTES, PPS_BYTES, nalu(NALU_TYPE_IDR_SLICE))),
    ).toBe(true);
  });

  it("returns false for non-IDR slices only", () => {
    expect(payloadIsKey(avcc(nalu(NALU_TYPE_NON_IDR_SLICE, [0])))).toBe(false);
    expect(payloadIsKey(avcc(SPS_BYTES, PPS_BYTES))).toBe(false);
  });

  it("returns false for empty payload", () => {
    expect(payloadIsKey(new Uint8Array())).toBe(false);
  });
});

describe("extractParameterSetsAndChunk", () => {
  it("separates SPS+PPS at IDR and rebuilds the chunk", () => {
    const idr = nalu(NALU_TYPE_IDR_SLICE, [0xa1, 0xa2, 0xa3]);
    const r = extractParameterSetsAndChunk(avcc(SPS_BYTES, PPS_BYTES, idr));
    expect(r.sps).toHaveLength(1);
    expect(Array.from(r.sps[0])).toEqual(Array.from(SPS_BYTES));
    expect(r.pps).toHaveLength(1);
    expect(Array.from(r.pps[0])).toEqual(Array.from(PPS_BYTES));
    expect(r.isKey).toBe(true);
    // chunk should be exactly the IDR re-wrapped with a 4-byte length prefix.
    expect(Array.from(r.chunk)).toEqual([
      0,
      0,
      0,
      idr.length,
      ...Array.from(idr),
    ]);
  });

  it("passes through delta frames without parameter sets", () => {
    const slice = nalu(NALU_TYPE_NON_IDR_SLICE, [0x10, 0x20]);
    const r = extractParameterSetsAndChunk(avcc(slice));
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
    const sei = nalu(NALU_TYPE_SEI, [0x99]);
    const idr = nalu(NALU_TYPE_IDR_SLICE, [0xff, 0xff]);
    const r = extractParameterSetsAndChunk(
      avcc(sei, SPS_BYTES, PPS_BYTES, idr),
    );
    // Picture NALUs are SEI then IDR, in arrival order.
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
    const r = extractParameterSetsAndChunk(avcc(SPS_BYTES, PPS_BYTES));
    expect(r.chunk).toHaveLength(0);
    expect(r.isKey).toBe(false);
  });
});

describe("buildAvcDecoderConfigDescription", () => {
  it("produces a valid AVCDecoderConfigurationRecord for one SPS + one PPS", () => {
    const out = buildAvcDecoderConfigDescription([SPS_BYTES], [PPS_BYTES]);
    let off = 0;
    expect(out[off++]).toBe(1); // configurationVersion
    expect(out[off++]).toBe(SPS_BYTES[1]); // profile (0x42)
    expect(out[off++]).toBe(SPS_BYTES[2]); // compat  (0xc0)
    expect(out[off++]).toBe(SPS_BYTES[3]); // level   (0x1f)
    expect(out[off++]).toBe(0xff); // reserved | lengthSizeMinusOne=3
    expect(out[off++]).toBe(0xe1); // reserved | numOfSPS=1
    expect((out[off] << 8) | out[off + 1]).toBe(SPS_BYTES.length);
    off += 2;
    expect(Array.from(out.slice(off, off + SPS_BYTES.length))).toEqual(
      Array.from(SPS_BYTES),
    );
    off += SPS_BYTES.length;
    expect(out[off++]).toBe(1); // numOfPPS
    expect((out[off] << 8) | out[off + 1]).toBe(PPS_BYTES.length);
    off += 2;
    expect(Array.from(out.slice(off, off + PPS_BYTES.length))).toEqual(
      Array.from(PPS_BYTES),
    );
    off += PPS_BYTES.length;
    expect(off).toBe(out.length);
  });

  it("encodes multiple SPS and PPS in arrival order", () => {
    const sps2 = nalu(NALU_TYPE_SPS, [0x4d, 0x40, 0x1e, 0x00]);
    const pps2 = nalu(NALU_TYPE_PPS, [0xab]);
    const out = buildAvcDecoderConfigDescription(
      [SPS_BYTES, sps2],
      [PPS_BYTES, pps2],
    );
    expect(out[5]).toBe(0xe2); // numOfSPS=2
    // First SPS still drives profile/compat/level (the spec leaves the others
    // for selection by the decoder).
    expect(out[1]).toBe(SPS_BYTES[1]);
  });

  it("throws when SPS or PPS is missing", () => {
    expect(() => buildAvcDecoderConfigDescription([], [PPS_BYTES])).toThrow(
      AvcParseError,
    );
    expect(() => buildAvcDecoderConfigDescription([SPS_BYTES], [])).toThrow(
      AvcParseError,
    );
  });

  it("throws when the first SPS is too short to read profile/level", () => {
    expect(() =>
      buildAvcDecoderConfigDescription(
        [new Uint8Array([0x67, 0x42])],
        [PPS_BYTES],
      ),
    ).toThrow(AvcParseError);
  });
});
