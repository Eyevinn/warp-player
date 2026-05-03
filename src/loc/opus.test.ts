import {
  OpusConfigError,
  buildOpusHead,
  buildOpusHeadFromCatalog,
} from "./opus";

describe("buildOpusHead", () => {
  it("produces a 19-byte stereo OpusHead with sensible defaults", () => {
    const head = buildOpusHead({ channels: 2, inputSampleRate: 48000 });
    expect(head).toHaveLength(19);
    // Magic "OpusHead"
    expect(Array.from(head.slice(0, 8))).toEqual([
      0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64,
    ]);
    expect(head[8]).toBe(1); // version
    expect(head[9]).toBe(2); // channels
    expect(head[10] | (head[11] << 8)).toBe(0); // pre-skip default
    expect(
      head[12] | (head[13] << 8) | (head[14] << 16) | (head[15] << 24),
    ).toBe(48000);
    expect(head[16] | (head[17] << 8)).toBe(0); // output gain default
    expect(head[18]).toBe(0); // channel mapping family
  });

  it("encodes mono with the right channel count", () => {
    const head = buildOpusHead({ channels: 1, inputSampleRate: 48000 });
    expect(head[9]).toBe(1);
  });

  it("encodes pre-skip and output gain little-endian", () => {
    const head = buildOpusHead({
      channels: 2,
      inputSampleRate: 48000,
      preSkip: 312,
      outputGain: -100,
    });
    expect(head[10] | (head[11] << 8)).toBe(312);
    // -100 as int16 → 0xff9c.
    expect(head[16] | (head[17] << 8)).toBe(0xff9c);
  });

  it("rejects channel counts that need a mapping table", () => {
    expect(() =>
      buildOpusHead({ channels: 0, inputSampleRate: 48000 }),
    ).toThrow(OpusConfigError);
    expect(() =>
      buildOpusHead({ channels: 6, inputSampleRate: 48000 }),
    ).toThrow(OpusConfigError);
  });

  it("rejects out-of-range pre-skip and gain", () => {
    expect(() =>
      buildOpusHead({ channels: 2, inputSampleRate: 48000, preSkip: 70_000 }),
    ).toThrow(OpusConfigError);
    expect(() =>
      buildOpusHead({
        channels: 2,
        inputSampleRate: 48000,
        outputGain: 40_000,
      }),
    ).toThrow(OpusConfigError);
  });

  it("rejects non-positive sample rates", () => {
    expect(() => buildOpusHead({ channels: 2, inputSampleRate: 0 })).toThrow(
      OpusConfigError,
    );
  });
});

describe("buildOpusHeadFromCatalog", () => {
  it("matches buildOpusHead for the typical stereo case", () => {
    const fromCatalog = buildOpusHeadFromCatalog(48000, "2");
    const direct = buildOpusHead({ channels: 2, inputSampleRate: 48000 });
    expect(Array.from(fromCatalog)).toEqual(Array.from(direct));
  });

  it("rejects non-numeric channelConfig", () => {
    expect(() => buildOpusHeadFromCatalog(48000, "stereo")).toThrow(
      OpusConfigError,
    );
  });
});
