/**
 * Test-only helpers that build LOCMAF v0.2 wire bytes from structured inputs.
 *
 * Lives under `src/` so Jest can import it via the same ts-jest pipeline as
 * the production decoder.
 */

const MAX_QUIC_VARINT = (1n << 62n) - 1n;

export function encodeVarint(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_QUIC_VARINT) {
    throw new Error(`varint out of range: ${value}`);
  }
  if (value < 64n) {
    return Uint8Array.of(Number(value));
  }
  if (value < 16384n) {
    return Uint8Array.of(
      Number(((value >> 8n) & 0x3fn) | 0x40n),
      Number(value & 0xffn),
    );
  }
  if (value < 1073741824n) {
    return Uint8Array.of(
      Number(((value >> 24n) & 0x3fn) | 0x80n),
      Number((value >> 16n) & 0xffn),
      Number((value >> 8n) & 0xffn),
      Number(value & 0xffn),
    );
  }
  return Uint8Array.of(
    Number(((value >> 56n) & 0x3fn) | 0xc0n),
    Number((value >> 48n) & 0xffn),
    Number((value >> 40n) & 0xffn),
    Number((value >> 32n) & 0xffn),
    Number((value >> 24n) & 0xffn),
    Number((value >> 16n) & 0xffn),
    Number((value >> 8n) & 0xffn),
    Number(value & 0xffn),
  );
}

export function zigzag(n: bigint): bigint {
  return (n << 1n) ^ (n >> 63n);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** Pack a (non_sync, depends_on, is_depended_on) triple into the 5-bit transport. */
export function packSampleFlags(
  nonSync: number,
  dependsOn: number,
  isDependedOn: number,
): bigint {
  return (
    BigInt(nonSync & 0x1) |
    (BigInt(dependsOn & 0x3) << 1n) |
    (BigInt(isDependedOn & 0x3) << 3n)
  );
}

export interface FieldEntry {
  fieldId: number;
  /** Even (scalar) value, raw varint encoded as-is. Either absolute or zigzag — caller decides. */
  scalar?: bigint;
  /** Odd (list) values, each varint encoded as-is (absolute or zigzag — caller decides). */
  list?: bigint[];
  /** Odd (raw bytes) value. */
  raw?: Uint8Array;
}

/**
 * Build a property block from a list of entries IN THE ORDER PROVIDED.
 *
 * Each entry must supply exactly one of {scalar, list, raw}. The caller is
 * responsible for choosing absolute vs zigzag encoding per the chunk kind.
 */
export function buildProperties(entries: FieldEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    parts.push(encodeVarint(BigInt(e.fieldId)));
    if (e.scalar !== undefined) {
      parts.push(encodeVarint(e.scalar));
    } else if (e.list !== undefined) {
      const listBytes = concatBytes(...e.list.map(encodeVarint));
      parts.push(encodeVarint(BigInt(listBytes.byteLength)));
      parts.push(listBytes);
    } else if (e.raw !== undefined) {
      parts.push(encodeVarint(BigInt(e.raw.byteLength)));
      parts.push(e.raw);
    } else {
      throw new Error(`field ${e.fieldId} has no value`);
    }
  }
  return concatBytes(...parts);
}

export function buildLocmafV02Object(
  headerId: number,
  properties: Uint8Array,
  mdatPayload: Uint8Array,
): Uint8Array {
  const header = encodeVarint(BigInt(headerId));
  const propLen = encodeVarint(BigInt(properties.byteLength));
  return concatBytes(header, propLen, properties, mdatPayload);
}
