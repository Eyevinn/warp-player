/**
 * Tests for the MOQT vi64 codec (draft-ietf-moq-transport-18 §1.4.1)
 * and the LOCMAF zigzag signed mapping. The example vectors are Table 2
 * of the draft, matching the Go reference tests in locmaf/vi64.
 */

import {
  VI64_MAX_LEN,
  encodeVi64,
  encodeZigzagVi64,
  readVi64,
  readZigzagVi64,
  vi64Len,
} from "./vi64";

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

/** Table 2 of draft-ietf-moq-transport-18, Section 1.4.1. */
const draftExamples: { enc: number[]; value: bigint; minimal: boolean }[] = [
  { enc: [0x25], value: 37n, minimal: true },
  { enc: [0x80, 0x25], value: 37n, minimal: false },
  { enc: [0xbb, 0xbd], value: 15293n, minimal: true },
  { enc: [0xed, 0x7f, 0x3e, 0x7d], value: 226442877n, minimal: true },
  {
    enc: [0xfa, 0xa1, 0xa0, 0xe4, 0x03, 0xd8],
    value: 2893212287960n,
    minimal: true,
  },
  {
    enc: [0xfc, 0x89, 0x98, 0xab, 0xc6, 0x6b, 0xc0],
    value: 151288809941952n,
    minimal: true,
  },
  {
    enc: [0xfe, 0xfa, 0x31, 0x8f, 0xa8, 0xe3, 0xca, 0x11],
    value: 70423237261249041n,
    minimal: true,
  },
  {
    enc: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    value: U64_MAX,
    minimal: true,
  },
];

describe("draft-18 Table 2 examples", () => {
  for (const { enc, value, minimal } of draftExamples) {
    const hex = enc.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    it(`parses ${hex} as ${value}`, () => {
      const got = readVi64(new Uint8Array(enc), 0);
      expect(got.value).toBe(value);
      expect(got.bytesRead).toBe(enc.length);
    });
    if (minimal) {
      it(`encodes ${value} as ${hex}`, () => {
        expect(Array.from(encodeVi64(value))).toEqual(enc);
        expect(vi64Len(value)).toBe(enc.length);
      });
    }
  }
});

describe("length boundaries", () => {
  // Largest value of each form; the next value needs one more byte.
  // Diverges from RFC 9000: 64..127 are one byte, and >= 2^62 encodes.
  const boundaries: [bigint, number][] = [
    [(1n << 7n) - 1n, 1],
    [(1n << 14n) - 1n, 2],
    [(1n << 21n) - 1n, 3],
    [(1n << 28n) - 1n, 4],
    [(1n << 35n) - 1n, 5],
    [(1n << 42n) - 1n, 6],
    [(1n << 49n) - 1n, 7],
    [(1n << 56n) - 1n, 8],
  ];

  it("steps up in length exactly at each boundary", () => {
    for (const [below, size] of boundaries) {
      expect(vi64Len(below)).toBe(size);
      expect(vi64Len(below + 1n)).toBe(size + 1);
    }
    expect(vi64Len(0n)).toBe(1);
    expect(vi64Len(63n)).toBe(1);
    expect(vi64Len(64n)).toBe(1);
    expect(vi64Len((1n << 62n) - 1n)).toBe(9);
    expect(vi64Len(1n << 62n)).toBe(9);
    expect(vi64Len(U64_MAX)).toBe(9);
  });

  it("round-trips values around every power of two", () => {
    const values: bigint[] = [];
    for (let shift = 0n; shift < 64n; shift++) {
      const v = 1n << shift;
      values.push(v - 1n, v, v + 1n);
    }
    values.push(U64_MAX);
    for (const v of values) {
      const enc = encodeVi64(v);
      expect(enc.length).toBe(vi64Len(v));
      const got = readVi64(enc, 0);
      expect(got.value).toBe(v);
      expect(got.bytesRead).toBe(enc.length);
    }
  });

  it("parses at a non-zero offset", () => {
    const enc = new Uint8Array([0x00, 0x00, 0xbb, 0xbd, 0x25]);
    expect(readVi64(enc, 2)).toEqual({ value: 15293n, bytesRead: 2 });
    expect(readVi64(enc, 4)).toEqual({ value: 37n, bytesRead: 1 });
  });
});

