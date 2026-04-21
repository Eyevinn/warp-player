import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultReaderConfig, readIsoBoxes } from "@svta/cml-iso-bmff";

import type { WarpTrack } from "../warpcatalog";

import {
  CompressedCMAFMoofDeltaDecoder,
  createCompressedCmafTrackState,
  decompressCompressedCmafFragment,
  initializeCompressedCmafTrack,
  assembleCmafFile,
  createCompressedCMAFMdatBox,
  decompressLocInit,
  decompressMoof,
  extractInitContextFromInitSegment,
  extractTrackMetadataFromInitSegment,
  getCompressedCMAFHeaderConstants,
} from "./compressedCMAF";

async function loadFixture(name: string): Promise<Uint8Array> {
  const fixturePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../test/decompression-assets",
    name,
  );
  return new Uint8Array(await readFile(fixturePath));
}

function buildTrack(referenceInit: Uint8Array): WarpTrack {
  const metadata = extractTrackMetadataFromInitSegment(referenceInit);
  return {
    name: "video",
    packaging: "compressed-cmaf",
    codec: metadata.codec,
    timescale: metadata.timescale,
    width: metadata.width,
    height: metadata.height,
    samplerate: metadata.samplerate,
    role: metadata.role,
    lang: metadata.lang,
  };
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

function encodeGoVarint(value: number): Uint8Array {
  if (value < 0) {
    throw new Error("test helper only supports non-negative values");
  }

  let encoded = BigInt(value) << 1n;
  const bytes: number[] = [];

  while (encoded >= 0x80n) {
    bytes.push(Number(encoded & 0x7fn) | 0x80);
    encoded >>= 7n;
  }
  bytes.push(Number(encoded));

  return Uint8Array.from(bytes);
}

function buildCompressedObject(
  headerId: number,
  locPayload: Uint8Array,
  mdatPayload: Uint8Array,
): Uint8Array {
  const header = encodeGoVarint(headerId);
  const locLength = encodeGoVarint(locPayload.byteLength);
  const bytes = new Uint8Array(
    header.byteLength +
      locLength.byteLength +
      locPayload.byteLength +
      mdatPayload.byteLength,
  );

  let offset = 0;
  bytes.set(header, offset);
  offset += header.byteLength;
  bytes.set(locLength, offset);
  offset += locLength.byteLength;
  bytes.set(locPayload, offset);
  offset += locPayload.byteLength;
  bytes.set(mdatPayload, offset);

  return bytes;
}

function buildCompressedInit(
  headerId: number,
  locPayload: Uint8Array,
): Uint8Array {
  return buildCompressedObject(headerId, locPayload, new Uint8Array());
}

describe("compressed CMAF reconstruction", () => {
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

    const deltaDecoder = new CompressedCMAFMoofDeltaDecoder();
    const headers = getCompressedCMAFHeaderConstants();

    const normal0 = decompressMoof(
      await loadFixture("normalMoof-0"),
      1,
      context,
    );
    const normal1 = decompressMoof(
      await loadFixture("normalMoof-1"),
      2,
      context,
    );
    const normal2 = decompressMoof(
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
      const moof = decompressMoof(
        await loadFixture(`normalMoof-${index}`),
        index + 1,
        context,
      );
      const mdat = createCompressedCMAFMdatBox(
        await loadFixture(`mdat-${index}`),
      );

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
      const moof = decompressMoof(
        await loadFixture(`normalMoof-${index}`),
        index + 1,
        reconstructedInit.context,
      );
      const mdat = createCompressedCMAFMdatBox(
        await loadFixture(`mdat-${index}`),
      );
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

    const tmpDir = await mkdtemp(
      path.join(os.tmpdir(), "warp-player-compressed-cmaf-"),
    );
    const outputPath = path.join(tmpDir, "reconstructed.cmaf.mp4");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outputPath, bytes);

    const outputStat = await stat(outputPath);
    expect(outputStat.size).toBe(bytes.byteLength);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reconstructs a CMAF init segment from compressed init data", async () => {
    const compressedInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const state = createCompressedCmafTrackState(
      buildTrack(referenceInit),
      compressedInit,
    );

    const boxes = readIsoBoxes(
      state.initSegment,
      defaultReaderConfig(),
    ) as Array<{
      type: string;
    }>;
    expect(boxes.map((box) => box.type)).toEqual(["ftyp", "moov"]);
  });

  it("reconstructs a framed compressed CMAF init segment", async () => {
    const compressedInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const initialized = initializeCompressedCmafTrack(
      buildTrack(referenceInit),
      buildCompressedInit(
        getCompressedCMAFHeaderConstants().moov,
        compressedInit,
      ),
    );

    const boxes = readIsoBoxes(
      initialized.state.initSegment,
      defaultReaderConfig(),
    ) as Array<{ type: string }>;
    expect(initialized.initWasReconstructed).toBe(true);
    expect(boxes.map((box) => box.type)).toEqual(["ftyp", "moov"]);
  });

  it("keeps a regular CMAF init segment when compressed-cmaf advertises one", async () => {
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const initialized = initializeCompressedCmafTrack(
      buildTrack(referenceInit),
      referenceInit,
    );

    expect(initialized.initWasReconstructed).toBe(false);
    expect(Array.from(initialized.state.initSegment)).toEqual(
      Array.from(referenceInit),
    );
  });

  it("reconstructs CMAF fragments from compressed objects", async () => {
    const compressedInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const state = createCompressedCmafTrackState(
      buildTrack(referenceInit),
      compressedInit,
    );
    const headers = getCompressedCMAFHeaderConstants();

    const loc0 = await loadFixture("deltaMoof-0");
    const loc1 = await loadFixture("deltaMoof-1");
    const mdat0 = await loadFixture("mdat-0");
    const mdat1 = await loadFixture("mdat-1");

    const fragment0 = decompressCompressedCmafFragment(
      buildCompressedObject(headers.moof, loc0, mdat0),
      1,
      state,
    );
    const fragment1 = decompressCompressedCmafFragment(
      buildCompressedObject(headers.moofDelta, loc1, mdat1),
      2,
      state,
    );

    const expected0Moof = decompressMoof(loc0, 1, state.initContext);
    const expected1Moof = decompressMoof(
      await loadFixture("normalMoof-1"),
      2,
      state.initContext,
    );
    const expected0 = assembleCmafFile({
      initSegment: new Uint8Array(),
      moof: expected0Moof.box,
      mdat: createCompressedCMAFMdatBox(mdat0),
    });
    const expected1 = assembleCmafFile({
      initSegment: new Uint8Array(),
      moof: expected1Moof.box,
      mdat: createCompressedCMAFMdatBox(mdat1),
    });

    const actual0Boxes = readIsoBoxes(
      fragment0,
      defaultReaderConfig(),
    ) as Array<{
      type: string;
    }>;
    const actual1Boxes = readIsoBoxes(
      fragment1,
      defaultReaderConfig(),
    ) as Array<{
      type: string;
    }>;

    expect(actual0Boxes.map((box) => box.type)).toEqual(["moof", "mdat"]);
    expect(actual1Boxes.map((box) => box.type)).toEqual(["moof", "mdat"]);
    expect(Array.from(fragment0)).toEqual(Array.from(expected0));
    expect(Array.from(fragment1)).toEqual(Array.from(expected1));
  });
});
