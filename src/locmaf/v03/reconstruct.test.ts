/**
 * Tests for the LOCMAF v0.3 canonical CMAF reconstruction
 * (draft-einarsson-moq-locmaf, "Canonical Reconstruction").
 *
 * The pinned byte expectations are copied verbatim from the Go
 * reference tests (github.com/Eyevinn/locmaf codec_test.go:
 * TestGoldenFullObject, TestSingleSampleCanonicalSize,
 * TestCENCSubsampleRoundTrip, TestCbcsOmitRule, TestEventOnly), and
 * the corpus cross-checks compare against the golden vectors the Go
 * reference generated (locmaf/testdata/vectors).
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { reconstructCanonical } from "./reconstruct";
import { EffectiveValues, InitContext, LocmafMalformedError } from "./types";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

function fill(n: number, b: number): Uint8Array {
  return new Uint8Array(n).fill(b);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function readU32(b: Uint8Array, off: number): number {
  return (
    ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0
  );
}

/** Index of the first occurrence of a FourCC in the byte stream, or
 * -1. Mirrors strings.Index in the Go tests. */
function indexOfFourCC(b: Uint8Array, name: string): number {
  const c0 = name.charCodeAt(0);
  const c1 = name.charCodeAt(1);
  const c2 = name.charCodeAt(2);
  const c3 = name.charCodeAt(3);
  for (let i = 0; i + 4 <= b.length; i++) {
    if (b[i] === c0 && b[i + 1] === c1 && b[i + 2] === c2 && b[i + 3] === c3) {
      return i;
    }
  }
  return -1;
}

/** Byte offset of the box (header start) with the given FourCC, or
 * -1 when absent. */
function findBox(b: Uint8Array, name: string): number {
  const idx = indexOfFourCC(b, name);
  return idx < 0 ? -1 : idx - 4;
}

/** InitContext matching the Go tests' buildSyntheticMoov: track 1,
 * timescale 90000, trex dur 3000 / size 1000 / flags 0x01010000. */
function makeCtx(overrides: Partial<InitContext> = {}): InitContext {
  return {
    trackId: 1,
    timescale: 90000,
    trexDefaultSampleDescriptionIndex: 1,
    trexDefaultSampleDuration: 3000,
    trexDefaultSampleSize: 1000,
    trexDefaultSampleFlags: 0x01010000,
    protected: false,
    tencDefaultPerSampleIVSize: 0,
    ...overrides,
  };
}

function makeEff(overrides: Partial<EffectiveValues> = {}): EffectiveValues {
  return {
    sampleCount: 0,
    bmdt: 0n,
    sampleDescriptionIndex: 1,
    durations: [],
    sizes: [],
    flags: [],
    ctos: [],
    perSampleIVSize: 0,
    ivs: new Uint8Array(0),
    hasSubsamples: false,
    subsampleCounts: [],
    clearBytes: [],
    protectedBytes: [],
    genBoxes: [],
    mdatPayload: new Uint8Array(0),
    ...overrides,
  };
}

