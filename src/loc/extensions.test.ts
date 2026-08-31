import { encodeVi64 } from "../transport/vi64";

import {
  LOC_EXT_TIMESTAMP,
  LocExtensionParseError,
  getLocCaptureTimestampUs,
  parseMoqExtensions,
} from "./extensions";

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Build an Object Properties blob from absolute pair types.
 *
 * draft-18 delta-encodes the types against the preceding one, so a test that
 * wrote them absolute would only pass for a single pair, or for a first pair
 * whose type happens to equal its own delta. Encoding the deltas here is what
 * makes the multi-pair cases meaningful.
 */
function properties(
  pairs: { type: bigint; varint?: bigint; bytes?: Uint8Array }[],
): Uint8Array {
  const parts: Uint8Array[] = [];
  let prev = 0n;
  for (const p of pairs) {
    if (p.type < prev) {
      throw new Error(
        `properties(): types must be non-decreasing, got 0x${p.type.toString(16)} after 0x${prev.toString(16)}`,
      );
    }
    parts.push(encodeVi64(p.type - prev));
    prev = p.type;
    if (p.type % 2n === 1n) {
      const b = p.bytes ?? new Uint8Array();
      parts.push(encodeVi64(BigInt(b.length)), b);
    } else {
      parts.push(encodeVi64(p.varint ?? 0n));
    }
  }
  return concat(...parts);
}

describe("parseMoqExtensions", () => {
  it("returns an empty list for undefined or empty input", () => {
    expect(parseMoqExtensions(undefined)).toEqual([]);
    expect(parseMoqExtensions(new Uint8Array())).toEqual([]);
  });

  it("parses a single even-typed (ValueVarInt) KVP", () => {
    const blob = properties([{ type: LOC_EXT_TIMESTAMP, varint: 123_456n }]);
    expect(parseMoqExtensions(blob)).toEqual([
      { type: LOC_EXT_TIMESTAMP, valueVarInt: 123_456n },
    ]);
  });

  it("parses a single odd-typed (ValueBytes) KVP", () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const blob = properties([{ type: 0x07n, bytes: payload }]);
    const out = parseMoqExtensions(blob);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe(0x07n);
    const valueBytes = out[0].valueBytes;
    expect(valueBytes).toBeDefined();
    expect(Array.from(valueBytes as Uint8Array)).toEqual([1, 2, 3, 4]);
  });

  it("parses a sequence of mixed-parity KVPs", () => {
    const ts = 1_700_000_000_000_000n;
    const bytes = new Uint8Array([0xaa, 0xbb]);
    const blob = properties([
      { type: LOC_EXT_TIMESTAMP, varint: ts },
      { type: 0x11n, bytes },
      { type: 0x12n, varint: 0n },
    ]);
    const out = parseMoqExtensions(blob);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ type: LOC_EXT_TIMESTAMP, valueVarInt: ts });
    expect(out[1].type).toBe(0x11n);
    const valueBytes = out[1].valueBytes;
    expect(valueBytes).toBeDefined();
    expect(Array.from(valueBytes as Uint8Array)).toEqual([0xaa, 0xbb]);
    expect(out[2]).toEqual({ type: 0x12n, valueVarInt: 0n });
  });

  it("accumulates delta-encoded types rather than reading them absolute", () => {
    // Three pairs at 0x0A, 0x0C, 0x0E encode as deltas 0x0A, 0x02, 0x02. A
    // parser that read the types absolute would report 0x0A, 0x02, 0x02.
    const blob = properties([
      { type: 0x0an, varint: 1n },
      { type: 0x0cn, varint: 2n },
      { type: 0x0en, varint: 3n },
    ]);
    expect(parseMoqExtensions(blob).map((k) => k.type)).toEqual([
      0x0an,
      0x0cn,
      0x0en,
    ]);
  });

  it("throws when a length-prefixed value runs past the end", () => {
    // Type 0x07 (odd), claimed length 4, but only 2 bytes follow.
    const blob = concat(
      encodeVi64(0x07n),
      encodeVi64(4n),
      new Uint8Array([0x01, 0x02]),
    );
    expect(() => parseMoqExtensions(blob)).toThrow(LocExtensionParseError);
  });
});

describe("getLocCaptureTimestampUs", () => {
  it("returns null when no extensions are present", () => {
    expect(getLocCaptureTimestampUs(undefined)).toBeNull();
    expect(getLocCaptureTimestampUs(new Uint8Array())).toBeNull();
  });

  it("returns null when the timestamp KVP is absent", () => {
    const blob = properties([{ type: 0x0cn, varint: 0n }]);
    expect(getLocCaptureTimestampUs(blob)).toBeNull();
  });

  it("returns the timestamp from a single-KVP blob", () => {
    const ts = 1_759_924_158_381_000n;
    const blob = properties([{ type: LOC_EXT_TIMESTAMP, varint: ts }]);
    expect(getLocCaptureTimestampUs(blob)).toBe(ts);
  });

  it("returns the timestamp when other KVPs precede it", () => {
    const ts = 1_700_000_000_000_001n;
    const blob = properties([
      { type: 0x02n, varint: 99n },
      { type: LOC_EXT_TIMESTAMP, varint: ts },
    ]);
    expect(getLocCaptureTimestampUs(blob)).toBe(ts);
  });

  it("matches a hand-encoded blob equivalent to mlmpub output", () => {
    // mlmpub writes a single Object Property: type 0x10, value = µs since the
    // epoch. As the first pair its delta is the type itself, and a timestamp
    // past Nov 2023 needs the 8-byte vi64 form. Pinning the exact bytes is what
    // catches a silent codepoint or varint change on the wire -- this property
    // has already moved twice (0x06 -> 0x0A in loc-03, -> 0x10 in loc-04).
    const ts = 1_759_924_158_381_000n;
    const expected = new Uint8Array([
      0x10,
      // 8-byte vi64: first byte 0xFE, then the value's seven low bytes... the
      // form carries 56 value bits, so byte 0 is 0xFE | (ts >> 56) which is
      // zero here, and the remaining seven bytes are the value.
      0xfe,
      Number((ts >> 48n) & 0xffn),
      Number((ts >> 40n) & 0xffn),
      Number((ts >> 32n) & 0xffn),
      Number((ts >> 24n) & 0xffn),
      Number((ts >> 16n) & 0xffn),
      Number((ts >> 8n) & 0xffn),
      Number(ts & 0xffn),
    ]);
    expect(
      Array.from(properties([{ type: LOC_EXT_TIMESTAMP, varint: ts }])),
    ).toEqual(Array.from(expected));
    expect(getLocCaptureTimestampUs(expected)).toBe(ts);
  });
});
