import {
  AAC_OBJECT_TYPE_LC,
  AacConfigError,
  aacAudioObjectTypeFromCodec,
  aacSamplingFrequencyIndex,
  buildAacAudioSpecificConfig,
  buildAacConfigFromCatalog,
} from "./aac";

describe("aacSamplingFrequencyIndex", () => {
  it("returns the correct index for standard rates", () => {
    expect(aacSamplingFrequencyIndex(96000)).toBe(0);
    expect(aacSamplingFrequencyIndex(48000)).toBe(3);
    expect(aacSamplingFrequencyIndex(44100)).toBe(4);
    expect(aacSamplingFrequencyIndex(8000)).toBe(11);
  });

  it("returns null for non-standard rates", () => {
    expect(aacSamplingFrequencyIndex(50000)).toBeNull();
  });
});

describe("aacAudioObjectTypeFromCodec", () => {
  it("parses mp4a.40.2 as AAC-LC", () => {
    expect(aacAudioObjectTypeFromCodec("mp4a.40.2")).toBe(AAC_OBJECT_TYPE_LC);
  });

  it("is case-insensitive", () => {
    expect(aacAudioObjectTypeFromCodec("MP4A.40.5")).toBe(5);
  });

  it("rejects non-mp4a codecs", () => {
    expect(() => aacAudioObjectTypeFromCodec("opus")).toThrow(AacConfigError);
    expect(() => aacAudioObjectTypeFromCodec("avc1.42c01f")).toThrow(
      AacConfigError,
    );
  });

  it("rejects mp4a codecs that aren't MPEG-4 audio", () => {
    // OTI 0x69 = MPEG-2 audio.
    expect(() => aacAudioObjectTypeFromCodec("mp4a.69.2")).toThrow(
      AacConfigError,
    );
  });

  it("rejects malformed strings", () => {
    expect(() => aacAudioObjectTypeFromCodec("mp4a.40")).toThrow(
      AacConfigError,
    );
    expect(() => aacAudioObjectTypeFromCodec("mp4a.40.0")).toThrow(
      AacConfigError,
    );
  });
});

describe("buildAacAudioSpecificConfig", () => {
  it("produces 0x11 0x90 for AAC-LC 48 kHz stereo", () => {
    // AOT=2 (00010), SFI=3 (0011), chCfg=2 (0010), three trailing 0 bits → 0x11 0x90.
    const out = buildAacAudioSpecificConfig(48000, 2);
    expect(Array.from(out)).toEqual([0x11, 0x90]);
  });

  it("produces 0x12 0x10 for AAC-LC 44.1 kHz stereo", () => {
    // AOT=2 (00010), SFI=4 (0100), chCfg=2 (0010), 000 → 00010 0100 0010 000 = 0x12 0x10.
    const out = buildAacAudioSpecificConfig(44100, 2);
    expect(Array.from(out)).toEqual([0x12, 0x10]);
  });

  it("produces 0x11 0x88 for AAC-LC 48 kHz mono", () => {
    // AOT=2, SFI=3, chCfg=1 → 00010 0011 0001 000 = 0x11 0x88.
    const out = buildAacAudioSpecificConfig(48000, 1);
    expect(Array.from(out)).toEqual([0x11, 0x88]);
  });

  it("falls back to the explicit 24-bit sample-rate escape", () => {
    // Non-standard rate → escape index 0xF + 24-bit value.
    const rate = 50000;
    const out = buildAacAudioSpecificConfig(rate, 2);
    // Layout: 5 bits AOT + 4 bits 0xF + 24 bits rate + 4 bits chCfg + 3 bits = 40 bits = 5 bytes.
    expect(out).toHaveLength(5);
    // Sanity: round-trip the rate. Bit positions 9..32 hold the 24-bit rate.
    let bitPos = 0;
    function readBits(n: number): number {
      let v = 0;
      for (let i = 0; i < n; i++) {
        const byte = out[(bitPos + i) >>> 3];
        const bit = 7 - ((bitPos + i) & 7);
        v = (v << 1) | ((byte >>> bit) & 1);
      }
      bitPos += n;
      return v;
    }
    expect(readBits(5)).toBe(2); // AOT
    expect(readBits(4)).toBe(0xf); // SFI escape
    expect(readBits(24)).toBe(rate); // explicit rate
    expect(readBits(4)).toBe(2); // channelConfig
  });

  it("rejects out-of-range channelConfig and AOT", () => {
    expect(() => buildAacAudioSpecificConfig(48000, 16)).toThrow(
      AacConfigError,
    );
    expect(() => buildAacAudioSpecificConfig(48000, -1)).toThrow(
      AacConfigError,
    );
    expect(() => buildAacAudioSpecificConfig(48000, 2, 0)).toThrow(
      AacConfigError,
    );
    expect(() => buildAacAudioSpecificConfig(48000, 2, 32)).toThrow(
      AacConfigError,
    );
  });
});

describe("buildAacConfigFromCatalog", () => {
  it("matches buildAacAudioSpecificConfig for the AAC-LC stereo case", () => {
    const direct = buildAacAudioSpecificConfig(48000, 2);
    const fromCat = buildAacConfigFromCatalog("mp4a.40.2", 48000, "2");
    expect(Array.from(fromCat)).toEqual(Array.from(direct));
  });

  it("rejects non-numeric channelConfig strings", () => {
    expect(() =>
      buildAacConfigFromCatalog("mp4a.40.2", 48000, "stereo"),
    ).toThrow(AacConfigError);
  });
});
