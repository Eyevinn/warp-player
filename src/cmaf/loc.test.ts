import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readIsoBoxes, defaultReaderConfig } from "@svta/cml-iso-bmff";

import {
  LocMoofDeltaDecoder,
  assembleCmafFile,
  createLocMdatBox,
  decompressLocInit,
  decompressLocMoof,
  extractInitContextFromInitSegment,
  extractTrackMetadataFromInitSegment,
  getLocHeaderConstants,
} from "./loc";

async function loadFixture(name: string): Promise<Uint8Array> {
  const fixturePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../test/decompression-assets",
    name,
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

function summarizeMoof(bytes: Uint8Array) {
  const boxes = readIsoBoxes(bytes, defaultReaderConfig());
  const moof = boxes.find((box: { type: string }) => box.type === "moof");
  if (!moof || !("boxes" in moof)) {
    throw new Error("moof not found");
  }

  const mfhd = findBox(moof.boxes, "mfhd");
  const tfhd = findBox(moof.boxes, "tfhd");
  const tfdt = findBox(moof.boxes, "tfdt");
  const trun = findBox(moof.boxes, "trun");

  return {
    sequenceNumber: mfhd?.sequenceNumber,
    trackId: tfhd?.trackId,
    tfhdFlags: tfhd?.flags,
    defaultSampleDuration: tfhd?.defaultSampleDuration,
    defaultSampleSize: tfhd?.defaultSampleSize,
    defaultSampleFlags: tfhd?.defaultSampleFlags,
    baseMediaDecodeTime: tfdt?.baseMediaDecodeTime,
    trunFlags: trun?.flags,
    sampleCount: trun?.sampleCount,
    dataOffset: trun?.dataOffset,
    firstSampleFlags: trun?.firstSampleFlags,
    samples: trun?.samples,
  };
}

describe("LOC reconstruction", () => {
  it("reconstructs an init segment from the compressed header", async () => {
    const compressedInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const trackMetadata = extractTrackMetadataFromInitSegment(referenceInit);
    const reconstructed = decompressLocInit(compressedInit, trackMetadata, {
      referenceInitSegment: referenceInit,
    });

    const parsed = readIsoBoxes(reconstructed.bytes, defaultReaderConfig());
    const ftyp = parsed.find((box: { type: string }) => box.type === "ftyp");
    const moov = parsed.find((box: { type: string }) => box.type === "moov");
    const trex =
      moov && "boxes" in moov ? findBox(moov.boxes, "trex") : undefined;
    const stsd =
      moov && "boxes" in moov ? findBox(moov.boxes, "stsd") : undefined;
    const sampleEntry = stsd?.entries?.[0];
    const frma = sampleEntry?.boxes
      ? findBox(sampleEntry.boxes, "frma")
      : undefined;

    expect(ftyp).toBeDefined();
    expect(moov).toBeDefined();
    expect(sampleEntry?.type).toBe("encv");
    expect(sampleEntry?.width).toBe(1920);
    expect(sampleEntry?.height).toBe(1080);
    expect(frma?.dataFormat).toBeDefined();
    expect(trex?.trackId).toBe(1);
    expect(reconstructed.context.trackId).toBe(1);
  });

  it("reconstructs the same moof from normal and delta headers", async () => {
    const compressedInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const trackMetadata = extractTrackMetadataFromInitSegment(referenceInit);
    const { context } = decompressLocInit(compressedInit, trackMetadata, {
      referenceInitSegment: referenceInit,
    });

    const deltaDecoder = new LocMoofDeltaDecoder();
    const headers = getLocHeaderConstants();

    const normal0 = decompressLocMoof(
      await loadFixture("normalMoof-0"),
      1,
      context,
    );
    const normal1 = decompressLocMoof(
      await loadFixture("normalMoof-1"),
      2,
      context,
    );
    const normal2 = decompressLocMoof(
      await loadFixture("normalMoof-2"),
      3,
      context,
    );

    const delta0 = deltaDecoder.decode(
      headers.moof,
      await loadFixture("deltaMoof-0"),
      1,
      context,
    );
    const delta1 = deltaDecoder.decode(
      headers.moofDelta,
      await loadFixture("deltaMoof-1"),
      2,
      context,
    );
    const delta2 = deltaDecoder.decode(
      headers.moofDelta,
      await loadFixture("deltaMoof-2"),
      3,
      context,
    );

    expect(summarizeMoof(normal0.bytes)).toEqual(summarizeMoof(delta0.bytes));
    expect(summarizeMoof(normal1.bytes)).toEqual(summarizeMoof(delta1.bytes));
    expect(summarizeMoof(normal2.bytes)).toEqual(summarizeMoof(delta2.bytes));
  });

  it("assembles a playable CMAF file layout with init, moof and mdat", async () => {
    const compressedInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const trackMetadata = extractTrackMetadataFromInitSegment(referenceInit);
    const reconstructedInit = decompressLocInit(compressedInit, trackMetadata, {
      referenceInitSegment: referenceInit,
    });

    const context = extractInitContextFromInitSegment(reconstructedInit.bytes);
    for (const index of [0, 1, 2]) {
      const moof = decompressLocMoof(
        await loadFixture(`normalMoof-${index}`),
        index + 1,
        context,
      );
      const mdat = createLocMdatBox(await loadFixture(`mdat-${index}`));

      const cmafFile = assembleCmafFile({
        initSegment: reconstructedInit.bytes,
        moof: moof.box,
        mdat,
      });

      const parsed = readIsoBoxes(cmafFile, defaultReaderConfig());
      expect(parsed.map((box: { type: string }) => box.type)).toEqual([
        "ftyp",
        "moov",
        "moof",
        "mdat",
      ]);

      const moofSummary = summarizeMoof(moof.bytes);
      const totalSampleBytes = (moofSummary.samples ?? []).reduce(
        (sum: number, sample: any) => sum + (sample.sampleSize ?? 0),
        0,
      );

      expect(moofSummary.dataOffset).toBe(moof.bytes.byteLength + 8);
      expect(totalSampleBytes).toBe(mdat.data.byteLength);
    }
  });

  it("writes the reconstructed file bytes to disk", async () => {
    const compressedInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const trackMetadata = extractTrackMetadataFromInitSegment(referenceInit);
    const reconstructedInit = decompressLocInit(compressedInit, trackMetadata, {
      referenceInitSegment: referenceInit,
    });
    const bytesParts: Uint8Array[] = [reconstructedInit.bytes];
    for (const index of [0, 1, 2]) {
      const moof = decompressLocMoof(
        await loadFixture(`normalMoof-${index}`),
        index + 1,
        reconstructedInit.context,
      );
      const mdat = createLocMdatBox(await loadFixture(`mdat-${index}`));
      bytesParts.push(
        assembleCmafFile({
          initSegment: new Uint8Array(),
          moof: moof.box,
          mdat,
        }),
      );
    }
    const bytes = Uint8Array.from(
      bytesParts.flatMap((part) => Array.from(part)),
    );

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "warp-player-loc-"));
    const outputPath = path.join(tmpDir, "reconstructed.cmaf.mp4");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outputPath, bytes);

    const outputStat = await stat(outputPath);
    expect(outputStat.size).toBe(bytes.byteLength);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
