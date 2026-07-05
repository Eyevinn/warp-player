/**
 * LOCMAF v0.3 decoder tests: a port of the Go reference tests
 * (github.com/Eyevinn/locmaf codec_test.go / rawboxes_test.go) decode
 * cases, plus parseInitContext against the golden-vector corpus.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { encodeVi64, encodeZigzagVi64 } from "../vi64";

import {
  LocmafGroupState,
  decodeObject,
  fieldIDs,
  parseInitContext,
} from "./decoder";
import {
  ELEMENT_TYPE_DELTA_HEADER,
  ELEMENT_TYPE_FULL_HEADER,
  ELEMENT_TYPE_RAW_BOXES,
  LocmafMalformedError,
  type InitContext,
} from "./types";

// -----------------------------------------------------------------------------
// Wire-building helpers (mirroring the Go tests' vi64.Append usage)
// -----------------------------------------------------------------------------

const u = (v: number | bigint): Uint8Array => encodeVi64(BigInt(v));
const z = (v: number | bigint): Uint8Array => encodeZigzagVi64(BigInt(v));

function cat(...parts: Array<Uint8Array | number[] | string>): Uint8Array {
  const arrs = parts.map((p) => {
    if (p instanceof Uint8Array) {
      return p;
    }
    if (typeof p === "string") {
      return new TextEncoder().encode(p); // FourCC bytes
    }
    return Uint8Array.from(p);
  });
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function hex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(2 * i, 2 * i + 2), 16);
  }
  return out;
}

function fill(len: number, byte: number): Uint8Array {
  return new Uint8Array(len).fill(byte);
}

/** field_id + absolute scalar vi64 (even IDs, full context). */
const scalarField = (id: number, v: number | bigint): Uint8Array =>
  cat(u(id), u(v));
/** field_id + zigzag scalar delta (even IDs, delta context). */
const deltaScalarField = (id: number, v: number | bigint): Uint8Array =>
  cat(u(id), z(v));
/** field_id + byte_length + bytes (odd IDs). */
const listField = (id: number, elems: Uint8Array): Uint8Array =>
  cat(u(id), u(elems.length), elems);
const unsignedList = (values: Array<number | bigint>): Uint8Array =>
  cat(...values.map(u));
const zigzagList = (values: Array<number | bigint>): Uint8Array =>
  cat(...values.map(z));

/** element_type + properties_length + property block + mdat payload. */
function headerObject(
  elementType: number,
  props: Uint8Array,
  mdat: Uint8Array = new Uint8Array(0),
): Uint8Array {
  return cat(u(elementType), u(props.length), props, mdat);
}
const fullObject = (props: Uint8Array, mdat?: Uint8Array): Uint8Array =>
  headerObject(ELEMENT_TYPE_FULL_HEADER, props, mdat);
const deltaObject = (props: Uint8Array, mdat?: Uint8Array): Uint8Array =>
  headerObject(ELEMENT_TYPE_DELTA_HEADER, props, mdat);

/** Synthetic InitContext matching the Go tests' buildSyntheticMoov:
 * timescale 90000, trex dur 3000, size 1000, flags 0x01010000. */
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

const DEF_FLAGS = 0x01010000;
const IDR_FLAGS = 0x02000000;

// -----------------------------------------------------------------------------
// Full / delta decoding
// -----------------------------------------------------------------------------

