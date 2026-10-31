import { Version } from "./version";
import {
  ByteReader,
  ByteWriter,
  type LocationFilter,
  LocationFilterType,
  PARAM_EXPIRES,
  PARAM_GROUP_ORDER,
  type Parameter,
  absoluteGroupEndFilter,
  absoluteRangeFilter,
  fetchRange18,
  fillParameter,
  locationFilterParameter,
  namespaceFields,
  nextObjectFilter,
  readParameters,
  relativeStartFilter,
  writeParameters,
} from "./wire18";

const decode = (fields: Uint8Array[]): string[] =>
  fields.map((f) => new TextDecoder().decode(f));

describe("namespaceFields", () => {
  it("splits a slash-joined namespace into one field per element", () => {
    expect(decode(namespaceFields("cmsf/clear"))).toEqual(["cmsf", "clear"]);
    expect(decode(namespaceFields("moq-test/interop"))).toEqual([
      "moq-test",
      "interop",
    ]);
    expect(decode(namespaceFields("a/b/c"))).toEqual(["a", "b", "c"]);
  });

  it("keeps a single-element namespace as one field", () => {
    expect(decode(namespaceFields("single"))).toEqual(["single"]);
  });

  it("drops empty fields, which cannot be encoded", () => {
    // Section 2.4.1: a Track Namespace Field MUST contain at least one byte.
    expect(decode(namespaceFields("/cmsf/clear"))).toEqual(["cmsf", "clear"]);
    expect(decode(namespaceFields("cmsf//clear"))).toEqual(["cmsf", "clear"]);
    expect(decode(namespaceFields("cmsf/clear/"))).toEqual(["cmsf", "clear"]);
    expect(namespaceFields("")).toEqual([]);
    expect(namespaceFields("/")).toEqual([]);
  });

  it("round-trips through the wire encoding", () => {
    // A namespace written as a tuple must read back as the same fields, so a
    // relay matching the prefix ("cmsf") sees a field it can compare against.
    const w = new ByteWriter(64);
    w.namespace(namespaceFields("cmsf/clear"));
    const r = new ByteReader(w.take());
    expect(decode(r.namespace())).toEqual(["cmsf", "clear"]);
  });
});

const writeParams = (params: Parameter[], version: Version): number[] => {
  const w = new ByteWriter(64);
  writeParameters(w, params, version);
  return [...w.take()];
};

const readParams = (bytes: number[], version: Version): Parameter[] => {
  const r = new ByteReader(new Uint8Array(bytes));
  const params = readParameters(r, version);
  expect(r.done).toBe(true);
  return params;
};

describe("LOCATION_FILTER", () => {
  // Draft-22 Section 9.20.9: no Length, the type alone selecting the fields
  // that follow, as WG issue #1991 converged. The vectors are moqtransport's.
  it.each<[string, LocationFilter, number[]]>([
    ["none", { type: LocationFilterType.None }, [0x00]],
    ["relative start", relativeStartFilter(1n), [0x01, 0x01]],
    [
      "absolute start",
      {
        type: LocationFilterType.AbsoluteStart,
        start: { group: 3n, object: 4n },
      },
      [0x02, 0x03, 0x04],
    ],
    [
      "absolute group end",
      absoluteGroupEndFilter({ group: 3n, object: 4n }, 5n),
      [0x03, 0x03, 0x04, 0x02],
    ],
    [
      "absolute range",
      absoluteRangeFilter({ group: 3n, object: 4n }, { group: 5n, object: 7n }),
      [0x04, 0x03, 0x04, 0x02, 0x07],
    ],
    ["next object", nextObjectFilter(), [0x05]],
  ])("draft-22 %s", (_, filter, value) => {
    const wire = [0x01, 0x21, ...value];
    const params = [locationFilterParameter(filter)];
    expect(writeParams(params, Version.DRAFT_22)).toEqual(wire);
    expect(readParams(wire, Version.DRAFT_22)).toEqual(params);
  });

  // Draft-18's SUBSCRIPTION_FILTER: a Length, then Filter Type 1-4, each
  // standing for one of draft-22's types.
  it.each<[string, LocationFilter, number[], LocationFilter | null]>([
    ["next group start", relativeStartFilter(0n), [0x01, 0x01], null],
    ["largest object", nextObjectFilter(), [0x01, 0x02], null],
    [
      "absolute start",
      {
        type: LocationFilterType.AbsoluteStart,
        start: { group: 3n, object: 4n },
      },
      [0x03, 0x03, 0x03, 0x04],
      null,
    ],
    [
      "absolute range",
      absoluteGroupEndFilter({ group: 3n, object: 4n }, 5n),
      [0x04, 0x04, 0x03, 0x04, 0x02],
      null,
    ],
    [
      "none, as an absolute start at zero",
      { type: LocationFilterType.None },
      [0x03, 0x03, 0x00, 0x00],
      {
        type: LocationFilterType.AbsoluteStart,
        start: { group: 0n, object: 0n },
      },
    ],
  ])("draft-18 %s", (_, filter, value, back) => {
    const wire = [0x01, 0x21, ...value];
    expect(
      writeParams([locationFilterParameter(filter)], Version.DRAFT_18),
    ).toEqual(wire);
    expect(readParams(wire, Version.DRAFT_18)).toEqual([
      locationFilterParameter(back ?? filter),
    ]);
  });

  it("refuses to send what draft-18 cannot say", () => {
    // Asking for something else would deliver what was not asked for.
    for (const filter of [
      relativeStartFilter(1n),
      absoluteRangeFilter({ group: 3n, object: 0n }, { group: 3n, object: 2n }),
    ]) {
      expect(() =>
        writeParams([locationFilterParameter(filter)], Version.DRAFT_18),
      ).toThrow(/draft-18/);
    }
  });

  it("rejects an unknown draft-22 filter type", () => {
    expect(() => readParams([0x01, 0x21, 0x06], Version.DRAFT_22)).toThrow(
      /location filter type/,
    );
  });
});

