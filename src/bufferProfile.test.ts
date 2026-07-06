import {
  BufferProfiles,
  DEFAULT_BUFFER_PROFILES,
  resolveBufferProfile,
} from "./bufferProfile";

describe("resolveBufferProfile (built-in default)", () => {
  it("uses the 200/300 base for every engine/browser combination", () => {
    const base = { minimalBuffer: 200, targetLatency: 300 };
    expect(resolveBufferProfile("mse", "safari")).toEqual(base);
    expect(resolveBufferProfile("webcodecs", "safari")).toEqual(base);
    expect(resolveBufferProfile("mse", "other")).toEqual(base);
    expect(resolveBufferProfile("webcodecs", "other")).toEqual(base);
  });
});

describe("resolveBufferProfile (custom table)", () => {
  it("applies later matching rules over earlier ones and over base", () => {
    const profiles: BufferProfiles = {
      base: { minimalBuffer: 100, targetLatency: 200 },
      rules: [
        { engine: "mse", minimalBuffer: 400, targetLatency: 700 },
        { browser: "safari", engine: "mse", targetLatency: 900 },
      ],
    };
    // MSE on non-Safari: only the first rule matches.
    expect(resolveBufferProfile("mse", "other", profiles)).toEqual({
      minimalBuffer: 400,
      targetLatency: 700,
    });
    // MSE on Safari: both rules match; the second overrides targetLatency only.
    expect(resolveBufferProfile("mse", "safari", profiles)).toEqual({
      minimalBuffer: 400,
      targetLatency: 900,
    });
    // WebCodecs: no rule matches, base wins.
    expect(resolveBufferProfile("webcodecs", "safari", profiles)).toEqual({
      minimalBuffer: 100,
      targetLatency: 200,
    });
  });

  it("falls back to base when there are no rules", () => {
    const profiles: BufferProfiles = {
      base: { minimalBuffer: 250, targetLatency: 450 },
    };
    expect(resolveBufferProfile("mse", "safari", profiles)).toEqual({
      minimalBuffer: 250,
      targetLatency: 450,
    });
  });

  it("DEFAULT_BUFFER_PROFILES base is 200/300", () => {
    expect(DEFAULT_BUFFER_PROFILES.base).toEqual({
      minimalBuffer: 200,
      targetLatency: 300,
    });
  });
});