describe("golden full object", () => {
  it("decodes the pinned wire bytes to the pinned effective values", () => {
    // n=2, BMDT 90000, sizes 800/700, durations at the trex default,
    // IDR first sample via trunFirstSampleFlags.
    const wantHeader = hex(
      "020f" + // element_type 2, properties_length 15
        "01" +
        "02" +
        "8320" + // field 1, 2 bytes, [vi64(800)]
        "0a" +
        "c15f90" + // field 10, vi64(90000)
        "0c" +
        "e2000000" + // field 12, vi64(0x02000000)
        "0e" +
        "02", // field 14, vi64(2)
    );
    const payload = cat(fill(800, 0xaa), fill(700, 0xbb));
    const obj = cat(wantHeader, payload);

    const { eff, raw } = decodeObject(obj, new LocmafGroupState(), makeCtx());
    expect(raw).toBeUndefined();
    expect(eff).toBeDefined();
    expect(eff!.sampleCount).toBe(2);
    expect(eff!.bmdt).toBe(90000n);
    expect(eff!.sizes).toEqual([800, 700]);
    expect(eff!.durations).toEqual([3000, 3000]);
    expect(eff!.flags).toEqual([IDR_FLAGS, DEF_FLAGS]);
    expect(eff!.ctos).toEqual([0, 0]);
    expect(eff!.sampleDescriptionIndex).toBe(1);
    expect(eff!.genBoxes).toEqual([]);
    expect(eff!.hasSubsamples).toBe(false);
    expect(eff!.perSampleIVSize).toBe(0);
    expect(eff!.mdatPayload).toEqual(payload);
  });
});

describe("delta sequence", () => {
  it("derives BMDT across deltas without ID 10 on the wire", () => {
    const ctx = makeCtx();
    const state = new LocmafGroupState();

    // Full: n=3, BMDT 0, sizes 1000/1010/1020 via ID 1 (n-1 entries).
    const full = fullObject(
      cat(
        listField(fieldIDs.trunSampleSizes, unsignedList([1000, 1010])),
        scalarField(fieldIDs.tfdtBaseMediaDecodeTime, 0),
        scalarField(fieldIDs.trunSampleCount, 3),
      ),
      fill(3030, 0x55),
    );
    const eff0 = decodeObject(full, state, ctx).eff!;
    expect(eff0.bmdt).toBe(0n);
    expect(eff0.sizes).toEqual([1000, 1010, 1020]);

    // Delta: sizes +100 each; BMDT derived as 0 + 3*3000.
    const delta1 = deltaObject(
      listField(fieldIDs.trunSampleSizes, zigzagList([100, 100])),
      fill(3330, 0x55),
    );
    const eff1 = decodeObject(delta1, state, ctx).eff!;
    expect(eff1.bmdt).toBe(9000n);
    expect(eff1.sizes).toEqual([1100, 1110, 1120]);

    // Empty delta: everything inherited; BMDT keeps advancing.
    const delta2 = deltaObject(new Uint8Array(0), fill(3330, 0x55));
    const eff2 = decodeObject(delta2, state, ctx).eff!;
    expect(eff2.bmdt).toBe(18000n);
    expect(eff2.sizes).toEqual([1100, 1110, 1120]);
    expect(eff2.sampleCount).toBe(3);
  });

  it("rejects a delta before any full header in the group", () => {
    const obj = deltaObject(new Uint8Array(0));
    expect(() => decodeObject(obj, new LocmafGroupState(), makeCtx())).toThrow(
      LocmafMalformedError,
    );
  });
});

describe("mid-group re-anchor", () => {
  it("a mid-group full header resets the reference for later deltas", () => {
    const ctx = makeCtx();
    const state = new LocmafGroupState();
    const props = (bmdt: number): Uint8Array =>
      cat(
        listField(fieldIDs.trunSampleSizes, unsignedList([900])),
        scalarField(fieldIDs.tfdtBaseMediaDecodeTime, bmdt),
        scalarField(fieldIDs.trunSampleCount, 2),
      );
    const payload = fill(1700, 0x11);

    expect(
      decodeObject(fullObject(props(0), payload), state, ctx).eff!.bmdt,
    ).toBe(0n);
    // Contiguous -> delta derives 0 + 2*3000.
    const eff2 = decodeObject(
      deltaObject(new Uint8Array(0), payload),
      state,
      ctx,
    ).eff!;
    expect(eff2.bmdt).toBe(6000n);
    // Splice: the encoder re-anchors with a full header.
    const eff3 = decodeObject(
      fullObject(props(500000), payload),
      state,
      ctx,
    ).eff!;
    expect(eff3.bmdt).toBe(500000n);
    // And the re-anchored reference carries the group forward.
    const eff4 = decodeObject(
      deltaObject(new Uint8Array(0), payload),
      state,
      ctx,
    ).eff!;
    expect(eff4.bmdt).toBe(506000n);
  });
});

