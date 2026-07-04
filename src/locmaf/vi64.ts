/**
 * MOQT vi64 variable-length integer codec
 * (draft-ietf-moq-transport-18 §1.4.1).
 *
 * Not the RFC 9000 QUIC varint: the number of leading 1 bits in the
 * first byte gives the number of continuation bytes (0–8), and the
 * remaining bits of the first byte plus the continuation bytes form
 * the value in network byte order. The 9-byte form (first byte 0xFF)
 * carries a full 64-bit value in the following 8 bytes.
 *
 * Non-minimal encodings are valid on parse; encoding always produces
 * the shortest form. Values are bigint to cover the full uint64 range.
 *
 * The zigzag variants map signed integers per the LOCMAF draft:
 * z = (n << 1) ^ (n >> 63) (arithmetic shift), n = (z >> 1) ^ -(z & 1),
 * so 0, -1, 1, -2, 2, ... encode as 0, 1, 2, 3, 4, ....
 */

/** Maximum encoded length of a vi64 in bytes. */
export const VI64_MAX_LEN = 9;

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export interface Vi64Read {
  value: bigint;
  bytesRead: number;
}

/**
 * Parse one vi64 at offset. Accepts non-minimal encodings. Throws
 * RangeError if the input ends before or inside the value.
 */
export function readVi64(bytes: Uint8Array, offset: number): Vi64Read {
  if (offset >= bytes.length) {
    throw new RangeError("vi64: unexpected end of input");
  }
  const first = bytes[offset];
  // Length = leading 1 bits of the first byte + 1 (0xFF => 9 bytes).
  let n = 1;
  while (n <= 8 && (first & (0x100 >> n)) !== 0) {
    n++;
  }
  if (offset + n > bytes.length) {
    throw new RangeError("vi64: unexpected end of input");
  }
  // Value bits of the first byte; none remain in the 9-byte form.
  let value = BigInt(n === 9 ? 0 : first & (0xff >> n));
  for (let i = 1; i < n; i++) {
    value = (value << 8n) | BigInt(bytes[offset + i]);
  }
  return { value, bytesRead: n };
}

/** Parse one zigzag vi64 at offset (signed). */
export function readZigzagVi64(bytes: Uint8Array, offset: number): Vi64Read {
  const { value, bytesRead } = readVi64(bytes, offset);
  return { value: unzigzag(value), bytesRead };
}

/** Byte length (1 to 9) of the shortest encoding of value. */
export function vi64Len(value: bigint): number {
  checkUnsignedRange(value);
  for (let n = 1; n < 9; n++) {
    if (value < 1n << BigInt(7 * n)) {
      return n;
    }
  }
  return 9;
}

/**
 * Encode value in its shortest vi64 form. Throws RangeError on
 * negative values or values above 2^64-1.
 */
export function encodeVi64(value: bigint): Uint8Array {
  const n = vi64Len(value);
  const out = new Uint8Array(n);
  // n-1 leading 1 bits, then a 0 bit (all 8 bits set for n = 9).
  const prefix = (0xff << (9 - n)) & 0xff;
  out[0] = prefix | Number((value >> BigInt(8 * (n - 1))) & 0xffn);
  for (let i = 1; i < n; i++) {
    out[i] = Number((value >> BigInt(8 * (n - 1 - i))) & 0xffn);
  }
  return out;
}

/** Encode a signed value (int64 range) as zigzag vi64, shortest form. */
export function encodeZigzagVi64(value: bigint): Uint8Array {
  if (value < I64_MIN || value > I64_MAX) {
    throw new RangeError(`vi64: zigzag value out of int64 range: ${value}`);
  }
  return encodeVi64(zigzag(value));
}

/** z = (n << 1) ^ (n >> 63), reduced to uint64. */
function zigzag(n: bigint): bigint {
  return BigInt.asUintN(64, (n << 1n) ^ (n >> 63n));
}

/** n = (z >> 1) ^ -(z & 1). */
function unzigzag(z: bigint): bigint {
  return (z >> 1n) ^ -(z & 1n);
}

function checkUnsignedRange(value: bigint): void {
  if (value < 0n || value > U64_MAX) {
    throw new RangeError(`vi64: value out of uint64 range: ${value}`);
  }
}
