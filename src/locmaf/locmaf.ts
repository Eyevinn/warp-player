import {
  IsoBoxWriteView,
  createAudioSampleEntryReader,
  createVisualSampleEntryReader,
  defaultReaderConfig,
  defaultWriterConfig,
  readIsoBoxes,
  writeAudioSampleEntryBox,
  writeIsoBox,
  writeIsoBoxes,
  writeVisualSampleEntryBox,
} from "@svta/cml-iso-bmff";
import type {
  AudioSampleEntryBox,
  FileTypeBox,
  HandlerReferenceBox,
  MediaBox,
  MediaDataBox,
  MediaHeaderBox,
  MediaInformationBox,
  MovieBox,
  MovieExtendsBox,
  MovieFragmentBox,
  MovieHeaderBox,
  SampleDescriptionBox,
  SampleTableBox,
  SoundMediaHeaderBox,
  TrackBox,
  TrackExtendsBox,
  TrackFragmentBaseMediaDecodeTimeBox,
  TrackFragmentBox,
  TrackFragmentHeaderBox,
  TrackHeaderBox,
  TrackRunBox,
  TrackRunSample,
  VideoMediaHeaderBox,
  VisualSampleEntryBox,
} from "@svta/cml-iso-bmff/dist/index.js";

import type { MediaTrackInfo } from "../buffer/mediaBuffer";
import type { WarpTrack } from "../warpcatalog";

const LOCMAF_HEADER_MOOV = 21;
const LOCMAF_HEADER_MOOF = 23;
const LOCMAF_HEADER_MOOF_DELTA = 25;

const DEFAULT_TRACK_ID = 1;
const DEFAULT_MOVIE_BRANDS = ["iso6", "cmfc", "mp41"];
const DEFAULT_MOVIE_RATE = 1;
const DEFAULT_MOVIE_VOLUME = 1;
const DEFAULT_AUDIO_VOLUME = 1;
const DEFAULT_TRANSFORM_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 16384];
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;
const TFHD_SAMPLE_DESCRIPTION_INDEX_PRESENT = 0x000002;
const TFHD_DEFAULT_SAMPLE_DURATION_PRESENT = 0x000008;
const TFHD_DEFAULT_SAMPLE_SIZE_PRESENT = 0x000010;
const TFHD_DEFAULT_SAMPLE_FLAGS_PRESENT = 0x000020;
const TRUN_DATA_OFFSET_PRESENT = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS_PRESENT = 0x000004;
const TRUN_SAMPLE_DURATION_PRESENT = 0x000100;
const TRUN_SAMPLE_SIZE_PRESENT = 0x000200;
const TRUN_SAMPLE_FLAGS_PRESENT = 0x000400;
const TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT = 0x000800;
const SENC_USE_SUBSAMPLE_ENCRYPTION = 0x000002;

const audioSampleEntryTypes = [
  "Opus",
  "ac-3",
  "ac-4",
  "ec-3",
  "enca",
  "mha1",
  "mha2",
  "mhm1",
  "mhm2",
  "mp4a",
] as const;

const visualSampleEntryTypes = [
  "av01",
  "avc1",
  "avc2",
  "avc3",
  "avc4",
  "avs3",
  "encv",
  "hev1",
  "hvc1",
  "vp08",
  "vp09",
  "vvc1",
  "vvi1",
] as const;

type RawFieldMap = Map<number, Uint8Array>;

type RawBox = {
  type: string;
  view: ArrayBufferView;
};

type ExtendedTrackEncryptionBox = {
  type: "tenc";
  version: number;
  flags: number;
  defaultIsEncrypted: number;
  defaultIvSize: number;
  defaultKid: number[];
  defaultCryptByteBlock?: number;
  defaultSkipByteBlock?: number;
  defaultConstantIv?: Uint8Array;
};

type SampleEncryptionEntry = {
  initializationVector?: Uint8Array;
  subsampleEncryption?: Array<{
    bytesOfClearData: number;
    bytesOfProtectedData: number;
  }>;
};

type ExtendedSampleEncryptionBox = {
  type: "senc";
  version: number;
  flags: number;
  sampleCount: number;
  samples: SampleEncryptionEntry[];
};

type LocmafBox =
  | MovieBox
  | MovieFragmentBox
  | FileTypeBox
  | MediaDataBox
  | RawBox;

const moovLocmafIDs = {
  codecConfigurationBox: 1,
  colr: 3,
  pasp: 5,
  chnl: 7,
  defaultConstantIV: 9,
  defaultKID: 11,
  format: 8,
  movieTimescale: 2,
  mediaTime: 6,
  channelCount: 14,
  sampleRate: 16,
  schemeType: 18,
  defaultCryptByteBlock: 20,
  defaultSkipByteBlock: 22,
  defaultPerSampleIVSize: 24,
  defaultConstantIVSize: 26,
  defaultSampleDuration: 28,
  defaultSampleSize: 30,
  defaultSampleFlags: 32,
  tkhdFlags: 34,
  tencVersion: 36,
} as const;

const moofLocmafIDs = {
  sampleDescriptionIndex: 2,
  defaultSampleDuration: 4,
  defaultSampleSize: 6,
  defaultSampleFlags: 8,
  baseMediaDecodeTime: 10,
  firstSampleFlags: 12,
  sampleCount: 16,
  sampleSizes: 1,
  sampleDurations: 3,
  sampleCompositionTimeOffsets: 5,
  sampleFlags: 7,
  perSampleIVSize: 14,
  initializationVector: 9,
  subsampleCount: 11,
  bytesOfClearData: 13,
  bytesOfProtectedData: 15,
} as const;

const moofDeltaDeletedLocmafID = 17;

export interface LocmafTrackMetadata {
  codec?: string;
  timescale?: number;
  width?: number;
  height?: number;
  samplerate?: number;
  channelCount?: number;
  role?: string;
  lang?: string;
}

export interface LocmafInitContext {
  trackId: number;
  timescale: number;
  defaultSampleDescriptionIndex: number;
  defaultSampleDuration: number;
  defaultSampleSize: number;
  defaultSampleFlags: number;
  defaultPerSampleIVSize: number;
}

export interface LocmafInitDecompressionResult {
  bytes: Uint8Array;
  boxes: LocmafBox[];
  context: LocmafInitContext;
}

export interface LocmafMoofDecompressionResult {
  box: MovieFragmentBox;
  bytes: Uint8Array;
  trackInfo: MediaTrackInfo;
}

export interface LocmafTrackState {
  initContext: LocmafInitContext;
  initSegment: Uint8Array;
  moofDecoder: LocmafMoofDeltaDecoder;
}

export interface InitializedLocmafTrack {
  state: LocmafTrackState;
  initWasReconstructed: boolean;
}

const readerConfig = (() => {
  const config = defaultReaderConfig();
  return {
    readers: {
      ...config.readers,
      ...Object.fromEntries(
        audioSampleEntryTypes
          .filter((type) => type !== "mp4a" && type !== "enca")
          .map((type) => [type, createAudioSampleEntryReader(type)]),
      ),
      ...Object.fromEntries(
        visualSampleEntryTypes
          .filter(
            (type) =>
              ![
                "avc1",
                "avc2",
                "avc3",
                "avc4",
                "encv",
                "hev1",
                "hvc1",
              ].includes(type),
          )
          .map((type) => [type, createVisualSampleEntryReader(type)]),
      ),
    },
  };
})();

