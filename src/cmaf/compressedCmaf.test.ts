import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultReaderConfig, readIsoBoxes } from "@svta/cml-iso-bmff";

import type { WarpTrack } from "../warpcatalog";

import {
  createCompressedCmafTrackState,
  decompressCompressedCmafFragment,
  initializeCompressedCmafTrack,
} from "./compressedCmaf";
import {
  assembleCmafFile,
  createLocMdatBox,
  decompressLocMoof,
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
      buildCompressedInit(getLocHeaderConstants().moov, compressedInit),
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
    const headers = getLocHeaderConstants();

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

    const expected0Moof = decompressLocMoof(loc0, 1, state.initContext);
    const expected1Moof = decompressLocMoof(
      await loadFixture("normalMoof-1"),
      2,
      state.initContext,
    );
    const expected0 = assembleCmafFile({
      initSegment: new Uint8Array(),
      moof: expected0Moof.box,
      mdat: createLocMdatBox(mdat0),
    });
    const expected1 = assembleCmafFile({
      initSegment: new Uint8Array(),
      moof: expected1Moof.box,
      mdat: createLocMdatBox(mdat1),
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
