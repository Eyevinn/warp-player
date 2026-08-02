/**
 * Walk a CMAF fragment's samples and feed them to a CTA-608 source.
 *
 * Both MSE packagings arrive here as plain CMAF bytes: `packaging: "cmaf"`
 * objects pass through untouched, and `packaging: "locmaf"` objects are
 * reconstructed to canonical `moof`+`mdat` before they reach the source
 * buffer, so one call site covers both.
 *
 * Nothing is copied: the samples are addressed through a `DataView` over the
 * caller's ArrayBuffer.
 */
import * as ISOBoxer from "codem-isoboxer";

import type { ILogger } from "../logger";

/** The subset of `Cc608Source` this module needs. */
export interface Cta608SampleConsumer {
  addSample(
    timeSec: number,
    view: DataView,
    offset: number,
    size: number,
  ): void;
}

/** tfhd flag: base-data-offset-present. */
const TFHD_BASE_DATA_OFFSET_PRESENT = 0x000001;
/** tfhd flag: default-base-is-moof. */
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;
/** trun flag: data-offset-present. */
const TRUN_DATA_OFFSET_PRESENT = 0x000001;

function childrenOf(box: any): any[] {
  return box && Array.isArray(box.boxes) ? box.boxes : [];
}

function firstChild(box: any, type: string): any | undefined {
  return childrenOf(box).find((child: any) => child.type === type);
}

function allChildren(box: any, type: string): any[] {
  return childrenOf(box).filter((child: any) => child.type === type);
}

/**
 * Feed every sample of every `moof` in `fragment` to `consumer`.
 *
 * @param fragment - the complete CMAF fragment (styp/moof/mdat, possibly
 *   several moof+mdat pairs).
 * @param timescale - the video track's timescale, from the init segment.
 * @returns the number of samples handed to the consumer.
 */
export function extractCta608FromFragment(
  fragment: ArrayBuffer,
  timescale: number,
  consumer: Cta608SampleConsumer,
  logger: ILogger,
): number {
  if (!fragment || fragment.byteLength === 0) {
    return 0;
  }
  if (!timescale || timescale <= 0) {
    logger.warn(`[CC608] Cannot map sample times without a timescale`);
    return 0;
  }

  let parsed: any;
  try {
    parsed = ISOBoxer.parseBuffer(fragment);
  } catch (err) {
    logger.warn(
      `[CC608] Failed to parse fragment: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 0;
  }

  const moofs = parsed.type === "moof" ? [parsed] : allChildren(parsed, "moof");
  if (moofs.length === 0) {
    return 0;
  }

  const view = new DataView(fragment);
  let fed = 0;
  for (const moof of moofs) {
    fed += processMoof(moof, view, timescale, consumer, logger);
  }
  return fed;
}

function processMoof(
  moof: any,
  view: DataView,
  timescale: number,
  consumer: Cta608SampleConsumer,
  logger: ILogger,
): number {
  // Only the first traf is walked: warp-player subscribes to single-track
  // fragments, and a multi-track fragment would need a track selection this
  // layer has no business making.
  const traf = firstChild(moof, "traf");
  if (!traf) {
    return 0;
  }
  const tfhd = firstChild(traf, "tfhd");
  const tfdt = firstChild(traf, "tfdt");
  const truns = allChildren(traf, "trun");
  if (truns.length === 0) {
    return 0;
  }

  const moofOffset: number = moof._offset ?? 0;
  const tfhdFlags: number = tfhd?.flags ?? 0;

  // ISO/IEC 14496-12 §8.8.7: base-data-offset-present wins; otherwise
  // default-base-is-moof (and, in practice, the plain default too) puts the
  // base at the first byte of the enclosing moof.
  let base = moofOffset;
  if (tfhd && tfhdFlags & TFHD_BASE_DATA_OFFSET_PRESENT) {
    base = Number(tfhd.base_data_offset ?? moofOffset);
  } else if (tfhd && !(tfhdFlags & TFHD_DEFAULT_BASE_IS_MOOF)) {
    // Neither flag set: the spec says "the first byte of the enclosing
    // movie fragment" for the first track fragment, which is the same thing.
    base = moofOffset;
  }

  const defaultSampleDuration: number | undefined =
    tfhd?.default_sample_duration;
  const defaultSampleSize: number | undefined = tfhd?.default_sample_size;

  let decodeTime = Number(tfdt?.baseMediaDecodeTime ?? 0);
  let cursor = base;
  let fed = 0;

  for (const trun of truns) {
    const sampleCount: number = trun.sample_count ?? 0;
    if (trun.flags & TRUN_DATA_OFFSET_PRESENT) {
      cursor = base + (trun.data_offset ?? 0);
    }

    const samples: any[] = Array.isArray(trun.samples) ? trun.samples : [];
    for (let i = 0; i < sampleCount; i++) {
      const sample = samples[i] ?? {};
      const size: number | undefined = sample.sample_size ?? defaultSampleSize;
      if (size === undefined) {
        logger.warn(
          `[CC608] trun has neither sample_size nor tfhd.default_sample_size; giving up`,
        );
        return fed;
      }
      const duration: number =
        sample.sample_duration ?? defaultSampleDuration ?? 0;
      // Presentation, not decode: with B-frames the two orders differ and
      // the caption must land on the frame the viewer sees.
      const compositionOffset: number =
        sample.sample_composition_time_offset ?? 0;

      if (cursor + size > view.byteLength) {
        logger.warn(
          `[CC608] Sample ${i} runs past the fragment (${cursor}+${size} > ${view.byteLength})`,
        );
        return fed;
      }

      consumer.addSample(
        (decodeTime + compositionOffset) / timescale,
        view,
        cursor,
        size,
      );
      fed++;

      cursor += size;
      decodeTime += duration;
    }
  }

  return fed;
}