describe("first-sample-flags deletion (ID 27)", () => {
  it("deleting ID 12 falls the first sample back to the default flags", () => {
    const ctx = makeCtx();
    const state = new LocmafGroupState();

    const full = fullObject(
      cat(
        scalarField(fieldIDs.tfhdDefaultSampleSize, 900),
        scalarField(fieldIDs.tfdtBaseMediaDecodeTime, 0),
        scalarField(fieldIDs.trunFirstSampleFlags, IDR_FLAGS),
        scalarField(fieldIDs.trunSampleCount, 3),
      ),
      fill(2700, 0xaa),
    );
    const eff1 = decodeObject(full, state, ctx).eff!;
    expect(eff1.flags).toEqual([IDR_FLAGS, DEF_FLAGS, DEF_FLAGS]);

    const delta = deltaObject(
      listField(
        fieldIDs.deltaDeletedLocmafIDs,
        unsignedList([fieldIDs.trunFirstSampleFlags]),
      ),
      fill(2700, 0xbb),
    );
    const eff2 = decodeObject(delta, state, ctx).eff!;
    expect(eff2.flags).toEqual([DEF_FLAGS, DEF_FLAGS, DEF_FLAGS]);
    expect(eff2.bmdt).toBe(9000n);
  });
});

describe("list length changes", () => {
  it("grows and shrinks per-sample lists across deltas (n 2→4→1→3)", () => {
    const ctx = makeCtx();
    const state = new LocmafGroupState();

    // Chunk 0 (full): n=2, sizes [1000, 1007].
    const full = fullObject(
      cat(
        listField(fieldIDs.trunSampleSizes, unsignedList([1000])),
        scalarField(fieldIDs.tfdtBaseMediaDecodeTime, 0),
        scalarField(fieldIDs.trunSampleCount, 2),
      ),
      fill(2007, 0x33),
    );
    const eff0 = decodeObject(full, state, ctx).eff!;
    expect(eff0.sizes).toEqual([1000, 1007]);

    // Chunk 1 (delta): n=4. The wire list carries n-1=3 entries: deltas
    // against the previous list where it exists, absolute beyond it.
    const delta1 = deltaObject(
      cat(
        listField(fieldIDs.trunSampleSizes, zigzagList([0, 1007, 1014])),
        deltaScalarField(fieldIDs.trunSampleCount, 2),
      ),
      fill(4042, 0x33),
    );
    const eff1 = decodeObject(delta1, state, ctx).eff!;
    expect(eff1.sampleCount).toBe(4);
    expect(eff1.sizes).toEqual([1000, 1007, 1014, 1021]);
    expect(eff1.bmdt).toBe(6000n);

    // Chunk 2 (delta): n=1. The inherited size list truncates to n-1=0
    // entries (present-but-empty), so the lone size derives from P.
    const delta2 = deltaObject(
      deltaScalarField(fieldIDs.trunSampleCount, -3),
      fill(1000, 0x33),
    );
    const eff2 = decodeObject(delta2, state, ctx).eff!;
    expect(eff2.sampleCount).toBe(1);
    expect(eff2.sizes).toEqual([1000]);
    expect(eff2.bmdt).toBe(18000n);

    // Chunk 3 (delta): n=3, growing from the empty list — all entries
    // absolute.
    const delta3 = deltaObject(
      cat(
        listField(fieldIDs.trunSampleSizes, zigzagList([1000, 1007])),
        deltaScalarField(fieldIDs.trunSampleCount, 2),
      ),
      fill(3021, 0x33),
    );
    const eff3 = decodeObject(delta3, state, ctx).eff!;
    expect(eff3.sampleCount).toBe(3);
    expect(eff3.sizes).toEqual([1000, 1007, 1014]);
    expect(eff3.bmdt).toBe(21000n);
  });

  it("shrinks to zero samples (event-only tail chunk)", () => {
    const ctx = makeCtx();
    const state = new LocmafGroupState();
    const full = fullObject(
      cat(
        listField(fieldIDs.trunSampleSizes, unsignedList([800, 700])),
        scalarField(fieldIDs.tfdtBaseMediaDecodeTime, 0),
        scalarField(fieldIDs.trunSampleCount, 3),
      ),
      fill(2100, 0xcc),
    );
    expect(decodeObject(full, state, ctx).eff!.sizes).toEqual([800, 700, 600]);

    const delta = deltaObject(deltaScalarField(fieldIDs.trunSampleCount, -3));
    const eff = decodeObject(delta, state, ctx).eff!;
    expect(eff.sampleCount).toBe(0);
    expect(eff.sizes).toEqual([]);
    expect(eff.bmdt).toBe(9000n);
  });
});

