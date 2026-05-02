import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultReaderConfig, readIsoBoxes } from "@svta/cml-iso-bmff";

import type { WarpTrack } from "../warpcatalog";

import {
  createLocmafTrackState,
  initializeLocmafTrack,
  decompressLocmafInit,
  decompressMoof,
  decompressMoofWithTrackInfo,
  extractTrackMetadataFromInitSegment,
  getLocmafHeaderConstants,
} from "./locmaf";

const SAMPLE_SIZES_FIELD_ID = 1;
const DEFAULT_SAMPLE_SIZE_FIELD_ID = 6;
const BASE_MEDIA_DECODE_TIME_FIELD_ID = 10;
const SAMPLE_COUNT_FIELD_ID = 16;
const SAMPLE_COMPOSITION_TIME_OFFSETS_FIELD_ID = 5;
const TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT = 0x000800;

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
    packaging: "locmaf",
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

function encodeQuicVarint(value: number): Uint8Array {
  if (value < 0) {
    throw new Error("test helper only supports non-negative values");
  }

  const encoded = BigInt(value);
  if (encoded < 64n) {
    return Uint8Array.of(Number(encoded));
  }
  if (encoded < 16384n) {
    return Uint8Array.of(
      Number(((encoded >> 8n) & 0x3fn) | 0x40n),
      Number(encoded & 0xffn),
    );
  }
  if (encoded < 1073741824n) {
    return Uint8Array.of(
      Number(((encoded >> 24n) & 0x3fn) | 0x80n),
      Number((encoded >> 16n) & 0xffn),
      Number((encoded >> 8n) & 0xffn),
      Number(encoded & 0xffn),
    );
  }
  return Uint8Array.of(
    Number(((encoded >> 56n) & 0x3fn) | 0xc0n),
    Number((encoded >> 48n) & 0xffn),
    Number((encoded >> 40n) & 0xffn),
    Number((encoded >> 32n) & 0xffn),
    Number((encoded >> 24n) & 0xffn),
    Number((encoded >> 16n) & 0xffn),
    Number((encoded >> 8n) & 0xffn),
    Number(encoded & 0xffn),
  );
}

function decodeQuicVarint(
  bytes: Uint8Array,
  offset: number,
): { value: number; bytesRead: number } {
  const first = bytes[offset];
  if (first === undefined) {
    throw new Error("unexpected end of locmaf payload");
  }

  const bytesRead = 1 << (first >> 6);
  if (offset + bytesRead > bytes.byteLength) {
    throw new Error("unexpected end of locmaf payload");
  }

  let encoded = BigInt(first & 0x3f);
  for (let index = 1; index < bytesRead; index++) {
    encoded = (encoded << 8n) | BigInt(bytes[offset + index]);
  }

  const value = Number(encoded);
  if (!Number.isSafeInteger(value)) {
    throw new Error("locmaf varint exceeds safe integer range");
  }
  return { value, bytesRead };
}

function separateLocmafFields(payload: Uint8Array): Map<number, Uint8Array> {
  const fields = new Map<number, Uint8Array>();
  let offset = 0;

  while (offset < payload.length) {
    const fieldId = decodeQuicVarint(payload, offset);
    offset += fieldId.bytesRead;

    if (fieldId.value % 2 === 0) {
      const value = decodeQuicVarint(payload, offset);
      fields.set(
        fieldId.value,
        payload.slice(offset, offset + value.bytesRead),
      );
      offset += value.bytesRead;
      continue;
    }

    const length = decodeQuicVarint(payload, offset);
    offset += length.bytesRead;
    const nextOffset = offset + length.value;
    fields.set(fieldId.value, payload.slice(offset, nextOffset));
    offset = nextOffset;
  }

  return fields;
}