describe("reconstructCanonical", () => {
  // Pinned canonical bytes from TestGoldenFullObject: n=2, BMDT 90000,
  // sizes 800/700 (varying), durations both at the trex default, IDR
  // first sample (first-sample-flags case with the remainder equal to
  // the trex default).
  const goldenMoofHex =
    "00000064" +
    "6d6f6f66" + // moof, 100 bytes
    "00000010" +
    "6d666864" +
    "00000000" +
    "00000000" + // mfhd, seq 0
    "0000004c" +
    "74726166" + // traf, 76 bytes
    "00000010" +
    "74666864" +
    "00020000" +
    "00000001" + // tfhd: base-is-moof, track 1
    "00000014" +
    "74666474" +
    "01000000" +
    "0000000000015f90" + // tfdt v1
    "00000020" +
    "7472756e" +
    "00000205" +
    "00000002" +
    "0000006c" + // trun: fsf+sizes, data_offset 108
    "02000000" + // first_sample_flags
    "00000320" +
    "000002bc" + // sizes 800, 700
    "000005e4" +
    "6d646174"; // mdat, 8+1500

  function goldenEff(): EffectiveValues {
    return makeEff({
      sampleCount: 2,
      bmdt: 90000n,
      durations: [3000, 3000],
      sizes: [800, 700],
      flags: [0x02000000, 0x01010000],
      ctos: [0, 0],
      mdatPayload: concat(fill(800, 0xaa), fill(700, 0xbb)),
    });
  }

  it("matches the golden full-object canonical chunk", () => {
    const eff = goldenEff();
    const chunk = reconstructCanonical(makeCtx(), eff);

    const wantHeader = hexToBytes(goldenMoofHex);
    expect(bytesToHex(chunk.subarray(0, wantHeader.length))).toBe(
      goldenMoofHex,
    );
    expect(chunk.subarray(wantHeader.length)).toEqual(eff.mdatPayload);
  });

  it("puts sequenceNumber into mfhd and changes nothing else", () => {
    const eff = goldenEff();
    const chunk0 = reconstructCanonical(makeCtx(), eff, 0);
    const chunk7 = reconstructCanonical(makeCtx(), eff, 7);

    // mfhd.sequence_number sits at moof(8) + mfhd header(8) +
    // version/flags(4) = byte 20.
    expect(readU32(chunk7, 20)).toBe(7);
    const patched = new Uint8Array(chunk0);
    patched[20] = 0;
    patched[21] = 0;
    patched[22] = 0;
    patched[23] = 7;
    expect(bytesToHex(chunk7)).toBe(bytesToHex(patched));
  });

  it("carries a single sample's size as a tfhd default", () => {
    // TestSingleSampleCanonicalSize: the wire omits a single sample's
    // size, but the canonical CMAF chunk must still carry it as a
    // tfhd default when it differs from trex (1000).
    const eff = makeEff({
      sampleCount: 1,
      bmdt: 90000n,
      durations: [3000],
      sizes: [800],
      flags: [0x01010000],
      ctos: [0],
      mdatPayload: fill(800, 0xaa),
    });
    const chunk = reconstructCanonical(makeCtx(), eff);

    const tfhdPos = findBox(chunk, "tfhd");
    expect(readU32(chunk, tfhdPos)).toBe(20); // 16 + one optional
    expect(readU32(chunk, tfhdPos + 8)).toBe(0x00020010); // v0, base-is-moof + default-size
    expect(readU32(chunk, tfhdPos + 16)).toBe(800); // default_sample_size
    const trunPos = findBox(chunk, "trun");
    const trFlags = readU32(chunk, trunPos + 8) & 0x00ffffff;
    expect(trFlags & 0x000200).toBe(0); // no per-sample sizes
  });

  it("omits the tfhd default size when it equals the trex default", () => {
    const eff = makeEff({
      sampleCount: 1,
      bmdt: 93000n,
      durations: [3000],
      sizes: [1000],
      flags: [0x01010000],
      ctos: [0],
      mdatPayload: fill(1000, 0xbb),
    });
    const chunk = reconstructCanonical(makeCtx(), eff);

    const tfhdPos = findBox(chunk, "tfhd");
    expect(readU32(chunk, tfhdPos)).toBe(16); // no optionals
    expect(readU32(chunk, tfhdPos + 8)).toBe(0x00020000);
  });

  it("reconstructs saiz/saio/senc with the pinned CENC layout", () => {
    // Mirrors TestCENCSubsampleRoundTrip: n=2, uniform size 800 (a
    // tfhd default vs trex 1000), IV size 8, one subsample per sample
    // (clear 7 / protected 793).
    const ctx = makeCtx({ protected: true, tencDefaultPerSampleIVSize: 8 });
    const ivs = fill(16, 0x0f);
    const eff = makeEff({
      sampleCount: 2,
      bmdt: 0n,
      durations: [3000, 3000],
      sizes: [800, 800],
      flags: [0x01010000, 0x01010000],
      ctos: [0, 0],
      perSampleIVSize: 8,
      ivs,
      hasSubsamples: true,
      subsampleCounts: [1, 1],
      clearBytes: [7, 7],
      protectedBytes: [793, 793],
      mdatPayload: fill(1600, 0xee),
    });
    const chunk = reconstructCanonical(ctx, eff);

    // Box order inside traf: tfhd, tfdt, trun, saiz, saio, senc.
    const order = ["tfhd", "tfdt", "trun", "saiz", "saio", "senc"];
    let last = -1;
    for (const name of order) {
      const idx = indexOfFourCC(chunk, name);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }

    // saiz: uniform aux size 8 + 2 + 6*1 = 16 -> default_sample_info_size.
    const saizPos = findBox(chunk, "saiz");
    expect(chunk[saizPos + 12]).toBe(16);

    // saio's single offset points at the first IV inside senc,
    // moof-relative (the moof starts at byte 0 here: no genBoxes).
    const saioPos = findBox(chunk, "saio");
    const offset = readU32(chunk, saioPos + 16);
    const sencPos = findBox(chunk, "senc");
    expect(offset).toBe(sencPos + 16); // saio offset = senc offset in moof + 16
    expect(chunk.subarray(offset, offset + 8)).toEqual(ivs.subarray(0, 8)); // lands on the first IV

    // senc: version 0, subsample flag set.
    expect(Array.from(chunk.subarray(sencPos + 8, sencPos + 12))).toEqual([
      0, 0, 0, 2,
    ]);
  });

  it("omits senc/saiz/saio when there is no per-sample aux info", () => {
    // TestCbcsOmitRule: constant-IV cbcs — protected track, but no
    // per-sample auxiliary information in the effective values.
    const ctx = makeCtx({ protected: true, tencDefaultPerSampleIVSize: 0 });
    const eff = makeEff({
      sampleCount: 2,
      bmdt: 0n,
      durations: [3000, 3000],
      sizes: [800, 800],
      flags: [0x01010000, 0x01010000],
      ctos: [0, 0],
      mdatPayload: concat(fill(800, 0x10), fill(800, 0x20)),
    });
    const chunk = reconstructCanonical(ctx, eff);

    for (const name of ["senc", "saiz", "saio"]) {
      expect(indexOfFourCC(chunk, name)).toBe(-1);
    }
  });

  it("renders an event-only chunk: genBox, moof, empty mdat", () => {
    // TestEventOnly: a zero-sample chunk with an emsg genBox and an
    // empty mdat payload.
    const emsgPayload = concat(
      new Uint8Array([1, 0, 0, 0]),
      new Uint8Array([0x69, 0x64, 0x33, 0x00]), // "id3\0"
    );
    const eff = makeEff({
      bmdt: 123456n,
      genBoxes: [{ name: "emsg", payload: emsgPayload }],
    });
    const chunk = reconstructCanonical(
      makeCtx({ trexDefaultSampleFlags: 0 }),
      eff,
    );

    // The genBox precedes the moof and is the byte-exact ISO wrap:
    // uint32be(8 + payload) | "emsg" | payload.
    expect(readU32(chunk, 0)).toBe(8 + emsgPayload.length);
    expect(indexOfFourCC(chunk, "emsg")).toBe(4);
    expect(chunk.subarray(8, 8 + emsgPayload.length)).toEqual(emsgPayload);
    expect(indexOfFourCC(chunk, "moof")).toBe(8 + emsgPayload.length + 4);

    // The chunk ends with an 8-byte-only mdat box.
    expect(Array.from(chunk.subarray(chunk.length - 8))).toEqual([
      0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74,
    ]);
  });

  it("rejects sample sizes that do not sum to the mdat payload", () => {
    const eff = makeEff({
      sampleCount: 1,
      durations: [3000],
      sizes: [10],
      flags: [0x01010000],
      ctos: [0],
      mdatPayload: fill(5, 0xaa),
    });
    expect(() => reconstructCanonical(makeCtx(), eff)).toThrow(
      LocmafMalformedError,
    );
  });

  it("rejects an IV payload of the wrong length", () => {
    const eff = makeEff({
      sampleCount: 1,
      durations: [3000],
      sizes: [10],
      flags: [0x01010000],
      ctos: [0],
      perSampleIVSize: 8,
      ivs: fill(4, 0x0f), // want 8
      mdatPayload: fill(10, 0xaa),
    });
    expect(() =>
      reconstructCanonical(
        makeCtx({ protected: true, tencDefaultPerSampleIVSize: 8 }),
        eff,
      ),
    ).toThrow(LocmafMalformedError);
  });

  it("rejects inconsistent subsample vectors", () => {
    const eff = makeEff({
      sampleCount: 1,
      durations: [3000],
      sizes: [10],
      flags: [0x01010000],
      ctos: [0],
      hasSubsamples: true,
      subsampleCounts: [2],
      clearBytes: [1], // want 2 entries
      protectedBytes: [4, 4],
      mdatPayload: fill(10, 0xaa),
    });
    expect(() =>
      reconstructCanonical(makeCtx({ protected: true }), eff),
    ).toThrow(LocmafMalformedError);
  });

  it("rejects subsample vectors present without hasSubsamples", () => {
    const eff = makeEff({
      sampleCount: 1,
      durations: [3000],
      sizes: [10],
      flags: [0x01010000],
      ctos: [0],
      clearBytes: [1],
      mdatPayload: fill(10, 0xaa),
    });
    expect(() => reconstructCanonical(makeCtx(), eff)).toThrow(
      LocmafMalformedError,
    );
  });

  it("rejects an aux_info size above the 8-bit saiz limit", () => {
    // aux_size = 8 (IV) + 2 + 6*42 = 262 > 255.
    const eff = makeEff({
      sampleCount: 1,
      durations: [3000],
      sizes: [100],
      flags: [0x01010000],
      ctos: [0],
      perSampleIVSize: 8,
      ivs: fill(8, 0x0f),
      hasSubsamples: true,
      subsampleCounts: [42],
      clearBytes: new Array<number>(42).fill(1),
      protectedBytes: new Array<number>(42).fill(1),
      mdatPayload: fill(100, 0xaa),
    });
    expect(() =>
      reconstructCanonical(
        makeCtx({ protected: true, tencDefaultPerSampleIVSize: 8 }),
        eff,
      ),
    ).toThrow(LocmafMalformedError);
  });
});

