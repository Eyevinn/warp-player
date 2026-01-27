/**
 * MSF/CMSF catalog interface definitions and helper functions.
 * Based on draft-ietf-moq-msf-00 (MOQT Streaming Format) and
 * draft-ietf-moq-cmsf-00 (CMAF MOQT Streaming Format).
 */
import { ILogger, LoggerFactory } from "./logger";

// Types of callbacks used with catalogs
type CatalogCallback = (catalog: WarpCatalog) => void;

/**
 * MSF catalog interface definition.
 * Conforms to draft-ietf-moq-msf-00.
 */
export interface WarpCatalog {
  /** MSF version (currently 1). Required. */
  version: number;
  /** Wallclock time at which this catalog was generated, in ms since Unix epoch. */
  generatedAt?: number;
  /** Signals that a previously live broadcast is complete. */
  isComplete?: boolean;
  /** Indicates this catalog object is a delta (partial) update. */
  deltaUpdate?: boolean;
  /** Delta processing instruction: tracks to add. */
  addTracks?: WarpTrack[];
  /** Delta processing instruction: tracks to remove. */
  removeTracks?: WarpTrack[];
  /** Delta processing instruction: tracks to clone. */
  cloneTracks?: WarpTrack[];
  /** Array of track objects. Required for non-delta updates. */
  tracks: WarpTrack[];
}

/**
 * MSF/CMSF track interface definition.
 * Conforms to draft-ietf-moq-msf-00 and draft-ietf-moq-cmsf-00.
 */
export interface WarpTrack {
  /** Track name. Required. */
  name: string;
  /** Namespace under which the track name is defined. */
  namespace?: string;
  /** Payload encapsulation type: "cmaf", "loc", "mediatimeline", "eventtimeline". Required. */
  packaging?: string;
  /** Whether new objects will be added to the track. Required. */
  isLive?: boolean;
  /** Role of content: "video", "audio", "subtitle", "caption", "audiodescription", etc. */
  role?: string;
  /** Human-readable label for the track. */
  label?: string;
  /** Group of tracks designed to be rendered together. */
  renderGroup?: number;
  /** Group of tracks that are alternate versions of one another. */
  altGroup?: number;
  /** Base64 encoded initialization data (e.g. CMAF init segment). */
  initData?: string;
  /** Track names this track depends on. */
  depends?: string[];
  /** Temporal layer/sub-layer encoding identifier. */
  temporalId?: number;
  /** Spatial layer encoding identifier. */
  spatialId?: number;
  /** Codec string (e.g. "avc1.42001f", "mp4a.40.2", "Opus"). */
  codec?: string;
  /** MIME type of the track (e.g. "video/mp4", "audio/mp4"). */
  mimeType?: string;
  /** Video framerate in frames per second. */
  framerate?: number;
  /** Number of time units per second. */
  timescale?: number;
  /** Bitrate in bits per second. */
  bitrate?: number;
  /** Encoded video width in pixels. */
  width?: number;
  /** Encoded video height in pixels. */
  height?: number;
  /** Audio sample rate in Hz. */
  samplerate?: number;
  /** Audio channel configuration. */
  channelConfig?: string;
  /** Intended display width in pixels. */
  displayWidth?: number;
  /** Intended display height in pixels. */
  displayHeight?: number;
  /** Dominant language of the track (BCP 47). */
  lang?: string;
  /** Target latency in milliseconds. Only when isLive is true. */
  targetLatency?: number;
  /** Track duration in milliseconds. Only when isLive is false. */
  trackDuration?: number;
  /** Event type, required when packaging is "eventtimeline". */
  eventType?: string;
  /** Parent track name for cloned tracks (only in cloneTracks). */
  parentName?: string;
  [key: string]: any; // For future/custom fields
}

/**
 * Wrapper class for MSF/CMSF catalog management
 */
export class WarpCatalogManager {
  private catalogData: WarpCatalog | null = null;
  private logger: ILogger;
  private catalogCallback: CatalogCallback | null = null;

  /**
   * Create a new WarpCatalogManager
   */
  constructor() {
    // Get a logger for the Catalog component
    this.logger = LoggerFactory.getInstance().getLogger("Catalog");
    this.logger.info("WarpCatalogManager initialized");
  }