const writerConfig = (() => {
  const config = defaultWriterConfig();
  return {
    writers: {
      ...config.writers,
      ...Object.fromEntries(
        audioSampleEntryTypes
          .filter((type) => type !== "mp4a" && type !== "enca")
          .map((type) => [
            type,
            (box: AudioSampleEntryBox) =>
              writeAudioSampleEntryBox(
                box as AudioSampleEntryBox,
                writerConfig,
              ),
          ]),
      ),
      ...Object.fromEntries(
        visualSampleEntryTypes
          .filter(
            (type) =>
              ![
                "avc1",
                "avc2",
                "avc3",
                "avc4",
                "encv",
                "hev1",
                "hvc1",
              ].includes(type),
          )
          .map((type) => [
            type,
            (box: VisualSampleEntryBox) =>
              writeVisualSampleEntryBox(
                box as VisualSampleEntryBox,
                writerConfig,
              ),
          ]),
      ),
      senc: (box: ExtendedSampleEncryptionBox) => writeSenc(box),
      tenc: (box: ExtendedTrackEncryptionBox) => writeTenc(box),
    },
  };
})();

function ensureUint8Array(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

const MAX_QUIC_VARINT = (1n << 62n) - 1n;

function decodeQuicVarint(
  bytes: Uint8Array,
  offset: number,
): { value: bigint; bytesRead: number } {
  const first = bytes[offset];
  if (first === undefined) {
    throw new Error("unexpected end of locmaf payload");
  }

  const prefix = first >> 6;
  const bytesRead = 1 << prefix;
  if (offset + bytesRead > bytes.byteLength) {
    throw new Error("unexpected end of locmaf payload");
  }

  let value = BigInt(first & 0x3f);
  for (let index = 1; index < bytesRead; index++) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }

  return { value, bytesRead };
}

function decodeSignedQuicVarint(
  bytes: Uint8Array,
  offset: number,
): { value: bigint; bytesRead: number } {
  const { value, bytesRead } = decodeQuicVarint(bytes, offset);
  const decoded = (value & 1n) === 0n ? value >> 1n : ~(value >> 1n);
  return { value: decoded, bytesRead };
}

function encodeQuicVarint(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_QUIC_VARINT) {
    throw new Error("quic varint out of range");
  }

  if (value < 64n) {
    return Uint8Array.of(Number(value));
  }
  if (value < 16384n) {
    return Uint8Array.of(
      Number(((value >> 8n) & 0x3fn) | 0x40n),
      Number(value & 0xffn),
    );
  }
  if (value < 1073741824n) {
    return Uint8Array.of(
      Number(((value >> 24n) & 0x3fn) | 0x80n),
      Number((value >> 16n) & 0xffn),
      Number((value >> 8n) & 0xffn),
      Number(value & 0xffn),
    );
  }

  return Uint8Array.of(
    Number(((value >> 56n) & 0x3fn) | 0xc0n),
    Number((value >> 48n) & 0xffn),
    Number((value >> 40n) & 0xffn),
    Number((value >> 32n) & 0xffn),
    Number((value >> 24n) & 0xffn),
    Number((value >> 16n) & 0xffn),
    Number((value >> 8n) & 0xffn),
    Number(value & 0xffn),
  );
}

function encodeSignedQuicVarint(value: bigint): Uint8Array {
  const zigzag = value >= 0n ? value << 1n : ~(value << 1n);
  return encodeQuicVarint(zigzag);
}

function readSingleVarint(value: Uint8Array): bigint {
  const decoded = decodeQuicVarint(value, 0);
  if (decoded.bytesRead !== value.byteLength) {
    throw new Error("locmaf scalar field has trailing bytes");
  }
  return decoded.value;
}

function readSingleSignedVarint(value: Uint8Array): bigint {
  const decoded = decodeSignedQuicVarint(value, 0);
  if (decoded.bytesRead !== value.byteLength) {
    throw new Error("locmaf scalar field has trailing bytes");
  }
  return decoded.value;
}

function readVarintList(value: Uint8Array): bigint[] {
  const result: bigint[] = [];
  let offset = 0;
  while (offset < value.byteLength) {
    const decoded = decodeQuicVarint(value, offset);
    result.push(decoded.value);
    offset += decoded.bytesRead;
  }
  return result;
}

function readSignedVarintList(value: Uint8Array): bigint[] {
  const result: bigint[] = [];
  let offset = 0;
  while (offset < value.byteLength) {
    const decoded = decodeSignedQuicVarint(value, offset);
    result.push(decoded.value);
    offset += decoded.bytesRead;
  }
  return result;
}

function encodeVarintList(values: bigint[], signed = false): Uint8Array {
  return concatBytes(
    ...values.map((value) =>
      signed ? encodeSignedQuicVarint(value) : encodeQuicVarint(value),
    ),
  );
}

function maybeGetVarint(
  fieldMap: RawFieldMap,
  fieldId: number,
): bigint | undefined {
  const value = fieldMap.get(fieldId);
  return value ? readSingleVarint(value) : undefined;
}

function maybeGetVarintList(
  fieldMap: RawFieldMap,
  fieldId: number,
): bigint[] | undefined {
  const value = fieldMap.get(fieldId);
  return value ? readVarintList(value) : undefined;
}

function maybeGetSignedVarintList(
  fieldMap: RawFieldMap,
  fieldId: number,
): bigint[] | undefined {
  const value = fieldMap.get(fieldId);
  return value ? readSignedVarintList(value) : undefined;
}

function isSignedFullMoofField(fieldId: number): boolean {
  return fieldId === moofLocmafIDs.sampleCompositionTimeOffsets;
}

function readMoofFieldValueList(fieldId: number, value: Uint8Array): bigint[] {
  return isSignedFullMoofField(fieldId)
    ? readSignedVarintList(value)
    : readVarintList(value);
}

function encodeMoofFieldValueList(
  fieldId: number,
  values: bigint[],
): Uint8Array {
  return encodeVarintList(values, isSignedFullMoofField(fieldId));
}

function fourCcFromBigInt(value: bigint): string {
  return String.fromCharCode(
    Number((value >> 24n) & 0xffn),
    Number((value >> 16n) & 0xffn),
    Number((value >> 8n) & 0xffn),
    Number(value & 0xffn),
  );
}

function asSafeNumber(value: bigint, label: string): number {
  const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (value < minSafe || value > maxSafe) {
    throw new Error(`${label} exceeds JavaScript safe integer range`);
  }
  return Number(value);
}

function cloneFieldMap(fields: RawFieldMap): RawFieldMap {
  return new Map(
    Array.from(fields.entries(), ([key, value]) => [
      key,
      new Uint8Array(value),
    ]),
  );
}

function separateFields(data: Uint8Array): RawFieldMap {
  const fields: RawFieldMap = new Map();
  let offset = 0;

  while (offset < data.byteLength) {
    const fieldIdDecoded = decodeQuicVarint(data, offset);
    offset += fieldIdDecoded.bytesRead;
    const fieldId = asSafeNumber(fieldIdDecoded.value, "locmaf id");

    if (fieldId % 2 === 0) {
      const valueDecoded = decodeQuicVarint(data, offset);
      fields.set(fieldId, data.slice(offset, offset + valueDecoded.bytesRead));
      offset += valueDecoded.bytesRead;
      continue;
    }

    const lengthDecoded = decodeQuicVarint(data, offset);
    offset += lengthDecoded.bytesRead;
    const length = asSafeNumber(lengthDecoded.value, "locmaf field length");
    const nextOffset = offset + length;
    if (length < 0 || nextOffset > data.byteLength) {
      throw new Error(`locmaf field ${fieldId} exceeds payload length`);
    }
    fields.set(fieldId, data.slice(offset, nextOffset));
    offset = nextOffset;
  }

  return fields;
}