describe("FILL_PARAMETERS", () => {
  it("encodes a join at the current Group as moqtransport does", () => {
    // Draft-22 Section 3.5, with GROUP_ORDER in between so FILL_PARAMETERS is
    // delta-coded from it. 01 04 01 21 01 01 is WG issue #1991's example.
    const params = [
      locationFilterParameter(nextObjectFilter()),
      { type: PARAM_GROUP_ORDER, number: 1n },
      fillParameter([locationFilterParameter(relativeStartFilter(1n))]),
    ];
    // prettier-ignore
    const wire = [
      0x03, // Number of Parameters
      0x21, 0x05, // LOCATION_FILTER, Next Object
      0x01, 0x01, // GROUP_ORDER (delta 1), Ascending
      0x01, 0x04, // FILL_PARAMETERS (delta 1), Length 4
      0x01, // Number of Parameters
      0x21, 0x01, 0x01, // LOCATION_FILTER, Relative Start, the current Group
    ];
    expect(writeParams(params, Version.DRAFT_22)).toEqual(wire);
    expect(readParams(wire, Version.DRAFT_22)).toEqual(params);
  });

  it("is a draft-22 parameter only", () => {
    const fill = [fillParameter([])];
    expect(() => writeParams(fill, Version.DRAFT_18)).toThrow(/draft-18/);
    expect(() =>
      readParams([0x01, 0x23, 0x01, 0x00], Version.DRAFT_18),
    ).toThrow(/unknown message parameter/);
  });

  it("admits only its own registry inside", () => {
    // EXPIRES may be on a SUBSCRIBE, but not inside its FILL_PARAMETERS.
    expect(() =>
      writeParams(
        [fillParameter([{ type: PARAM_EXPIRES, number: 1n }])],
        Version.DRAFT_22,
      ),
    ).toThrow(/cannot be sent/);
  });
});

describe("fetchRange18", () => {
  it("writes an inclusive range as draft-18's end-plus-one", () => {
    expect(
      fetchRange18(
        absoluteRangeFilter(
          { group: 7n, object: 0n },
          { group: 7n, object: 2n },
        ),
      ),
    ).toEqual({
      start: { group: 7n, object: 0n },
      end: { group: 7n, object: 3n },
    });
  });

  it("writes a whole last Group as Object 0", () => {
    expect(
      fetchRange18(absoluteGroupEndFilter({ group: 0n, object: 0n }, 0n)),
    ).toEqual({
      start: { group: 0n, object: 0n },
      end: { group: 0n, object: 0n },
    });
  });

  it("cannot express a relative start", () => {
    expect(() => fetchRange18(relativeStartFilter(1n))).toThrow(/draft-18/);
  });
});