describe("non-minimal encodings", () => {
  it("accepts value 1 widened to every length, but encodes 1 byte", () => {
    for (let n = 2; n <= VI64_MAX_LEN; n++) {
      const enc = new Uint8Array(n);
      enc[0] = n === 9 ? 0xff : (0xff << (9 - n)) & 0xff;
      enc[n - 1] = 0x01;
      expect(readVi64(enc, 0)).toEqual({ value: 1n, bytesRead: n });
    }
    expect(Array.from(encodeVi64(1n))).toEqual([0x01]);
  });
});

describe("truncation and range errors", () => {
  const truncated: number[][] = [
    [],
    [0x80],
    [0xc0, 0x00],
    [0xfe, 0x01, 0x02],
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  ];

  it("throws RangeError on truncated input", () => {
    for (const enc of truncated) {
      expect(() => readVi64(new Uint8Array(enc), 0)).toThrow(RangeError);
      expect(() => readZigzagVi64(new Uint8Array(enc), 0)).toThrow(RangeError);
    }
  });

  it("throws RangeError when offset is past the end", () => {
    expect(() => readVi64(new Uint8Array([0x25]), 1)).toThrow(RangeError);
  });

  it("throws RangeError on out-of-range encode values", () => {
    expect(() => encodeVi64(-1n)).toThrow(RangeError);
    expect(() => encodeVi64(U64_MAX + 1n)).toThrow(RangeError);
    expect(() => vi64Len(-1n)).toThrow(RangeError);
    expect(() => vi64Len(U64_MAX + 1n)).toThrow(RangeError);
    expect(() => encodeZigzagVi64(I64_MIN - 1n)).toThrow(RangeError);
    expect(() => encodeZigzagVi64(I64_MAX + 1n)).toThrow(RangeError);
  });
});

describe("zigzag", () => {
  // Mapping table from the LOCMAF draft's zigzag section.
  const mapping: [bigint, bigint][] = [
    [0n, 0n],
    [-1n, 1n],
    [1n, 2n],
    [-2n, 3n],
    [2n, 4n],
    [-3n, 5n],
    [3n, 6n],
    [I64_MAX, U64_MAX - 1n],
    [I64_MIN, U64_MAX],
  ];

  it("pins the draft mapping table", () => {
    for (const [n, z] of mapping) {
      expect(Array.from(encodeZigzagVi64(n))).toEqual(
        Array.from(encodeVi64(z)),
      );
      const got = readZigzagVi64(encodeVi64(z), 0);
      expect(got.value).toBe(n);
    }
  });

  it("round-trips values around every power of two, both signs", () => {
    const values: bigint[] = [I64_MIN, I64_MAX];
    for (let shift = 0n; shift < 63n; shift++) {
      const v = 1n << shift;
      values.push(v - 1n, v, v + 1n, -v, -v - 1n, -v + 1n);
    }
    for (const n of values) {
      const enc = encodeZigzagVi64(n);
      const got = readZigzagVi64(enc, 0);
      expect(got.value).toBe(n);
      expect(got.bytesRead).toBe(enc.length);
    }
  });

  it("gives small magnitudes of either sign the 1-byte form", () => {
    for (let n = -64n; n <= 63n; n++) {
      expect(encodeZigzagVi64(n).length).toBe(1);
    }
    expect(Array.from(encodeZigzagVi64(-1n))).toEqual([0x01]);
    expect(Array.from(encodeZigzagVi64(64n))).toEqual([0x80, 0x80]);
  });
});
