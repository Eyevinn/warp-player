/**
 * WARP catalog interface definitions and helper functions
 * Based on the WARP specification
 */

// Types of callbacks used with catalogs
type LoggerFunction = (message: string, type?: 'info' | 'success' | 'error' | 'warn') => void;
type CatalogCallback = (catalog: WarpCatalog) => void;

/**
 * WARP catalog interface definition
 */
export interface WarpCatalog {
  version: number;
  deltaUpdate?: boolean;
  tracks: WarpTrack[];
}

/**
 * WARP track interface definition
 */
export interface WarpTrack {
  name: string;
  namespace?: string;
  packaging?: string;
  renderGroup?: number;
  codec?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  framerate?: number;
  bitrate?: number;
  samplerate?: number;
  channelConfig?: string;
  [key: string]: any; // For custom fields
}

/**
 * Wrapper class for WARP catalog management
 */
export class WarpCatalogManager {
  private catalogData: WarpCatalog | null = null;
  private logger: LoggerFunction;
  private catalogCallback: CatalogCallback | null = null;

  /**
   * Create a new WarpCatalogManager
   * @param logger Function to log messages
   */
  constructor(logger: LoggerFunction) {
    this.logger = logger;
  }

  /**
   * Handle received catalog data
   * @param data The catalog data received from the server
   */
  public handleCatalogData(data: WarpCatalog): void {
    try {
      this.logger('Received catalog data', 'info');
      
      // Validate that the data is a WARP catalog
      if (!data || typeof data !== 'object' || !Array.isArray(data.tracks)) {
        this.logger('Invalid catalog data format', 'error');
        return;
      }
      
      // Store the catalog data
      this.catalogData = data;
      
      // Log the catalog information
      this.logger(`Processing WARP catalog version ${data.version}`, 'info');
      this.logger(`Found ${data.tracks.length} tracks in catalog`, 'info');
      
      // Separate tracks by type
      const videoTracks = this.getTracksByType(data, 'video');
      const audioTracks = this.getTracksByType(data, 'audio');
      
      // Log summary of found tracks
      this.logger(`Found ${videoTracks.length} video tracks and ${audioTracks.length} audio tracks`, 'success');
      
      // Call the callback if set
      if (this.catalogCallback) {
        this.catalogCallback(data);
      }
    } catch (error) {
      this.logger(`Error handling catalog data: ${error instanceof Error ? error.message : String(error)}`, 'error');
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
   * Find a track from the catalog by namespace, name, and type
   * @param namespace The namespace of the track
   * @param name The name of the track
   * @param kind The kind of track (video or audio)
   * @returns The track, or undefined if not found
   */
  public getTrackFromCatalog(namespace: string, name: string, kind: string): WarpTrack | undefined {
    if (!this.catalogData) {
      return undefined;
    }
    return this.catalogData.tracks.find(
      (t: WarpTrack) => 
        t.namespace === namespace && 
        t.name === name && 
        typeof t.mimeType === 'string' && 
        t.mimeType.startsWith(kind)
    );
  }

  /**
   * Get tracks of a specific type from the catalog
   * @param catalog The catalog to search in, defaults to the current catalog
   * @param trackType The type of tracks to return ('video' or 'audio')
   * @returns Array of tracks matching the type
   */
  public getTracksByType(catalog: WarpCatalog | null = null, trackType: 'video' | 'audio'): WarpTrack[] {
    const data = catalog || this.catalogData;
    if (!data) {
      return [];
    }

    return data.tracks.filter(track => {
      if (trackType === 'video') {
        return track.type === 'video' || 
              (track.codec && this.isVideoCodec(track.codec)) ||
              (track.mimeType && track.mimeType.startsWith('video/'));
      } else {
        return track.type === 'audio' || 
              (track.codec && this.isAudioCodec(track.codec)) ||
              (track.mimeType && track.mimeType.startsWith('audio/'));
      }
    });
  }

  /**
   * Check if a codec string represents a video codec
   * @param codec The codec string to check
   * @returns True if the codec is a video codec
   */
  private isVideoCodec(codec: string): boolean {
    const videoCodecPrefixes = ['avc1', 'hvc1', 'hev1', 'av01', 'vp8', 'vp9'];
    return videoCodecPrefixes.some(prefix => codec.startsWith(prefix));
  }

  /**
   * Check if a codec string represents an audio codec
   * @param codec The codec string to check
   * @returns True if the codec is an audio codec
   */
  private isAudioCodec(codec: string): boolean {
    const audioCodecs = ['opus', 'mp4a', 'flac', 'vorbis'];
    return audioCodecs.some(ac => codec.includes(ac));
  }

  /**
   * Clear the catalog data
   */
  public clearCatalog(): void {
    this.catalogData = null;
  }
}