function parseRawBox(raw: Uint8Array): RawBox {
  const boxes = readIsoBoxes(raw, readerConfig) as any[];
  if (boxes.length !== 1) {
    throw new Error("expected exactly one ISO box");
  }
  const box = boxes[0];
  return {
    type: box.type,
    view: box.view as ArrayBufferView,
  };
}

function isAudioCodec(format: string): boolean {
  return audioSampleEntryTypes.includes(
    format as (typeof audioSampleEntryTypes)[number],
  );
}

function inferMediaType(
  format: string,
  track: LocmafTrackMetadata,
): "video" | "audio" {
  if (track.role === "audio" || isAudioCodec(format)) {
    return "audio";
  }
  return "video";
}

function getRawBoxField(
  fieldMap: RawFieldMap,
  fieldId: number,
): RawBox | undefined {
  const value = fieldMap.get(fieldId);
  return value ? parseRawBox(value) : undefined;
}

function createSampleEntry(
  format: string,
  mediaType: "video" | "audio",
  track: LocmafTrackMetadata,
  fieldMap: RawFieldMap,
): AudioSampleEntryBox | VisualSampleEntryBox {
  if (mediaType === "audio") {
    const entry: AudioSampleEntryBox = {
      type: format as AudioSampleEntryBox["type"],
      reserved1: [0, 0, 0, 0, 0, 0],
      dataReferenceIndex: 1,
      reserved2: [0, 0],
      channelcount:
        track.channelCount ??
        Number(maybeGetVarint(fieldMap, moovLocmafIDs.channelCount) ?? 2n),
      samplesize: 16,
      preDefined: 0,
      reserved3: 0,
      samplerate: track.samplerate ?? track.timescale ?? 48000,
      boxes: [],
    };

    const codecConfigurationBox = getRawBoxField(
      fieldMap,
      moovLocmafIDs.codecConfigurationBox,
    );
    const chnlBox = getRawBoxField(fieldMap, moovLocmafIDs.chnl);
    if (codecConfigurationBox) {
      entry.boxes.push(codecConfigurationBox as any);
    }
    if (chnlBox) {
      entry.boxes.push(chnlBox as any);
    }

    const sinf = createProtectionSchemeBox(format, fieldMap, track);
    if (sinf) {
      entry.boxes.push(sinf as any);
    }
    return entry;
  }

  const entry: VisualSampleEntryBox = {
    type: format as VisualSampleEntryBox["type"],
    reserved1: [0, 0, 0, 0, 0, 0],
    dataReferenceIndex: 1,
    preDefined1: 0,
    reserved2: 0,
    preDefined2: [0, 0, 0],
    width: track.width ?? 0,
    height: track.height ?? 0,
    horizresolution: 72,
    vertresolution: 72,
    reserved3: 0,
    frameCount: 1,
    compressorName: new Array(32).fill(0),
    depth: 24,
    preDefined3: -1,
    boxes: [],
  };

  const codecConfigurationBox = getRawBoxField(
    fieldMap,
    moovLocmafIDs.codecConfigurationBox,
  );
  const colrBox = getRawBoxField(fieldMap, moovLocmafIDs.colr);
  const paspBox = getRawBoxField(fieldMap, moovLocmafIDs.pasp);
  if (codecConfigurationBox) {
    entry.boxes.push(codecConfigurationBox as any);
  }
  if (colrBox) {
    entry.boxes.push(colrBox as any);
  }
  if (paspBox) {
    entry.boxes.push(paspBox as any);
  }

  const sinf = createProtectionSchemeBox(format, fieldMap, track);
  if (sinf) {
    entry.boxes.push(sinf as any);
  }
  return entry;
}

function createProtectionSchemeBox(
  format: string,
  fieldMap: RawFieldMap,
  track?: LocmafTrackMetadata,
):
  | {
      type: "sinf";
      boxes: Array<
        | { type: "frma"; dataFormat: number }
        | {
            type: "schm";
            version: number;
            flags: number;
            schemeType: number;
            schemeVersion: number;
          }
        | { type: "schi"; boxes: [ExtendedTrackEncryptionBox] }
      >;
    }
  | undefined {
  const schemeType = maybeGetVarint(fieldMap, moovLocmafIDs.schemeType);
  const defaultKid = fieldMap.get(moovLocmafIDs.defaultKID);
  const defaultPerSampleIVSize = maybeGetVarint(
    fieldMap,
    moovLocmafIDs.defaultPerSampleIVSize,
  );

  if (!schemeType && !defaultKid && defaultPerSampleIVSize === undefined) {
    return undefined;
  }

  const tencVersion = asSafeNumber(
    maybeGetVarint(fieldMap, moovLocmafIDs.tencVersion) ?? 0n,
    "tenc version",
  );
  const defaultCryptByteBlock = maybeGetVarint(
    fieldMap,
    moovLocmafIDs.defaultCryptByteBlock,
  );
  const defaultSkipByteBlock = maybeGetVarint(
    fieldMap,
    moovLocmafIDs.defaultSkipByteBlock,
  );
  const defaultConstantIv = fieldMap.get(moovLocmafIDs.defaultConstantIV);

  const tenc: ExtendedTrackEncryptionBox = {
    type: "tenc",
    version: tencVersion,
    flags: 0,
    defaultIsEncrypted: 1,
    defaultIvSize: asSafeNumber(
      defaultPerSampleIVSize ?? 0n,
      "default per-sample IV size",
    ),
    defaultKid: Array.from(defaultKid ?? new Uint8Array(16)),
  };

  if (defaultCryptByteBlock !== undefined) {
    tenc.defaultCryptByteBlock = asSafeNumber(
      defaultCryptByteBlock,
      "default crypt byte block",
    );
  }
  if (defaultSkipByteBlock !== undefined) {
    tenc.defaultSkipByteBlock = asSafeNumber(
      defaultSkipByteBlock,
      "default skip byte block",
    );
  }
  if (defaultConstantIv) {
    tenc.defaultConstantIv = new Uint8Array(defaultConstantIv);
  }

  return {
    type: "sinf",
    boxes: [
      {
        type: "frma",
        dataFormat: fourCcToUint32(
          track?.codec && track.codec.split(".")[0].length === 4
            ? track.codec.split(".")[0]
            : format,
        ),
      },
      {
        type: "schm",
        version: 0,
        flags: 0,
        schemeType: asSafeNumber(
          schemeType ?? BigInt(fourCcToUint32("cenc")),
          "scheme type",
        ),
        schemeVersion: 0x00010000,
      },
      {
        type: "schi",
        boxes: [tenc],
      },
    ],
  };
}

function createFtypBox(reference?: Uint8Array): FileTypeBox {
  if (reference) {
    const parsed = readIsoBoxes(reference, readerConfig) as any[];
    const box = parsed.find((entry) => entry.type === "ftyp") as
      | FileTypeBox
      | undefined;
    if (box) {
      return {
        type: "ftyp",
        majorBrand: box.majorBrand,
        minorVersion: box.minorVersion,
        compatibleBrands: [...box.compatibleBrands],
      };
    }
  }

  return {
    type: "ftyp",
    majorBrand: "iso6",
    minorVersion: 0,
    compatibleBrands: [...DEFAULT_MOVIE_BRANDS],
  };
}