describe("sample-size derivation", () => {
  const mkObj = (n: number, mdatLen: number): Uint8Array =>
    fullObject(
      cat(
        listField(fieldIDs.trunSampleSizes, new Uint8Array(0)), // present, empty
        scalarField(fieldIDs.tfhdDefaultSampleSize, 5),
        scalarField(fieldIDs.tfdtBaseMediaDecodeTime, 0),
        scalarField(fieldIDs.trunSampleCount, n),
      ),
      fill(mdatLen, 0xee),
    );

  it("accepts a present-but-empty size list at n == 1 (size = P, ID 6 ignored)", () => {
    const eff = decodeObject(
      mkObj(1, 3),
      new LocmafGroupState(),
      makeCtx(),
    ).eff!;
    expect(eff.sizes).toEqual([3]);
  });

  it("rejects a present size list without exactly n-1 entries at n == 2", () => {
    expect(() =>
      decodeObject(mkObj(2, 10), new LocmafGroupState(), makeCtx()),
    ).toThrow(LocmafMalformedError);
  });

  it("skips unknown field IDs via the parity rule", () => {
    const props = cat(
      scalarField(fieldIDs.tfdtBaseMediaDecodeTime, 90000),
      scalarField(fieldIDs.trunSampleCount, 1),
      scalarField(98, 12345), // unknown scalar
      listField(99, Uint8Array.from([0xde, 0xad, 0xbf])), // unknown list
    );
    const eff = decodeObject(
      fullObject(props, fill(500, 0x42)),
      new LocmafGroupState(),
      makeCtx(),
    ).eff!;
    expect(eff.sampleCount).toBe(1);
    expect(eff.bmdt).toBe(90000n);
    expect(eff.sizes).toEqual([500]); // single-sample size from mdat length
  });
});

describe("CENC", () => {
  it("decodes per-sample IVs and subsample maps on a protected track", () => {
    const ctx = makeCtx({ protected: true, tencDefaultPerSampleIVSize: 8 });
    const ivs = fill(16, 0x0f);
    const props = cat(
      scalarField(fieldIDs.tfhdDefaultSampleSize, 800),
      listField(fieldIDs.sencInitializationVector, ivs),
      scalarField(fieldIDs.tfdtBaseMediaDecodeTime, 0),
      listField(fieldIDs.sencSubsampleCount, unsignedList([1, 1])),
      listField(fieldIDs.sencBytesOfClearData, unsignedList([7, 7])),
      scalarField(fieldIDs.trunSampleCount, 2),
      listField(fieldIDs.sencBytesOfProtectedData, unsignedList([793, 793])),
      scalarField(fieldIDs.sencPerSampleIVSize, 8),
    );
    const eff = decodeObject(
      fullObject(props, fill(1600, 0xee)),
      new LocmafGroupState(),
      ctx,
    ).eff!;
    expect(eff.perSampleIVSize).toBe(8);
    expect(eff.ivs).toEqual(ivs);
    expect(eff.hasSubsamples).toBe(true);
    expect(eff.subsampleCounts).toEqual([1, 1]);
    expect(eff.clearBytes).toEqual([7, 7]);
    expect(eff.protectedBytes).toEqual([793, 793]);
    expect(eff.sizes).toEqual([800, 800]);
  });

  it("rejects a subsample map that does not cover its sample exactly", () => {
    const ctx = makeCtx({ protected: true, tencDefaultPerSampleIVSize: 0 });
    const props = cat(
      scalarField(fieldIDs.tfhdDefaultSampleSize, 100),
      scalarField(fieldIDs.tfdtBaseMediaDecodeTime, 0),
      listField(fieldIDs.sencSubsampleCount, unsignedList([1])),
      listField(fieldIDs.sencBytesOfClearData, unsignedList([10])),
      scalarField(fieldIDs.trunSampleCount, 1),
      listField(fieldIDs.sencBytesOfProtectedData, unsignedList([20])), // 10+20 != 100
    );
    expect(() =>
      decodeObject(
        fullObject(props, fill(100, 0xee)),
        new LocmafGroupState(),
        ctx,
      ),
    ).toThrow(/subsample bytes/);
  });

  it("rejects CENC fields on an unprotected track", () => {
    const props = cat(
      listField(fieldIDs.sencInitializationVector, fill(8, 0x0f)),
      scalarField(fieldIDs.tfdtBaseMediaDecodeTime, 0),
      scalarField(fieldIDs.trunSampleCount, 1),
      scalarField(fieldIDs.sencPerSampleIVSize, 8),
    );
    expect(() =>
      decodeObject(
        fullObject(props, fill(100, 0xee)),
        new LocmafGroupState(),
        makeCtx({ protected: false }),
      ),
    ).toThrow(/unprotected/);
  });
});

