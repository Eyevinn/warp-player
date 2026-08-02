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