function encodeLocmafFields(fields: Map<number, Uint8Array>): Uint8Array {
  const encoded: Uint8Array[] = [];

  for (const [fieldId, value] of fields.entries()) {
    encoded.push(encodeQuicVarint(fieldId));
    if (fieldId % 2 === 0) {
      encoded.push(value);
      continue;
    }
    encoded.push(encodeQuicVarint(value.byteLength));
    encoded.push(value);
  }

  const totalLength = encoded.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of encoded) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function buildLocmafObject(
  headerId: number,
  locPayload: Uint8Array,
  mdatPayload: Uint8Array,
): Uint8Array {
  const header = encodeQuicVarint(headerId);
  const locLength = encodeQuicVarint(locPayload.byteLength);
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

function buildLocmafInit(headerId: number, locPayload: Uint8Array): Uint8Array {
  return buildLocmafObject(headerId, locPayload, new Uint8Array());
}

function parseLocmafObject(payload: Uint8Array): {
  headerId: number;
  locPayload: Uint8Array;
  mdatPayload: Uint8Array;
} {
  const header = decodeQuicVarint(payload, 0);
  const locLength = decodeQuicVarint(payload, header.bytesRead);
  const locStart = header.bytesRead + locLength.bytesRead;
  const locEnd = locStart + locLength.value;

  return {
    headerId: header.value,
    locPayload: payload.slice(locStart, locEnd),
    mdatPayload: payload.slice(locEnd),
  };
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

describe("locmaf reconstruction", () => {
  it("reconstructs an init segment from the locmaf header", async () => {
    const locmafInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const trackMetadata = extractTrackMetadataFromInitSegment(referenceInit);
    const reconstructed = decompressLocmafInit(locmafInit, trackMetadata, {
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
    expect(sampleEntry?.width).toBe(trackMetadata.width);
    expect(sampleEntry?.height).toBe(trackMetadata.height);
    expect(frma?.dataFormat).toBeDefined();
    expect(trex?.trackId).toBe(1);
    expect(reconstructed.context.trackId).toBe(1);
  });

  it("reconstructs the same moof from normal and delta headers", async () => {
    const locmafInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const normalState = createLocmafTrackState(
      buildTrack(referenceInit),
      locmafInit,
    );
    const deltaState = createLocmafTrackState(
      buildTrack(referenceInit),
      locmafInit,
    );

    const normal0 = decompressMoof(
      await loadFixture("normalMoof-0"),
      1,
      normalState,
    );
    const normal1 = decompressMoof(
      await loadFixture("normalMoof-1"),
      2,
      normalState,
    );
    const normal2 = decompressMoof(
      await loadFixture("normalMoof-2"),
      3,
      normalState,
    );

    const delta0 = decompressMoof(
      await loadFixture("deltaMoof-0"),
      1,
      deltaState,
    );
    const delta1 = decompressMoof(
      await loadFixture("deltaMoof-1"),
      2,
      deltaState,
    );
    const delta2 = decompressMoof(
      await loadFixture("deltaMoof-2"),
      3,
      deltaState,
    );

    expect(summarizeMoof(normal0)).toEqual(summarizeMoof(delta0));
    expect(summarizeMoof(normal1)).toEqual(summarizeMoof(delta1));
    expect(summarizeMoof(normal2)).toEqual(summarizeMoof(delta2));
  });

  it("returns track timing metadata while reconstructing a locmaf moof", async () => {
    const locmafInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const state = createLocmafTrackState(buildTrack(referenceInit), locmafInit);

    const result = decompressMoofWithTrackInfo(
      await loadFixture("normalMoof-1"),
      2,
      state,
    );
    const summary = summarizeMoof(result.bytes);
    const expectedDuration = (summary.samples ?? []).reduce(
      (sum: number, sample: any) => sum + (sample.sampleDuration ?? 0),
      0,
    );

    expect(result.trackInfo.timescale).toBe(
      extractTrackMetadataFromInitSegment(referenceInit).timescale,
    );
    expect(result.trackInfo.baseMediaDecodeTime).toBe(
      summary.baseMediaDecodeTime,
    );
    expect(result.trackInfo.sequenceNumber).toBe(summary.sequenceNumber);
    expect(result.trackInfo.duration).toBe(expectedDuration);
  });

  it("derives baseMediaDecodeTime for delta moofs", async () => {
    const locmafInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const state = createLocmafTrackState(buildTrack(referenceInit), locmafInit);

    decompressMoof(await loadFixture("deltaMoof-0"), 1, state);

    const deltaObject = parseLocmafObject(await loadFixture("deltaMoof-1"));
    const fields = separateLocmafFields(deltaObject.locPayload);
    fields.delete(BASE_MEDIA_DECODE_TIME_FIELD_ID);

    const derivedDelta = buildLocmafObject(
      deltaObject.headerId,
      encodeLocmafFields(fields),
      deltaObject.mdatPayload,
    );
    const derivedMoof = decompressMoof(derivedDelta, 2, state);

    const normalState = createLocmafTrackState(
      buildTrack(referenceInit),
      locmafInit,
    );
    const normalMoof = decompressMoof(
      await loadFixture("normalMoof-1"),
      2,
      normalState,
    );

    expect(summarizeMoof(derivedMoof)).toEqual(summarizeMoof(normalMoof));
  });

  it("reconstructs a single-sample moof without sampleSizes", async () => {
    const locmafInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const trackMetadata = extractTrackMetadataFromInitSegment(referenceInit);
    decompressLocmafInit(locmafInit, trackMetadata, {
      referenceInitSegment: referenceInit,
    });

    const originalPayload = await loadFixture("normalMoof-0");
    const originalState = createLocmafTrackState(
      buildTrack(referenceInit),
      locmafInit,
    );
    const originalMoof = decompressMoof(originalPayload, 1, originalState);
    const originalSummary = summarizeMoof(originalMoof);

    const parsedObject = parseLocmafObject(originalPayload);
    const fields = separateLocmafFields(parsedObject.locPayload);
    expect(originalSummary.sampleCount).toBe(1);
    expect(fields.get(SAMPLE_COUNT_FIELD_ID)).toBeDefined();

    if (fields.has(SAMPLE_SIZES_FIELD_ID)) {
      fields.delete(SAMPLE_SIZES_FIELD_ID);
    }
    fields.delete(DEFAULT_SAMPLE_SIZE_FIELD_ID);

    const reconstructedObject = buildLocmafObject(
      parsedObject.headerId,
      encodeLocmafFields(fields),
      parsedObject.mdatPayload,
    );
    const reconstructedState = createLocmafTrackState(
      buildTrack(referenceInit),
      locmafInit,
    );
    const reconstructed = decompressMoof(
      reconstructedObject,
      1,
      reconstructedState,
    );
    const reconstructedSummary = summarizeMoof(reconstructed);

    expect(reconstructedSummary.sampleCount).toBe(1);
    expect(
      separateLocmafFields(encodeLocmafFields(fields)).has(
        SAMPLE_SIZES_FIELD_ID,
      ),
    ).toBe(false);
    expect(
      separateLocmafFields(encodeLocmafFields(fields)).has(
        DEFAULT_SAMPLE_SIZE_FIELD_ID,
      ),
    ).toBe(false);
    expect(reconstructedSummary.baseMediaDecodeTime).toBe(
      originalSummary.baseMediaDecodeTime,
    );
    expect(reconstructedSummary.samples).toEqual(originalSummary.samples);
  });

  it("requires an explicit sampleCount field when reconstructing a moof", async () => {
    const locmafInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const parsedObject = parseLocmafObject(await loadFixture("normalMoof-0"));
    const fields = separateLocmafFields(parsedObject.locPayload);

    fields.delete(SAMPLE_COUNT_FIELD_ID);

    const state = createLocmafTrackState(buildTrack(referenceInit), locmafInit);

    expect(() =>
      decompressMoof(
        buildLocmafObject(
          parsedObject.headerId,
          encodeLocmafFields(fields),
          parsedObject.mdatPayload,
        ),
        1,
        state,
      ),
    ).toThrow("locmaf moof is missing sample count");
  });

  it("defaults missing composition time offsets to zero and clears the trun flag", async () => {
    const locmafInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const parsedObject = parseLocmafObject(await loadFixture("normalMoof-1"));
    const fields = separateLocmafFields(parsedObject.locPayload);

    fields.delete(SAMPLE_COMPOSITION_TIME_OFFSETS_FIELD_ID);

    const state = createLocmafTrackState(buildTrack(referenceInit), locmafInit);
    const fragment = decompressMoof(
      buildLocmafObject(
        parsedObject.headerId,
        encodeLocmafFields(fields),
        parsedObject.mdatPayload,
      ),
      2,
      state,
    );
    const summary = summarizeMoof(fragment);

    expect(summary.sampleCount).toBeGreaterThan(0);
    expect(
      (summary.trunFlags ?? 0) & TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT,
    ).toBe(0);
    expect(
      summary.samples?.every(
        (sample: any) => (sample.sampleCompositionTimeOffset ?? 0) === 0,
      ),
    ).toBe(true);
  });

  it("assembles a playable CMAF file layout with init, moof and mdat", async () => {
    const locmafInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const trackMetadata = extractTrackMetadataFromInitSegment(referenceInit);
    const reconstructedInit = decompressLocmafInit(locmafInit, trackMetadata, {
      referenceInitSegment: referenceInit,
    });

    const state = createLocmafTrackState(buildTrack(referenceInit), locmafInit);
    for (const index of [0, 1, 2]) {
      const fragment = decompressMoof(
        await loadFixture(`normalMoof-${index}`),
        index + 1,
        state,
      );
      const cmafFile = concatBytes(reconstructedInit.bytes, fragment);

      const parsed = readIsoBoxes(cmafFile, defaultReaderConfig());
      expect(parsed.map((box: { type: string }) => box.type)).toEqual([
        "ftyp",
        "moov",
        "moof",
        "mdat",
      ]);

      const moofSummary = summarizeMoof(fragment);
      const totalSampleBytes = (moofSummary.samples ?? []).reduce(
        (sum: number, sample: any) => sum + (sample.sampleSize ?? 0),
        0,
      );
      const mdat = parsed.find(
        (box: { type: string }) => box.type === "mdat",
      ) as {
        data?: Uint8Array;
      };

      expect(totalSampleBytes).toBe(mdat.data?.byteLength);
    }
  });

  it("writes the reconstructed file bytes to disk", async () => {
    const locmafInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const trackMetadata = extractTrackMetadataFromInitSegment(referenceInit);
    const reconstructedInit = decompressLocmafInit(locmafInit, trackMetadata, {
      referenceInitSegment: referenceInit,
    });
    const bytesParts: Uint8Array[] = [reconstructedInit.bytes];
    const state = createLocmafTrackState(buildTrack(referenceInit), locmafInit);
    for (const index of [0, 1, 2]) {
      const fragment = decompressMoof(
        await loadFixture(`normalMoof-${index}`),
        index + 1,
        state,
      );
      bytesParts.push(fragment);
    }
    const bytes = Uint8Array.from(
      bytesParts.flatMap((part) => Array.from(part)),
    );

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "warp-player-locmaf-"));
    const outputPath = path.join(tmpDir, "reconstructed.cmaf.mp4");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outputPath, bytes);

    const outputStat = await stat(outputPath);
    expect(outputStat.size).toBe(bytes.byteLength);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reconstructs a CMAF init segment from locmaf init data", async () => {
    const locmafInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const state = createLocmafTrackState(buildTrack(referenceInit), locmafInit);

    const boxes = readIsoBoxes(
      state.initSegment,
      defaultReaderConfig(),
    ) as Array<{
      type: string;
    }>;
    expect(boxes.map((box) => box.type)).toEqual(["ftyp", "moov"]);
  });

  it("reconstructs a framed locmaf init segment", async () => {
    const locmafInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const initialized = initializeLocmafTrack(
      buildTrack(referenceInit),
      buildLocmafInit(getLocmafHeaderConstants().moov, locmafInit),
    );

    const boxes = readIsoBoxes(
      initialized.state.initSegment,
      defaultReaderConfig(),
    ) as Array<{ type: string }>;
    expect(initialized.initWasReconstructed).toBe(true);
    expect(boxes.map((box) => box.type)).toEqual(["ftyp", "moov"]);
  });

  it("keeps a regular CMAF init segment when locmaf advertises one", async () => {
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const initialized = initializeLocmafTrack(
      buildTrack(referenceInit),
      referenceInit,
    );

    expect(initialized.initWasReconstructed).toBe(false);
    expect(Array.from(initialized.state.initSegment)).toEqual(
      Array.from(referenceInit),
    );
  });

  it("reconstructs CMAF fragments from locmaf objects", async () => {
    const locmafInit = await loadFixture("init");
    const referenceInit = await loadFixture("init.cmaf.mp4");
    const state = createLocmafTrackState(buildTrack(referenceInit), locmafInit);
    const expectedState = createLocmafTrackState(
      buildTrack(referenceInit),
      locmafInit,
    );

    const fragment0 = decompressMoof(
      await loadFixture("deltaMoof-0"),
      1,
      state,
    );
    const fragment1 = decompressMoof(
      await loadFixture("deltaMoof-1"),
      2,
      state,
    );

    const expected0 = decompressMoof(
      await loadFixture("normalMoof-0"),
      1,
      expectedState,
    );
    const expected1 = decompressMoof(
      await loadFixture("normalMoof-1"),
      2,
      expectedState,
    );

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