describe("malformed objects", () => {
  const decode = (obj: Uint8Array): void => {
    decodeObject(obj, new LocmafGroupState(), makeCtx());
  };

  it("rejects an unknown element type (no skip for top-level elements)", () => {
    expect(() => decode(cat(u(99), u(0)))).toThrow(LocmafMalformedError);
  });

  it("rejects an empty object (ends before a header element)", () => {
    expect(() => decode(new Uint8Array(0))).toThrow(LocmafMalformedError);
  });

  it("rejects field 10 in a delta header (BMDT is derived-only)", () => {
    const ctx = makeCtx();
    const state = new LocmafGroupState();
    const full = fullObject(
      cat(
        scalarField(fieldIDs.tfdtBaseMediaDecodeTime, 0),
        scalarField(fieldIDs.trunSampleCount, 1),
      ),
      fill(1000, 0x77),
    );
    decodeObject(full, state, ctx);
    const delta = deltaObject(
      deltaScalarField(fieldIDs.tfdtBaseMediaDecodeTime, 3000),
      fill(1000, 0x77),
    );
    expect(() => decodeObject(delta, state, ctx)).toThrow(LocmafMalformedError);
  });

  it("rejects field 27 in a full header (deletion marker is delta-only)", () => {
    const props = cat(
      scalarField(fieldIDs.tfdtBaseMediaDecodeTime, 0),
      scalarField(fieldIDs.trunSampleCount, 0),
      listField(fieldIDs.deltaDeletedLocmafIDs, unsignedList([12])),
    );
    expect(() => decode(fullObject(props))).toThrow(LocmafMalformedError);
  });

  it("rejects a repeated field ID in one property block", () => {
    const props = cat(
      scalarField(fieldIDs.trunSampleCount, 0),
      scalarField(fieldIDs.trunSampleCount, 0),
    );
    expect(() => decode(fullObject(props))).toThrow(LocmafMalformedError);
  });

  it("rejects zero samples with a non-empty mdat payload", () => {
    const props = cat(
      scalarField(fieldIDs.tfdtBaseMediaDecodeTime, 0),
      scalarField(fieldIDs.trunSampleCount, 0),
    );
    expect(() => decode(fullObject(props, Uint8Array.from([0x01])))).toThrow(
      LocmafMalformedError,
    );
  });

  it("rejects a property block that exceeds the object payload", () => {
    // properties_length 5 but only 2 bytes remain.
    const obj = cat(u(ELEMENT_TYPE_FULL_HEADER), u(5), [0x0e, 0x00]);
    expect(() => decode(obj)).toThrow(LocmafMalformedError);
  });

  it("rejects a truncated vi64 inside the property block", () => {
    // Field id 14, scalar value 0xC1 declares 3 bytes but the block ends.
    const obj = cat(u(ELEMENT_TYPE_FULL_HEADER), u(2), [0x0e, 0xc1]);
    expect(() => decode(obj)).toThrow(LocmafMalformedError);
  });
});

