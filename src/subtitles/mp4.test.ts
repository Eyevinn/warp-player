import type { InitContext } from "../locmaf/v03/types";

import { boxesIn, parseCmafSamples, wholeSampleBoxType } from "./mp4";

const CTX: InitContext = {
  trackId: 1,
  timescale: 1000,
  trexDefaultSampleDescriptionIndex: 1,
  trexDefaultSampleDuration: 0,
  trexDefaultSampleSize: 0,
  trexDefaultSampleFlags: 0,
  protected: false,
  tencDefaultPerSampleIVSize: 0,
};

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [
    ...u32(8 + body.length),
    ...Array.from(type, (c) => c.charCodeAt(0)),
    ...body,
  ];
}

/**
 * One moof+mdat with two samples of 3 and 5 bytes, sized from tfhd defaults
 * (duration 40) or from the trun, with the data offset in the trun.
 */
function chunk(bmdt: number, useDefaults: boolean): Uint8Array {
  const data = [1, 2, 3, 4, 5, 6, 7, 8];
  const tfhd = useDefaults
    ? box("tfhd", u32(0x020008), u32(1), u32(40)) // default-base-is-moof, default duration
    : box("tfhd", u32(0x020000), u32(1));
  const tfdt = box(
    "tfdt",
    [1, 0, 0, 0],
    u32(Math.floor(bmdt / 2 ** 32)),
    u32(bmdt >>> 0),
  );
  const trunFlags = useDefaults ? 0x000201 : 0x000301;
  const entries = useDefaults
    ? [u32(3), u32(5)]
    : [u32(40), u32(3), u32(60), u32(5)];
  const trunLen = 8 + 12 + entries.flat().length;
  const moofLen = 8 + 16 + 8 + tfhd.length + tfdt.length + trunLen; // moof, mfhd, traf headers
  const trun = box(
    "trun",
    u32(trunFlags),
    u32(2),
    u32(moofLen + 8),
    ...entries,
  );
  const traf = box("traf", tfhd, tfdt, trun);
  const moof = box("moof", box("mfhd", u32(0), u32(1)), traf);
  return new Uint8Array([...moof, ...box("mdat", data)]);
}

describe("parseCmafSamples", () => {
  it("times samples from tfdt and trun durations", () => {
    const samples = parseCmafSamples(chunk(1_700_000_000_000, false), CTX);
    expect(
      samples.map((s) => [s.startMs, s.endMs, Array.from(s.data)]),
    ).toEqual([
      [1_700_000_000_000, 1_700_000_000_040, [1, 2, 3]],
      [1_700_000_000_040, 1_700_000_000_100, [4, 5, 6, 7, 8]],
    ]);
  });

  it("uses tfhd default durations", () => {
    const samples = parseCmafSamples(chunk(0, true), CTX);
    expect(samples.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 40],
      [40, 80],
    ]);
  });

  it("reads every moof of a multi-chunk segment", () => {
    const a = chunk(0, false);
    const b = chunk(100, false);
    const both = new Uint8Array([...a, ...b]);
    expect(parseCmafSamples(both, CTX).map((s) => s.startMs)).toEqual([
      0, 40, 100, 140,
    ]);
  });

  it("converts from the track timescale", () => {
    const samples = parseCmafSamples(chunk(90_000, false), {
      ...CTX,
      timescale: 90_000,
    });
    expect(samples[0].startMs).toBe(1000);
  });

  it("stops at a truncated sample", () => {
    const whole = chunk(0, false);
    expect(
      parseCmafSamples(whole.subarray(0, whole.length - 2), CTX),
    ).toHaveLength(1);
  });
});

describe("wholeSampleBoxType", () => {
  const ttmn = new Uint8Array(box("ttmn"));
  it("recognises a box that is the whole sample", () => {
    expect(wholeSampleBoxType(ttmn, ["ttmn", "ttmb"])).toBe("ttmn");
    expect(
      wholeSampleBoxType(new Uint8Array(box("ttmb", [60, 98])), [
        "ttmn",
        "ttmb",
      ]),
    ).toBe("ttmb");
  });
  it("rejects documents, other types, and boxes that are not the whole sample", () => {
    expect(
      wholeSampleBoxType(
        new TextEncoder().encode("<?xml version='1.0'?><tt/>"),
        ["ttmn"],
      ),
    ).toBeNull();
    expect(wholeSampleBoxType(ttmn, ["vttn"])).toBeNull();
    expect(
      wholeSampleBoxType(new Uint8Array([...ttmn, 0]), ["ttmn"]),
    ).toBeNull();
  });
});

describe("boxesIn", () => {
  it("stops at a box that overruns its range", () => {
    const data = new Uint8Array([
      ...box("free", [1]),
      ...u32(100),
      0x6d,
      0x64,
      0x61,
      0x74,
    ]);
    expect(boxesIn(data).map((b) => b.type)).toEqual(["free"]);
  });
});
