// Opus helpers for the LOC payload path.
//
// LOC Opus objects are raw Opus packets without any container framing. To
// set up a WebCodecs AudioDecoder we synthesize an Opus ID Header
// ("OpusHead") from catalog metadata and pass it as
// `AudioDecoderConfig.description`.
//
// References:
//   - RFC 7845 §5.1 (Opus ID Header)
//   - WebCodecs AudioDecoderConfig.description for the "opus" codec.
//
// All multi-byte fields in OpusHead are little-endian.

export class OpusConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpusConfigError";
  }
}

export interface OpusHeadOptions {
  /** 1 or 2 — channel-mapping family 0 forbids more channels. */
  channels: number;
  /**
   * Original input sample rate in Hz. Informational only — the Opus decoder
   * always outputs at 48 kHz. Pass the catalog samplerate field through.
   */
  inputSampleRate: number;
  /**
   * Encoder pre-skip in 48 kHz samples. Catalogs for live content typically
   * imply 0; this field accepts a non-default override.
   */
  preSkip?: number;
  /** Output gain in Q7.8 fixed-point dB. 0 = unity. */
  outputGain?: number;
}

const OPUS_HEAD_MAGIC = new Uint8Array([
  0x4f,
  0x70,
  0x75,
  0x73,
  0x48,
  0x65,
  0x61,
  0x64, // "OpusHead"
]);

/**
 * Build an OpusHead suitable for `AudioDecoderConfig.description` when
 * codec is "opus". Mapping family is fixed at 0 (mono / stereo, no mapping
 * table) — mlmpub only emits stereo Opus today.
 */
export function buildOpusHead(options: OpusHeadOptions): Uint8Array {
  const { channels, inputSampleRate } = options;
  const preSkip = options.preSkip ?? 0;
  const outputGain = options.outputGain ?? 0;
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw new OpusConfigError(
      `mapping family 0 requires 1 or 2 channels, got ${channels}`,
    );
  }
  if (
    !Number.isInteger(inputSampleRate) ||
    inputSampleRate <= 0 ||
    inputSampleRate > 0xffffffff
  ) {
    throw new OpusConfigError(`invalid input sample rate ${inputSampleRate}`);
  }
  if (!Number.isInteger(preSkip) || preSkip < 0 || preSkip > 0xffff) {
    throw new OpusConfigError(`pre-skip ${preSkip} outside [0, 65535]`);
  }
  if (
    !Number.isInteger(outputGain) ||
    outputGain < -32768 ||
    outputGain > 32767
  ) {
    throw new OpusConfigError(`output gain ${outputGain} outside int16 range`);
  }

  const out = new Uint8Array(19);
  out.set(OPUS_HEAD_MAGIC, 0);
  out[8] = 1; // version
  out[9] = channels;
  out[10] = preSkip & 0xff;
  out[11] = (preSkip >>> 8) & 0xff;
  out[12] = inputSampleRate & 0xff;
  out[13] = (inputSampleRate >>> 8) & 0xff;
  out[14] = (inputSampleRate >>> 16) & 0xff;
  out[15] = (inputSampleRate >>> 24) & 0xff;
  // Output gain is signed 16-bit little-endian.
  const gainU16 = outputGain & 0xffff;
  out[16] = gainU16 & 0xff;
  out[17] = (gainU16 >>> 8) & 0xff;
  out[18] = 0; // channel mapping family
  return out;
}

/** Convenience: build OpusHead from the catalog fields. */
export function buildOpusHeadFromCatalog(
  sampleRate: number,
  channelConfig: string,
): Uint8Array {
  const channels = parseInt(channelConfig, 10);
  if (!Number.isInteger(channels)) {
    throw new OpusConfigError(
      `channelConfig "${channelConfig}" is not a decimal integer`,
    );
  }
  return buildOpusHead({ channels, inputSampleRate: sampleRate });
}