describe("genBox", () => {
  it("carries pre-moof boxes verbatim, in payload order", () => {
    const prftPayload = Uint8Array.from([
      0, 0, 0, 0, 0, 0, 0, 1, 0x12, 0x34, 0x56, 0x78, 0, 0, 0, 0, 0, 0, 0, 2,
    ]);
    const emsgPayload = cat(
      [1, 0, 0, 0],
      new TextEncoder().encode("scheme\0value\0"),
    );
    const header = cat(
      u(1),
      u(4 + prftPayload.length),
      new TextEncoder().encode("prft"),
      prftPayload,
      u(1),
      u(4 + emsgPayload.length),
      new TextEncoder().encode("emsg"),
      emsgPayload,
    );
    const props = cat(
      scalarField(fieldIDs.tfdtBaseMediaDecodeTime, 0),
      scalarField(fieldIDs.trunSampleCount, 1),
    );
    const obj = cat(header, fullObject(props, fill(600, 0x99)));

    const eff = decodeObject(obj, new LocmafGroupState(), makeCtx()).eff!;
    expect(eff.genBoxes).toHaveLength(2);
    expect(eff.genBoxes[0].name).toBe("prft");
    expect(eff.genBoxes[0].payload).toEqual(prftPayload);
    expect(eff.genBoxes[1].name).toBe("emsg");
    expect(eff.genBoxes[1].payload).toEqual(emsgPayload);
    expect(eff.sizes).toEqual([600]);
  });
});

// -----------------------------------------------------------------------------
// rawBoxes (element type 4)
// -----------------------------------------------------------------------------

/** A valid rawBoxes content: a 16-byte ftyp followed by an 8-byte free. */
const testBoxes = (): Uint8Array =>
  hex(
    "00000010" + "66747970" + "636d6632" + "00000000" + "00000008" + "66726565",
  );

describe("rawBoxes", () => {
  it("passes complete boxes through verbatim (element 4, no length)", () => {
    const boxes = testBoxes();
    const obj = cat(u(ELEMENT_TYPE_RAW_BOXES), boxes);
    const { eff, raw } = decodeObject(obj, new LocmafGroupState(), makeCtx());
    expect(eff).toBeUndefined();
    expect(raw).toBeDefined();
    expect(raw).toEqual(boxes);
  });

  it("resets the in-group delta state", () => {
    const ctx = makeCtx();
    const state = new LocmafGroupState();
    const full = fullObject(
      cat(
        scalarField(fieldIDs.tfdtBaseMediaDecodeTime, 90000),
        scalarField(fieldIDs.trunSampleCount, 1),
      ),
      fill(700, 0xaa),
    );
    const delta = deltaObject(new Uint8Array(0), fill(700, 0xaa));

    decodeObject(full, state, ctx);
    const rawObj = cat(u(ELEMENT_TYPE_RAW_BOXES), testBoxes());
    expect(decodeObject(rawObj, state, ctx).raw).toBeDefined();
    // A delta directly after rawBoxes is rejected...
    expect(() => decodeObject(delta, state, ctx)).toThrow(LocmafMalformedError);
    // ...and a re-anchoring full header decodes.
    expect(decodeObject(full, state, ctx).eff).toBeDefined();
  });

  it.each([
    ["empty content", cat(u(4))],
    ["box size 0 (to-end-of-file escape)", cat(u(4), [0, 0, 0, 0], "free")],
    ["box size 1 (largesize escape)", cat(u(4), [0, 0, 0, 1], "free")],
    ["truncated box header", cat(u(4), [0, 0, 0, 8])],
    ["box exceeds content", cat(u(4), [0, 0, 0, 9], "free")],
    ["trailing bytes after the last box", cat(u(4), testBoxes(), [0xff])],
    ["rawBoxes after a genBox", cat(u(1), u(4), "styp", u(4), testBoxes())],
  ] as Array<[string, Uint8Array]>)("rejects %s", (_name, obj) => {
    expect(() => decodeObject(obj, new LocmafGroupState(), makeCtx())).toThrow(
      LocmafMalformedError,
    );
  });
});

