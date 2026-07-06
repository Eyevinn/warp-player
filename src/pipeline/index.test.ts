import { WarpTrack } from "../warpcatalog";

import {
  defaultEngineForTracks,
  engineCanPlayTracks,
  engineSupports,
  resolveEngine,
  trackIsEncrypted,
} from "./index";

function track(
  packaging: string | undefined,
  options: { encrypted?: boolean } = {},
): WarpTrack {
  const t: WarpTrack = {
    name: "test",
    namespace: "test",
    packaging,
    isLive: true,
  } as WarpTrack;
  if (options.encrypted) {
    t.contentProtectionRefIDs = ["cenc-ref-1"];
  }
  return t;
}

describe("trackIsEncrypted", () => {
  it("treats missing or empty contentProtectionRefIDs as clear", () => {
    expect(trackIsEncrypted(null)).toBe(false);
    expect(trackIsEncrypted(undefined)).toBe(false);
    expect(trackIsEncrypted(track("cmaf"))).toBe(false);
  });

  it("treats any non-empty contentProtectionRefIDs as encrypted", () => {
    expect(trackIsEncrypted(track("cmaf", { encrypted: true }))).toBe(true);
  });
});

describe("engineSupports", () => {
  it("MSE handles cmaf in clear and encrypted forms", () => {
    expect(engineSupports("mse", "cmaf", false)).toBe(true);
    expect(engineSupports("mse", "cmaf", true)).toBe(true);
  });

  it("MSE handles locmaf after reconstruction", () => {
    expect(engineSupports("mse", "locmaf", false)).toBe(true);
    expect(engineSupports("mse", "locmaf", true)).toBe(true);
  });

  it("MSE does not yet handle loc or unknown packagings", () => {
    // Reserve loc reconstruction for a follow-up phase.
    expect(engineSupports("mse", "loc", false)).toBe(false);
    expect(engineSupports("mse", "moqmi", false)).toBe(false);
  });

  it("WebCodecs handles clear loc only", () => {
    expect(engineSupports("webcodecs", "loc", false)).toBe(true);
    expect(engineSupports("webcodecs", "loc", true)).toBe(false);
    expect(engineSupports("webcodecs", "cmaf", false)).toBe(false);
  });
});

describe("engineCanPlayTracks", () => {
  it("returns true for an empty selection", () => {
    expect(engineCanPlayTracks("mse", null, null)).toBe(true);
    expect(engineCanPlayTracks("webcodecs", null, null)).toBe(true);
  });

  it("MSE accepts cmaf-only selections, including encrypted", () => {
    expect(engineCanPlayTracks("mse", track("cmaf"), track("cmaf"))).toBe(true);
    expect(
      engineCanPlayTracks(
        "mse",
        track("cmaf", { encrypted: true }),
        track("cmaf"),
      ),
    ).toBe(true);
  });

  it("WebCodecs accepts clear loc, rejects encrypted loc and cmaf", () => {
    expect(engineCanPlayTracks("webcodecs", track("loc"), track("loc"))).toBe(
      true,
    );
    expect(
      engineCanPlayTracks(
        "webcodecs",
        track("loc", { encrypted: true }),
        track("loc"),
      ),
    ).toBe(false);
    expect(engineCanPlayTracks("webcodecs", track("cmaf"), null)).toBe(false);
  });
});

describe("defaultEngineForTracks", () => {
  it("falls back to mse when no tracks are present", () => {
    expect(defaultEngineForTracks(null, null)).toBe("mse");
  });

  it("picks mse for cmaf", () => {
    expect(defaultEngineForTracks(track("cmaf"), track("cmaf"))).toBe("mse");
  });

  it("picks mse for locmaf", () => {
    expect(defaultEngineForTracks(track("locmaf"), track("locmaf"))).toBe(
      "mse",
    );
  });

  it("picks webcodecs for clear loc", () => {
    expect(defaultEngineForTracks(track("loc"), track("loc"))).toBe(
      "webcodecs",
    );
  });

  it("forces mse when any track is encrypted, even for loc", () => {
    expect(
      defaultEngineForTracks(track("loc", { encrypted: true }), track("loc")),
    ).toBe("mse");
  });

  it("allows a cmaf/locmaf mix (same MSE-CMAF family)", () => {
    expect(defaultEngineForTracks(track("cmaf"), track("locmaf"))).toBe("mse");
    expect(defaultEngineForTracks(track("locmaf"), track("cmaf"))).toBe("mse");
  });

  it("rejects mixed packagings across engine families", () => {
    expect(() => defaultEngineForTracks(track("cmaf"), track("loc"))).toThrow(
      /mixed packagings/i,
    );
    expect(() => defaultEngineForTracks(track("locmaf"), track("loc"))).toThrow(
      /mixed packagings/i,
    );
  });
});

describe("resolveEngine", () => {
  it("delegates to defaultEngineForTracks for auto", () => {
    expect(resolveEngine("auto", track("cmaf"), null)).toBe("mse");
    expect(resolveEngine("auto", track("loc"), null)).toBe("webcodecs");
  });

  it("respects explicit choices when compatible", () => {
    expect(resolveEngine("mse", track("cmaf"), null)).toBe("mse");
    expect(resolveEngine("mse", track("locmaf"), null)).toBe("mse");
    expect(resolveEngine("webcodecs", track("loc"), null)).toBe("webcodecs");
  });

  it("allows a cmaf/locmaf selection (same MSE-CMAF family)", () => {
    expect(resolveEngine("auto", track("cmaf"), track("locmaf"))).toBe("mse");
    expect(resolveEngine("mse", track("cmaf"), track("locmaf"))).toBe("mse");
    expect(resolveEngine("mse", track("locmaf"), track("cmaf"))).toBe("mse");
  });

  it("rejects explicit choices that can't play the selection", () => {
    expect(() => resolveEngine("webcodecs", track("cmaf"), null)).toThrow(
      /cannot play/i,
    );
    expect(() =>
      resolveEngine("webcodecs", track("loc", { encrypted: true }), null),
    ).toThrow(/cannot play/i);
  });
});