function buildInitBoxes(
  fieldMap: RawFieldMap,
  track: LocmafTrackMetadata,
  ftypBox: FileTypeBox,
  referenceContext?: LocmafInitContext,
): { boxes: LocmafBox[]; context: LocmafInitContext } {
  const formatValue = maybeGetVarint(fieldMap, moovLocmafIDs.format);
  if (formatValue === undefined) {
    throw new Error(
      "locmaf init header does not contain a sample entry format",
    );
  }

  const movieTimescale = asSafeNumber(
    maybeGetVarint(fieldMap, moovLocmafIDs.movieTimescale) ??
      BigInt(track.timescale ?? 90000),
    "movie timescale",
  );
  const format = fourCcFromBigInt(formatValue);
  const mediaType = inferMediaType(format, track);
  const trackTimescale = track.timescale ?? movieTimescale;
  const trackId = DEFAULT_TRACK_ID;
  const trackFlags = asSafeNumber(
    maybeGetVarint(fieldMap, moovLocmafIDs.tkhdFlags) ?? 7n,
    "tkhd flags",
  );
  const mediaTime = maybeGetVarint(fieldMap, moovLocmafIDs.mediaTime);

  const sampleEntry = createSampleEntry(format, mediaType, track, fieldMap);
  const stsd: SampleDescriptionBox = {
    type: "stsd",
    version: 0,
    flags: 0,
    entryCount: 1,
    entries: [sampleEntry as any],
  };

  const stbl: SampleTableBox = {
    type: "stbl",
    boxes: [
      stsd,
      {
        type: "stts",
        version: 0,
        flags: 0,
        entryCount: 0,
        entries: [],
      },
      {
        type: "stsc",
        version: 0,
        flags: 0,
        entryCount: 0,
        entries: [],
      },
      {
        type: "stsz",
        version: 0,
        flags: 0,
        sampleSize: 0,
        sampleCount: 0,
      },
      {
        type: "stco",
        version: 0,
        flags: 0,
        entryCount: 0,
        chunkOffset: [],
      },
    ],
  };

  const mediaHeader: MediaHeaderBox = {
    type: "mdhd",
    version: 0,
    flags: 0,
    creationTime: 0,
    modificationTime: 0,
    timescale: trackTimescale,
    duration: 0,
    language: track.lang ?? "und",
    preDefined: 0,
  };

  const handler: HandlerReferenceBox = {
    type: "hdlr",
    version: 0,
    flags: 0,
    preDefined: 0,
    handlerType: mediaType === "audio" ? "soun" : "vide",
    reserved: [0, 0, 0],
    name: mediaType === "audio" ? "SoundHandler" : "VideoHandler",
  };

  const mediaInfoHeader: VideoMediaHeaderBox | SoundMediaHeaderBox =
    mediaType === "audio"
      ? {
          type: "smhd",
          version: 0,
          flags: 0,
          balance: 0,
          reserved: 0,
        }
      : {
          type: "vmhd",
          version: 0,
          flags: 1,
          graphicsmode: 0,
          opcolor: [0, 0, 0],
        };

  const minf: MediaInformationBox = {
    type: "minf",
    boxes: [
      mediaInfoHeader,
      {
        type: "dinf",
        boxes: [
          {
            type: "dref",
            version: 0,
            flags: 0,
            entryCount: 1,
            entries: [
              {
                type: "url ",
                version: 0,
                flags: 1,
                location: "",
              },
            ],
          },
        ],
      },
      stbl,
    ],
  };

  const mdia: MediaBox = {
    type: "mdia",
    boxes: [mediaHeader, handler, minf],
  };

  const tkhd: TrackHeaderBox = {
    type: "tkhd",
    version: 0,
    flags: trackFlags,
    creationTime: 0,
    modificationTime: 0,
    trackId,
    reserved1: 0,
    duration: 0,
    reserved2: [0, 0],
    layer: 0,
    alternateGroup: 0,
    volume: mediaType === "audio" ? DEFAULT_AUDIO_VOLUME : 0,
    reserved3: 0,
    matrix: [...DEFAULT_TRANSFORM_MATRIX],
    width: mediaType === "video" ? (track.width ?? 0) : 0,
    height: mediaType === "video" ? (track.height ?? 0) : 0,
  };

  const trak: TrackBox = {
    type: "trak",
    boxes: [
      tkhd,
      ...(mediaTime !== undefined ? [createEditBox(mediaTime)] : []),
      mdia,
    ],
  };

  const defaultSampleDescriptionIndex = asSafeNumber(
    BigInt(referenceContext?.defaultSampleDescriptionIndex ?? 1),
    "default sample description index",
  );
  const defaultSampleDuration = asSafeNumber(
    maybeGetVarint(fieldMap, moovLocmafIDs.defaultSampleDuration) ??
      BigInt(referenceContext?.defaultSampleDuration ?? 0),
    "default sample duration",
  );
  const defaultSampleSize = asSafeNumber(
    maybeGetVarint(fieldMap, moovLocmafIDs.defaultSampleSize) ??
      BigInt(referenceContext?.defaultSampleSize ?? 0),
    "default sample size",
  );
  const defaultSampleFlags = asSafeNumber(
    maybeGetVarint(fieldMap, moovLocmafIDs.defaultSampleFlags) ??
      BigInt(referenceContext?.defaultSampleFlags ?? 0),
    "default sample flags",
  );
  const defaultPerSampleIVSize = asSafeNumber(
    maybeGetVarint(fieldMap, moovLocmafIDs.defaultPerSampleIVSize) ??
      BigInt(referenceContext?.defaultPerSampleIVSize ?? 0),
    "default per-sample IV size",
  );

  const mvex: MovieExtendsBox = {
    type: "mvex",
    boxes: [
      {
        type: "trex",
        version: 0,
        flags: 0,
        trackId,
        defaultSampleDescriptionIndex,
        defaultSampleDuration,
        defaultSampleSize,
        defaultSampleFlags,
      } satisfies TrackExtendsBox,
    ],
  };

  const mvhd: MovieHeaderBox = {
    type: "mvhd",
    version: 0,
    flags: 0,
    creationTime: 0,
    modificationTime: 0,
    timescale: movieTimescale,
    duration: 0,
    rate: DEFAULT_MOVIE_RATE,
    volume: DEFAULT_MOVIE_VOLUME,
    reserved1: 0,
    reserved2: [0, 0],
    matrix: [...DEFAULT_TRANSFORM_MATRIX],
    preDefined: [0, 0, 0, 0, 0, 0],
    nextTrackId: trackId + 1,
  };

  const moov: MovieBox = {
    type: "moov",
    boxes: [mvhd, trak, mvex],
  };

  const context: LocmafInitContext = {
    trackId,
    timescale: trackTimescale,
    defaultSampleDescriptionIndex,
    defaultSampleDuration,
    defaultSampleSize,
    defaultSampleFlags,
    defaultPerSampleIVSize,
  };

  return {
    boxes: [ftypBox, moov],
    context,
  };
}

function createEditBox(mediaTime: bigint) {
  return {
    type: "edts" as const,
    boxes: [
      {
        type: "elst" as const,
        version: 0,
        flags: 0,
        entryCount: 1,
        entries: [
          {
            segmentDuration: 0,
            mediaTime: asSafeNumber(mediaTime, "edit list media time"),
            mediaRateInteger: 1,
            mediaRateFraction: 0,
          },
        ],
      },
    ],
  };
}

