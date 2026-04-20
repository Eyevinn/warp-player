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

import type { WarpTrack } from "../warpcatalog";

const LOC_HEADER_MOOV = 21;
const LOC_HEADER_MOOF = 23;
const LOC_HEADER_MOOF_DELTA = 25;

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

type LocBox = MovieBox | MovieFragmentBox | FileTypeBox | MediaDataBox | RawBox;

const moovFieldIds = {
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

const moofFieldIds = {
  sampleDescriptionIndex: 2,
  defaultSampleDuration: 4,
  defaultSampleSize: 6,
  defaultSampleFlags: 8,
  baseMediaDecodeTime: 10,
  firstSampleFlags: 12,
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

const moofDeltaDeletedFieldId = 17;

export interface LocTrackMetadata {
  codec?: string;
  timescale?: number;
  width?: number;
  height?: number;
  samplerate?: number;
  channelCount?: number;
  role?: string;
  lang?: string;
}

export interface LocInitContext {
  trackId: number;
  defaultSampleDescriptionIndex: number;
  defaultSampleDuration: number;
  defaultSampleSize: number;
  defaultSampleFlags: number;
  defaultPerSampleIVSize: number;
}

export interface LocInitDecompressionResult {
  bytes: Uint8Array;
  boxes: LocBox[];
  context: LocInitContext;
}

export interface LocMoofDecompressionResult {
  box: MovieFragmentBox;
  bytes: Uint8Array;
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

function decodeGoUvarint(
  bytes: Uint8Array,
  offset: number,
): { value: bigint; bytesRead: number } {
  let value = 0n;
  let shift = 0n;

  for (let i = 0; i < 10; i++) {
    const index = offset + i;
    if (index >= bytes.length) {
      throw new Error("unexpected end of LOC payload");
    }
    const byte = BigInt(bytes[index]);
    if (byte < 0x80n) {
      if (i === 9 && byte > 1n) {
        throw new Error("LOC varint overflow");
      }
      return {
        value: value | (byte << shift),
        bytesRead: i + 1,
      };
    }
    value |= (byte & 0x7fn) << shift;
    shift += 7n;
  }

  throw new Error("LOC varint overflow");
}

function decodeGoVarint(
  bytes: Uint8Array,
  offset: number,
): { value: bigint; bytesRead: number } {
  const { value, bytesRead } = decodeGoUvarint(bytes, offset);
  const decoded = (value & 1n) === 0n ? value >> 1n : ~(value >> 1n);
  return { value: decoded, bytesRead };
}

function encodeGoUvarint(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new Error("uvarint must be non-negative");
  }

  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80n) {
    bytes.push(Number((remaining & 0x7fn) | 0x80n));
    remaining >>= 7n;
  }
  bytes.push(Number(remaining));
  return Uint8Array.from(bytes);
}

function encodeGoVarint(value: bigint): Uint8Array {
  const zigzag = value >= 0n ? value << 1n : ~(value << 1n);
  return encodeGoUvarint(zigzag);
}

function readSingleVarint(value: Uint8Array): bigint {
  const decoded = decodeGoVarint(value, 0);
  if (decoded.bytesRead !== value.byteLength) {
    throw new Error("LOC scalar field has trailing bytes");
  }
  return decoded.value;
}

function readVarintList(value: Uint8Array): bigint[] {
  const result: bigint[] = [];
  let offset = 0;
  while (offset < value.byteLength) {
    const decoded = decodeGoVarint(value, offset);
    result.push(decoded.value);
    offset += decoded.bytesRead;
  }
  return result;
}

function encodeVarintList(values: bigint[]): Uint8Array {
  return concatBytes(...values.map((value) => encodeGoVarint(value)));
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
    const fieldIdDecoded = decodeGoVarint(data, offset);
    offset += fieldIdDecoded.bytesRead;
    const fieldId = asSafeNumber(fieldIdDecoded.value, "LOC field id");

    if (fieldId % 2 === 0) {
      const valueDecoded = decodeGoVarint(data, offset);
      fields.set(fieldId, data.slice(offset, offset + valueDecoded.bytesRead));
      offset += valueDecoded.bytesRead;
      continue;
    }

    const lengthDecoded = decodeGoVarint(data, offset);
    offset += lengthDecoded.bytesRead;
    const length = asSafeNumber(lengthDecoded.value, "LOC field length");
    const nextOffset = offset + length;
    if (length < 0 || nextOffset > data.byteLength) {
      throw new Error(`LOC field ${fieldId} exceeds payload length`);
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
  track: LocTrackMetadata,
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
  track: LocTrackMetadata,
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
        Number(maybeGetVarint(fieldMap, moovFieldIds.channelCount) ?? 2n),
      samplesize: 16,
      preDefined: 0,
      reserved3: 0,
      samplerate: track.samplerate ?? track.timescale ?? 48000,
      boxes: [],
    };

    const codecConfigurationBox = getRawBoxField(
      fieldMap,
      moovFieldIds.codecConfigurationBox,
    );
    const chnlBox = getRawBoxField(fieldMap, moovFieldIds.chnl);
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
    moovFieldIds.codecConfigurationBox,
  );
  const colrBox = getRawBoxField(fieldMap, moovFieldIds.colr);
  const paspBox = getRawBoxField(fieldMap, moovFieldIds.pasp);
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
  track?: LocTrackMetadata,
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
  const schemeType = maybeGetVarint(fieldMap, moovFieldIds.schemeType);
  const defaultKid = fieldMap.get(moovFieldIds.defaultKID);
  const defaultPerSampleIVSize = maybeGetVarint(
    fieldMap,
    moovFieldIds.defaultPerSampleIVSize,
  );

  if (!schemeType && !defaultKid && defaultPerSampleIVSize === undefined) {
    return undefined;
  }

  const tencVersion = asSafeNumber(
    maybeGetVarint(fieldMap, moovFieldIds.tencVersion) ?? 0n,
    "tenc version",
  );
  const defaultCryptByteBlock = maybeGetVarint(
    fieldMap,
    moovFieldIds.defaultCryptByteBlock,
  );
  const defaultSkipByteBlock = maybeGetVarint(
    fieldMap,
    moovFieldIds.defaultSkipByteBlock,
  );
  const defaultConstantIv = fieldMap.get(moovFieldIds.defaultConstantIV);

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
  track: LocTrackMetadata,
  ftypBox: FileTypeBox,
  referenceContext?: LocInitContext,
): { boxes: LocBox[]; context: LocInitContext } {
  const formatValue = maybeGetVarint(fieldMap, moovFieldIds.format);
  if (formatValue === undefined) {
    throw new Error("LOC init header does not contain a sample entry format");
  }

  const movieTimescale = asSafeNumber(
    maybeGetVarint(fieldMap, moovFieldIds.movieTimescale) ??
      BigInt(track.timescale ?? 90000),
    "movie timescale",
  );
  const format = fourCcFromBigInt(formatValue);
  const mediaType = inferMediaType(format, track);
  const trackTimescale = track.timescale ?? movieTimescale;
  const trackId = DEFAULT_TRACK_ID;
  const trackFlags = asSafeNumber(
    maybeGetVarint(fieldMap, moovFieldIds.tkhdFlags) ?? 7n,
    "tkhd flags",
  );
  const mediaTime = maybeGetVarint(fieldMap, moovFieldIds.mediaTime);

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
    maybeGetVarint(fieldMap, moovFieldIds.defaultSampleDuration) ??
      BigInt(referenceContext?.defaultSampleDuration ?? 0),
    "default sample duration",
  );
  const defaultSampleSize = asSafeNumber(
    maybeGetVarint(fieldMap, moovFieldIds.defaultSampleSize) ??
      BigInt(referenceContext?.defaultSampleSize ?? 0),
    "default sample size",
  );
  const defaultSampleFlags = asSafeNumber(
    maybeGetVarint(fieldMap, moovFieldIds.defaultSampleFlags) ??
      BigInt(referenceContext?.defaultSampleFlags ?? 0),
    "default sample flags",
  );
  const defaultPerSampleIVSize = asSafeNumber(
    maybeGetVarint(fieldMap, moovFieldIds.defaultPerSampleIVSize) ??
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

  const context: LocInitContext = {
    trackId,
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
    moofFieldIds.initializationVector,
  );
  const subsampleCounts = maybeGetVarintList(
    fieldMap,
    moofFieldIds.subsampleCount,
  );
  const clearData = maybeGetVarintList(fieldMap, moofFieldIds.bytesOfClearData);
  const protectedData = maybeGetVarintList(
    fieldMap,
    moofFieldIds.bytesOfProtectedData,
  );

  if (!ivValues && !subsampleCounts && !clearData && !protectedData) {
    return undefined;
  }

  if (ivValues) {
    if (perSampleIVSize === 0) {
      throw new Error("LOC moof includes IV data but IV size is zero");
    }
    if (ivValues.length !== sampleCount * perSampleIVSize) {
      throw new Error("LOC IV field length does not match sample count");
    }
  }

  if (subsampleCounts && subsampleCounts.length !== sampleCount) {
    throw new Error("LOC subsample count length mismatch");
  }
  if ((clearData || protectedData) && !subsampleCounts) {
    throw new Error("LOC subsample encryption data requires subsample counts");
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
  context: LocInitContext,
): MovieFragmentBox {
  const baseMediaDecodeTime = maybeGetVarint(
    fieldMap,
    moofFieldIds.baseMediaDecodeTime,
  );
  if (baseMediaDecodeTime === undefined) {
    throw new Error("LOC moof is missing baseMediaDecodeTime");
  }

  const compositionOffsets = maybeGetVarintList(
    fieldMap,
    moofFieldIds.sampleCompositionTimeOffsets,
  );
  if (!compositionOffsets) {
    throw new Error("LOC moof is missing composition time offsets");
  }

  const sampleCount = compositionOffsets.length;
  const tfhdDefaultSampleDuration =
    maybeGetVarint(fieldMap, moofFieldIds.defaultSampleDuration) ??
    BigInt(context.defaultSampleDuration);
  const tfhdDefaultSampleSize =
    maybeGetVarint(fieldMap, moofFieldIds.defaultSampleSize) ??
    BigInt(context.defaultSampleSize);
  const tfhdDefaultSampleFlags =
    maybeGetVarint(fieldMap, moofFieldIds.defaultSampleFlags) ??
    BigInt(context.defaultSampleFlags);
  const sampleSizes =
    maybeGetVarintList(fieldMap, moofFieldIds.sampleSizes) ??
    repeatValue(tfhdDefaultSampleSize, sampleCount);
  const sampleDurations =
    maybeGetVarintList(fieldMap, moofFieldIds.sampleDurations) ??
    repeatValue(tfhdDefaultSampleDuration, sampleCount);
  const sampleFlags =
    maybeGetVarintList(fieldMap, moofFieldIds.sampleFlags) ??
    repeatValue(tfhdDefaultSampleFlags, sampleCount);
  const firstSampleFlags = maybeGetVarint(
    fieldMap,
    moofFieldIds.firstSampleFlags,
  );
  const perSampleIVSize = asSafeNumber(
    maybeGetVarint(fieldMap, moofFieldIds.perSampleIVSize) ??
      BigInt(context.defaultPerSampleIVSize),
    "per-sample IV size",
  );

  if (
    sampleSizes.length !== sampleCount ||
    sampleDurations.length !== sampleCount ||
    sampleFlags.length !== sampleCount
  ) {
    throw new Error("LOC moof sample field lengths do not match");
  }

  const tfhdFlags =
    TFHD_DEFAULT_BASE_IS_MOOF |
    (fieldMap.has(moofFieldIds.sampleDescriptionIndex)
      ? TFHD_SAMPLE_DESCRIPTION_INDEX_PRESENT
      : 0) |
    (fieldMap.has(moofFieldIds.defaultSampleDuration)
      ? TFHD_DEFAULT_SAMPLE_DURATION_PRESENT
      : 0) |
    (fieldMap.has(moofFieldIds.defaultSampleSize)
      ? TFHD_DEFAULT_SAMPLE_SIZE_PRESENT
      : 0) |
    (fieldMap.has(moofFieldIds.defaultSampleFlags)
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
    moofFieldIds.sampleDescriptionIndex,
  );
  if (sampleDescriptionIndex !== undefined) {
    tfhd.sampleDescriptionIndex = asSafeNumber(
      sampleDescriptionIndex,
      "sample description index",
    );
  }

  if (fieldMap.has(moofFieldIds.defaultSampleDuration)) {
    tfhd.defaultSampleDuration = asSafeNumber(
      tfhdDefaultSampleDuration,
      "default sample duration",
    );
  }

  if (fieldMap.has(moofFieldIds.defaultSampleSize)) {
    tfhd.defaultSampleSize = asSafeNumber(
      tfhdDefaultSampleSize,
      "default sample size",
    );
  }

  if (fieldMap.has(moofFieldIds.defaultSampleFlags)) {
    tfhd.defaultSampleFlags = asSafeNumber(
      tfhdDefaultSampleFlags,
      "default sample flags",
    );
  }

  const samples: TrackRunSample[] = compositionOffsets.map((offset, index) => ({
    sampleDuration: asSafeNumber(
      sampleDurations[index],
      `sample ${index} duration`,
    ),
    sampleSize: asSafeNumber(sampleSizes[index], `sample ${index} size`),
    sampleFlags: asSafeNumber(sampleFlags[index], `sample ${index} flags`),
    sampleCompositionTimeOffset: asSafeNumber(
      offset,
      `sample ${index} composition offset`,
    ),
  }));

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
      TRUN_SAMPLE_COMPOSITION_TIME_OFFSET_PRESENT,
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

  const trafBoxes: TrackFragmentBox["boxes"] = [tfhd, tfdt, trun];
  const senc = createSencBox(fieldMap, sampleCount, perSampleIVSize);
  if (senc) {
    trafBoxes.push(senc as any);
  }

  return {
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

function applyMoofDelta(
  previous: RawFieldMap,
  delta: RawFieldMap,
): RawFieldMap {
  const current = cloneFieldMap(previous);
  const deletedFields = maybeGetVarintList(delta, moofDeltaDeletedFieldId);
  if (deletedFields) {
    for (const deletedField of deletedFields) {
      current.delete(asSafeNumber(deletedField, "deleted LOC field id"));
    }
  }

  for (const [fieldId, deltaValue] of delta.entries()) {
    if (fieldId === moofDeltaDeletedFieldId) {
      continue;
    }

    const previousValue = current.get(fieldId);
    if (fieldId % 2 === 0) {
      const nextValue =
        readSingleVarint(deltaValue) +
        (previousValue ? readSingleVarint(previousValue) : 0n);
      current.set(fieldId, encodeGoVarint(nextValue));
      continue;
    }

    const currentList = readVarintList(deltaValue);
    const previousList = previousValue ? readVarintList(previousValue) : [];
    current.set(
      fieldId,
      encodeVarintList(
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

function readSampleEntryMetadata(initSegment: Uint8Array): LocTrackMetadata {
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

export function locTrackMetadataFromWarpTrack(
  track: WarpTrack,
): LocTrackMetadata {
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
): LocTrackMetadata {
  return readSampleEntryMetadata(ensureUint8Array(initSegment));
}

export function extractInitContextFromInitSegment(
  initSegment: Uint8Array | ArrayBuffer,
): LocInitContext {
  const parsed = readIsoBoxes(
    ensureUint8Array(initSegment),
    readerConfig,
  ) as any[];
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

  return {
    trackId: trex.trackId,
    defaultSampleDescriptionIndex: trex.defaultSampleDescriptionIndex,
    defaultSampleDuration: trex.defaultSampleDuration,
    defaultSampleSize: trex.defaultSampleSize,
    defaultSampleFlags: trex.defaultSampleFlags,
    defaultPerSampleIVSize: tenc?.defaultIvSize ?? 0,
  };
}

export function decompressLocInit(
  payload: Uint8Array | ArrayBuffer,
  track: LocTrackMetadata,
  options?: {
    referenceInitSegment?: Uint8Array | ArrayBuffer;
  },
): LocInitDecompressionResult {
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

export function decompressLocMoof(
  payload: Uint8Array | ArrayBuffer,
  sequenceNumber: number,
  context: LocInitContext,
): LocMoofDecompressionResult {
  const fieldMap = separateFields(ensureUint8Array(payload));
  const box = buildMoofFromFields(fieldMap, sequenceNumber, context);
  return {
    box,
    bytes: encodeMoof(box),
  };
}

export class LocMoofDeltaDecoder {
  private previous?: RawFieldMap;

  public decode(
    headerType: typeof LOC_HEADER_MOOF | typeof LOC_HEADER_MOOF_DELTA,
    payload: Uint8Array | ArrayBuffer,
    sequenceNumber: number,
    context: LocInitContext,
  ): LocMoofDecompressionResult {
    const fieldMap = separateFields(ensureUint8Array(payload));
    let currentFields: RawFieldMap;

    if (headerType === LOC_HEADER_MOOF) {
      currentFields = cloneFieldMap(fieldMap);
    } else if (headerType === LOC_HEADER_MOOF_DELTA) {
      if (!this.previous) {
        throw new Error("cannot decode delta moof without a previous moof");
      }
      currentFields = applyMoofDelta(this.previous, fieldMap);
    } else {
      throw new Error(`unsupported LOC moof header type ${headerType}`);
    }

    this.previous = cloneFieldMap(currentFields);
    const box = buildMoofFromFields(currentFields, sequenceNumber, context);
    return {
      box,
      bytes: encodeMoof(box),
    };
  }

  public reset(): void {
    this.previous = undefined;
  }
}

export function createLocMdatBox(
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

export function getLocHeaderConstants(): Readonly<{
  moov: typeof LOC_HEADER_MOOV;
  moof: typeof LOC_HEADER_MOOF;
  moofDelta: typeof LOC_HEADER_MOOF_DELTA;
}> {
  return {
    moov: LOC_HEADER_MOOV,
    moof: LOC_HEADER_MOOF,
    moofDelta: LOC_HEADER_MOOF_DELTA,
  } as const;
}
