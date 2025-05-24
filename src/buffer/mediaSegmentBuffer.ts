import { ILogger, LoggerFactory } from "../logger";

import { MediaBuffer, MediaTrackInfo } from "./mediaBuffer";

/**
 * Media segment with timing information
 */
export interface MediaSegment {
  data: ArrayBuffer;
  trackInfo: MediaTrackInfo;
  timestamp: number; // JavaScript timestamp when segment was received
  isInitSegment: boolean;
}

/**
 * Options for the MediaSegmentBuffer
 */
export interface MediaSegmentBufferOptions {
  maxBufferSize?: number; // Maximum number of segments to store
  onSegmentReady?: (segment: MediaSegment) => void;
  mediaType?: "video" | "audio"; // Type of media this buffer will handle
}

/**
 * MediaSegmentBuffer manages a queue of media segments with timing information
 * It uses MediaBuffer to parse segments and extract timing information
 */
export class MediaSegmentBuffer {
  private mediaBuffer: MediaBuffer;
  private segments: MediaSegment[] = [];
  private options: Required<MediaSegmentBufferOptions>;
  private isInitialized: boolean = false;
  private initSegment: MediaSegment | null = null;
  private pendingSegments: MediaSegment[] = [];
  private isAppending: boolean = false;
  private sourceBuffer: SourceBuffer | null = null;
  private mediaType: "video" | "audio" | "unknown" = "unknown";
  private logger: ILogger;

  constructor(options: MediaSegmentBufferOptions = {}) {
    // Set the media type if provided
    this.mediaType = options.mediaType || "unknown";

    // Create logger with appropriate category
    const loggerCategory =
      this.mediaType !== "unknown"
        ? `MediaSegmentBuffer:${this.mediaType}`
        : "MediaSegmentBuffer";
    this.logger = LoggerFactory.getInstance().getLogger(loggerCategory);

    // Create MediaBuffer with the same media type
    this.mediaBuffer = new MediaBuffer(this.mediaType as any);

    // Set default options and merge with provided options
    this.options = {
      maxBufferSize: 30, // Default to 30 segments max
      onSegmentReady: () => {
        // No-op by default - will be overridden if provided in options
      },
      mediaType: this.mediaType as any,
      ...options,
    };

    this.logger.info(
      `MediaSegmentBuffer initialized with type: ${this.mediaType}, maxBufferSize: ${this.options.maxBufferSize}`
    );
  }

  /**
   * Get the media type of this buffer
   */
  public getMediaType(): "video" | "audio" | "unknown" {
    return this.mediaType;
  }

  /**
   * Set the media type for this buffer
   */
  public setMediaType(mediaType: "video" | "audio"): void {
    this.mediaType = mediaType;
    this.options.mediaType = mediaType;

    // Update MediaBuffer's media type
    this.mediaBuffer.setMediaType(mediaType);

    // Update logger to use the new media type
    this.logger = LoggerFactory.getInstance().getLogger(
      `MediaSegmentBuffer:${mediaType}`
    );
    this.logger.info(`Media type set to ${mediaType}`);
  }

  /**
   * Add an initialization segment to the buffer
   * @param data The initialization segment data
   * @returns The parsed segment with timing information
   */
  public addInitSegment(data: ArrayBuffer): MediaSegment {
    try {
      // Parse the init segment
      const trackInfo = this.mediaBuffer.parseInitSegment(data);

      // If media type was unknown, update it from the parsed trackInfo
      if (
        this.mediaType === "unknown" &&
        trackInfo.mediaType &&
        trackInfo.mediaType !== "unknown"
      ) {
        this.setMediaType(trackInfo.mediaType);
      }

      // Create a segment object
      const segment: MediaSegment = {
        data,
        trackInfo,
        timestamp: Date.now(),
        isInitSegment: true,
      };

      // Store the init segment
      this.initSegment = segment;
      this.isInitialized = true;

      this.logger.info(
        `Added init segment with timescale: ${trackInfo.timescale}`
      );

      // Notify that the segment is ready
      this.options.onSegmentReady(segment);

      return segment;
    } catch (error) {
      this.logger.error(`Error adding init segment: ${error}`);
      throw error;
    }
  }

