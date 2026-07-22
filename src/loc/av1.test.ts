import {
  Av1ParseError,
  OBU_FRAME,
  OBU_METADATA,
  OBU_SEQUENCE_HEADER,
  OBU_TEMPORAL_DELIMITER,
  extractSequenceHeaderObu,
  payloadIsKey,
  walkObus,
} from "./av1";

// Encode an unsigned LEB128 value (AV1 §4.10.5).
function leb128(size: number): number[] {
  const bytes: number[] = [];
  let v = size;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) {
      b |= 0x80;
    }
    bytes.push(b);
  } while (v > 0);
  return bytes;
}

// Build a self-delimiting OBU (obu_has_size_field == 1) of the given type.
function obu(
  type: number,
  body: number[] = [],
  opts: { extension?: boolean } = {},
): Uint8Array {
  const extension = opts.extension ?? false;
  // bit7 forbidden=0 | bits6..3 type | bit2 extension_flag | bit1 has_size | bit0 reserved=0
  const first = (type << 3) | (extension ? 0x04 : 0) | 0x02;
  const header = [first];
  if (extension) {
    header.push(0x00); // temporal_id / spatial_id / reserved = 0
  }
  return new Uint8Array([...header, ...leb128(body.length), ...body]);
}

// Build an OBU without a size field (obu_has_size_field == 0) — only valid as
// the final OBU in a temporal unit.
function obuNoSize(type: number, body: number[] = []): Uint8Array {
  const first = type << 3; // has_size_field = 0, no extension
  return new Uint8Array([first, ...body]);
}

// Concatenate OBUs into a temporal unit.
function tu(...obus: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const o of obus) {
    total += o.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const o of obus) {
    out.set(o, off);
    off += o.length;
  }
  return out;
}

describe("walkObus", () => {
  it("returns an empty list for an empty payload", () => {
    expect(walkObus(new Uint8Array())).toEqual([]);
  });

  it("splits a single OBU", () => {
    const out = walkObus(obu(OBU_FRAME, [1, 2, 3]));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe(OBU_FRAME);
    // data includes the header + size byte + body.
    expect(Array.from(out[0].data)).toEqual([
      (OBU_FRAME << 3) | 0x02,
      3,
      1,
      2,
      3,
    ]);
  });

  it("splits a keyframe temporal unit preserving OBU order", () => {
    const out = walkObus(
      tu(obu(OBU_SEQUENCE_HEADER, [0xaa]), obu(OBU_FRAME, [0xbb, 0xcc])),
    );
    expect(out.map((o) => o.type)).toEqual([OBU_SEQUENCE_HEADER, OBU_FRAME]);
  });

  it("parses an OBU carrying the extension header byte", () => {
    const out = walkObus(obu(OBU_FRAME, [0x10, 0x20], { extension: true }));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe(OBU_FRAME);
    // header (1) + extension (1) + leb size (1) + body (2) = 5 bytes.
    expect(out[0].data).toHaveLength(5);
  });

  it("handles a multi-byte LEB128 obu_size", () => {
    const body = new Array(200).fill(0x5a);
    const out = walkObus(obu(OBU_FRAME, body));
    expect(out).toHaveLength(1);
    // 200 needs two LEB128 bytes (0xc8 0x01), so total = 1 + 2 + 200.
    expect(out[0].data).toHaveLength(203);
  });

  it("treats a final OBU with no size field as running to the end", () => {
    const out = walkObus(
      tu(obu(OBU_SEQUENCE_HEADER, [0x01]), obuNoSize(OBU_FRAME, [7, 8, 9, 10])),
    );
    expect(out.map((o) => o.type)).toEqual([OBU_SEQUENCE_HEADER, OBU_FRAME]);
    expect(Array.from(out[1].data)).toEqual([OBU_FRAME << 3, 7, 8, 9, 10]);
  });

  it("throws when the forbidden bit is set", () => {
    expect(() => walkObus(new Uint8Array([0x80]))).toThrow(Av1ParseError);
  });

  it("throws when an OBU size runs past the end", () => {
    // has_size_field OBU claiming 10 bytes but only 2 follow.
    const bad = new Uint8Array([(OBU_FRAME << 3) | 0x02, 10, 0x00, 0x00]);
    expect(() => walkObus(bad)).toThrow(Av1ParseError);
  });

  it("throws on a truncated extension header", () => {
    // extension_flag set but no extension byte present.
    const bad = new Uint8Array([(OBU_FRAME << 3) | 0x04]);
    expect(() => walkObus(bad)).toThrow(Av1ParseError);
  });
});

describe("payloadIsKey", () => {
  it("returns true when a sequence-header OBU is present", () => {
    expect(
      payloadIsKey(tu(obu(OBU_SEQUENCE_HEADER, [0]), obu(OBU_FRAME, [1]))),
    ).toBe(true);
  });

  it("returns false for a delta temporal unit (no sequence header)", () => {
    expect(payloadIsKey(tu(obu(OBU_FRAME, [1, 2, 3])))).toBe(false);
    expect(
      payloadIsKey(tu(obu(OBU_TEMPORAL_DELIMITER), obu(OBU_FRAME, [1]))),
    ).toBe(false);
  });

  it("returns false for an empty payload", () => {
    expect(payloadIsKey(new Uint8Array())).toBe(false);
  });
});

describe("extractSequenceHeaderObu", () => {
  it("returns the sequence-header OBU bytes when present", () => {
    const sh = obu(OBU_SEQUENCE_HEADER, [0x0a, 0x0b]);
    const out = extractSequenceHeaderObu(tu(sh, obu(OBU_FRAME, [0xff])));
    expect(Array.from(out)).toEqual(Array.from(sh));
  });

  it("concatenates multiple sequence-header OBUs", () => {
    const sh1 = obu(OBU_SEQUENCE_HEADER, [0x01]);
    const sh2 = obu(OBU_SEQUENCE_HEADER, [0x02]);
    const out = extractSequenceHeaderObu(tu(sh1, sh2, obu(OBU_FRAME, [0])));
    expect(Array.from(out)).toEqual([...Array.from(sh1), ...Array.from(sh2)]);
  });

  it("returns an empty array when no sequence header is present", () => {
    const out = extractSequenceHeaderObu(
      tu(obu(OBU_METADATA, [0x1]), obu(OBU_FRAME, [0x2])),
    );
    expect(out).toHaveLength(0);
  });
});