// Cross-check against the golden corpus generated by the Go reference
// (locmaf/testdata/vectors): rebuild the canonical .cmfc from the
// effective/*.json values (the mdat payload is not in the JSON — it is
// the tail of the canonical file) and compare byte-for-byte.
const vectorsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../locmaf/testdata/vectors",
);
const haveVectors = fs.existsSync(vectorsDir);
const describeVectors = haveVectors ? describe : describe.skip;
if (!haveVectors) {
  console.warn(`locmaf golden vectors not found at ${vectorsDir}; skipping`);
}

interface EffectiveJson {
  sampleCount?: number;
  bmdt?: number;
  sampleDescriptionIndex?: number;
  durations?: number[];
  sizes?: number[];
  flags?: number[];
  ctos?: number[];
  perSampleIVSize?: number;
  ivs?: string;
  hasSubsamples?: boolean;
  subsampleCounts?: number[];
  clearBytes?: number[];
  protectedBytes?: number[];
  genBoxes?: Array<{ name: string; payload: string }>;
  mdatLength?: number;
  mdatSha256?: string;
}

function effFromJson(json: EffectiveJson, cmfc: Uint8Array): EffectiveValues {
  const mdatLength = json.mdatLength ?? 0;
  return {
    sampleCount: json.sampleCount ?? 0,
    bmdt: BigInt(json.bmdt ?? 0),
    sampleDescriptionIndex: json.sampleDescriptionIndex ?? 1,
    durations: json.durations ?? [],
    sizes: json.sizes ?? [],
    flags: json.flags ?? [],
    ctos: json.ctos ?? [],
    perSampleIVSize: json.perSampleIVSize ?? 0,
    ivs: hexToBytes(json.ivs ?? ""),
    hasSubsamples: json.hasSubsamples ?? false,
    subsampleCounts: json.subsampleCounts ?? [],
    clearBytes: json.clearBytes ?? [],
    protectedBytes: json.protectedBytes ?? [],
    genBoxes: (json.genBoxes ?? []).map((g) => ({
      name: g.name,
      payload: hexToBytes(g.payload),
    })),
    // The mdat payload is the last mdatLength bytes of the canonical
    // chunk.
    mdatPayload: cmfc.subarray(cmfc.length - mdatLength),
  };
}

