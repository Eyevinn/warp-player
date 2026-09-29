import type { SubtitleStatsRow } from "./controller";
import type { SubtitleStats } from "./receiver";
import { subtitleFigures } from "./statsView";

function row(
  sampleEntry: string,
  stats: Partial<SubtitleStats>,
): SubtitleStatsRow {
  return {
    key: sampleEntry,
    track: { name: `subs_${sampleEntry}_en`, packaging: "locmaf" },
    sampleEntry,
    displayed: false,
    stats: {
      objects: 0,
      bytes: 0,
      samples: 0,
      mediaMs: 0,
      documentsParsed: 0,
      bodySplices: 0,
      xmlBytesParsed: 0,
      cueBoxesParsed: 0,
      noChangeSamples: 0,
      parseMs: 0,
      droppedSamples: 0,
      droppedObjects: 0,
      ...stats,
    },
  };
}

describe("subtitleFigures", () => {
  it("gives rates per second of received media", () => {
    const f = subtitleFigures(
      row("stpc", {
        objects: 50,
        bytes: 4000,
        samples: 50,
        mediaMs: 2000,
        documentsParsed: 6,
        xmlBytesParsed: 6000,
        noChangeSamples: 44,
        parseMs: 1,
        droppedSamples: 1,
        droppedObjects: 2,
      }),
    );
    expect(f).toEqual({
      kbps: 16,
      bytesPerObject: 80,
      parsedPerSec: 3,
      parsedUnit: "docs",
      xmlKBps: 3,
      parseMsPerSec: 0.5,
      noChangePct: 88,
      dropped: 3,
    });
  });

  it("counts cue boxes for WebVTT, and zeros before anything arrived", () => {
    expect(
      subtitleFigures(row("wvtc", { mediaMs: 1000, cueBoxesParsed: 1 }))
        .parsedUnit,
    ).toBe("cues");
    expect(subtitleFigures(row("wvtt", {})).kbps).toBe(0);
  });
});
