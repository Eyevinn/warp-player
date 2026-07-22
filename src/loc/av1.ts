// AV1 helpers for the LOC payload path.
//
// LOC AV1 objects are raw AV1 temporal units: a sequence of self-delimiting
// OBUs (obu_has_size_field == 1, LEB128 obu_size) — exactly the bytes of the
// underlying fMP4 sample. Unlike AVC/HEVC there is NO 4-byte length prefix and
// NO Annex-B start code, and the decoder configuration (the sequence-header
// OBU) is not sent out of band: mlmpub leaves it in-band on each keyframe
// temporal unit (SVT-AV1 / ffmpeg repeat it there). So the whole object
// payload is fed to the VideoDecoder unchanged and VideoDecoderConfig needs no
// `description`.
//
// References:
//   - AV1 Bitstream & Decoding Process Specification §5.3.2 (obu_header),
//     §4.10.5 (leb128)
//   - AV1 Codec ISO Media File Format Binding §2.3 (a sample is an OBU
//     temporal unit with no temporal-delimiter OBU)
//   - WebCodecs AV1 registration: EncodedVideoChunk data is the AV1
//     "low-overhead bitstream" temporal unit
//   - moqlivemock/internal/media.go (AV1Data) for the wire layout we consume

export const OBU_SEQUENCE_HEADER = 1;
export const OBU_TEMPORAL_DELIMITER = 2;
export const OBU_FRAME_HEADER = 3;
export const OBU_TILE_GROUP = 4;
export const OBU_METADATA = 5;
export const OBU_FRAME = 6;
export const OBU_REDUNDANT_FRAME_HEADER = 7;
export const OBU_TILE_LIST = 8;
export const OBU_PADDING = 15;

export interface ObuView {
  /** obu_type (bits 6..3 of the first header byte). */
  type: number;
  /** The full OBU including its header, size field, and payload. */
  data: Uint8Array;
}

export class Av1ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Av1ParseError";
  }
}

interface Leb128 {
  value: number;
  nextOffset: number;
}

/**
 * Read an unsigned LEB128 value (AV1 §4.10.5). At most 8 bytes; each byte
 * contributes 7 low bits, high bit is the continuation flag. Multiplication
 * (rather than `<<`) is used for accumulation so shifts beyond 31 bits don't
 * wrap under JavaScript's 32-bit bitwise operators.
 */
function readLeb128(buf: Uint8Array, offset: number): Leb128 {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    if (offset >= buf.length) {
      throw new Av1ParseError(`truncated LEB128 at offset ${offset}`);
    }
    const byte = buf[offset++];
    value += (byte & 0x7f) * 2 ** (i * 7);
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: offset };
    }
  }
  throw new Av1ParseError("LEB128 value not terminated within 8 bytes");
}

/**
 * Split an AV1 temporal unit into its OBUs. Each OBU carries a 1- or 2-byte
 * header; when obu_has_size_field is set (always, for the low-overhead
 * bitstream mlmpub emits) it is followed by an LEB128 obu_size and that many
 * payload bytes. A trailing OBU with obu_has_size_field == 0 (permitted only
 * as the final OBU) is taken to run to the end of the buffer. Empty payload
 * yields an empty array.
 */
export function walkObus(payload: Uint8Array): ObuView[] {
  const result: ObuView[] = [];
  let offset = 0;
  while (offset < payload.length) {
    const start = offset;
    const b0 = payload[offset];
    if ((b0 & 0x80) !== 0) {
      throw new Av1ParseError(`obu_forbidden_bit set at offset ${offset}`);
    }
    const type = (b0 >> 3) & 0x0f;
    const hasExtension = (b0 & 0x04) !== 0;
    const hasSizeField = (b0 & 0x02) !== 0;
    offset += 1;
    if (hasExtension) {
      if (offset >= payload.length) {
        throw new Av1ParseError(
          `truncated OBU extension header at offset ${offset}`,
        );
      }
      offset += 1;
    }
    let obuSize: number;
    if (hasSizeField) {
      const leb = readLeb128(payload, offset);
      obuSize = leb.value;
      offset = leb.nextOffset;
    } else {
      // Only valid as the final OBU: it runs to the end of the buffer.
      obuSize = payload.length - offset;
    }
    if (offset + obuSize > payload.length) {
      throw new Av1ParseError(
        `OBU of size ${obuSize} extends past end (offset ${offset}, payload ${payload.length})`,
      );
    }
    offset += obuSize;
    result.push({ type, data: payload.subarray(start, offset) });
  }
  return result;
}

/**
 * True when the temporal unit carries a sequence-header OBU. mlmpub emits the
 * sequence header only on keyframe temporal units (SVT-AV1 low-delay CBR, I/P
 * only), mirroring how the publisher itself detects AV1 sync samples
 * (moqlivemock/internal/media.go keyframeHasAV1SeqHeader). A keyframe is
 * randomly accessible precisely because the sequence header travels with it,
 * so a sequence-header OBU is a reliable keyframe marker for this content.
 */
export function payloadIsKey(payload: Uint8Array): boolean {
  for (const obu of walkObus(payload)) {
    if (obu.type === OBU_SEQUENCE_HEADER) {
      return true;
    }
  }
  return false;
}

/**
 * Return the concatenated sequence-header OBU(s) in the temporal unit, or an
 * empty array if none are present. Used to detect a sequence-header change
 * (e.g. a rendition/resolution switch) so the decoder can be reconfigured.
 */
export function extractSequenceHeaderObu(payload: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const obu of walkObus(payload)) {
    if (obu.type === OBU_SEQUENCE_HEADER) {
      parts.push(obu.data);
    }
  }
  if (parts.length === 0) {
    return new Uint8Array(0);
  }
  if (parts.length === 1) {
    return new Uint8Array(parts[0]);
  }
  let total = 0;
  for (const p of parts) {
    total += p.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
