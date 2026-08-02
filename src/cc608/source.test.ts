/**
 * Emission policy and lifecycle of {@link Cc608Source}.
 *
 * The samples here are synthesised: an AVC access unit is built around an SEI
 * NAL carrying the CTA-608 `cc_data` byte pairs, which lets each rule be
 * exercised on its own. Real-fixture coverage lives in
 * `src/buffer/cta608Fragment.test.ts`.
 */
import { extractCta608DataFromSample } from "@svta/cml-608";

import type { ILogger } from "../logger";

import { snapshotText } from "./snapshot";
import { Cc608Source } from "./source";
import type { Cc608Sink, Cc608Snapshot } from "./types";

const logger: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  getCategory: () => "cc608-test",
  setLevel: () => undefined,
};

interface Push {
  timeMs: number;
  screen: Cc608Snapshot | null;
}

class RecordingSink implements Cc608Sink {
  public readonly pushes: Push[] = [];
  public push(timeMs: number, screen: Cc608Snapshot | null): void {
    this.pushes.push({ timeMs, screen });
  }
}

/** Odd-parity byte, as CTA-608 requires on the wire. */
function parity(byte: number): number {
  let ones = 0;
  for (let i = 0; i < 7; i++) {
    if (byte & (1 << i)) {
      ones++;
    }
  }
  return ones % 2 === 0 ? byte | 0x80 : byte & 0x7f;
}

/** CTA-608 control code / character pair, parity applied. */
function pair(a: number, b: number): [number, number] {
  return [parity(a), parity(b)];
}

/** Text as CC1 character pairs (padded with a null control if odd). */
function textPairs(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 2) {
    const a = text.charCodeAt(i);
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
    out.push(...pair(a, b));
  }
  return out;
}

// CC1 (field 1, channel 1) control codes, from CTA-608-E table 53/54.
const RCL = pair(0x14, 0x20); // resume caption loading (pop-on)
const ENM = pair(0x14, 0x2e); // erase non-displayed memory
const EOC = pair(0x14, 0x2f); // end of caption (flip)
const EDM = pair(0x14, 0x2c); // erase displayed memory
/** PAC: row 15, white, no indent. */
const PAC_ROW15 = pair(0x14, 0x70);

/** A complete pop-on caption: build it, then flip it up. */
function popOn(text: string): number[] {
  return [...RCL, ...ENM, ...PAC_ROW15, ...textPairs(text), ...EOC];
}

/**
 * Wrap `ccData` (cc_data byte pairs) in a length-prefixed AVC SEI NAL that
 * `extractCta608DataFromSample` recognises, and hand back a DataView over it.
 */
function avcSampleWithCc(ccData: number[]): DataView {
  const ccCount = ccData.length / 2;
  const payload: number[] = [
    // user_data_registered_itu_t_t35
    0xb5, // itu_t_t35_country_code = USA
    0x00,
    0x31, // provider_code = ATSC
    0x47,
    0x41,
    0x39,
    0x34, // user_identifier "GA94"
    0x03, // user_data_type_code = cc_data
    0x40 | ccCount, // process_cc_data_flag | cc_count
    0xff, // em_data
  ];
  for (let i = 0; i < ccCount; i++) {
    payload.push(0xfc); // marker | cc_valid | cc_type=0 (field 1 / CC1)
    payload.push(ccData[2 * i]);
    payload.push(ccData[2 * i + 1]);
  }
  payload.push(0xff); // marker_bits

  const sei: number[] = [0x06, 0x04]; // nal_unit_type 6 (SEI), payloadType 4
  let remaining = payload.length;
  while (remaining >= 255) {
    sei.push(0xff);
    remaining -= 255;
  }
  sei.push(remaining);
  sei.push(...payload, 0x80); // rbsp_trailing_bits

  const bytes = new Uint8Array(4 + sei.length);
  new DataView(bytes.buffer).setUint32(0, sei.length);
  bytes.set(sei, 4);
  return new DataView(bytes.buffer);
}

/** An access unit with no captions at all. */
function emptyAvcSample(): DataView {
  const nal = [0x21, 0x00, 0x00, 0x00]; // non-IDR slice, contents irrelevant
  const bytes = new Uint8Array(4 + nal.length);
  new DataView(bytes.buffer).setUint32(0, nal.length);
  bytes.set(nal, 4);
  return new DataView(bytes.buffer);
}

function feed(source: Cc608Source, timeSec: number, view: DataView): void {
  source.addSample(timeSec, view, 0, view.byteLength);
}

