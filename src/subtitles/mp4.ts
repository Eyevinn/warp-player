/**
 * The little ISOBMFF a text track needs: the sample entry of the init
 * segment, and the timed samples of a CMAF chunk.
 *
 * Text never goes to MSE, so the player reads the samples itself. A MoQ
 * object is one CMAF chunk, but the walker accepts any number of
 * `moof`+`mdat` pairs, since an HTTP segment of many chunks is the same
 * structure and the case two shaka-player bugs were made of.
 */
import type { InitContext } from "../locmaf/v03/types";

/** One timed sample, with its time already in milliseconds. */
export interface TextSample {
  startMs: number;
  endMs: number;
  /** ISO sample_flags. */
  flags: number;
  data: Uint8Array;
}

/** tfhd flags (ISO/IEC 14496-12 §8.8.7). */
const TFHD_BASE_DATA_OFFSET = 0x000001;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x000002;
const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008;
const TFHD_DEFAULT_SAMPLE_SIZE = 0x000010;
const TFHD_DEFAULT_SAMPLE_FLAGS = 0x000020;

/** trun flags (ISO/IEC 14496-12 §8.8.8). */
const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const TRUN_SAMPLE_CTO = 0x000800;

/** A box inside a byte range: its type and the range of its payload. */
export interface BoxRange {
  type: string;
  start: number;
  /** First payload byte, after the 8-byte (or 16-byte large) header. */
  body: number;
  end: number;
}

function u32(data: Uint8Array, off: number): number {
  return (
    data[off] * 0x1000000 +
    data[off + 1] * 0x10000 +
    data[off + 2] * 0x100 +
    data[off + 3]
  );
}

function i32(data: Uint8Array, off: number): number {
  const v = u32(data, off);
  return v >= 0x80000000 ? v - 0x100000000 : v;
}

function u64(data: Uint8Array, off: number): number {
  return u32(data, off) * 0x100000000 + u32(data, off + 4);
}

export function fourCC(data: Uint8Array, off: number): string {
  return String.fromCharCode(
    data[off],
    data[off + 1],
    data[off + 2],
    data[off + 3],
  );
}

/** The boxes in [start, end), in order. Stops at a malformed size. */
export function boxesIn(
  data: Uint8Array,
  start = 0,
  end = data.length,
): BoxRange[] {
  const boxes: BoxRange[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32(data, pos);
    let body = pos + 8;
    if (size === 1) {
      if (pos + 16 > end) {
        break;
      }
      size = u64(data, pos + 8);
      body = pos + 16;
    } else if (size === 0) {
      size = end - pos; // Extends to the end of the enclosing range.
    }
    if (size < body - pos || pos + size > end) {
      break;
    }
    boxes.push({
      type: fourCC(data, pos + 4),
      start: pos,
      body,
      end: pos + size,
    });
    pos += size;
  }
  return boxes;
}

function child(
  data: Uint8Array,
  parent: BoxRange,
  type: string,
): BoxRange | undefined {
  return boxesIn(data, parent.body, parent.end).find((b) => b.type === type);
}

/**
 * The 4CC of the first sample entry in the init segment's `stsd`: `stpp`,
 * `stpc`, `wvtt`, `wvtc` for the text tracks. Null if there is none.
 *
 * This, not the catalog's codec string, is what gates the paint-model
 * receiver: a substring test on codecs is how players have misread text
 * formats before (dash.js #5145).
 */
export function sampleEntryType(init: Uint8Array): string | null {
  const path = ["moov", "trak", "mdia", "minf", "stbl", "stsd"];
  let range: BoxRange | undefined = {
    type: "",
    start: 0,
    body: 0,
    end: init.length,
  };
  for (const type of path) {
    range = child(init, range, type);
    if (!range) {
      return null;
    }
  }
  // stsd is a FullBox with an entry_count before the entries.
  const entries = boxesIn(init, range.body + 8, range.end);
  return entries.length > 0 ? entries[0].type : null;
}

/**
 * Every sample of every `moof`+`mdat` in `chunk`, timed from `tfdt` and the
 * per-sample durations, in milliseconds on the media timeline.
 */
export function parseCmafSamples(
  chunk: Uint8Array,
  ctx: InitContext,
): TextSample[] {
  const samples: TextSample[] = [];
  for (const box of boxesIn(chunk)) {
    if (box.type === "moof") {
      samples.push(...moofSamples(chunk, box, ctx));
    }
  }
  return samples;
}