function repeatValue(value: bigint, count: number): bigint[] {
  return Array.from({ length: count }, () => value);
}

function createSencBox(
  fieldMap: RawFieldMap,
  sampleCount: number,
  perSampleIVSize: number,
): ExtendedSampleEncryptionBox | undefined {
  const ivValues = maybeGetVarintList(
    fieldMap,
    moofLocmafIDs.initializationVector,
  );
  const subsampleCounts = maybeGetVarintList(
    fieldMap,
    moofLocmafIDs.subsampleCount,
  );
  const clearData = maybeGetVarintList(
    fieldMap,
    moofLocmafIDs.bytesOfClearData,
  );
  const protectedData = maybeGetVarintList(
    fieldMap,
    moofLocmafIDs.bytesOfProtectedData,
  );

  if (!ivValues && !subsampleCounts && !clearData && !protectedData) {
    return undefined;
  }

  if (ivValues) {
    if (perSampleIVSize === 0) {
      throw new Error("locmaf moof includes IV data but IV size is zero");
    }
    if (ivValues.length !== sampleCount * perSampleIVSize) {
      throw new Error("locmaf IV field length does not match sample count");
    }
  }

  if (subsampleCounts && subsampleCounts.length !== sampleCount) {
    throw new Error("locmaf subsample count length mismatch");
  }
  if ((clearData || protectedData) && !subsampleCounts) {
    throw new Error(
      "locmaf subsample encryption data requires subsample counts",
    );
  }

  let clearIndex = 0;
  let protectedIndex = 0;
  const samples: SampleEncryptionEntry[] = [];

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const sample: SampleEncryptionEntry = {};

    if (ivValues) {
      const start = sampleIndex * perSampleIVSize;
      sample.initializationVector = Uint8Array.from(
        ivValues
          .slice(start, start + perSampleIVSize)
          .map((value) => asSafeNumber(value, "sample IV byte")),
      );
    }

    const subsampleCount = subsampleCounts
      ? asSafeNumber(subsampleCounts[sampleIndex], "subsample count")
      : 0;
    if (subsampleCount > 0) {
      sample.subsampleEncryption = [];
      for (let i = 0; i < subsampleCount; i++) {
        const bytesOfClearData = clearData?.[clearIndex] ?? 0n;
        const bytesOfProtectedData = protectedData?.[protectedIndex] ?? 0n;
        sample.subsampleEncryption.push({
          bytesOfClearData: asSafeNumber(
            bytesOfClearData,
            "bytes of clear data",
          ),
          bytesOfProtectedData: asSafeNumber(
            bytesOfProtectedData,
            "bytes of protected data",
          ),
        });
        clearIndex += 1;
        protectedIndex += 1;
      }
    }

    samples.push(sample);
  }

  return {
    type: "senc",
    version: 0,
    flags: samples.some((sample) => sample.subsampleEncryption?.length)
      ? SENC_USE_SUBSAMPLE_ENCRYPTION
      : 0,
    sampleCount,
    samples,
  };
}

function buildMoofFromFields(
  fieldMap: RawFieldMap,
  sequenceNumber: number,
  context: LocmafInitContext,
  mdatPayloadLength: number,
): { box: MovieFragmentBox; trackInfo: MediaTrackInfo } {
  const baseMediaDecodeTime = maybeGetVarint(
    fieldMap,
    moofLocmafIDs.baseMediaDecodeTime,
  );
  if (baseMediaDecodeTime === undefined) {
    throw new Error("locmaf moof is missing baseMediaDecodeTime");
  }

  const compositionOffsets = maybeGetSignedVarintList(
    fieldMap,
    moofLocmafIDs.sampleCompositionTimeOffsets,
  );
  const sampleCountValue = maybeGetVarint(fieldMap, moofLocmafIDs.sampleCount);
  if (sampleCountValue === undefined) {
    throw new Error("locmaf moof is missing sample count");
  }
  const sampleCount = asSafeNumber(sampleCountValue, "sample count");
  const hasCompositionOffsets = compositionOffsets !== undefined;
  const resolvedCompositionOffsets =
    compositionOffsets ?? repeatValue(0n, sampleCount);
  if (resolvedCompositionOffsets.length !== sampleCount) {
    throw new Error(
      "locmaf moof composition time offsets length does not match sample count",
    );
  }
  const tfhdDefaultSampleDuration =
    maybeGetVarint(fieldMap, moofLocmafIDs.defaultSampleDuration) ??
    BigInt(context.defaultSampleDuration);
  const tfhdDefaultSampleSize =
    maybeGetVarint(fieldMap, moofLocmafIDs.defaultSampleSize) ??
    BigInt(context.defaultSampleSize);
  const tfhdDefaultSampleFlags =
    maybeGetVarint(fieldMap, moofLocmafIDs.defaultSampleFlags) ??
    BigInt(context.defaultSampleFlags);
  const sampleSizes =
    maybeGetVarintList(fieldMap, moofLocmafIDs.sampleSizes) ??
    (() => {
      if (sampleCount === 1 && !fieldMap.has(moofLocmafIDs.defaultSampleSize)) {
        if (mdatPayloadLength <= 0) {
          throw new Error(
            "locmaf moof is missing sample size for a single-sample fragment from mdat payload length",
          );
        }
        return [BigInt(mdatPayloadLength)];
      }
      return repeatValue(tfhdDefaultSampleSize, sampleCount);
    })();
  const sampleDurations =
    maybeGetVarintList(fieldMap, moofLocmafIDs.sampleDurations) ??
    repeatValue(tfhdDefaultSampleDuration, sampleCount);
  const sampleFlags =
    maybeGetVarintList(fieldMap, moofLocmafIDs.sampleFlags) ??
    repeatValue(tfhdDefaultSampleFlags, sampleCount);
  const firstSampleFlags = maybeGetVarint(
    fieldMap,
    moofLocmafIDs.firstSampleFlags,
  );
  const perSampleIVSize = asSafeNumber(
    maybeGetVarint(fieldMap, moofLocmafIDs.perSampleIVSize) ??
      BigInt(context.defaultPerSampleIVSize),
    "per-sample IV size",
  );

  if (
    sampleSizes.length !== sampleCount ||
    sampleDurations.length !== sampleCount ||
    sampleFlags.length !== sampleCount
  ) {
    throw new Error("locmaf moof sample field lengths do not match");
  }

  const tfhdFlags =
    TFHD_DEFAULT_BASE_IS_MOOF |
    (fieldMap.has(moofLocmafIDs.sampleDescriptionIndex)
      ? TFHD_SAMPLE_DESCRIPTION_INDEX_PRESENT
      : 0) |
    (fieldMap.has(moofLocmafIDs.defaultSampleDuration)
      ? TFHD_DEFAULT_SAMPLE_DURATION_PRESENT
      : 0) |
    (fieldMap.has(moofLocmafIDs.defaultSampleSize)
      ? TFHD_DEFAULT_SAMPLE_SIZE_PRESENT
      : 0) |
    (fieldMap.has(moofLocmafIDs.defaultSampleFlags)
      ? TFHD_DEFAULT_SAMPLE_FLAGS_PRESENT
      : 0);

  const tfhd: TrackFragmentHeaderBox = {
    type: "tfhd",
    version: 0,
    flags: tfhdFlags,
    trackId: context.trackId,
  };

  const sampleDescriptionIndex = maybeGetVarint(
    fieldMap,
    moofLocmafIDs.sampleDescriptionIndex,
  );
  if (sampleDescriptionIndex !== undefined) {
    tfhd.sampleDescriptionIndex = asSafeNumber(
      sampleDescriptionIndex,
      "sample description index",
    );
  }

  if (fieldMap.has(moofLocmafIDs.defaultSampleDuration)) {
    tfhd.defaultSampleDuration = asSafeNumber(
      tfhdDefaultSampleDuration,
      "default sample duration",
    );
  }

  if (fieldMap.has(moofLocmafIDs.defaultSampleSize)) {
    tfhd.defaultSampleSize = asSafeNumber(
      tfhdDefaultSampleSize,
      "default sample size",
    );
  }

  if (fieldMap.has(moofLocmafIDs.defaultSampleFlags)) {
    tfhd.defaultSampleFlags = asSafeNumber(
      tfhdDefaultSampleFlags,
      "default sample flags",
    );
  }

  const samples: TrackRunSample[] = Array.from(
    { length: sampleCount },
    (_, index) => ({
      sampleDuration: asSafeNumber(
        sampleDurations[index],
        `sample ${index} duration`,
      ),
      sampleSize: asSafeNumber(sampleSizes[index], `sample ${index} size`),
      sampleFlags: asSafeNumber(sampleFlags[index], `sample ${index} flags`),
      sampleCompositionTimeOffset: asSafeNumber(
        resolvedCompositionOffsets[index],
        `sample ${index} composition offset`,
      ),
    }),
  );

  const trun: TrackRunBox = {
    type: "trun",
    version: samples.some(
      (sample) => (sample.sampleCompositionTimeOffset ?? 0) < 0,
    )
      ? 1
      : 0,
    flags:
      TRUN_DATA_OFFSET_PRESENT |
      (firstSampleFlags !== undefined ? TRUN_FIRST_SAMPLE_FLAGS_PRESENT : 0) |
      TRUN_SAMPLE_DURATION_PRESENT |
      TRUN_SAMPLE_SIZE_PRESENT |
      TRUN_SAMPLE_FLAGS_PRESENT |
      (hasCompositionOffsets ? TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT : 0),
    sampleCount,
    dataOffset: 0,
    samples,
  };

  if (firstSampleFlags !== undefined) {
    trun.firstSampleFlags = asSafeNumber(
      firstSampleFlags,
      "first sample flags",
    );
  }

  const tfdt: TrackFragmentBaseMediaDecodeTimeBox = {
    type: "tfdt",
    version: baseMediaDecodeTime > 0xffffffffn ? 1 : 0,
    flags: 0,
    baseMediaDecodeTime: asSafeNumber(
      baseMediaDecodeTime,
      "base media decode time",
    ),
  };
  const totalDuration = sampleDurations.reduce(
    (sum, duration) => sum + asSafeNumber(duration, "sample duration"),
    0,
  );

  const trafBoxes: TrackFragmentBox["boxes"] = [tfhd, tfdt, trun];
  const senc = createSencBox(fieldMap, sampleCount, perSampleIVSize);
  if (senc) {
    trafBoxes.push(senc as any);
  }

  return {
    box: {
      type: "moof",
      boxes: [
        {
          type: "mfhd",
          version: 0,
          flags: 0,
          sequenceNumber,
        },
        {
          type: "traf",
          boxes: trafBoxes,
        },
      ],
    },
    trackInfo: {
      timescale: context.timescale,
      baseMediaDecodeTime: tfdt.baseMediaDecodeTime,
      duration: totalDuration,
      sequenceNumber,
    },
  };
}

