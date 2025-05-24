import * as ISOBoxer from "codem-isoboxer";

import { ILogger, LoggerFactory } from "../logger";

/**
 * Media track information extracted from CMAF segments
 */
export interface MediaTrackInfo {
  timescale: number;
  baseMediaDecodeTime?: number;
  duration?: number;
  sequenceNumber?: number;
  mediaType?: "video" | "audio" | "unknown";
}

/**
 * MediaBuffer class for parsing and analyzing CMAF media segments
 * This class extracts timing information from init segments and media segments
 */
export class MediaBuffer {
  private initSegment: ArrayBuffer | null = null;
  private trackInfo: MediaTrackInfo = {
    timescale: 0,
    mediaType: "unknown",
  };
  private logger: ILogger;

  constructor(mediaType?: "video" | "audio") {
    this.logger = LoggerFactory.getInstance().getLogger("MediaBuffer");

    if (mediaType) {
      this.trackInfo.mediaType = mediaType;
      this.logger = LoggerFactory.getInstance().getLogger(
        `MediaBuffer:${mediaType}`
      );
    }
  }

  /**
   * Get the media type of this buffer
   */
  public getMediaType(): "video" | "audio" | "unknown" {
    return this.trackInfo.mediaType || "unknown";
  }

  /**
   * Set the media type for this buffer
   */
  public setMediaType(mediaType: "video" | "audio"): void {
    this.trackInfo.mediaType = mediaType;
    // Update logger to use the new media type
    this.logger = LoggerFactory.getInstance().getLogger(
      `MediaBuffer:${mediaType}`
    );
    this.logger.info(`Media type set to ${mediaType}`);
  }

  /**
   * Find a specific box in the parsed structure
   * @param parsed The parsed ISO structure
   * @param boxType The type of box to find
   * @returns The found box or undefined
   */
  private findBox(parsed: any, boxType: string): any {
    // If the parsed object is the box we're looking for
    if (parsed.type === boxType) {
      return parsed;
    }

    // If it has a boxes array, search through it
    if (parsed.boxes && Array.isArray(parsed.boxes)) {
      return parsed.boxes.find((box: any) => box.type === boxType);
    }

    // If it has a fetch method, try to use it
    if (typeof parsed.fetch === "function") {
      try {
        return parsed.fetch(boxType);
      } catch (e) {
        this.logger.warn(`Error using fetch for ${boxType}: ${e}`);
      }
    }

    return undefined;
  }

  /**
   * Find the first box of a specific type inside a parent box
   * @param parentBox The parent box to search in
   * @param boxType The type of box to find
   * @returns The found box or undefined
   */
  private findBoxInParent(parentBox: any, boxType: string): any {
    if (!parentBox) {
      return undefined;
    }

    // If it has a boxes array, search through it
    if (parentBox.boxes && Array.isArray(parentBox.boxes)) {
      return parentBox.boxes.find((box: any) => box.type === boxType);
    }

    // If it has a fetch method, try to use it
    if (typeof parentBox.fetch === "function") {
      try {
        return parentBox.fetch(boxType);
      } catch (e) {
        this.logger.warn(`Error using fetch for ${boxType} in parent: ${e}`);
      }
    }

    return undefined;
  }

  /**
   * Try to detect media type from the initialization segment
   * @param parsed The parsed ISO structure
   */
  private detectMediaType(parsed: any): void {
    try {
      // Find the moov box
      const moov = this.findBox(parsed, "moov");
      if (!moov) {
        return;
      }

      // Find the trak box
      const trak = this.findBoxInParent(moov, "trak");
      if (!trak) {
        return;
      }

      // Find the mdia box
      const mdia = this.findBoxInParent(trak, "mdia");
      if (!mdia) {
        return;
      }

      // Find the hdlr box
      const hdlr = this.findBoxInParent(mdia, "hdlr");
      if (!hdlr) {
        return;
      }

      // Check the handler type
      if (hdlr.handler_type) {
        if (hdlr.handler_type === "vide") {
          this.trackInfo.mediaType = "video";
          this.logger.info("Detected media type: video");
        } else if (hdlr.handler_type === "soun") {
          this.trackInfo.mediaType = "audio";
          this.logger.info("Detected media type: audio");
        } else {
          this.logger.info(`Unrecognized handler type: ${hdlr.handler_type}`);
        }
      }
    } catch (e) {
      this.logger.warn(`Error detecting media type: ${e}`);
    }
  }

