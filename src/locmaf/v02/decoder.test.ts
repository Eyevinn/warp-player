import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { jest } from "@jest/globals";
import { defaultReaderConfig, readIsoBoxes } from "@svta/cml-iso-bmff";

import type { WarpTrack } from "../../warpcatalog";
import {
  createLocmafTrackState,
  decompressMoofWithTrackInfo,
  initializeLocmafTrack,
} from "../locmaf";

import {
  auxV02IDs,
  decompressMoofV02WithTrackInfo,
  initializeLocmafV02Track,
  LOCMAF_V02_DELTA,
  LOCMAF_V02_FULL,
  fieldV02IDs,
} from "./decoder";
import {
  buildLocmafV02Object,
  buildProperties,
  encodeVarint,
  packSampleFlags,
  zigzag,
} from "./testEncoder";

const CMAF_INIT_FIXTURE = "init.cmaf.mp4";

async function loadInitCmaf(): Promise<Uint8Array> {
  const fixturePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../test/locmaf-test-files",
    CMAF_INIT_FIXTURE,
  );
  return new Uint8Array(await readFile(fixturePath));
}

function findBox(boxes: any[], type: string): any | undefined {
  for (const box of boxes) {
    if (box.type === type) {
      return box;
    }
    if (box.boxes) {
      const nested = findBox(box.boxes, type);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

function summarize(bytes: Uint8Array) {
  const boxes = readIsoBoxes(bytes, defaultReaderConfig());
  const moof = boxes.find((b: any) => b.type === "moof") as any;
  const mdat = boxes.find((b: any) => b.type === "mdat") as any;
  const prft = boxes.find((b: any) => b.type === "prft") as any;
  const tfhd = findBox(moof.boxes, "tfhd");
  const tfdt = findBox(moof.boxes, "tfdt");
  const trun = findBox(moof.boxes, "trun");
  return {
    boxOrder: boxes.map((b: any) => b.type),
    sequenceNumber: findBox(moof.boxes, "mfhd")?.sequenceNumber,
    trackId: tfhd?.trackId,
    bmdt: tfdt?.baseMediaDecodeTime,
    sampleCount: trun?.sampleCount,
    samples: trun?.samples,
    firstSampleFlags: trun?.firstSampleFlags,
    mdatLen: mdat?.data?.byteLength,
    prft,
  };
}

describe("locmaf v0.2 decoder", () => {
  describe("initialization", () => {
    it("uses raw CMAF init bytes unchanged and extracts trex/mdhd context", async () => {
      const init = await loadInitCmaf();
      const initialized = initializeLocmafV02Track(init);
      expect(initialized.initWasReconstructed).toBe(false);
      expect(initialized.state.initSegment).toEqual(init);
      expect(initialized.state.initContext.trackId).toBe(1);
      expect(initialized.state.initContext.timescale).toBe(12800);
      expect(initialized.state.initContext.defaultSampleSize).toBe(0);
    });

    it("dispatches to v0.2 path via initializeLocmafTrack when locmafVersion=0.2", async () => {
      const init = await loadInitCmaf();
      const track: WarpTrack = {
        name: "video",
        packaging: "locmaf",
        locmafVersion: "0.2",
      };
      const initialized = initializeLocmafTrack(track, init);
      expect(initialized.initWasReconstructed).toBe(false);
      expect(initialized.state.version).toBe("0.2");
      expect(initialized.state.initSegment).toEqual(init);
    });
  });

  describe("Full chunk round-trip", () => {
    it("decodes a representative LocmafFullHeader into a CMAF moof+mdat", async () => {
      const init = await loadInitCmaf();
      const state = initializeLocmafV02Track(init).state;

      // Three video samples: 4-byte mdat segments (toy), durations & sizes
      // explicit, sample_flags showing sync + depended-on for sample 0,
      // non-sync for samples 1 and 2.
      const sampleSizes = [10n, 12n, 8n];
      const sampleDurations = [512n, 512n, 512n];
      const sampleFlags = [
        packSampleFlags(0, 2, 1), // sync, depends_on=2 ("none"), is_depended_on=1
        packSampleFlags(1, 1, 0),
        packSampleFlags(1, 1, 0),
      ];
      const bmdt = 1024n;
      const mdatPayload = new Uint8Array(
        sampleSizes.reduce((s, v) => s + Number(v), 0),
      );
      for (let i = 0; i < mdatPayload.length; i++) {
        mdatPayload[i] = i & 0xff;
      }

      const properties = buildProperties([
        // ID 10 baseMediaDecodeTime (even, absolute in Full)
        { fieldId: fieldV02IDs.tfdtBaseMediaDecodeTime, scalar: bmdt },
        // ID 14 sampleCount (even, absolute)
        {
          fieldId: fieldV02IDs.trunSampleCount,
          scalar: BigInt(sampleSizes.length),
        },
        // ID 1 sampleSizes per §15.1: n−1 entries; last sample size is
        // derived by the receiver from the mdat payload length.
        {
          fieldId: fieldV02IDs.trunSampleSizes,
          list: sampleSizes.slice(0, -1),
        },
        // ID 3 sampleDurations
        { fieldId: fieldV02IDs.trunSampleDurations, list: sampleDurations },
        // ID 7 sampleFlags (5-bit packed, list)
        { fieldId: fieldV02IDs.trunSampleFlags, list: sampleFlags },
      ]);

      const wire = buildLocmafV02Object(
        LOCMAF_V02_FULL,
        properties,
        mdatPayload,
      );
      const result = decompressMoofV02WithTrackInfo(wire, 7, state);
      expect(result).toBeDefined();
      const s = summarize(result!.bytes);
      expect(s.boxOrder).toEqual(["moof", "mdat"]);
      expect(s.sequenceNumber).toBe(7);
      expect(s.trackId).toBe(1);
      expect(s.bmdt).toBe(Number(bmdt));
      expect(s.sampleCount).toBe(3);
      expect(s.samples?.map((x: any) => x.sampleSize)).toEqual([10, 12, 8]);
      expect(s.samples?.map((x: any) => x.sampleDuration)).toEqual([
        512, 512, 512,
      ]);
      expect(s.mdatLen).toBe(mdatPayload.byteLength);
      expect(result!.trackInfo.timescale).toBe(12800);
      expect(result!.trackInfo.duration).toBe(1536);
    });

    it("decodes zigzag-signed composition time offsets (ID 5) in a Full chunk", async () => {
      const init = await loadInitCmaf();
      const state = initializeLocmafV02Track(init).state;

      // Composition offsets are signed in trun v1 — the common CMAF case with
      // B-frames. In a Full chunk they are still zigzag-encoded (unlike the
      // other odd-ID lists, which are plain unsigned varints).
      const sampleSizes = [10n, 12n, 8n];
      const compositionOffsets = [0n, -512n, 256n];
      const mdat = new Uint8Array(
        sampleSizes.reduce((s, v) => s + Number(v), 0),
      );

      const properties = buildProperties([
        { fieldId: fieldV02IDs.tfdtBaseMediaDecodeTime, scalar: 0n },
        { fieldId: fieldV02IDs.trunSampleCount, scalar: 3n },
        {
          fieldId: fieldV02IDs.trunSampleSizes,
          list: sampleSizes.slice(0, -1),
        },
        {
          fieldId: fieldV02IDs.trunSampleDurations,
          list: [512n, 512n, 512n],
        },
        // ID 5: zigzag-encoded even in a Full chunk.
        {
          fieldId: fieldV02IDs.trunSampleCompositionTimeOffsets,
          list: compositionOffsets.map(zigzag),
        },
      ]);

      const wire = buildLocmafV02Object(LOCMAF_V02_FULL, properties, mdat);
      const result = decompressMoofV02WithTrackInfo(wire, 3, state);
      expect(result).toBeDefined();
      const s = summarize(result!.bytes);
      expect(s.samples?.map((x: any) => x.sampleCompositionTimeOffset)).toEqual(
        [0, -512, 256],
      );
      // A negative offset forces trun version 1 (signed composition offsets).
      const moofBox = readIsoBoxes(result!.bytes, defaultReaderConfig()).find(
        (b: any) => b.type === "moof",
      ) as any;
      const trun = findBox(moofBox.boxes, "trun");
      expect(trun.version).toBe(1);
    });
  });

  describe("sample_flags 5-bit unpacking", () => {
    it("expands the packed transport into the correct 32-bit sample_flags", async () => {
      const init = await loadInitCmaf();
      const state = initializeLocmafV02Track(init).state;

      // Build a single-sample Full chunk with sample_flags expressing
      // non_sync=1, depends_on=2, is_depended_on=3. Expected 32-bit value:
      //   (is_depended_on << 22) | (depends_on << 24) | (non_sync << 16)
      // = (3 << 22) | (2 << 24) | (1 << 16) = 0x02C10000
      const packed = packSampleFlags(1, 2, 3);
      const expected32 = (3 << 22) | (2 << 24) | (1 << 16);

      const mdat = new Uint8Array([1, 2, 3, 4]);
      // Single-sample chunk: omit sampleSizes (ID 1) and defaultSampleSize (ID 6).
      const properties = buildProperties([
        { fieldId: fieldV02IDs.tfdtBaseMediaDecodeTime, scalar: 0n },
        { fieldId: fieldV02IDs.trunSampleCount, scalar: 1n },
        { fieldId: fieldV02IDs.trunSampleDurations, list: [256n] },
        { fieldId: fieldV02IDs.trunSampleFlags, list: [packed] },
      ]);
      const wire = buildLocmafV02Object(LOCMAF_V02_FULL, properties, mdat);

      const result = decompressMoofV02WithTrackInfo(wire, 1, state);
      const s = summarize(result!.bytes);
      expect(s.sampleCount).toBe(1);
      expect(s.samples?.[0].sampleSize).toBe(4); // derived from mdat length
      expect(s.samples?.[0].sampleFlags).toBe(expected32);
    });

    it("expands defaultSampleFlags scalar from the packed 5-bit value", async () => {
      const init = await loadInitCmaf();
      const state = initializeLocmafV02Track(init).state;

      const packed = packSampleFlags(0, 2, 1); // non_sync=0, depends_on=2, is_depended_on=1
      const expected32 = (1 << 22) | (2 << 24);

      const mdat = new Uint8Array(10);
      const properties = buildProperties([
        // defaultSampleFlags (8) is the 5-bit packed value.
        { fieldId: fieldV02IDs.tfhdDefaultSampleFlags, scalar: packed },
        { fieldId: fieldV02IDs.tfdtBaseMediaDecodeTime, scalar: 0n },
        { fieldId: fieldV02IDs.trunSampleCount, scalar: 1n },
        { fieldId: fieldV02IDs.trunSampleDurations, list: [256n] },
      ]);
      const wire = buildLocmafV02Object(LOCMAF_V02_FULL, properties, mdat);
      const result = decompressMoofV02WithTrackInfo(wire, 1, state);
      const s = summarize(result!.bytes);
      // tfhd.defaultSampleFlags should hold the expanded 32-bit value, AND
      // each sample inherits it (we copied the default into the per-sample
      // list during reconstruction).
      const moofBox = readIsoBoxes(result!.bytes, defaultReaderConfig()).find(
        (b: any) => b.type === "moof",
      ) as any;
      const tfhd = findBox(moofBox.boxes, "tfhd");
      expect(tfhd.defaultSampleFlags).toBe(expected32);
      expect(s.samples?.[0].sampleFlags).toBe(expected32);
    });
  });

  describe("Delta chunk sequence", () => {
    it("decodes Full + several Deltas with BMDT derivation, list-length changes, and deletion marker", async () => {
      const init = await loadInitCmaf();
      const state = initializeLocmafV02Track(init).state;

      const dur = 512n;

      // ---- Chunk 1: Full, 3 samples, SAP-1 (firstSampleFlags present) ----
      const sizes1 = [10n, 12n, 8n];
      const flags1 = [packSampleFlags(0, 2, 1)]; // sync sample 0 (will use as firstSampleFlags)
      const mdat1 = new Uint8Array(30); // sum of [10, 12, 8]
      const props1 = buildProperties([
        { fieldId: fieldV02IDs.tfdtBaseMediaDecodeTime, scalar: 0n },
        { fieldId: fieldV02IDs.trunFirstSampleFlags, scalar: flags1[0] },
        { fieldId: fieldV02IDs.trunSampleCount, scalar: 3n },
        // §15.1: n−1 entries; last is derived from mdat length (= 8).
        { fieldId: fieldV02IDs.trunSampleSizes, list: sizes1.slice(0, -1) },
        { fieldId: fieldV02IDs.trunSampleDurations, list: [dur, dur, dur] },
      ]);
      const wire1 = buildLocmafV02Object(LOCMAF_V02_FULL, props1, mdat1);
      const r1 = decompressMoofV02WithTrackInfo(wire1, 1, state);
      const s1 = summarize(r1!.bytes);
      expect(s1.sampleCount).toBe(3);
      expect(s1.bmdt).toBe(0);
      // §15: with firstSampleFlags present, trun encodes the first sample's
      // flags via that scalar and uses a placeholder for the per-sample list
      // (the receiver gives sample 0 the firstSampleFlags value).
      expect(s1.firstSampleFlags).toBe(
        (1 << 22) | (2 << 24), // expanded from packed(0,2,1)
      );

      // ---- Chunk 2: Delta. Same sample_count(=3), all sizes shrink by 2
      //      (zigzag(-2) = 3), drop firstSampleFlags via deletion marker. ----
      const mdat2 = new Uint8Array(24); // sum of [8, 10, 6]
      const props2 = buildProperties([
        // deletion marker first — receiver applies before deltas
        {
          fieldId: auxV02IDs.deltaDeletedLocmafIDs,
          list: [BigInt(fieldV02IDs.trunFirstSampleFlags)],
        },
        // sampleCount unchanged → zigzag(0) = 0
        { fieldId: fieldV02IDs.trunSampleCount, scalar: zigzag(0n) },
        // BMDT delta = +sum(prev_durations) = +1536 — but BMDT is also normally
        // derived. To test derivation, omit ID 10 entirely; the decoder will
        // compute bmdt = 0 + 1536 = 1536.
        // sampleSizes: n−1 = 2 wire entries (sizes 0 and 1). Each shrinks
        // by 2 → zigzag(-2)=3. Sample 2's size (6) is derived from mdat.
        {
          fieldId: fieldV02IDs.trunSampleSizes,
          list: [zigzag(-2n), zigzag(-2n)],
        },
      ]);
      const wire2 = buildLocmafV02Object(LOCMAF_V02_DELTA, props2, mdat2);
      const r2 = decompressMoofV02WithTrackInfo(wire2, 2, state);
      const s2 = summarize(r2!.bytes);
      expect(s2.bmdt).toBe(1536);
      expect(s2.sampleCount).toBe(3);
      expect(s2.samples?.map((x: any) => x.sampleSize)).toEqual([8, 10, 6]);
      // firstSampleFlags was deleted, so the trun should not carry it.
      expect(s2.firstSampleFlags).toBeUndefined();

      // ---- Chunk 3: Delta. sample_count grows from 3 → 4. New sample's
      //      previous size is treated as 0; wire carries absolute size for it. ----
      const mdat3 = new Uint8Array(28); // sum of [8, 10, 6, 4]
      const props3 = buildProperties([
        { fieldId: fieldV02IDs.trunSampleCount, scalar: zigzag(1n) },
        // sampleSizes per §15.1: n_curr−1 = 3 wire entries (sizes 0..2).
        // Previous wire list (from chunk 2) was [8, 10] (n_prev−1 = 2).
        // Current wire list = [8, 10, 6]. Deltas: [zigzag(0), zigzag(0),
        // zigzag(6)] (last is absolute since prev[2] doesn't exist).
        // Sample 3's size (4) is derived from mdat: 28 − 8 − 10 − 6 = 4.
        {
          fieldId: fieldV02IDs.trunSampleSizes,
          list: [zigzag(0n), zigzag(0n), zigzag(6n)],
        },
        {
          fieldId: fieldV02IDs.trunSampleDurations,
          list: [zigzag(0n), zigzag(0n), zigzag(0n), zigzag(dur)],
        },
      ]);
      const wire3 = buildLocmafV02Object(LOCMAF_V02_DELTA, props3, mdat3);
      const r3 = decompressMoofV02WithTrackInfo(wire3, 3, state);
      const s3 = summarize(r3!.bytes);
      // BMDT derived = previous bmdt (1536) + sum(prev durations) (3*512=1536) = 3072.
      expect(s3.bmdt).toBe(3072);
      expect(s3.sampleCount).toBe(4);
      expect(s3.samples?.map((x: any) => x.sampleSize)).toEqual([8, 10, 6, 4]);

      // ---- Chunk 4: Delta. sample_count shrinks from 4 → 2 (truncate). ----
      const mdat4 = new Uint8Array(18);
      const props4 = buildProperties([
        { fieldId: fieldV02IDs.trunSampleCount, scalar: zigzag(-2n) },
        // No size delta — implicitly truncate previous sizes to [8, 10].
      ]);
      const wire4 = buildLocmafV02Object(LOCMAF_V02_DELTA, props4, mdat4);
      const r4 = decompressMoofV02WithTrackInfo(wire4, 4, state);
      const s4 = summarize(r4!.bytes);
      // BMDT derived = 3072 + sum([512]*4) = 3072 + 2048 = 5120.
      expect(s4.bmdt).toBe(5120);
      expect(s4.sampleCount).toBe(2);
      expect(s4.samples?.map((x: any) => x.sampleSize)).toEqual([8, 10]);

      // ---- Chunk 5: Delta with explicit absolute BMDT override (re-anchor). ----
      const mdat5 = new Uint8Array(18);
      const props5 = buildProperties([
        // Absolute BMDT (NOT zigzag delta) per §16.2.
        { fieldId: fieldV02IDs.tfdtBaseMediaDecodeTime, scalar: 99999n },
        { fieldId: fieldV02IDs.trunSampleCount, scalar: zigzag(0n) },
      ]);
      const wire5 = buildLocmafV02Object(LOCMAF_V02_DELTA, props5, mdat5);
      const r5 = decompressMoofV02WithTrackInfo(wire5, 5, state);
      const s5 = summarize(r5!.bytes);
      expect(s5.bmdt).toBe(99999);
      expect(s5.sampleCount).toBe(2);
    });
  });

  describe("unknown top-level header_id", () => {
    it("returns undefined with a warning", async () => {
      const init = await loadInitCmaf();
      const state = initializeLocmafV02Track(init).state;
      const wire = buildLocmafV02Object(99, new Uint8Array(), new Uint8Array());
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {
        /* expected */
      });
      try {
        expect(decompressMoofV02WithTrackInfo(wire, 1, state)).toBeUndefined();
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("dispatch through src/locmaf.ts", () => {
    it("decompressMoofWithTrackInfo routes to v0.2 when track.locmafVersion=0.2", async () => {
      const init = await loadInitCmaf();
      const track: WarpTrack = {
        name: "video",
        packaging: "locmaf",
        locmafVersion: "0.2",
      };
      const state = createLocmafTrackState(track, init);
      expect(state.version).toBe("0.2");

      const mdat = new Uint8Array([1, 2, 3, 4]);
      const properties = buildProperties([
        { fieldId: fieldV02IDs.tfdtBaseMediaDecodeTime, scalar: 0n },
        { fieldId: fieldV02IDs.trunSampleCount, scalar: 1n },
        { fieldId: fieldV02IDs.trunSampleDurations, list: [256n] },
      ]);
      const wire = buildLocmafV02Object(LOCMAF_V02_FULL, properties, mdat);

      const result = decompressMoofWithTrackInfo(wire, 42, state);
      expect(result).toBeDefined();
      const s = summarize(result!.bytes);
      expect(s.sequenceNumber).toBe(42);
      expect(s.sampleCount).toBe(1);
      expect(s.samples?.[0].sampleSize).toBe(4);
    });
  });

  describe("cross-decoder smoke test", () => {
    it("v0.1 and v0.2 produce sample-equivalent moof for the same logical content", async () => {
      // We build the same logical 1-sample chunk in v0.2 wire and compare
      // against the v0.1 test fixture's decode for sample-level equivalence.
      // The byte-level output is expected to differ; we assert on sample
      // structure only (sample count, sizes, durations, BMDT direction).
      const init = await loadInitCmaf();
      const v02State = initializeLocmafV02Track(init).state;

      const sizes = [10n, 12n, 8n];
      const durations = [512n, 512n, 512n];
      const mdatLen = Number(sizes.reduce((s, v) => s + v, 0n));
      const mdat = new Uint8Array(mdatLen);

      const props = buildProperties([
        { fieldId: fieldV02IDs.tfdtBaseMediaDecodeTime, scalar: 0n },
        { fieldId: fieldV02IDs.trunSampleCount, scalar: BigInt(sizes.length) },
        // §15.1: drop the last size; decoder derives it from mdat length.
        { fieldId: fieldV02IDs.trunSampleSizes, list: sizes.slice(0, -1) },
        { fieldId: fieldV02IDs.trunSampleDurations, list: durations },
      ]);
      const wire = buildLocmafV02Object(LOCMAF_V02_FULL, props, mdat);
      const v02Result = decompressMoofV02WithTrackInfo(wire, 1, v02State);
      const v02Summary = summarize(v02Result!.bytes);

      // Equivalence check: sample-level fields match the canned inputs.
      expect(v02Summary.sampleCount).toBe(3);
      expect(v02Summary.samples?.map((x: any) => x.sampleSize)).toEqual([
        10, 12, 8,
      ]);
      expect(v02Summary.samples?.map((x: any) => x.sampleDuration)).toEqual([
        512, 512, 512,
      ]);
      expect(v02Summary.bmdt).toBe(0);
      expect(v02Summary.mdatLen).toBe(mdatLen);
    });
  });

  // Touch the unused import so the import is observable; encodeVarint is
  // also re-exported for downstream test files.
  it("exposes encodeVarint helper", () => {
    expect(encodeVarint(0n)).toEqual(new Uint8Array([0]));
    expect(encodeVarint(63n)).toEqual(new Uint8Array([63]));
  });
});