function encodeMoof(box: MovieFragmentBox): Uint8Array {
  const moofWithoutOffset = writeIsoBox(box as any, writerConfig);
  const traf = box.boxes.find(
    (child: { type: string }) => child.type === "traf",
  ) as TrackFragmentBox;
  const trun = traf.boxes.find(
    (child: { type: string }) => child.type === "trun",
  ) as TrackRunBox;
  trun.dataOffset = moofWithoutOffset.byteLength + 8;
  return writeIsoBox(box as any, writerConfig);
}

function deriveNextBaseMediaDecodeTime(
  previous: RawFieldMap,
  context: LocmafInitContext,
): bigint {
  const baseMediaDecodeTime = maybeGetVarint(
    previous,
    moofLocmafIDs.baseMediaDecodeTime,
  );
  if (baseMediaDecodeTime === undefined) {
    throw new Error("locmaf delta is missing previous baseMediaDecodeTime");
  }

  return baseMediaDecodeTime + moofFieldDuration(previous, context);
}

function moofFieldDuration(
  fields: RawFieldMap,
  context: LocmafInitContext,
): bigint {
  const sampleCountValue = maybeGetVarint(fields, moofLocmafIDs.sampleCount);
  if (sampleCountValue === undefined) {
    throw new Error("locmaf delta is missing previous sample count");
  }
  const sampleCount = asSafeNumber(sampleCountValue, "sample count");

  const sampleDurations = maybeGetVarintList(
    fields,
    moofLocmafIDs.sampleDurations,
  );
  if (sampleDurations !== undefined) {
    if (sampleDurations.length !== sampleCount) {
      throw new Error(
        "locmaf moof sample durations length does not match sample count",
      );
    }
    return sampleDurations.reduce((sum, duration) => sum + duration, 0n);
  }

  const defaultSampleDuration =
    maybeGetVarint(fields, moofLocmafIDs.defaultSampleDuration) ??
    BigInt(context.defaultSampleDuration);
  return defaultSampleDuration * sampleCountValue;
}

function applyMoofDelta(
  previous: RawFieldMap,
  delta: RawFieldMap,
  context: LocmafInitContext,
): RawFieldMap {
  const current = cloneFieldMap(previous);
  current.set(
    moofLocmafIDs.baseMediaDecodeTime,
    encodeQuicVarint(deriveNextBaseMediaDecodeTime(previous, context)),
  );

  const deletedFields = maybeGetVarintList(delta, moofDeltaDeletedLocmafID);
  if (deletedFields) {
    for (const deletedField of deletedFields) {
      current.delete(asSafeNumber(deletedField, "deleted locmaf id"));
    }
  }

  for (const [fieldId, deltaValue] of delta.entries()) {
    if (fieldId === moofDeltaDeletedLocmafID) {
      continue;
    }

    const previousValue = previous.get(fieldId);
    if (fieldId % 2 === 0) {
      const nextValue =
        readSingleSignedVarint(deltaValue) +
        (previousValue ? readSingleVarint(previousValue) : 0n);
      current.set(fieldId, encodeQuicVarint(nextValue));
      continue;
    }

    const currentList = readSignedVarintList(deltaValue);
    const previousList = previousValue
      ? readMoofFieldValueList(fieldId, previousValue)
      : [];
    current.set(
      fieldId,
      encodeMoofFieldValueList(
        fieldId,
        currentList.map((value, index) => value + (previousList[index] ?? 0n)),
      ),
    );
  }

  return current;
}