// -----------------------------------------------------------------------------
// State poisoning
// -----------------------------------------------------------------------------

describe("state poisoning", () => {
  it("a malformed object breaks in-group sync until a full re-anchors", () => {
    const ctx = makeCtx();
    const state = new LocmafGroupState();
    const full = fullObject(
      cat(
        scalarField(fieldIDs.tfdtBaseMediaDecodeTime, 0),
        scalarField(fieldIDs.trunSampleCount, 1),
      ),
      fill(700, 0xaa),
    );
    const delta = deltaObject(new Uint8Array(0), fill(700, 0xaa));

    expect(decodeObject(full, state, ctx).eff).toBeDefined();
    // Unknown element type poisons the state...
    expect(() => decodeObject(Uint8Array.from([0x63]), state, ctx)).toThrow(
      LocmafMalformedError,
    );
    // ...so the following delta must not apply...
    expect(() => decodeObject(delta, state, ctx)).toThrow(LocmafMalformedError);
    // ...but a later full header decodes.
    expect(decodeObject(full, state, ctx).eff).toBeDefined();
    // And now the delta chain works again.
    expect(decodeObject(delta, state, ctx).eff!.bmdt).toBe(3000n);
  });
});

// -----------------------------------------------------------------------------
// parseInitContext against the golden-vector corpus
// -----------------------------------------------------------------------------

const vectorsDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../locmaf/testdata/vectors",
);

const readVector = (rel: string): Uint8Array =>
  new Uint8Array(fs.readFileSync(path.join(vectorsDir, rel)));

const corpusPresent = fs.existsSync(vectorsDir);
const describeCorpus = corpusPresent ? describe : describe.skip;

describeCorpus("parseInitContext (golden corpus)", () => {
  it("parses the varying-sizes init (unprotected)", () => {
    const ctx = parseInitContext(readVector("varying-sizes/init.mp4"));
    expect(ctx.trackId).toBe(1);
    expect(ctx.timescale).toBe(90000);
    expect(ctx.trexDefaultSampleDescriptionIndex).toBe(1);
    expect(ctx.trexDefaultSampleDuration).toBe(3000);
    expect(ctx.trexDefaultSampleSize).toBe(0);
    expect(ctx.trexDefaultSampleFlags).toBe(0x01010000);
    expect(ctx.protected).toBe(false);
    expect(ctx.tencDefaultPerSampleIVSize).toBe(0);
  });

  it("parses the cenc-subsamples init (protected, IV size 8)", () => {
    const ctx = parseInitContext(readVector("cenc-subsamples/init.mp4"));
    expect(ctx.protected).toBe(true);
    expect(ctx.tencDefaultPerSampleIVSize).toBe(8);
    expect(ctx.timescale).toBe(90000);
  });

  it("decodes the varying-sizes objects to the pinned effective values", () => {
    const ctx = parseInitContext(readVector("varying-sizes/init.mp4"));
    const state = new LocmafGroupState();
    for (const name of ["g000_o000", "g000_o001", "g000_o002"]) {
      const obj = readVector(`varying-sizes/objects/${name}.locmafobj`);
      const want = JSON.parse(
        Buffer.from(
          readVector(`varying-sizes/effective/${name}.json`),
        ).toString("utf8"),
      );
      const eff = decodeObject(obj, state, ctx).eff!;
      expect(eff.sampleCount).toBe(want.sampleCount);
      expect(eff.bmdt).toBe(BigInt(want.bmdt));
      expect(eff.sampleDescriptionIndex).toBe(want.sampleDescriptionIndex);
      expect(eff.durations).toEqual(want.durations);
      expect(eff.sizes).toEqual(want.sizes);
      expect(eff.flags).toEqual(want.flags);
      expect(eff.ctos).toEqual(want.ctos);
      expect(eff.mdatPayload.length).toBe(want.mdatLength);
    }
  });
});
