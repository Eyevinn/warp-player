import { codecCanCarryCta608 } from "../loc/cta608";

import { resolveCaptionGate } from "./gate";

describe("resolveCaptionGate", () => {
  it("is inert with no engine playing (the teardown case)", () => {
    expect(
      resolveCaptionGate({ enabled: true, available: true, engine: null }),
    ).toEqual({ active: false, mseSink: false, webcodecsSink: false });
  });

  it("installs the sink only on the MSE engine when MSE is playing", () => {
    expect(
      resolveCaptionGate({ enabled: true, available: true, engine: "mse" }),
    ).toEqual({ active: true, mseSink: true, webcodecsSink: false });
  });

  it("installs the sink only on the WebCodecs engine when it is playing", () => {
    expect(
      resolveCaptionGate({
        enabled: true,
        available: true,
        engine: "webcodecs",
      }),
    ).toEqual({ active: true, mseSink: false, webcodecsSink: true });
  });

  it("never installs a sink on both engines at once", () => {
    for (const engine of ["mse", "webcodecs"] as const) {
      const out = resolveCaptionGate({
        enabled: true,
        available: true,
        engine,
      });
      expect(out.mseSink && out.webcodecsSink).toBe(false);
    }
  });

  it("is inert when the user has captions off", () => {
    expect(
      resolveCaptionGate({ enabled: false, available: true, engine: "mse" }),
    ).toEqual({ active: false, mseSink: false, webcodecsSink: false });
  });

  it("is inert when the track does not advertise CTA-608", () => {
    // Intent is still true — it is remembered, just not acted on.
    expect(
      resolveCaptionGate({ enabled: true, available: false, engine: "mse" }),
    ).toEqual({ active: false, mseSink: false, webcodecsSink: false });
  });

  it("is inert when neither intent nor availability holds", () => {
    expect(
      resolveCaptionGate({
        enabled: false,
        available: false,
        engine: "webcodecs",
      }),
    ).toEqual({ active: false, mseSink: false, webcodecsSink: false });
  });

  it("activates exactly when intent, availability and an engine all hold", () => {
    // Exhaustive over the truth table: active iff all three.
    for (const enabled of [false, true]) {
      for (const available of [false, true]) {
        for (const engine of [null, "mse", "webcodecs"] as const) {
          const out = resolveCaptionGate({ enabled, available, engine });
          expect(out.active).toBe(enabled && available && engine !== null);
          // A sink is installed iff active, and on exactly one engine.
          expect(out.mseSink || out.webcodecsSink).toBe(out.active);
        }
      }
    }
  });
});

describe("caption availability requires a codec that can carry CTA-608", () => {
  // Regression for #166: mlmpub advertises the accessibility descriptor on its
  // AV1 renditions too, but AV1 carries CTA-608 in a metadata OBU rather than
  // an SEI NAL unit, and neither extractor reads it. Gating on the descriptor
  // alone enabled a CC button that could never show anything.
  const cases: [string | undefined, boolean][] = [
    ["avc1.4D401F", true],
    ["avc3.4D401F", true],
    ["hvc1.1.6.L93.90", true],
    ["hev1.1.6.L93.90", true],
    ["av01.0.05M.08", false],
    ["vp09.00.10.08", false],
    [undefined, false],
    ["", false],
  ];

  it.each(cases)("codecCanCarryCta608(%s) === %s", (codec, expected) => {
    expect(codecCanCarryCta608(codec)).toBe(expected);
  });

  it("is an allow-list, so an unknown codec is rejected rather than passed", () => {
    expect(codecCanCarryCta608("future-codec.1")).toBe(false);
  });
});
