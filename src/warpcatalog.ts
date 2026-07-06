/**
 * MSF/CMSF catalog interface definitions and helper functions.
 * Based on draft-ietf-moq-msf-01 (MOQT Streaming Format) and
 * draft-ietf-moq-cmsf-01 (CMAF MOQT Streaming Format).
 */
import { ILogger, LoggerFactory } from "./logger";

// Types of callbacks used with catalogs
type CatalogCallback = (catalog: WarpCatalog) => void;

/**
 * MSF catalog version this player understands (draft-ietf-moq-msf-01).
 * Per the spec a subscriber MUST NOT attempt to parse a catalog version it
 * does not understand, so catalogs advertising any other version are rejected.
 */
export const MSF_SUPPORTED_VERSION = "draft-01";

/**
 * MSF catalog interface definition.
 * Conforms to draft-ietf-moq-msf-01.
 */
export interface WarpCatalog {
  /** MSF version. Required. A JSON string; must be "draft-01". */
  version: string;
  /** Wallclock time at which this catalog was generated, in ms since Unix epoch. */
  generatedAt?: number;
  /** Signals that a previously live broadcast is complete. */
  isComplete?: boolean;
  /** Ordered delta-update operations (draft-ietf-moq-msf-01 Section 5.1.6). */
  deltaUpdate?: DeltaOperation[];
  /** Array of track objects. Required for non-delta updates. */
  tracks: WarpTrack[];
  /** Initialization data referenced by tracks via initRef (Section 5.1.7). */
  initDataList?: InitDataEntry[];
  /**DRM information that tracks reference */
  contentProtections?: ContentProtection[];
}

/** A single delta-update operation (draft-ietf-moq-msf-01 Section 5.1.6). */
export interface DeltaOperation {
  /** Operation type. */
  op: "add" | "remove" | "clone";
  /** Tracks the operation applies to. */
  tracks: WarpTrack[];
}

/** An entry in the catalog-level initDataList (draft-ietf-moq-msf-01 Section 5.1.7). */
export interface InitDataEntry {
  /** Reference id, unique within the catalog. */
  id: string;
  /** Reference type. Currently only "inline" is defined. */
  type: string;
  /** Init payload as defined by type. For "inline": Base64-encoded init data. */
  data: string;
}

/**
 * MSF/CMSF track interface definition.
 * Conforms to draft-ietf-moq-msf-01 and draft-ietf-moq-cmsf-01.
 */
export interface WarpTrack {
  /** Track name. Required. */
  name: string;
  /** Namespace under which the track name is defined. */
  namespace?: string;
  /** Payload encapsulation type: "cmaf", "loc", "mediatimeline", "eventtimeline". Required. */
  packaging?: string;
  /** LOCMAF wire-format version. Present only when packaging is "locmaf". */
  locmafVersion?: string;
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
  /** Reference to an entry in the catalog initDataList (Section 5.2.13). */
  initRef?: string;
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
  /** References to DRM-related information in the contentProtections field in the root-level catalog*/
  contentProtectionRefIDs?: string[];
  /** Parent track name for cloned tracks (only in cloneTracks). */
  parentName?: string;
  [key: string]: any; // For future/custom fields
}

/** DRM information for a track. */
export interface ContentProtection {
  refID?: string;
  defaultKIDs?: string[];
  scheme?: string;
  drmSystem: DRMSystem;
}

/** A specific DRM system configuration. */
export interface DRMSystem {
  systemID?: string;
  robustness?: string;
  laURL?: DRMService;
  authzURL?: DRMService;
  certURL?: DRMService;
  pssh?: string;
}

/** A DRM license or authorization service. */
export interface DRMService {
  url?: string;
  type?: string;
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
   * @param announceNamespace The namespace under which the catalog track was
   *   announced. Per draft-ietf-moq-msf-00 §5.1.10, tracks without an explicit
   *   namespace inherit it from the catalog track.
   */
  public handleCatalogData(
    data: WarpCatalog,
    announceNamespace?: string,
  ): void {
    try {
      this.logger.info("Received catalog data");

      // Validate that the data is an MSF/CMSF catalog
      if (!data || typeof data !== "object" || !Array.isArray(data.tracks)) {
        this.logger.error("Invalid catalog data format");
        return;
      }

      // Reject catalog versions we do not understand (draft-ietf-moq-msf-01
      // §5.1.1: a subscriber MUST NOT parse an unknown catalog version).
      if (data.version !== MSF_SUPPORTED_VERSION) {
        this.logger.error(
          `Unsupported MSF catalog version "${data.version}"; ` +
            `expected "${MSF_SUPPORTED_VERSION}"`,
        );
        return;
      }

      if (announceNamespace) {
        const inherit = (tracks?: WarpTrack[]) => {
          tracks?.forEach((t) => {
            if (!t.namespace) {
              t.namespace = announceNamespace;
            }
          });
        };
        inherit(data.tracks);
        data.deltaUpdate?.forEach((op) => inherit(op.tracks));
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
   * Resolve a track's initRef against the catalog initDataList.
   * @param track The track whose init data to resolve
   * @returns The Base64-encoded init data, or undefined if the track has no
   *   initRef or the referenced entry is missing.
   */
  public getInitData(track: WarpTrack): string | undefined {
    if (!track.initRef || !this.catalogData?.initDataList) {
      return undefined;
    }
    return this.catalogData.initDataList.find(
      (entry) => entry.id === track.initRef,
    )?.data;
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