  /**
   * Add a media segment to the buffer
   * @param data The media segment data
   * @returns The parsed segment with timing information
   */
  public addMediaSegment(data: ArrayBuffer): MediaSegment {
    if (!this.isInitialized) {
      throw new Error("Buffer not initialized. Call addInitSegment first.");
    }

    try {
      // Parse the media segment
      const trackInfo = this.mediaBuffer.parseMediaSegment(data);

      // Create a segment object
      const segment: MediaSegment = {
        data,
        trackInfo,
        timestamp: Date.now(),
        isInitSegment: false,
      };

      // Add the segment to the queue
      this.segments.push(segment);

      // Check if we need to remove old segments
      if (this.segments.length > this.options.maxBufferSize) {
        this.segments.shift(); // Remove the oldest segment
      }

      // Only log every 10th segment to reduce logging overhead
      if (this.segments.length % 10 === 0) {
        this.logger.debug(
          `Added media segment with baseMediaDecodeTime: ${trackInfo.baseMediaDecodeTime}, ` +
            `timescale: ${trackInfo.timescale}, buffer size: ${this.segments.length}`
        );
      }

      // Notify that the segment is ready
      this.options.onSegmentReady(segment);

      return segment;
    } catch (error) {
      this.logger.error(`Error adding media segment: ${error}`);
      throw error;
    }
  }

  /**
   * Get the next segment from the buffer
   * @returns The next segment or null if the buffer is empty
   */
  public getNextSegment(): MediaSegment | null {
    if (this.segments.length === 0) {
      return null;
    }

    return this.segments.shift() || null;
  }

  /**
   * Get the initialization segment
   * @returns The initialization segment or null if not initialized
   */
  public getInitSegment(): MediaSegment | null {
    return this.initSegment;
  }

  /**
   * Get all segments in the buffer
   * @returns Array of all segments
   */
  public getAllSegments(): MediaSegment[] {
    return [...this.segments];
  }

  /**
   * Get the number of segments in the buffer
   * @returns The number of segments
   */
  public getSegmentCount(): number {
    return this.segments.length;
  }

  /**
   * Get the buffer duration in seconds
   * @returns The buffer duration in seconds or 0 if not initialized
   */
  public getBufferDuration(): number {
    if (!this.isInitialized || this.segments.length === 0) {
      return 0;
    }

    const firstSegment = this.segments[0];
    const lastSegment = this.segments[this.segments.length - 1];

    if (
      !firstSegment.trackInfo.baseMediaDecodeTime ||
      !lastSegment.trackInfo.baseMediaDecodeTime ||
      !lastSegment.trackInfo.duration
    ) {
      return 0;
    }

    const startTime = firstSegment.trackInfo.baseMediaDecodeTime;
    const endTime =
      lastSegment.trackInfo.baseMediaDecodeTime +
      lastSegment.trackInfo.duration;

    return this.mediaBuffer.mediaTimeToSeconds(endTime - startTime);
  }

  /**
   * Set the source buffer to use for appending segments
   * @param sourceBuffer The SourceBuffer instance to use
   */
  public setSourceBuffer(sourceBuffer: SourceBuffer): void {
    this.sourceBuffer = sourceBuffer;

    // Add event listeners to the source buffer
    if (this.sourceBuffer) {
      this.sourceBuffer.addEventListener("updateend", () => {
        this.isAppending = false;
        this.processQueue();
      });

      this.sourceBuffer.addEventListener("error", (e) => {
        this.logger.error(`SourceBuffer error: ${e}`);
        this.isAppending = false;
      });

      this.logger.info("SourceBuffer set and event listeners attached");
    }
  }

  /**
   * Append a segment to the source buffer
   * @param segment The segment to append
   */
  public appendToSourceBuffer(segment: MediaSegment): void {
    if (!this.sourceBuffer) {
      this.logger.error("No source buffer set");
      return;
    }

    // Add to pending segments queue
    this.pendingSegments.push(segment);

    // Process the queue if not already appending
    if (!this.isAppending) {
      this.processQueue();
    }
  }

