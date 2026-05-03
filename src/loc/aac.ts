// AAC helpers for the LOC payload path.
//
// LOC AAC objects are raw access units (no ADTS, no LATM). To set up a
// WebCodecs `AudioDecoder` we need to synthesize an AudioSpecificConfig from
// catalog metadata and pass it as `AudioDecoderConfig.description`.
//
// References:
//   - ISO/IEC 14496-3 §1.6.2.1 (AudioSpecificConfig)
//   - RFC 6381 §3.3 (mp4a.OO.A codec strings)
//
// mlmpub on feat/loc only emits AAC-LC (mp4a.40.2). The builder still
// supports arbitrary audioObjectType so the same code path covers HE-AAC
// when it shows up later.

export const AAC_OBJECT_TYPE_LC = 2;

export class AacConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AacConfigError";
  }
}

/** Sampling-frequency-index table — ISO/IEC 14496-3 Table 1.16. */
const SAMPLING_FREQUENCY_INDEX: ReadonlyArray<number> = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
];

/** Look up the 4-bit index for a standard AAC sampling frequency, or null. */
export function aacSamplingFrequencyIndex(sampleRate: number): number | null {
  const idx = SAMPLING_FREQUENCY_INDEX.indexOf(sampleRate);
  return idx === -1 ? null : idx;
}

/**
 * Extract the AAC audioObjectType from a codec string like "mp4a.40.2".
 * Returns the trailing decimal as a number. Throws on malformed input or on
 * an OTI that isn't MPEG-4 audio (0x40).
 */
export function aacAudioObjectTypeFromCodec(codec: string): number {
  const parts = codec.toLowerCase().split(".");
  if (parts.length !== 3 || parts[0] !== "mp4a") {
    throw new AacConfigError(`not an mp4a codec string: ${codec}`);
  }
  const oti = parseInt(parts[1], 16);
  if (oti !== 0x40) {
    throw new AacConfigError(
      `expected MPEG-4 audio OTI 0x40, got 0x${oti.toString(16)} (${codec})`,
    );
  }
  const aot = parseInt(parts[2], 10);
  if (!Number.isInteger(aot) || aot < 1 || aot > 31) {
    throw new AacConfigError(`invalid audioObjectType in codec: ${codec}`);
  }
  return aot;
}

/**
 * Build a minimal AudioSpecificConfig (the bytes WebCodecs expects in
 * `AudioDecoderConfig.description` for `mp4a.*` codecs).
 *
 * Bit layout — ISO/IEC 14496-3 §1.6.2.1:
 *   5 bits  audioObjectType
 *   4 bits  samplingFrequencyIndex (or 15 + explicit 24-bit frequency)
 *   4 bits  channelConfiguration
 *   1 bit   frameLengthFlag
 *   1 bit   dependsOnCoreCoder
 *   1 bit   extensionFlag
 *
 * frameLengthFlag/dependsOnCoreCoder/extensionFlag are all 0 for the common
 * AAC-LC profile.
 */
export function buildAacAudioSpecificConfig(
  sampleRate: number,
  channelConfig: number,
  audioObjectType: number = AAC_OBJECT_TYPE_LC,
): Uint8Array {
  if (
    !Number.isInteger(audioObjectType) ||
    audioObjectType < 1 ||
    audioObjectType > 31
  ) {
    throw new AacConfigError(
      `audioObjectType ${audioObjectType} outside [1, 31]`,
    );
  }
  if (
    !Number.isInteger(channelConfig) ||
    channelConfig < 0 ||
    channelConfig > 15
  ) {
    throw new AacConfigError(`channelConfig ${channelConfig} outside [0, 15]`);
  }

  const sfIndex = aacSamplingFrequencyIndex(sampleRate);
  const writer = new BitWriter();
  writer.write(audioObjectType, 5);
  if (sfIndex !== null) {
    writer.write(sfIndex, 4);
  } else {
    if (sampleRate <= 0 || sampleRate >= 1 << 24) {
      throw new AacConfigError(`sample rate ${sampleRate} out of range`);
    }
    writer.write(0xf, 4); // escape
    writer.write(sampleRate, 24);
  }
  writer.write(channelConfig, 4);
  writer.write(0, 1); // frameLengthFlag
  writer.write(0, 1); // dependsOnCoreCoder
  writer.write(0, 1); // extensionFlag
  return writer.finish();
}

/**
 * Convenience: build the AudioSpecificConfig directly from the catalog
 * fields. `channelConfig` arrives as a string per the MSF catalog schema.
 */
export function buildAacConfigFromCatalog(
  codec: string,
  sampleRate: number,
  channelConfig: string,
): Uint8Array {
  const aot = aacAudioObjectTypeFromCodec(codec);
  const ch = parseInt(channelConfig, 10);
  if (!Number.isInteger(ch)) {
    throw new AacConfigError(
      `channelConfig "${channelConfig}" is not a decimal integer`,
    );
  }
  return buildAacAudioSpecificConfig(sampleRate, ch, aot);
}

/** Tiny MSB-first bit writer. */
class BitWriter {
  private readonly bytes: number[] = [];
  private buffer = 0;
  private bits = 0;

  write(value: number, width: number): void {
    if (width < 1 || width > 24) {
      throw new AacConfigError(`bit width ${width} outside [1, 24]`);
    }
    if (value < 0 || value >= 1 << width) {
      throw new AacConfigError(`value ${value} doesn't fit in ${width} bits`);
    }
    this.buffer = (this.buffer << width) | value;
    this.bits += width;
    while (this.bits >= 8) {
      this.bits -= 8;
      this.bytes.push((this.buffer >>> this.bits) & 0xff);
    }
  }

  finish(): Uint8Array {
    if (this.bits > 0) {
      // Pad the final byte with zero bits — matches the spec's reserved tail.
      this.bytes.push((this.buffer << (8 - this.bits)) & 0xff);
      this.bits = 0;
    }
    return new Uint8Array(this.bytes);
  }
}