  /**
   * Parse an initialization segment and extract track information
   * @param initSegment The initialization segment as an ArrayBuffer
   * @returns The extracted track information
   */
  public parseInitSegment(initSegment: ArrayBuffer | any): MediaTrackInfo {
    try {
      // Validate that initSegment is an ArrayBuffer or convert from TypedArray
      if (!(initSegment instanceof ArrayBuffer)) {
        // Check if it's a TypedArray (Uint8Array, etc.) and convert to ArrayBuffer if possible
        if (initSegment && initSegment.buffer instanceof ArrayBuffer) {
          // Convert TypedArray to ArrayBuffer
          initSegment = initSegment.buffer;
        } else {
          const type = initSegment ? typeof initSegment : "null or undefined";
          const constructor = initSegment
            ? initSegment.constructor?.name
            : "unknown";
          throw new TypeError(
            `Init segment must be an ArrayBuffer, but got ${type} (${constructor})`
          );
        }
      }

      // Validate that the ArrayBuffer is not empty
      if (initSegment.byteLength === 0) {
        throw new Error("Init segment is empty (zero bytes)");
      }

      // Store the init segment for future reference
      this.initSegment = initSegment;

      // Parse the init segment using ISOBoxer
      const parsed = ISOBoxer.parseBuffer(initSegment);

      // Try to detect the media type if not already set
      if (this.trackInfo.mediaType === "unknown") {
        this.detectMediaType(parsed);
      }

      // Find the moov box
      const moov = this.findBox(parsed, "moov");
      if (!moov) {
        throw new Error("Init segment does not contain moov box");
      }

      // Find the trak box
      const trak = this.findBoxInParent(moov, "trak");
      if (!trak) {
        throw new Error("Init segment does not contain trak box");
      }

      // Find the mdia box
      const mdia = this.findBoxInParent(trak, "mdia");
      if (!mdia) {
        throw new Error("Init segment does not contain mdia box");
      }

      // Find the mdhd box
      const mdhd = this.findBoxInParent(mdia, "mdhd");
      if (!mdhd) {
        throw new Error("Init segment does not contain mdhd box");
      }

      // Extract the timescale from the mdhd box
      this.trackInfo.timescale = mdhd.timescale || 0;

      // If no timescale was found, use a default value (typically 48000 for audio)
      if (this.trackInfo.timescale === 0) {
        this.trackInfo.timescale =
          this.trackInfo.mediaType === "audio" ? 48000 : 90000; // Default timescales
        this.logger.warn(
          `No timescale found in mdhd box, using default value of ${this.trackInfo.timescale}`
        );
      } else {
        this.logger.info(
          `Parsed init segment with timescale: ${this.trackInfo.timescale}`
        );
      }

      return { ...this.trackInfo };
    } catch (error) {
      this.logger.error(`Error parsing init segment: ${error}`);
      throw error;
    }
  }

