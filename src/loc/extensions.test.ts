import {
  LOC_EXT_TIMESTAMP,
  LocExtensionParseError,
  getLocCaptureTimestampUs,
  parseMoqExtensions,
  readQuicVarint,
} from "./extensions";

// Helper: build a QUIC varint of the smallest size that fits `value`.
function quicVarint(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new Error("negative varint");
  }
  if (value <= 0x3fn) {
    return new Uint8Array([Number(value)]);
  }
  if (value <= 0x3fffn) {
    const buf = new Uint8Array(2);
    buf[0] = 0x40 | Number((value >> 8n) & 0x3fn);
    buf[1] = Number(value & 0xffn);
    return buf;
  }
  if (value <= 0x3fffffffn) {
    const buf = new Uint8Array(4);
    buf[0] = 0x80 | Number((value >> 24n) & 0x3fn);
    buf[1] = Number((value >> 16n) & 0xffn);
    buf[2] = Number((value >> 8n) & 0xffn);
    buf[3] = Number(value & 0xffn);
    return buf;
  }
  if (value <= 0x3fffffffffffffffn) {
    const buf = new Uint8Array(8);
    buf[0] = 0xc0 | Number((value >> 56n) & 0x3fn);
    for (let i = 1; i < 8; i++) {
      buf[i] = Number((value >> BigInt((7 - i) * 8)) & 0xffn);
    }
    return buf;
  }
  throw new Error("value too large for QUIC varint");
}

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

describe("readQuicVarint", () => {
  it("reads a 1-byte varint", () => {
    const r = readQuicVarint(new Uint8Array([0x06]), 0);
    expect(r).toEqual({ value: 6n, bytesRead: 1 });
  });

  it("reads a 2-byte varint", () => {
    // value 0x40 (= 64) requires the 2-byte form since it overflows 6 bits.
    const r = readQuicVarint(quicVarint(64n), 0);
    expect(r).toEqual({ value: 64n, bytesRead: 2 });
  });

  it("reads a 4-byte varint", () => {
    const r = readQuicVarint(quicVarint(1_000_000n), 0);
    expect(r).toEqual({ value: 1_000_000n, bytesRead: 4 });
  });

  it("reads an 8-byte varint", () => {
    // 1_700_000_000_000_000 µs (~ 2023-11-14) overflows 30 bits → 8-byte form.
    const ts = 1_700_000_000_000_000n;
    const r = readQuicVarint(quicVarint(ts), 0);
    expect(r).toEqual({ value: ts, bytesRead: 8 });
  });

  it("reads at a non-zero offset", () => {
    const buf = concat(new Uint8Array([0xde, 0xad]), quicVarint(42n));
    const r = readQuicVarint(buf, 2);
    expect(r).toEqual({ value: 42n, bytesRead: 1 });
  });

  it("throws when the buffer is empty", () => {
    expect(() => readQuicVarint(new Uint8Array(), 0)).toThrow(
      LocExtensionParseError,
    );
  });

  it("throws when a multi-byte varint runs past the end", () => {
    // First byte signals 4-byte size but only 2 bytes are available.
    expect(() => readQuicVarint(new Uint8Array([0x80, 0x00]), 0)).toThrow(
      LocExtensionParseError,
    );
  });
});

describe("parseMoqExtensions", () => {
  it("returns an empty list for undefined or empty input", () => {
    expect(parseMoqExtensions(undefined)).toEqual([]);
    expect(parseMoqExtensions(new Uint8Array())).toEqual([]);
  });

  it("parses a single even-typed (ValueVarInt) KVP", () => {
    const blob = concat(quicVarint(LOC_EXT_TIMESTAMP), quicVarint(123_456n));
    expect(parseMoqExtensions(blob)).toEqual([
      { type: LOC_EXT_TIMESTAMP, valueVarInt: 123_456n },
    ]);
  });

  it("parses a single odd-typed (ValueBytes) KVP", () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const blob = concat(
      quicVarint(0x07n),
      quicVarint(BigInt(payload.length)),
      payload,
    );
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
    const blob = concat(
      // even type 0x06 → varint
      quicVarint(LOC_EXT_TIMESTAMP),
      quicVarint(ts),
      // odd type 0x07 → length-prefixed bytes
      quicVarint(0x07n),
      quicVarint(BigInt(bytes.length)),
      bytes,
      // even type 0x08 → varint
      quicVarint(0x08n),
      quicVarint(0n),
    );
    const out = parseMoqExtensions(blob);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ type: LOC_EXT_TIMESTAMP, valueVarInt: ts });
    expect(out[1].type).toBe(0x07n);
    const valueBytes = out[1].valueBytes;
    expect(valueBytes).toBeDefined();
    expect(Array.from(valueBytes as Uint8Array)).toEqual([0xaa, 0xbb]);
    expect(out[2]).toEqual({ type: 0x08n, valueVarInt: 0n });
  });

  it("throws when a length-prefixed value runs past the end", () => {
    // type 0x07 (odd), claimed length 4, but only 2 bytes follow.
    const blob = concat(
      quicVarint(0x07n),
      quicVarint(4n),
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
    const blob = concat(quicVarint(0x08n), quicVarint(0n));
    expect(getLocCaptureTimestampUs(blob)).toBeNull();
  });

  it("returns the timestamp from a single-KVP blob", () => {
    const ts = 1_759_924_158_381_000n;
    const blob = concat(quicVarint(LOC_EXT_TIMESTAMP), quicVarint(ts));
    expect(getLocCaptureTimestampUs(blob)).toBe(ts);
  });

  it("returns the timestamp when other KVPs precede it", () => {
    const ts = 1_700_000_000_000_001n;
    const blob = concat(
      quicVarint(0x08n),
      quicVarint(99n),
      quicVarint(LOC_EXT_TIMESTAMP),
      quicVarint(ts),
    );
    expect(getLocCaptureTimestampUs(blob)).toBe(ts);
  });

  it("matches a hand-encoded blob equivalent to mlmpub output", () => {
    // mlmpub writes a single KVP: type 0x06 (1 byte), value=µs (8-byte varint
    // for any timestamp past Nov 2023). Verify the exact byte layout we expect
    // to receive on the wire.
    const ts = 1_759_924_158_381_000n;
    const expected = new Uint8Array([
      0x06,
      0xc0 | Number((ts >> 56n) & 0x3fn),
      Number((ts >> 48n) & 0xffn),
      Number((ts >> 40n) & 0xffn),
      Number((ts >> 32n) & 0xffn),
      Number((ts >> 24n) & 0xffn),
      Number((ts >> 16n) & 0xffn),
      Number((ts >> 8n) & 0xffn),
      Number(ts & 0xffn),
    ]);
    expect(getLocCaptureTimestampUs(expected)).toBe(ts);
  });
});
