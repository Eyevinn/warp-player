// LOC (Low Overhead Container) extension-header parsing.
//
// LOC objects carry metadata in MoQ Object extension headers, which are encoded
// as a sequence of moqtransport KeyValuePairs concatenated without an outer
// count or length. The extensions blob is what tracks.ts exposes on
// MOQObject.extensions.
//
// moqtransport's KVP parity rule (see moqtransport/internal/wire/key_value_pair.go):
//   type % 2 == 0  →  ValueVarInt (single varint, no length)
//   type % 2 == 1  →  ValueBytes  (varint length followed by bytes)
//
// LOC property IDs used by mlmpub today (see moqlivemock/internal/sub/loc.go):
//   0x06  Capture timestamp, microseconds since the Unix epoch (varint).

export const LOC_EXT_TIMESTAMP = 0x06n;

export interface LocKvp {
  type: bigint;
  /** Set for even-typed pairs (ValueVarInt). */
  valueVarInt?: bigint;
  /** Set for odd-typed pairs (ValueBytes). */
  valueBytes?: Uint8Array;
}

export class LocExtensionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocExtensionParseError";
  }
}

/**
 * Read a single QUIC variable-length integer from `buf` at `offset`.
 * Returns the value and the number of bytes consumed.
 */
export function readQuicVarint(
  buf: Uint8Array,
  offset: number,
): { value: bigint; bytesRead: number } {
  if (offset >= buf.length) {
    throw new LocExtensionParseError(
      `varint read out of bounds at offset ${offset}`,
    );
  }
  const first = buf[offset];
  const sizeCode = (first & 0xc0) >> 6;
  const length = 1 << sizeCode;
  if (offset + length > buf.length) {
    throw new LocExtensionParseError(
      `varint of size ${length} extends past end (offset ${offset}, buf ${buf.length})`,
    );
  }
  // Strip the size bits from the first byte and accumulate.
  let value = BigInt(first & 0x3f);
  for (let i = 1; i < length; i++) {
    value = (value << 8n) | BigInt(buf[offset + i]);
  }
  return { value, bytesRead: length };
}

/**
 * Parse a flat extension-headers blob into KVPs. Returns an empty list when
 * `blob` is undefined or empty. Throws LocExtensionParseError on malformed input.
 */
export function parseMoqExtensions(blob: Uint8Array | undefined): LocKvp[] {
  if (!blob || blob.length === 0) {
    return [];
  }
  const result: LocKvp[] = [];
  let offset = 0;
  while (offset < blob.length) {
    const typeRead = readQuicVarint(blob, offset);
    offset += typeRead.bytesRead;
    const type = typeRead.value;

    if ((type & 1n) === 0n) {
      const valueRead = readQuicVarint(blob, offset);
      offset += valueRead.bytesRead;
      result.push({ type, valueVarInt: valueRead.value });
    } else {
      const lenRead = readQuicVarint(blob, offset);
      offset += lenRead.bytesRead;
      const length = Number(lenRead.value);
      if (offset + length > blob.length) {
        throw new LocExtensionParseError(
          `length-prefixed value of ${length} bytes extends past end ` +
            `(offset ${offset}, buf ${blob.length})`,
        );
      }
      const valueBytes = blob.slice(offset, offset + length);
      offset += length;
      result.push({ type, valueBytes });
    }
  }
  return result;
}

/**
 * Convenience: extract the LOC capture timestamp (microseconds since the Unix
 * epoch) from an extension blob. Returns null when no timestamp KVP is present.
 */
export function getLocCaptureTimestampUs(
  blob: Uint8Array | undefined,
): bigint | null {
  for (const kvp of parseMoqExtensions(blob)) {
    if (kvp.type === LOC_EXT_TIMESTAMP && kvp.valueVarInt !== undefined) {
      return kvp.valueVarInt;
    }
  }
  return null;
}
