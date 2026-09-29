/**
 * The subtitle receiver against real mlmpub output: every format, as CMAF and
 * as LOCMAF, one MoQ object per 25 fps video frame. See
 * test/media-files/subtitles/README.md for how the fixtures were made.
 *
 * In each 1 s group one cue shows from the group start for 900 ms, so it ends
 * 20 ms into chunk 22 [880, 920).
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { SubtitleTrackReceiver, type SubtitleObject } from "./receiver";
import type { SubtitleCue } from "./types";

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../test/media-files/subtitles",
);

const FIRST_GROUP = 1_000_000;

function readInit(format: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(dir, `${format}_init.mp4`)));
}

/** Objects framed as group(u32) object(u32) length(u32) payload. */
function readObjects(format: string, packaging: string): SubtitleObject[] {
  const buf = new Uint8Array(
    fs.readFileSync(path.join(dir, `${format}_${packaging}.objs`)),
  );
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const objects: SubtitleObject[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const group = view.getUint32(pos);
    const object = view.getUint32(pos + 4);
    const len = view.getUint32(pos + 8);
    objects.push({
      location: { group: BigInt(group), object: BigInt(object) },
      data: buf.subarray(pos + 12, pos + 12 + len),
    });
    pos += 12 + len;
  }
  return objects;
}

interface Shown {
  start: number;
  end: number;
  cue: SubtitleCue;
}

function run(
  format: string,
  packaging: "cmaf" | "locmaf",
  drop?: (o: SubtitleObject) => boolean,
) {
  const shown: Shown[] = [];
  const warnings: string[] = [];
  const receiver = new SubtitleTrackReceiver({
    initSegment: readInit(format),
    packaging,
    sink: (start, end, cue) => shown.push({ start, end, cue }),
    onWarning: (w) => warnings.push(w),
  });
  for (const obj of readObjects(format, packaging)) {
    if (!drop?.(obj)) {
      receiver.receiveObject(obj);
    }
  }
  return { receiver, shown, warnings, stats: receiver.getStats() };
}

/** The text a cue shows, lines joined with "|". */
function cueText(cue: SubtitleCue): string {
  if (cue.kind === "vtt") {
    return cue.lines.map((l) => l.map((r) => r.text).join("")).join("|");
  }
  const texts: string[] = [];
  const walk = (n: ImscIsdElement): void => {
    if (n.kind === "br") {
      texts.push("|");
    }
    if (typeof n.text === "string") {
      texts.push(n.text);
    }
    (n.contents ?? []).forEach(walk);
  };
  cue.isd.contents.forEach(walk);
  return texts.join("");
}

