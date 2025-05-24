import * as fs from "fs";
import * as path from "path";

import * as ISOBoxer from "codem-isoboxer";

describe("ISO Box Parsing", () => {
  // Helper function to read a file and convert it to ArrayBuffer
  function readFileAsArrayBuffer(filePath: string): ArrayBuffer {
    const buffer = fs.readFileSync(filePath);
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
  }

  // Test files - update these paths to point to your actual test files
  const initSegmentPath = path.resolve(__dirname, "../../test/scale_init.mp4");
  const mediaSegmentPath = path.resolve(__dirname, "../../test/scale_frag.mp4");

  let initSegment: ArrayBuffer;
  let mediaSegment: ArrayBuffer;

  beforeAll(() => {
    try {
      // Read test files
      initSegment = readFileAsArrayBuffer(initSegmentPath);
      mediaSegment = readFileAsArrayBuffer(mediaSegmentPath);
    } catch (error) {
      console.error("Error loading test files:", error);
    }
  });

  test("should parse init segment and extract timescale", () => {
    // Skip test if files couldn't be loaded
    if (!initSegment) {
      console.warn("Skipping test: Init segment file not loaded");
      return;
    }

    // Parse the init segment
    const parsed = ISOBoxer.parseBuffer(initSegment);

    // Find the moov box
    const moov = parsed.boxes
      ? parsed.boxes.find((box: any) => box.type === "moov")
      : parsed.type === "moov"
      ? parsed
      : undefined;
    expect(moov).toBeDefined();
    if (!moov || !moov.boxes) {
      fail("moov box or moov.boxes not found");
      return;
    }

    // Find the trak box
    const trak = moov.boxes.find((box: any) => box.type === "trak");
    expect(trak).toBeDefined();
    if (!trak || !trak.boxes) {
      fail("trak box or trak.boxes not found");
      return;
    }

    // Find the mdia box
    const mdia = trak.boxes.find((box: any) => box.type === "mdia");
    expect(mdia).toBeDefined();
    if (!mdia || !mdia.boxes) {
      fail("mdia box or mdia.boxes not found");
      return;
    }

    // Find the mdhd box
    const mdhd = mdia.boxes.find((box: any) => box.type === "mdhd");
    expect(mdhd).toBeDefined();
    if (!mdhd) {
      fail("mdhd box not found");
      return;
    }

    // Extract and verify timescale
    const timescale = mdhd.timescale;
    expect(timescale).toBe(48000);
  });

  test("should parse media segment and extract baseMediaDecodeTime and duration", () => {
    // Skip test if files couldn't be loaded
    if (!mediaSegment) {
      console.warn("Skipping test: Media segment file not loaded");
      return;
    }

    // Parse the media segment
    const parsed = ISOBoxer.parseBuffer(mediaSegment);

    // Find the moof box
    const moof = parsed.boxes
      ? parsed.boxes.find((box: any) => box.type === "moof")
      : parsed.type === "moof"
      ? parsed
      : undefined;
    expect(moof).toBeDefined();
    if (!moof || !moof.boxes) {
      fail("moof box or moof.boxes not found");
      return;
    }

    // Find the traf box
    const traf = moof.boxes.find((box: any) => box.type === "traf");
    expect(traf).toBeDefined();
    if (!traf || !traf.boxes) {
      fail("traf box or traf.boxes not found");
      return;
    }

    // Find the tfhd box to get default sample duration
    const tfhd = traf.boxes.find((box: any) => box.type === "tfhd");
    expect(tfhd).toBeDefined();
    if (!tfhd) {
      fail("tfhd box not found");
      return;
    }

    const defaultSampleDuration = tfhd.default_sample_duration;

    // Find the tfdt box to get baseMediaDecodeTime
    const tfdt = traf.boxes.find((box: any) => box.type === "tfdt");
    expect(tfdt).toBeDefined();
    if (!tfdt) {
      fail("tfdt box not found");
      return;
    }

    // Extract and verify baseMediaDecodeTime
    const baseMediaDecodeTime = tfdt.baseMediaDecodeTime;
    expect(baseMediaDecodeTime).toBe(83874483360768);

    // Find the trun box
    const trun = traf.boxes.find((box: any) => box.type === "trun");
    expect(trun).toBeDefined();
    if (!trun) {
      fail("trun box not found");
      return;
    }

    // Check trun properties

    // Calculate total duration
    let totalDuration = 0;

    if (trun.samples && trun.samples.length > 0) {
      // Sum up sample durations
      trun.samples.forEach((sample: any) => {
        if (sample.sample_duration) {
          totalDuration += sample.sample_duration;
        } else if (defaultSampleDuration) {
          totalDuration += defaultSampleDuration;
        }
      });
    } else if (defaultSampleDuration && trun.sample_count) {
      totalDuration = defaultSampleDuration * trun.sample_count;
    }

    // Verify the expected duration value
    expect(totalDuration).toBe(2048);
  });
});
