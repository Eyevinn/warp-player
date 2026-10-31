import {
  CtrlType,
  FetchType,
  decodeCtrlBody,
  encodeCtrlMessage,
  type Fetch,
} from "./messages18";
import { Version } from "./version";
import {
  PARAM_LARGEST_OBJECT,
  absoluteRangeFilter,
  fetchRange18,
  locationFilterParameter,
} from "./wire18";

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The body of an encoded message: past the type (one byte here) and the 16-bit length. */
const bodyOf = (frame: Uint8Array): number[] => {
  const length = (frame[1] << 8) | frame[2];
  expect(frame.length).toBe(3 + length);
  return [...frame.subarray(3)];
};

describe("FETCH", () => {
  const range = absoluteRangeFilter(
    { group: 0n, object: 0n },
    { group: 0n, object: 0n },
  );
  const track = { namespace: [ascii("a")], name: ascii("c") };

  it("carries its range as LOCATION_FILTER in draft-22", () => {
    const fetch: Fetch = {
      kind: CtrlType.Fetch,
      requestId: 2n,
      fetchType: FetchType.Standalone,
      standalone: track,
      parameters: [locationFilterParameter(range)],
    };
    const frame = encodeCtrlMessage(fetch, Version.DRAFT_22);
    expect(frame[0]).toBe(CtrlType.Fetch);
    // prettier-ignore
    const want = [
      0x02, // Request ID; no Fetch Type follows
      0x01, 0x01, 0x61, // Track Namespace (a)
      0x01, 0x63, // Track Name (c)
      0x01, 0x21, 0x04, 0x00, 0x00, 0x00, 0x00, // LOCATION_FILTER, {0,0}..{0,0}
    ];
    expect(bodyOf(frame)).toEqual(want);
  });

  it("carries explicit Start and End Locations in draft-18", () => {
    const fetch: Fetch = {
      kind: CtrlType.Fetch,
      requestId: 2n,
      fetchType: FetchType.Standalone,
      standalone: { ...track, ...fetchRange18(range) },
      parameters: [],
    };
    // prettier-ignore
    const want = [
      0x02, // Request ID
      0x01, // Fetch Type: standalone
      0x01, 0x01, 0x61, // Track Namespace (a)
      0x01, 0x63, // Track Name (c)
      0x00, 0x00, // Start Location {0,0}
      0x00, 0x01, // End Location: the last Object plus one
      0x00, // no parameters
    ];
    expect(bodyOf(encodeCtrlMessage(fetch, Version.DRAFT_18))).toEqual(want);
  });

  it("has no joining form in draft-22", () => {
    const joining: Fetch = {
      kind: CtrlType.Fetch,
      requestId: 4n,
      fetchType: FetchType.RelativeJoining,
      joining: { joiningRequestId: 2n, joiningStart: 0n },
      parameters: [],
    };
    expect(() => encodeCtrlMessage(joining, Version.DRAFT_22)).toThrow(
      /only standalone/,
    );
    expect(() => encodeCtrlMessage(joining, Version.DRAFT_18)).not.toThrow();
  });
});

describe("GOAWAY on the control stream", () => {
  // New Session URI "", Timeout 5, and in draft-18 a Request ID of 8.
  it("carries a Request ID in draft-18", () => {
    const msg = decodeCtrlBody(
      CtrlType.GoAway,
      new Uint8Array([0x00, 0x05, 0x08]),
      Version.DRAFT_18,
      true,
    );
    expect(msg).toEqual({
      kind: CtrlType.GoAway,
      newSessionUri: "",
      timeout: 5n,
      requestId: 8n,
    });
  });

  it("has none in draft-22", () => {
    const msg = decodeCtrlBody(
      CtrlType.GoAway,
      new Uint8Array([0x00, 0x05]),
      Version.DRAFT_22,
      true,
    );
    expect(msg).toEqual({
      kind: CtrlType.GoAway,
      newSessionUri: "",
      timeout: 5n,
    });
  });
});

describe("PUBLISH_STATE_NOTIFY", () => {
  // One parameter: LARGEST_OBJECT {3, 1}.
  const body = new Uint8Array([0x01, 0x09, 0x03, 0x01]);

  it("decodes in draft-22", () => {
    expect(
      decodeCtrlBody(CtrlType.PublishStateNotify, body, Version.DRAFT_22),
    ).toEqual({
      kind: CtrlType.PublishStateNotify,
      parameters: [
        { type: PARAM_LARGEST_OBJECT, location: { group: 3n, object: 1n } },
      ],
    });
  });

  it("does not exist in draft-18", () => {
    expect(() =>
      decodeCtrlBody(CtrlType.PublishStateNotify, body, Version.DRAFT_18),
    ).toThrow(/does not exist/);
  });
});