/** Merge adjacent intervals of the same cue object, as the overlay does. */
function merged(shown: Shown[]): Shown[] {
  const out: Shown[] = [];
  for (const s of shown) {
    const last = out[out.length - 1];
    if (last && last.cue === s.cue && last.end === s.start) {
      last.end = s.end;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

const FORMATS = ["stpp", "stpc", "wvtt", "wvtc"] as const;
const GROUPS: Record<string, number> = { stpp: 1, stpc: 2, wvtt: 2, wvtc: 2 };

describe("SubtitleTrackReceiver on mlmpub output", () => {
  for (const format of FORMATS) {
    describe(format, () => {
      it("gates on the sample entry of the init segment", () => {
        const { receiver } = run(format, "cmaf");
        expect(receiver.sampleEntry).toBe(format);
        expect(receiver.isPaintModel).toBe(
          format === "stpc" || format === "wvtc",
        );
      });

      for (const packaging of ["cmaf", "locmaf"] as const) {
        it(`shows each group's cue for exactly 900 ms (${packaging})`, () => {
          const { shown, warnings, stats } = run(format, packaging);
          expect(warnings).toEqual([]);
          expect(stats.droppedSamples).toBe(0);
          expect(stats.droppedObjects).toBe(0);
          const groups = GROUPS[format];
          expect(stats.objects).toBe(25 * groups);
          expect(stats.mediaMs).toBe(1000 * groups);
          // One cue object per group, restated chunk after chunk.
          const intervals = merged(shown);
          expect(intervals).toHaveLength(groups);
          intervals.forEach((iv, g) => {
            const groupStart = (FIRST_GROUP + g) * 1000;
            expect(iv.start).toBe(groupStart);
            expect(iv.end).toBe(groupStart + 900);
            const utc = new Date(groupStart)
              .toISOString()
              .replace(".000Z", "Z");
            expect(cueText(iv.cue)).toBe(`${utc}|en # ${FIRST_GROUP + g}`);
          });
          // Clipped to the samples: no cue interval spans a chunk boundary.
          for (const s of shown) {
            expect(Math.floor((s.start % 1000) / 40)).toBe(
              Math.floor(((s.end - 1) % 1000) / 40),
            );
          }
        });
      }

      it("shows the same cues from CMAF and LOCMAF", () => {
        const key = (s: Shown) => `${s.start}-${s.end}-${s.cue.key}`;
        expect(run(format, "locmaf").shown.map(key)).toEqual(
          run(format, "cmaf").shown.map(key),
        );
      });
    });
  }

  it("parses every stpp document", () => {
    const { stats } = run("stpp", "cmaf");
    expect(stats.documentsParsed).toBe(25);
    expect(stats.noChangeSamples).toBe(0);
    expect(stats.xmlBytesParsed).toBeGreaterThan(25 * 1000);
  });

  it("parses only the changes of stpc: the head, the cue end and the clear", () => {
    const stpp = run("stpp", "cmaf").stats;
    const { stats } = run("stpc", "cmaf");
    // Per group: chunk 0 is a full document; chunks 22 (the end written) and
    // 23 (nothing on screen) are ttmb bodies; the other 22 are ttmn.
    expect(stats.documentsParsed).toBe(3 * 2);
    expect(stats.bodySplices).toBe(2 * 2);
    expect(stats.noChangeSamples).toBe(22 * 2);
    expect(stats.xmlBytesParsed / 2).toBeLessThan(stpp.xmlBytesParsed / 5);
  });

  it("parses one wvtc cue box per cue, against one per chunk for wvtt", () => {
    const wvtt = run("wvtt", "cmaf").stats;
    const wvtc = run("wvtc", "cmaf").stats;
    expect(wvtt.cueBoxesParsed).toBe(23 * 2);
    expect(wvtt.samples).toBe(26 * 2); // Chunk 22 is split at the cue end.
    expect(wvtc.cueBoxesParsed).toBe(1 * 2);
    // vttn: chunks 1-21, the cue part of 22, and the idle chunks 23 and 24.
    expect(wvtc.noChangeSamples).toBe(24 * 2);
  });

  it("counts LOCMAF bytes smaller than CMAF bytes for every format", () => {
    for (const format of FORMATS) {
      expect(run(format, "locmaf").stats.bytes).toBeLessThan(
        run(format, "cmaf").stats.bytes,
      );
    }
  });

  for (const packaging of ["cmaf", "locmaf"] as const) {
    it(`shows nothing of a group whose first object was lost, then recovers (${packaging})`, () => {
      for (const format of ["stpc", "wvtc"]) {
        const lost = (o: SubtitleObject) =>
          o.location.group === BigInt(FIRST_GROUP) && o.location.object === 0n;
        const { shown, stats } = run(format, packaging, lost);
        // CMAF drops the dependent samples; LOCMAF cannot even decode the delta objects.
        expect(stats.droppedSamples + stats.droppedObjects).toBeGreaterThan(0);
        const intervals = merged(shown);
        expect(intervals).toHaveLength(1);
        expect(intervals[0].start).toBe((FIRST_GROUP + 1) * 1000);
        expect(intervals[0].end).toBe((FIRST_GROUP + 1) * 1000 + 900);
      }
    });
  }

  it("keeps parsing and counting without a sink", () => {
    const receiver = new SubtitleTrackReceiver({
      initSegment: readInit("stpc"),
      packaging: "cmaf",
    });
    for (const obj of readObjects("stpc", "cmaf")) {
      receiver.receiveObject(obj);
    }
    expect(receiver.getStats().documentsParsed).toBe(6);
  });

  it("rejects an init segment that is not a text track", () => {
    const video = new Uint8Array(
      fs.readFileSync(path.join(dir, "../scale_init.mp4")),
    );
    expect(
      () =>
        new SubtitleTrackReceiver({ initSegment: video, packaging: "cmaf" }),
    ).toThrow(/not a subtitle track/);
  });
});
