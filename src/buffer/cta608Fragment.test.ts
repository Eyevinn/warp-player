/**
 * CTA-608 extraction from CMAF fragments on the MSE path.
 *
 * Fixtures: `test/media-files/cta608/608_h264.m4s` and `608_h265.m4s`, copied
 * from the Common Media Library (Apache-2.0) — see the README next to them.
 * Between them they cover both NAL header sizes and both `trun`/`tfhd`
 * shapes (per-sample durations vs `tfhd.default_sample_duration`), and both
 * carry composition-time offsets.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import * as ISOBoxer from "codem-isoboxer";

import { snapshotRowText, snapshotText } from "../cc608/snapshot";
import { Cc608Source } from "../cc608/source";
import type { Cc608Sink, Cc608Snapshot } from "../cc608/types";
import { reconstructCanonical } from "../locmaf/v03/reconstruct";
import type { EffectiveValues, InitContext } from "../locmaf/v03/types";
import { LogLevel, type ILogger } from "../logger";

import { extractCta608FromFragment } from "./cta608Fragment";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, "../../test/media-files/cta608");

/** Silent logger: several cases exercise warn paths on purpose. */
const logger: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  getCategory: () => "cta608-test",
  setLevel: (_level: LogLevel) => undefined,
};

/** Timescales are pinned by the fixtures' own content — see their README. */
const FIXTURES = [
  { name: "AVC", file: "608_h264.m4s", timescale: 90000, offsetSec: 66 },
  { name: "HEVC", file: "608_h265.m4s", timescale: 15360, offsetSec: 0 },
] as const;