  /**
   * Process the pending segments queue
   */
  private processQueue(): void {
    if (
      !this.sourceBuffer ||
      this.isAppending ||
      this.pendingSegments.length === 0
    ) {
      return;
    }

    // Check if the source buffer is ready
    if (this.sourceBuffer.updating) {
      return;
    }

    // Limit the number of segments to process at once to avoid overwhelming the browser
    const maxSegmentsToProcess = 5;

    // Concatenate segments if there are multiple in the queue, but not too many
    if (this.pendingSegments.length > 1) {
      // If we have too many segments, only process a subset to avoid performance issues
      if (this.pendingSegments.length > maxSegmentsToProcess) {
        const segmentsToProcess = this.pendingSegments.slice(
          0,
          maxSegmentsToProcess
        );
        this.pendingSegments = this.pendingSegments.slice(maxSegmentsToProcess);

        // Create a temporary array for processing
        const tempPendingSegments = this.pendingSegments;
        this.pendingSegments = segmentsToProcess;

        // Process the subset
        this.appendConcatenatedSegments();

        // Restore the remaining segments
        this.pendingSegments = this.pendingSegments.concat(tempPendingSegments);

        this.logger.debug(
          `Processing ${segmentsToProcess.length} segments, ${tempPendingSegments.length} remaining`
        );
      } else {
        // Process all segments if we don't have too many
        this.appendConcatenatedSegments();
      }
    } else {
      // Just append the single segment
      const segment = this.pendingSegments.shift();
      if (segment) {
        this.appendSingleSegment(segment);
      }
    }
  }

  /**
   * Append a single segment to the source buffer
   * @param segment The segment to append
   */
  private appendSingleSegment(segment: MediaSegment): void {
    if (!this.sourceBuffer) {
      return;
    }

    try {
      this.isAppending = true;
      this.sourceBuffer.appendBuffer(segment.data);

      // Only log for init segments or occasionally for media segments to reduce noise
      if (segment.isInitSegment || Math.random() < 0.1) {
        this.logger.debug(
          `Appending ${
            segment.isInitSegment ? "init" : "media"
          } segment to SourceBuffer`
        );
      }
    } catch (e) {
      this.logger.error(`Error appending single segment: ${e}`);
      this.isAppending = false;
    }
  }

  /**
   * Concatenate and append multiple segments to the source buffer
   */
  private appendConcatenatedSegments(): void {
    if (!this.sourceBuffer || this.pendingSegments.length === 0) {
      return;
    }

    // Calculate total size
    const totalLength = this.pendingSegments.reduce(
      (sum, segment) => sum + segment.data.byteLength,
      0
    );

    // Create a new buffer to hold all segments
    const combined = new Uint8Array(totalLength);
    let offset = 0;

    // Copy all segments into the combined buffer
    const segmentsToAppend = [...this.pendingSegments];
    this.pendingSegments = [];

    for (const segment of segmentsToAppend) {
      combined.set(new Uint8Array(segment.data), offset);
      offset += segment.data.byteLength;
    }

    try {
      this.isAppending = true;
      this.sourceBuffer.appendBuffer(combined.buffer);
      this.logger.debug(
        `Appending concatenated segments (${segmentsToAppend.length} segments, ${totalLength} bytes)`
      );
    } catch (e) {
      this.logger.error(`Error appending concatenated segments: ${e}`);
      this.isAppending = false;

      // If concatenation fails, try appending segments individually
      if (segmentsToAppend.length > 0) {
        this.logger.info("Falling back to individual segment appending");

        // Instead of calling processQueue (which would cause recursion),
        // append the first segment individually if possible
        if (segmentsToAppend.length > 0 && !this.sourceBuffer.updating) {
          try {
            // Directly call appendSingleSegment for the first segment
            this.appendSingleSegment(segmentsToAppend[0]);
            // Store remaining segments for later processing via updateend event
            this.pendingSegments = segmentsToAppend.slice(1);
          } catch (innerError) {
            this.logger.error(
              `Error in fallback individual append: ${innerError}`
            );
            // Store all segments for later processing
            this.pendingSegments = segmentsToAppend;
          }
        } else {
          // Store all segments for later processing
          this.pendingSegments = segmentsToAppend;
        }
      }
    }
  }

  /**
   * Reset the buffer
   */
  public reset(): void {
    this.segments = [];
    this.pendingSegments = [];
    this.initSegment = null;
    this.isInitialized = false;
    this.isAppending = false;
    this.mediaBuffer.reset();
    this.logger.info("MediaSegmentBuffer reset");
  }
}