function findBox<T extends { type: string; boxes?: any[] }>(
  boxes: Array<T | any>,
  type: string,
): any | undefined {
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

function fourCcToUint32(value: string): number {
  if (value.length !== 4) {
    throw new Error(`fourcc must be exactly 4 characters, got "${value}"`);
  }

  return (
    ((value.charCodeAt(0) << 24) |
      (value.charCodeAt(1) << 16) |
      (value.charCodeAt(2) << 8) |
      value.charCodeAt(3)) >>>
    0
  );
}

function readSampleEntryMetadata(initSegment: Uint8Array): LocmafTrackMetadata {
  const parsed = readIsoBoxes(initSegment, readerConfig) as any[];
  const moov = parsed.find((box) => box.type === "moov") as
    | MovieBox
    | undefined;
  if (!moov) {
    throw new Error("init segment does not contain moov");
  }
  const mdhd = findBox(moov.boxes, "mdhd") as MediaHeaderBox | undefined;
  const hdlr = findBox(moov.boxes, "hdlr") as HandlerReferenceBox | undefined;
  const stsd = findBox(moov.boxes, "stsd") as SampleDescriptionBox | undefined;
  if (!mdhd || !stsd || stsd.entries.length === 0) {
    throw new Error("init segment is missing required track boxes");
  }

  const sampleEntry = stsd.entries[0] as any;
  return {
    codec: sampleEntry.type,
    timescale: mdhd.timescale,
    width: sampleEntry.width,
    height: sampleEntry.height,
    samplerate: sampleEntry.samplerate,
    channelCount: sampleEntry.channelcount,
    role: hdlr?.handlerType === "soun" ? "audio" : "video",
    lang: mdhd.language,
  };
}

function writeSenc(box: ExtendedSampleEncryptionBox): IsoBoxWriteView {
  let size = 8 + 4 + 4;
  for (const sample of box.samples) {
    size += sample.initializationVector?.byteLength ?? 0;
    if (box.flags & SENC_USE_SUBSAMPLE_ENCRYPTION) {
      size += 2;
      size += (sample.subsampleEncryption?.length ?? 0) * 6;
    }
  }

  const writer = new IsoBoxWriteView("senc", size);
  writer.writeFullBox(box.version, box.flags);
  writer.writeUint(box.sampleCount, 4);

  for (const sample of box.samples) {
    if (sample.initializationVector) {
      writer.writeBytes(sample.initializationVector);
    }
    if (box.flags & SENC_USE_SUBSAMPLE_ENCRYPTION) {
      const subsamples = sample.subsampleEncryption ?? [];
      writer.writeUint(subsamples.length, 2);
      for (const subsample of subsamples) {
        writer.writeUint(subsample.bytesOfClearData, 2);
        writer.writeUint(subsample.bytesOfProtectedData, 4);
      }
    }
  }

  return writer;
}

function writeTenc(box: ExtendedTrackEncryptionBox): IsoBoxWriteView {
  let size = 8 + 4 + 1 + 1 + 1 + 1 + 16;
  if (box.defaultIsEncrypted !== 0 && box.defaultIvSize === 0) {
    size += 1 + (box.defaultConstantIv?.byteLength ?? 0);
  }

  const writer = new IsoBoxWriteView("tenc", size);
  writer.writeFullBox(box.version, box.flags);
  writer.writeUint(0, 1);
  if (box.version > 0) {
    const cryptByteBlock = box.defaultCryptByteBlock ?? 0;
    const skipByteBlock = box.defaultSkipByteBlock ?? 0;
    writer.writeUint(
      ((cryptByteBlock & 0x0f) << 4) | (skipByteBlock & 0x0f),
      1,
    );
  } else {
    writer.writeUint(0, 1);
  }
  writer.writeUint(box.defaultIsEncrypted, 1);
  writer.writeUint(box.defaultIvSize, 1);
  writer.writeBytes(Uint8Array.from(box.defaultKid));
  if (box.defaultIsEncrypted !== 0 && box.defaultIvSize === 0) {
    const constantIv = box.defaultConstantIv ?? new Uint8Array();
    writer.writeUint(constantIv.byteLength, 1);
    writer.writeBytes(constantIv);
  }
  return writer;
}

export function locmafTrackMetadataFromWarpTrack(
  track: WarpTrack,
): LocmafTrackMetadata {
  return {
    codec: track.codec,
    timescale: track.timescale,
    width: track.width,
    height: track.height,
    samplerate: track.samplerate,
    role: track.role,
    lang: track.lang,
  };
}

export function extractTrackMetadataFromInitSegment(
  initSegment: Uint8Array | ArrayBuffer,
): LocmafTrackMetadata {
  return readSampleEntryMetadata(ensureUint8Array(initSegment));
}

export function extractInitContextFromInitSegment(
  initSegment: Uint8Array | ArrayBuffer,
): LocmafInitContext {
  const initBytes = ensureUint8Array(initSegment);
  const parsed = readIsoBoxes(initBytes, readerConfig) as any[];
  const moov = parsed.find((box) => box.type === "moov") as
    | MovieBox
    | undefined;
  if (!moov) {
    throw new Error("init segment does not contain moov");
  }
  const trex = findBox(moov.boxes, "trex") as TrackExtendsBox | undefined;
  if (!trex) {
    throw new Error("init segment does not contain trex");
  }
  const tenc = findBox(moov.boxes, "tenc") as
    | {
        defaultIvSize?: number;
      }
    | undefined;
  const metadata = extractTrackMetadataFromInitSegment(initBytes);
  if (metadata.timescale === undefined) {
    throw new Error("init segment does not contain track timescale");
  }

  return {
    trackId: trex.trackId,
    timescale: metadata.timescale,
    defaultSampleDescriptionIndex: trex.defaultSampleDescriptionIndex,
    defaultSampleDuration: trex.defaultSampleDuration,
    defaultSampleSize: trex.defaultSampleSize,
    defaultSampleFlags: trex.defaultSampleFlags,
    defaultPerSampleIVSize: tenc?.defaultIvSize ?? 0,
  };
}

export function decompressLocmafInit(
  payload: Uint8Array | ArrayBuffer,
  track: LocmafTrackMetadata,
  options?: {
    referenceInitSegment?: Uint8Array | ArrayBuffer;
  },
): LocmafInitDecompressionResult {
  const fieldMap = separateFields(ensureUint8Array(payload));
  const referenceInit = options?.referenceInitSegment
    ? ensureUint8Array(options.referenceInitSegment)
    : undefined;
  const ftyp = createFtypBox(referenceInit);
  const referenceContext = referenceInit
    ? extractInitContextFromInitSegment(referenceInit)
    : undefined;
  const { boxes, context } = buildInitBoxes(
    fieldMap,
    track,
    ftyp,
    referenceContext,
  );
  return {
    boxes,
    bytes: concatBytes(...writeIsoBoxes(boxes as any, writerConfig)),
    context,
  };
}

export class LocmafMoofDeltaDecoder {
  private previous?: RawFieldMap;

  public decode(
    headerType: typeof LOCMAF_HEADER_MOOF | typeof LOCMAF_HEADER_MOOF_DELTA,
    payload: Uint8Array | ArrayBuffer,
    sequenceNumber: number,
    context: LocmafInitContext,
    mdatPayloadLength: number,
  ): LocmafMoofDecompressionResult {
    const fieldMap = separateFields(ensureUint8Array(payload));
    let currentFields: RawFieldMap;

    if (headerType === LOCMAF_HEADER_MOOF) {
      currentFields = cloneFieldMap(fieldMap);
    } else if (headerType === LOCMAF_HEADER_MOOF_DELTA) {
      if (!this.previous) {
        throw new Error("cannot decode delta moof without a previous moof");
      }
      currentFields = applyMoofDelta(this.previous, fieldMap, context);
    } else {
      throw new Error(`unsupported locmaf moof header type ${headerType}`);
    }

    this.previous = cloneFieldMap(currentFields);
    const moof = buildMoofFromFields(
      currentFields,
      sequenceNumber,
      context,
      mdatPayloadLength,
    );
    return {
      box: moof.box,
      bytes: encodeMoof(moof.box),
      trackInfo: moof.trackInfo,
    };
  }

  public reset(): void {
    this.previous = undefined;
  }
}

export function createLocmafMdatBox(
  fragmentOrMdat: Uint8Array | ArrayBuffer,
): MediaDataBox {
  const input = ensureUint8Array(fragmentOrMdat);

  try {
    const parsed = readIsoBoxes(input, readerConfig) as any[];
    const mdat = parsed.find((box) => box.type === "mdat") as
      | MediaDataBox
      | undefined;
    if (mdat) {
      return {
        type: "mdat",
        data: new Uint8Array(mdat.data),
      };
    }
  } catch {
    // Fall back to treating the input as raw media payload bytes.
  }

  return {
    type: "mdat",
    data: new Uint8Array(input),
  };
}

export function assembleCmafFile(parts: {
  initSegment: Uint8Array | ArrayBuffer;
  moof: MovieFragmentBox | Uint8Array | ArrayBuffer;
  mdat: MediaDataBox | Uint8Array | ArrayBuffer;
}): Uint8Array {
  const initSegment = ensureUint8Array(parts.initSegment);
  const moofBytes =
    parts.moof instanceof Uint8Array || parts.moof instanceof ArrayBuffer
      ? ensureUint8Array(parts.moof)
      : encodeMoof(parts.moof);
  const mdatBytes =
    parts.mdat instanceof Uint8Array || parts.mdat instanceof ArrayBuffer
      ? ensureUint8Array(parts.mdat)
      : writeIsoBox(parts.mdat as any, writerConfig);

  return concatBytes(initSegment, moofBytes, mdatBytes);
}

export function getLocmafHeaderConstants(): Readonly<{
  moov: typeof LOCMAF_HEADER_MOOV;
  moof: typeof LOCMAF_HEADER_MOOF;
  moofDelta: typeof LOCMAF_HEADER_MOOF_DELTA;
}> {
  return {
    moov: LOCMAF_HEADER_MOOV,
    moof: LOCMAF_HEADER_MOOF,
    moofDelta: LOCMAF_HEADER_MOOF_DELTA,
  } as const;
}

function parseLocmafObject(payload: Uint8Array | ArrayBuffer): {
  headerId: number;
  locPayload: Uint8Array;
  mdatPayload: Uint8Array;
} {
  const bytes = ensureUint8Array(payload);
  const header = decodeQuicVarint(bytes, 0);
  const locLength = decodeQuicVarint(bytes, header.bytesRead);
  const headerId = asSafeNumber(header.value, "locmaf object header id");
  const locPayloadLength = asSafeNumber(
    locLength.value,
    "locmaf object payload length",
  );
  const locStart = header.bytesRead + locLength.bytesRead;
  const locEnd = locStart + locPayloadLength;

  if (locPayloadLength < 0 || locEnd > bytes.byteLength) {
    throw new Error("locmaf LOC payload exceeds object length");
  }

  return {
    headerId,
    locPayload: bytes.subarray(locStart, locEnd),
    mdatPayload: bytes.subarray(locEnd),
  };
}

function parseLocmafInit(payload: Uint8Array | ArrayBuffer): {
  headerId: number;
  locPayload: Uint8Array;
} {
  const bytes = ensureUint8Array(payload);
  const header = decodeQuicVarint(bytes, 0);
  const locLength = decodeQuicVarint(bytes, header.bytesRead);
  const headerId = asSafeNumber(header.value, "locmaf init header id");
  const locPayloadLength = asSafeNumber(
    locLength.value,
    "locmaf init payload length",
  );
  const locStart = header.bytesRead + locLength.bytesRead;
  const locEnd = locStart + locPayloadLength;

  if (locPayloadLength < 0 || locEnd > bytes.byteLength) {
    throw new Error("locmaf init payload exceeds object length");
  }

  return {
    headerId,
    locPayload: bytes.subarray(locStart, locEnd),
  };
}

export function isLocmafTrack(track: Pick<WarpTrack, "packaging">): boolean {
  return track.packaging === "locmaf";
}

export function createLocmafTrackState(
  track: WarpTrack,
  locmafInitSegment: Uint8Array | ArrayBuffer,
): LocmafTrackState {
  const headers = getLocmafHeaderConstants();
  let locPayload = ensureUint8Array(locmafInitSegment);

  try {
    const parsedInit = parseLocmafInit(locmafInitSegment);
    if (parsedInit.headerId !== headers.moov) {
      throw new Error(`unsupported locmaf init header ${parsedInit.headerId}`);
    }
    locPayload = parsedInit.locPayload;
  } catch {
    // Backward compatibility for pre-framed test fixtures / older catalogs.
  }

  const reconstructedInit = decompressLocmafInit(
    locPayload,
    locmafTrackMetadataFromWarpTrack(track),
  );

  return {
    initContext: reconstructedInit.context,
    initSegment: reconstructedInit.bytes,
    moofDecoder: new LocmafMoofDeltaDecoder(),
  };
}

export function initializeLocmafTrack(
  track: WarpTrack,
  initSegment: Uint8Array | ArrayBuffer,
): InitializedLocmafTrack {
  const initBytes = ensureUint8Array(initSegment);

  try {
    const parsedInit = parseLocmafInit(initBytes);
    if (parsedInit.headerId === getLocmafHeaderConstants().moov) {
      return {
        state: createLocmafTrackState(track, initBytes),
        initWasReconstructed: true,
      };
    }
  } catch {
    // Not a framed locmaf init.
  }

  try {
    return {
      state: {
        initContext: extractInitContextFromInitSegment(initBytes),
        initSegment: initBytes,
        moofDecoder: new LocmafMoofDeltaDecoder(),
      },
      initWasReconstructed: false,
    };
  } catch {
    return {
      state: createLocmafTrackState(track, initBytes),
      initWasReconstructed: true,
    };
  }
}

export function decompressMoof(
  payload: Uint8Array | ArrayBuffer,
  sequenceNumber: number,
  state: LocmafTrackState,
): Uint8Array {
  return decompressMoofWithTrackInfo(payload, sequenceNumber, state).bytes;
}

export function decompressMoofWithTrackInfo(
  payload: Uint8Array | ArrayBuffer,
  sequenceNumber: number,
  state: LocmafTrackState,
): { bytes: Uint8Array; trackInfo: MediaTrackInfo } {
  const { headerId, locPayload, mdatPayload } = parseLocmafObject(payload);
  const headers = getLocmafHeaderConstants();

  if (headerId !== headers.moof && headerId !== headers.moofDelta) {
    throw new Error(`unsupported locmaf moof header ${headerId}`);
  }

  const moof = state.moofDecoder.decode(
    headerId,
    locPayload,
    sequenceNumber,
    state.initContext,
    mdatPayload.byteLength,
  );
  const mdat = createLocmafMdatBox(mdatPayload);

  return {
    bytes: assembleCmafFile({
      initSegment: new Uint8Array(),
      moof: moof.box,
      mdat,
    }),
    trackInfo: moof.trackInfo,
  };
}

export function decompressLocmafFragment(
  payload: Uint8Array | ArrayBuffer,
  sequenceNumber: number,
  state: LocmafTrackState,
): Uint8Array {
  return decompressMoof(payload, sequenceNumber, state);
}
