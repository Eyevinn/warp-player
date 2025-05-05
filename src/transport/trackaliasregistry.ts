import { ObjectCallback } from './tracks';

// Logger for track alias registry operations
const logger = {
  log: (message: string, ...args: any[]) => {
    console.log(`[MoQ TrackAliasRegistry] ${message}`, ...args);
    // Dispatch a custom event that our UI can listen to
    if (typeof window !== 'undefined') {
      const event = new CustomEvent('moq-log', { 
        detail: { type: 'info', message: `[TrackAliasRegistry] ${message}` }
      });
      window.dispatchEvent(event);
    }
  },
  warn: (message: string, ...args: any[]) => {
    console.warn(`[MoQ TrackAliasRegistry] ${message}`, ...args);
    if (typeof window !== 'undefined') {
      const event = new CustomEvent('moq-log', { 
        detail: { type: 'warn', message: `[TrackAliasRegistry] ${message}` }
      });
      window.dispatchEvent(event);
    }
  },
  error: (message: string, ...args: any[]) => {
    console.error(`[MoQ TrackAliasRegistry] ${message}`, ...args);
    if (typeof window !== 'undefined') {
      const event = new CustomEvent('moq-log', { 
        detail: { type: 'error', message: `[TrackAliasRegistry] ${message}` }
      });
      window.dispatchEvent(event);
    }
  }
};

// Interface for track information
export interface TrackInfo {
  namespace: string;
  trackName: string;
  trackAlias: bigint;
  requestId: bigint;  // The request ID used in the subscribe message
  callbacks: ObjectCallback[];
}

/**
 * Registry for track aliases that maps between namespace+trackName and trackAlias
 * and stores callbacks for incoming objects.
 */
export class TrackAliasRegistry {
  // Map from namespace+trackName to track info
  private trackNameToInfo: Map<string, TrackInfo> = new Map();
  
  // Map from trackAlias to track info
  private trackAliasToInfo: Map<string, TrackInfo> = new Map();
  
  // Counter for generating unique track aliases
  private nextTrackAlias: bigint = 1n;
  
  /**
   * Generate a key for namespace+trackName
   */
  private getNamespaceTrackKey(namespace: string, trackName: string): string {
    return `${namespace}:${trackName}`;
  }
  
  /**
   * Register a track and get its alias
   * If the track is already registered, returns the existing alias
   * If not, creates a new unique alias
   * @param namespace The namespace of the track
   * @param trackName The name of the track
   * @param requestId The request ID used in the subscribe message
   * @returns The track alias
   */
  public registerTrack(namespace: string, trackName: string, requestId: bigint): bigint {
    const key = this.getNamespaceTrackKey(namespace, trackName);
    
    // Check if the track is already registered
    if (this.trackNameToInfo.has(key)) {
      const info = this.trackNameToInfo.get(key);
      // This should never be null since we just checked with has()
      if (!info) {
        throw new Error(`Track info for ${namespace}:${trackName} not found despite being registered`);
      }
      logger.log(`Track ${namespace}:${trackName} already registered with alias ${info.trackAlias} and requestId ${info.requestId}`);
      return info.trackAlias;
    }
    
    // Generate a new unique track alias
    const trackAlias = this.nextTrackAlias;
    this.nextTrackAlias += 1n;
    
    // Validate that a request ID is provided
    if (requestId === undefined) {
      throw new Error(`Request ID is required for track registration ${namespace}:${trackName}`);
    }
    
    // Create track info
    const info: TrackInfo = {
      namespace,
      trackName,
      trackAlias,
      requestId,
      callbacks: []
    };
    
    // Store in both maps
    this.trackNameToInfo.set(key, info);
    this.trackAliasToInfo.set(trackAlias.toString(), info);
    
    logger.log(`Registered new track ${namespace}:${trackName} with alias ${trackAlias} and request ID ${requestId}`);
    return trackAlias;
  }
  
  /**
   * Get track info from namespace+trackName
   */
  public getTrackInfoFromName(namespace: string, trackName: string): TrackInfo | undefined {
    const key = this.getNamespaceTrackKey(namespace, trackName);
    return this.trackNameToInfo.get(key);
  }
  
  /**
   * Get track info from trackAlias
   */
  public getTrackInfoFromAlias(trackAlias: bigint): TrackInfo | undefined {
    return this.trackAliasToInfo.get(trackAlias.toString());
  }
  
  /**
   * Register a callback for a track
   */
  public registerCallback(trackAlias: bigint, callback: ObjectCallback): void {
    const info = this.trackAliasToInfo.get(trackAlias.toString());
    
    if (!info) {
      logger.warn(`Attempted to register callback for unknown track alias ${trackAlias}`);
      return;
    }
    
    info.callbacks.push(callback);
    logger.log(`Registered callback for track ${info.namespace}:${info.trackName} (alias: ${trackAlias}), total callbacks: ${info.callbacks.length}`);
  }
  
  /**
   * Unregister a specific callback for a track
   */
  public unregisterCallback(trackAlias: bigint, callback: ObjectCallback): void {
    const info = this.trackAliasToInfo.get(trackAlias.toString());
    
    if (!info) {
      logger.warn(`Attempted to unregister callback for unknown track alias ${trackAlias}`);
      return;
    }
    
    const index = info.callbacks.indexOf(callback);
    if (index !== -1) {
      info.callbacks.splice(index, 1);
      logger.log(`Unregistered callback for track ${info.namespace}:${info.trackName} (alias: ${trackAlias}), remaining callbacks: ${info.callbacks.length}`);
    }
  }
  
  /**
   * Unregister all callbacks for a track
   */
  public unregisterAllCallbacks(trackAlias: bigint): void {
    const info = this.trackAliasToInfo.get(trackAlias.toString());
    
    if (!info) {
      logger.warn(`Attempted to unregister all callbacks for unknown track alias ${trackAlias}`);
      return;
    }
    
    const callbackCount = info.callbacks.length;
    info.callbacks = [];
    logger.log(`Unregistered all ${callbackCount} callbacks for track ${info.namespace}:${info.trackName} (alias: ${trackAlias})`);
  }
  
  /**
   * Get all callbacks for a track
   */
  public getCallbacks(trackAlias: bigint): ObjectCallback[] {
    const info = this.trackAliasToInfo.get(trackAlias.toString());
    return info ? [...info.callbacks] : [];
  }
  
  /**
   * Clear all registered tracks and callbacks
   */
  public clear(): void {
    this.trackNameToInfo.clear();
    this.trackAliasToInfo.clear();
    this.nextTrackAlias = 1n;
    logger.log('Cleared all track registrations');
  }
}