  /**
   * Parse a media segment and extract timing information
   * @param mediaSegment The media segment as an ArrayBuffer
   * @returns The updated track information including baseMediaDecodeTime
   */
  public parseMediaSegment(mediaSegment: ArrayBuffer | any): MediaTrackInfo {
    try {
      if (!this.initSegment) {
        throw new Error(
          "Init segment must be parsed before parsing media segments"
        );
      }

      // Validate that mediaSegment is an ArrayBuffer or convert from TypedArray
      if (!(mediaSegment instanceof ArrayBuffer)) {
        // Check if it's a TypedArray (Uint8Array, etc.) and convert to ArrayBuffer if possible
        if (mediaSegment && mediaSegment.buffer instanceof ArrayBuffer) {
          // Convert TypedArray to ArrayBuffer
          mediaSegment = mediaSegment.buffer;
        } else {
          const type = mediaSegment ? typeof mediaSegment : "null or undefined";
          const constructor = mediaSegment
            ? mediaSegment.constructor?.name
            : "unknown";
          throw new TypeError(
            `Media segment must be an ArrayBuffer, but got ${type} (${constructor})`
          );
        }
      }

      // Validate that the ArrayBuffer is not empty
      if (mediaSegment.byteLength === 0) {
        throw new Error("Media segment is empty (zero bytes)");
      }

      // Parse the media segment using ISOBoxer
      const parsed = ISOBoxer.parseBuffer(mediaSegment);

      // Find the moof box
      const moof = this.findBox(parsed, "moof");
      if (!moof) {
        throw new Error("Media segment does not contain moof box");
      }

      // Find the traf box
      const traf = this.findBoxInParent(moof, "traf");
      if (!traf) {
        throw new Error("Media segment does not contain traf box");
      }

      // Find the tfdt box
      const tfdt = this.findBoxInParent(traf, "tfdt");
      if (!tfdt) {
        throw new Error("Media segment does not contain tfdt box");
      }

      // Extract the baseMediaDecodeTime from the tfdt box
      this.trackInfo.baseMediaDecodeTime = tfdt.baseMediaDecodeTime || 0;

      // Try to extract sequence number and default sample duration if available
      const tfhd = this.findBoxInParent(traf, "tfhd");
      let defaultSampleDuration: number | undefined;

      if (tfhd) {
        if (tfhd.sequence_number !== undefined) {
          this.trackInfo.sequenceNumber = tfhd.sequence_number;
        }

        // Extract defaultSampleDuration if available
        if (tfhd.default_sample_duration !== undefined) {
          defaultSampleDuration = tfhd.default_sample_duration;
        }
      }

      // Try to extract duration information
      const trun = this.findBoxInParent(traf, "trun");
      if (trun && trun.sample_count && trun.sample_count > 0) {
        // Sum up the sample durations if available
        let totalDuration = 0;

        // If we have samples array with explicit durations
        if (trun.samples && trun.samples.length > 0) {
          for (let i = 0; i < trun.samples.length; i++) {
            const sample = trun.samples[i];
            if (sample && sample.sample_duration) {
              // Use explicit sample duration from trun
              totalDuration += sample.sample_duration;
            } else if (defaultSampleDuration) {
              // Fall back to default sample duration from tfhd
              totalDuration += defaultSampleDuration;
            }
          }
        } else if (defaultSampleDuration) {
          // If no explicit sample durations, use default duration * sample count
          totalDuration = defaultSampleDuration * trun.sample_count;
        }

        if (totalDuration > 0) {
          this.trackInfo.duration = totalDuration;
        }
      }

      // Log segment info at debug level to avoid excessive logs
      this.logger.debug(
        `Parsed media segment with baseMediaDecodeTime: ${this.trackInfo.baseMediaDecodeTime}, timescale: ${this.trackInfo.timescale}`
      );

      return { ...this.trackInfo };
    } catch (error) {
      this.logger.error(`Error parsing media segment: ${error}`);
      throw error;
    }
  }

  /**
   * Get the current track information
   * @returns The current track information
   */
  public getTrackInfo(): MediaTrackInfo {
    return { ...this.trackInfo };
  }

  /**
   * Convert media time to seconds based on the track's timescale
   * @param mediaTime The media time in the track's timescale
   * @returns The time in seconds
   */
  public mediaTimeToSeconds(mediaTime: number): number {
    if (!this.trackInfo.timescale) {
      throw new Error("Timescale not available");
    }

    return mediaTime / this.trackInfo.timescale;
  }

  /**
   * Reset the buffer state
   */
  public reset(): void {
    this.initSegment = null;
    // Keep the media type when resetting
    const mediaType = this.trackInfo.mediaType;
    this.trackInfo = {
      timescale: 0,
      mediaType,
    };
    this.logger.info("MediaBuffer reset");
  }
}