describeVectors("reconstructCanonical against the golden corpus", () => {
  // trex defaults per case: see locmaf/internal/vectorgen/cases.go.
  const cases: Array<{ name: string; ctx: InitContext; stem: string }> = [
    {
      // buildInit(90000, "video", 3000, 0, 0x01010000)
      name: "varying-sizes",
      ctx: makeCtx({ trexDefaultSampleSize: 0 }),
      stem: "g000_o000",
    },
    {
      // buildInit(90000, "video", 3000, 0, 0x01010000) + tenc IV size 8
      name: "cenc-subsamples",
      ctx: makeCtx({
        trexDefaultSampleSize: 0,
        protected: true,
        tencDefaultPerSampleIVSize: 8,
      }),
      stem: "g000_o000",
    },
    {
      // buildInit(48000, "audio", 1024, 160, 0x02000000) + constant-IV tenc
      name: "cbcs-omit",
      ctx: makeCtx({
        timescale: 48000,
        trexDefaultSampleDuration: 1024,
        trexDefaultSampleSize: 160,
        trexDefaultSampleFlags: 0x02000000,
        protected: true,
        tencDefaultPerSampleIVSize: 0,
      }),
      stem: "g000_o000",
    },
  ];

  for (const c of cases) {
    it(`rebuilds ${c.name}/${c.stem} byte-exactly`, () => {
      const caseDir = path.join(vectorsDir, c.name);
      const cmfc = new Uint8Array(
        fs.readFileSync(path.join(caseDir, "canonical", `${c.stem}.cmfc`)),
      );
      const json = JSON.parse(
        fs.readFileSync(
          path.join(caseDir, "effective", `${c.stem}.json`),
          "utf8",
        ),
      ) as EffectiveJson;

      const chunk = reconstructCanonical(c.ctx, effFromJson(json, cmfc));
      expect(bytesToHex(chunk)).toBe(bytesToHex(cmfc));
    });
  }
});