function moofSamples(
  data: Uint8Array,
  moof: BoxRange,
  ctx: InitContext,
): TextSample[] {
  // warp-player subscribes to single-track fragments: the first traf is the track.
  const traf = child(data, moof, "traf");
  if (!traf) {
    return [];
  }
  const parts = boxesIn(data, traf.body, traf.end);
  const tfhd = parts.find((b) => b.type === "tfhd");
  const tfdt = parts.find((b) => b.type === "tfdt");
  if (!tfhd || !tfdt) {
    return [];
  }

  const tfhdFlags = u32(data, tfhd.body) & 0xffffff;
  let pos = tfhd.body + 8; // version/flags, track_ID
  let base = moof.start; // default-base-is-moof, and the CMAF default
  if (tfhdFlags & TFHD_BASE_DATA_OFFSET) {
    base = u64(data, pos);
    pos += 8;
  }
  if (tfhdFlags & TFHD_SAMPLE_DESCRIPTION_INDEX) {
    pos += 4;
  }
  let defaultDuration = ctx.trexDefaultSampleDuration;
  let defaultSize = ctx.trexDefaultSampleSize;
  let defaultFlags = ctx.trexDefaultSampleFlags;
  if (tfhdFlags & TFHD_DEFAULT_SAMPLE_DURATION) {
    defaultDuration = u32(data, pos);
    pos += 4;
  }
  if (tfhdFlags & TFHD_DEFAULT_SAMPLE_SIZE) {
    defaultSize = u32(data, pos);
    pos += 4;
  }
  if (tfhdFlags & TFHD_DEFAULT_SAMPLE_FLAGS) {
    defaultFlags = u32(data, pos);
  }

  const tfdtVersion = data[tfdt.body];
  let decodeTime =
    tfdtVersion === 1 ? u64(data, tfdt.body + 4) : u32(data, tfdt.body + 4);
  const timescale = ctx.timescale || 1000;
  const toMs = (t: number): number => (t * 1000) / timescale;

  const samples: TextSample[] = [];
  let cursor = base;
  for (const trun of parts.filter((b) => b.type === "trun")) {
    const flags = u32(data, trun.body) & 0xffffff;
    const count = u32(data, trun.body + 4);
    let p = trun.body + 8;
    if (flags & TRUN_DATA_OFFSET) {
      cursor = base + i32(data, p);
      p += 4;
    }
    let firstFlags: number | undefined;
    if (flags & TRUN_FIRST_SAMPLE_FLAGS) {
      firstFlags = u32(data, p);
      p += 4;
    }
    for (let i = 0; i < count; i++) {
      let duration = defaultDuration;
      let size = defaultSize;
      let sampleFlags =
        i === 0 && firstFlags !== undefined ? firstFlags : defaultFlags;
      if (flags & TRUN_SAMPLE_DURATION) {
        duration = u32(data, p);
        p += 4;
      }
      if (flags & TRUN_SAMPLE_SIZE) {
        size = u32(data, p);
        p += 4;
      }
      if (flags & TRUN_SAMPLE_FLAGS) {
        sampleFlags = u32(data, p);
        p += 4;
      }
      if (flags & TRUN_SAMPLE_CTO) {
        p += 4; // Text samples are not reordered.
      }
      if (p > trun.end || cursor + size > data.length) {
        return samples; // Truncated: keep what was complete.
      }
      samples.push({
        startMs: toMs(decodeTime),
        endMs: toMs(decodeTime + duration),
        flags: sampleFlags,
        data: data.subarray(cursor, cursor + size),
      });
      cursor += size;
      decodeTime += duration;
    }
  }
  return samples;
}

/**
 * The type of a sample that is a single whole-sample box of one of `types`:
 * its size field equals the sample size and its type is listed. Null for
 * anything else — in particular any TTML document, which cannot start with
 * the zero byte of a box size.
 */
export function wholeSampleBoxType(
  sample: Uint8Array,
  types: readonly string[],
): string | null {
  if (sample.length < 8 || u32(sample, 0) !== sample.length) {
    return null;
  }
  const type = fourCC(sample, 4);
  return types.includes(type) ? type : null;
}