  /**
   * Handle received catalog data
   * @param data The catalog data received from the server
   */
  public handleCatalogData(data: WarpCatalog): void {
    try {
      this.logger.info("Received catalog data");

      // Validate that the data is an MSF/CMSF catalog
      if (!data || typeof data !== "object" || !Array.isArray(data.tracks)) {
        this.logger.error("Invalid catalog data format");
        return;
      }

      // Store the catalog data
      this.catalogData = data;

      // Log the catalog information
      this.logger.info(`Processing MSF/CMSF catalog version ${data.version}`);
      if (data.generatedAt) {
        this.logger.info(
          `Catalog generated at ${new Date(data.generatedAt).toISOString()}`,
        );
      }
      this.logger.info(`Found ${data.tracks.length} tracks in catalog`);

      // Separate tracks by type
      const videoTracks = this.getTracksByType(data, "video");
      const audioTracks = this.getTracksByType(data, "audio");

      // Log summary of found tracks
      this.logger.info(
        `Found ${videoTracks.length} video tracks and ${audioTracks.length} audio tracks`,
      );

      // Call the callback if set
      if (this.catalogCallback) {
        this.catalogCallback(data);
      }
    } catch (error) {
      this.logger.error(
        `Error handling catalog data: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Set a callback to be called when catalog data is received
   * @param callback The callback function
   */
  public setCatalogCallback(callback: CatalogCallback): void {
    this.catalogCallback = callback;
  }

  /**
   * Get the current catalog data
   * @returns The catalog data, or null if not yet received
   */
  public getCatalog(): WarpCatalog | null {
    return this.catalogData;
  }

  /**
   * Find a track from the catalog by namespace, name, and type.
   * Uses the MSF 'role' field as primary discriminator, falling back to mimeType.
   * @param namespace The namespace of the track
   * @param name The name of the track
   * @param kind The kind of track (video or audio)
   * @returns The track, or undefined if not found
   */
  public getTrackFromCatalog(
    namespace: string,
    name: string,
    kind: string,
  ): WarpTrack | undefined {
    if (!this.catalogData) {
      return undefined;
    }
    return this.catalogData.tracks.find(
      (t: WarpTrack) =>
        t.namespace === namespace &&
        t.name === name &&
        (t.role === kind ||
          (typeof t.mimeType === "string" && t.mimeType.startsWith(kind))),
    );
  }

  /**
   * Get tracks of a specific type from the catalog.
   * Uses the MSF 'role' field as primary discriminator, falling back to
   * codec and mimeType detection for backward compatibility.
   * @param catalog The catalog to search in, defaults to the current catalog
   * @param trackType The type of tracks to return ('video' or 'audio')
   * @returns Array of tracks matching the type
   */
  public getTracksByType(
    catalog: WarpCatalog | null = null,
    trackType: "video" | "audio",
  ): WarpTrack[] {
    const data = catalog || this.catalogData;
    if (!data) {
      return [];
    }

    return data.tracks.filter((track) => {
      // Primary: use the MSF 'role' field
      if (track.role === trackType) {
        return true;
      }
      // Fallback: codec and mimeType detection
      if (trackType === "video") {
        return (
          (track.codec && this.isVideoCodec(track.codec)) ||
          (track.mimeType && track.mimeType.startsWith("video/"))
        );
      } else {
        return (
          (track.codec && this.isAudioCodec(track.codec)) ||
          (track.mimeType && track.mimeType.startsWith("audio/"))
        );
      }
    });
  }

  /**
   * Check if a codec string represents a video codec
   * @param codec The codec string to check
   * @returns True if the codec is a video codec
   */
  private isVideoCodec(codec: string): boolean {
    const videoCodecPrefixes = ["avc1", "hvc1", "hev1", "av01", "vp8", "vp9"];
    return videoCodecPrefixes.some((prefix) => codec.startsWith(prefix));
  }

  /**
   * Check if a codec string represents an audio codec
   * @param codec The codec string to check
   * @returns True if the codec is an audio codec
   */
  private isAudioCodec(codec: string): boolean {
    const audioCodecs = ["opus", "mp4a", "flac", "vorbis", "ac-3", "ec-3"];
    return audioCodecs.some((ac) => codec.includes(ac));
  }

  /**
   * Clear the catalog data
   */
  public clearCatalog(): void {
    this.catalogData = null;
  }
}