function readFixture(file: string): ArrayBuffer {
  const buf = fs.readFileSync(path.join(fixtureDir, file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

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

function runFragment(
  fragment: ArrayBuffer,
  timescale: number,
): { sink: RecordingSink; source: Cc608Source; fed: number } {
  const sink = new RecordingSink();
  const source = new Cc608Source(sink, logger);
  const fed = extractCta608FromFragment(fragment, timescale, source, logger);
  return { sink, source, fed };
}

describe("extractCta608FromFragment", () => {
  describe.each(FIXTURES)("$name fixture", ({ file, timescale, offsetSec }) => {
    let fragment: ArrayBuffer;

    beforeAll(() => {
      fragment = readFixture(file);
    });

    test("walks all 60 samples of the fragment", () => {
      const { fed, source } = runFragment(fragment, timescale);
      expect(fed).toBe(60);
      expect(source.getStats()).toEqual({ samplesSeen: 60, samplesWithCc: 2 });
    });

    test("yields the two expected screens at the expected times", () => {
      const { sink } = runFragment(fragment, timescale);

      expect(sink.pushes).toHaveLength(2);

      const [first, second] = sink.pushes;
      expect(snapshotText(first.screen!)).toBe("eng: 00:01:06:00");
      expect(snapshotText(second.screen!)).toBe("eng: 00:01:07:00");

      // Presentation time of the caption sample: tfdt + Σ durations + cto.
      // The two captions are exactly one second apart, and the +66.7 ms is
      // the first frame's composition offset (two frames at 30 fps).
      expect(first.timeMs / 1000).toBeCloseTo(offsetSec + 1 / 15, 5);
      expect(second.timeMs / 1000).toBeCloseTo(offsetSec + 1 + 1 / 15, 5);
    });

    test("the two screens differ by row, which is what defeats the dedupe", () => {
      const { sink } = runFragment(fragment, timescale);
      expect(sink.pushes[0].screen!.rows.map((r) => r.row)).toEqual([10]);
      expect(sink.pushes[1].screen!.rows.map((r) => r.row)).toEqual([11]);
      expect(snapshotRowText(sink.pushes[0].screen!.rows[0])).toBe(
        "eng: 00:01:06:00",
      );
    });

    test("the captions are blue on black", () => {
      const { sink } = runFragment(fragment, timescale);
      const cell = sink.pushes[0].screen!.rows[0].cells[0];
      expect(cell.uchar).toBe("e");
      expect(cell.pen).toEqual({
        foreground: "blue",
        background: "black",
        underline: false,
        italics: false,
        flash: false,
      });
    });

    test("halving the timescale doubles the cue times", () => {
      const { sink } = runFragment(fragment, timescale / 2);
      expect(sink.pushes).toHaveLength(2);
      expect(sink.pushes[0].timeMs / 1000).toBeCloseTo(
        2 * (offsetSec + 1 / 15),
        5,
      );
    });

    test("no timescale is a no-op", () => {
      const { fed, sink } = runFragment(fragment, 0);
      expect(fed).toBe(0);
      expect(sink.pushes).toEqual([]);
    });
  });

  test("AVC and HEVC produce identical caption content", () => {
    const avc = runFragment(
      readFixture(FIXTURES[0].file),
      FIXTURES[0].timescale,
    );
    const hevc = runFragment(
      readFixture(FIXTURES[1].file),
      FIXTURES[1].timescale,
    );

    expect(hevc.sink.pushes.map((p) => p.screen)).toEqual(
      avc.sink.pushes.map((p) => p.screen),
    );
    // ...and at the same times once the tfdt difference is removed. The
    // caption samples sit at different *decode* indices in the two files
    // (30 vs 29), so this only holds because presentation time is used.
    hevc.sink.pushes.forEach((push, i) => {
      expect(push.timeMs).toBeCloseTo(avc.sink.pushes[i].timeMs - 66000, 6);
    });
  });

  test("composition offsets are applied, not ignored", () => {
    // Decode time of the AVC fixture's first sample is exactly 66 s; the
    // reported cue time is two frames later because of its cto of 6000.
    const { sink } = runFragment(readFixture(FIXTURES[0].file), 90000);
    expect(sink.pushes[0].timeMs).not.toBeCloseTo(66000, 3);
    expect(sink.pushes[0].timeMs).toBeCloseTo(66000 + (6000 / 90000) * 1000, 6);
  });

  test("empty and unparseable input is a no-op", () => {
    const sink = new RecordingSink();
    const source = new Cc608Source(sink, logger);
    expect(
      extractCta608FromFragment(new ArrayBuffer(0), 90000, source, logger),
    ).toBe(0);
    // 16 bytes of nonsense: the box walker finds no moof.
    expect(
      extractCta608FromFragment(
        new Uint8Array(16).buffer,
        90000,
        source,
        logger,
      ),
    ).toBe(0);
    expect(sink.pushes).toEqual([]);
  });

  test("an init segment (moov, no moof) is a no-op", () => {
    const initSegment = fs.readFileSync(
      path.resolve(__dirname, "../../test/media-files/scale_init.mp4"),
    );
    const ab = initSegment.buffer.slice(
      initSegment.byteOffset,
      initSegment.byteOffset + initSegment.byteLength,
    );
    const sink = new RecordingSink();
    const source = new Cc608Source(sink, logger);
    expect(extractCta608FromFragment(ab, 90000, source, logger)).toBe(0);
    expect(sink.pushes).toEqual([]);
  });

  test("a caption-free fragment clears the overlay exactly once", () => {
    const mediaSegment = fs.readFileSync(
      path.resolve(__dirname, "../../test/media-files/scale_frag.mp4"),
    );
    const ab = mediaSegment.buffer.slice(
      mediaSegment.byteOffset,
      mediaSegment.byteOffset + mediaSegment.byteLength,
    );
    const { fed, sink } = runFragment(ab, 90000);
    expect(fed).toBeGreaterThan(0);
    expect(sink.pushes).toHaveLength(1);
    expect(sink.pushes[0].screen).toBeNull();
  });
});

/**
 * The LOCMAF path reaches MSE as reconstructed CMAF bytes
 * (`decompressMoofWithTrackInfo` -> `reconstructCanonical`), so a hook on the
 * decoded fragment must serve it too. This rebuilds the AVC fixture's
 * fragment through exactly that reconstruction — a different moof with a
 * different box layout and a different `trun.data_offset` — and asserts the
 * extractor gets identical captions and times out of it.
 */
describe("LOCMAF-reconstructed fragments hit the same extractor", () => {
  const CMAF_TIMESCALE = 90000;

  /** Read the AVC fixture's trun/tfdt/mdat back out as LOCMAF effective values. */
  function effectiveFromFixture(): { ctx: InitContext; eff: EffectiveValues } {
    const fragment = readFixture(FIXTURES[0].file);
    const bytes = new Uint8Array(fragment);
    const parsed: any = ISOBoxer.parseBuffer(fragment);
    const find = (box: any, type: string): any =>
      box.boxes.find((b: any) => b.type === type);
    const moof = find(parsed, "moof");
    const traf = find(moof, "traf");
    const tfdt = find(traf, "tfdt");
    const trun = find(traf, "trun");
    const mdat = find(parsed, "mdat");

    const durations: number[] = [];
    const sizes: number[] = [];
    const flags: number[] = [];
    const ctos: number[] = [];
    for (const sample of trun.samples) {
      durations.push(sample.sample_duration);
      sizes.push(sample.sample_size);
      flags.push(sample.sample_flags);
      ctos.push(sample.sample_composition_time_offset ?? 0);
    }

    return {
      ctx: {
        trackId: 1,
        timescale: CMAF_TIMESCALE,
        trexDefaultSampleDescriptionIndex: 1,
        trexDefaultSampleDuration: 0,
        trexDefaultSampleSize: 0,
        trexDefaultSampleFlags: 0,
        protected: false,
        tencDefaultPerSampleIVSize: 0,
      },
      eff: {
        sampleCount: trun.sample_count,
        bmdt: BigInt(tfdt.baseMediaDecodeTime),
        sampleDescriptionIndex: 1,
        durations,
        sizes,
        flags,
        ctos,
        perSampleIVSize: 0,
        ivs: new Uint8Array(0),
        hasSubsamples: false,
        subsampleCounts: [],
        clearBytes: [],
        protectedBytes: [],
        genBoxes: [],
        mdatPayload: bytes.subarray(mdat._offset + 8, mdat._offset + mdat.size),
      },
    };
  }

  function rebuild(): ArrayBuffer {
    const { ctx, eff } = effectiveFromFixture();
    // sequenceNumber 7 == a MoQ group id, as playback passes it.
    const rebuilt = reconstructCanonical(ctx, eff, 7);
    return rebuilt.buffer.slice(
      rebuilt.byteOffset,
      rebuilt.byteOffset + rebuilt.byteLength,
    ) as ArrayBuffer;
  }

  test("the reconstruction really is a different byte layout", () => {
    const rebuilt = new Uint8Array(rebuild());
    const original = new Uint8Array(readFixture(FIXTURES[0].file));
    // No styp, a regenerated moof, a different trun.data_offset.
    expect(rebuilt.byteLength).not.toBe(original.byteLength);
    expect(Buffer.from(rebuilt).equals(Buffer.from(original))).toBe(false);
  });

  test("captions and times survive the reconstruction unchanged", () => {
    const viaLocmaf = runFragment(rebuild(), CMAF_TIMESCALE);
    const viaCmaf = runFragment(readFixture(FIXTURES[0].file), CMAF_TIMESCALE);

    expect(viaLocmaf.fed).toBe(60);
    expect(viaLocmaf.sink.pushes).toEqual(viaCmaf.sink.pushes);
    expect(snapshotText(viaLocmaf.sink.pushes[0].screen!)).toBe(
      "eng: 00:01:06:00",
    );
    expect(viaLocmaf.sink.pushes[0].timeMs / 1000).toBeCloseTo(66 + 1 / 15, 5);
  });
});