describe("Cc608Source", () => {
  test("the synthetic samples really carry CC1 data the library can extract", () => {
    // Guards the rest of the suite: if the SEI shape were wrong, every test
    // below would pass vacuously by never producing a screen at all.
    const cc = popOn("HI");
    const view = avcSampleWithCc(cc);
    const fieldData = extractCta608DataFromSample(view, 0, view.byteLength);
    expect(fieldData[0]).toHaveLength(cc.length);
    expect(fieldData[1]).toEqual([]);

    const empty = emptyAvcSample();
    expect(extractCta608DataFromSample(empty, 0, empty.byteLength)).toEqual([
      [],
      [],
    ]);
  });

  test("a pop-on caption is pushed on the sample that flips it", () => {
    const sink = new RecordingSink();
    const source = new Cc608Source(sink, logger);

    feed(source, 1.0, emptyAvcSample());
    feed(source, 2.0, avcSampleWithCc(popOn("HELLO")));

    expect(sink.pushes).toHaveLength(2);
    expect(sink.pushes[0]).toEqual({ timeMs: 1000, screen: null });
    expect(sink.pushes[1].timeMs).toBe(2000);
    expect(snapshotText(sink.pushes[1].screen!)).toBe("HELLO");
  });

  test("an unchanged screen is not re-pushed", () => {
    const sink = new RecordingSink();
    const source = new Cc608Source(sink, logger);

    feed(source, 0.0, avcSampleWithCc(popOn("STABLE")));
    for (let i = 1; i <= 30; i++) {
      feed(source, i / 30, emptyAvcSample());
    }

    expect(sink.pushes).toHaveLength(1);
    expect(snapshotText(sink.pushes[0].screen!)).toBe("STABLE");
  });

  test("a new screen is pushed immediately, not one screen late", () => {
    const sink = new RecordingSink();
    const source = new Cc608Source(sink, logger);

    feed(source, 0.0, avcSampleWithCc(popOn("FIRST")));
    feed(source, 0.5, emptyAvcSample());
    feed(source, 1.0, avcSampleWithCc(popOn("SECOND")));

    // The library's own outputDataUpdate path would only reveal "FIRST" here;
    // cueSplitAtTime gives us "SECOND" on the very sample that flips it.
    expect(sink.pushes.map((p) => p.timeMs)).toEqual([0, 1000]);
    expect(snapshotText(sink.pushes[1].screen!)).toBe("SECOND");
  });

  test("an erase clears the overlay, and only once", () => {
    const sink = new RecordingSink();
    const source = new Cc608Source(sink, logger);

    feed(source, 0.0, avcSampleWithCc(popOn("GONE SOON")));
    feed(source, 1.0, avcSampleWithCc([...EDM]));
    feed(source, 1.1, emptyAvcSample());
    feed(source, 1.2, emptyAvcSample());

    expect(sink.pushes).toHaveLength(2);
    expect(sink.pushes[1]).toEqual({ timeMs: 1000, screen: null });
  });

  test("caption-free content pushes null exactly once", () => {
    const sink = new RecordingSink();
    const source = new Cc608Source(sink, logger);

    for (let i = 0; i < 50; i++) {
      feed(source, i / 25, emptyAvcSample());
    }

    expect(sink.pushes).toEqual([{ timeMs: 0, screen: null }]);
  });

  test("times are pushed in milliseconds and taken from the sample", () => {
    const sink = new RecordingSink();
    const source = new Cc608Source(sink, logger);
    feed(source, 1234.567, avcSampleWithCc(popOn("T")));
    expect(sink.pushes[0].timeMs).toBeCloseTo(1234567, 3);
  });

  describe("lifecycle", () => {
    test("reset discards 608 state so a stale caption cannot be flipped up", () => {
      const sink = new RecordingSink();
      const source = new Cc608Source(sink, logger);

      // Build a pop-on caption but do NOT flip it: exactly what a publisher
      // transmits in the group before the one carrying the EOC.
      feed(
        source,
        0.0,
        avcSampleWithCc([...RCL, ...ENM, ...PAC_ROW15, ...textPairs("STALE")]),
      );
      expect(sink.pushes).toEqual([{ timeMs: 0, screen: null }]);

      source.reset();

      // A joiner now hits the EOC without its build. With clean state that
      // flips an empty screen; with retained state it would flip "STALE".
      feed(source, 1.0, avcSampleWithCc([...EOC]));
      const last = sink.pushes[sink.pushes.length - 1];
      expect(last.screen).toBeNull();
      expect(sink.pushes.some((p) => p.screen !== null)).toBe(false);
    });

    test("without a reset the stale build really would surface", () => {
      // Documents why the reset above matters, rather than asserting it in prose.
      const sink = new RecordingSink();
      const source = new Cc608Source(sink, logger);

      feed(
        source,
        0.0,
        avcSampleWithCc([...RCL, ...ENM, ...PAC_ROW15, ...textPairs("STALE")]),
      );
      feed(source, 1.0, avcSampleWithCc([...EOC]));

      expect(snapshotText(sink.pushes[sink.pushes.length - 1].screen!)).toBe(
        "STALE",
      );
    });

    test("reset re-pushes the same screen rather than deduping across the gap", () => {
      const sink = new RecordingSink();
      const source = new Cc608Source(sink, logger);

      feed(source, 0.0, avcSampleWithCc(popOn("SAME")));
      source.reset();
      feed(source, 5.0, avcSampleWithCc(popOn("SAME")));

      expect(sink.pushes).toHaveLength(2);
      expect(sink.pushes.map((p) => p.timeMs)).toEqual([0, 5000]);
      expect(snapshotText(sink.pushes[1].screen!)).toBe("SAME");
    });

    test("reset clears the statistics", () => {
      const sink = new RecordingSink();
      const source = new Cc608Source(sink, logger);
      feed(source, 0.0, avcSampleWithCc(popOn("X")));
      expect(source.getStats()).toEqual({ samplesSeen: 1, samplesWithCc: 1 });
      source.reset();
      expect(source.getStats()).toEqual({ samplesSeen: 0, samplesWithCc: 0 });
    });
  });

  describe("bad input", () => {
    test("an out-of-range sample is ignored", () => {
      const sink = new RecordingSink();
      const source = new Cc608Source(sink, logger);
      const view = avcSampleWithCc(popOn("X"));
      source.addSample(0, view, 0, view.byteLength + 10);
      source.addSample(0, view, -1, 4);
      expect(sink.pushes).toEqual([]);
      expect(source.getStats().samplesSeen).toBe(0);
    });

    test("a non-finite or zero-length sample is ignored", () => {
      const sink = new RecordingSink();
      const source = new Cc608Source(sink, logger);
      const view = avcSampleWithCc(popOn("X"));
      source.addSample(Number.NaN, view, 0, view.byteLength);
      source.addSample(0, view, 0, 0);
      expect(sink.pushes).toEqual([]);
    });
  });
});
