// LOC (Low Overhead Container) Object Property parsing.
//
// LOC objects carry metadata in MoQ Object Properties -- draft-16 called them
// extension headers -- encoded as a sequence of Key-Value-Pairs that runs to the
// end of the block, with no outer count. The blob is what tracks.ts exposes on
// MOQObject.extensions.
//
// The KVP parity rule selects the value:
//   type % 2 == 0  →  a varint, no length
//   type % 2 == 1  →  a varint length followed by that many bytes
//
// Three things changed with draft-18 and all three break a draft-16 parser:
//
//   - Varints are vi64 (leading-ones), not the RFC 9000 two-bit-prefix form.
//   - Pair *types* are delta-encoded against the preceding type, so they must
//     be accumulated rather than read absolute.
//   - The LOC Timestamp property moved off 0x06. MOQT's Properties registry
//     allocates 0x06 to SUBGROUP_DELIVERY_TIMEOUT, which is Track scope only,
//     so a 0x06 Object Property makes the track malformed from draft-18
//     onwards. draft-ietf-moq-loc-03 renumbered it to 0x0A for that reason and
//     draft-04 moved it again to 0x10, publishing a settled registry table
//     where -03 still carried "IANA, please assign" on its neighbours.

import { ByteReader, readKvpList } from "../transport/wire18";

/** Capture timestamp, microseconds since the Unix epoch (draft-ietf-moq-loc-04). */
export const LOC_EXT_TIMESTAMP = 0x10n;

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
 * Parse an Object Properties blob into KVPs. Returns an empty list when `blob`
 * is undefined or empty. Throws LocExtensionParseError on malformed input.
 */
export function parseMoqExtensions(blob: Uint8Array | undefined): LocKvp[] {
  if (!blob || blob.length === 0) {
    return [];
  }
  try {
    return readKvpList(new ByteReader(blob)).map((kvp) => ({
      type: kvp.type,
      ...(kvp.varint !== undefined && { valueVarInt: kvp.varint }),
      ...(kvp.bytes !== undefined && { valueBytes: kvp.bytes }),
    }));
  } catch (e) {
    throw new LocExtensionParseError(
      e instanceof Error ? e.message : String(e),
    );
  }
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
