import { MediaBuffer, MediaSegmentBuffer } from './buffer';
import { ILogger, LoggerFactory } from './logger';
import { Client } from './transport/client';
import { WarpCatalog, WarpTrack, WarpCatalogManager } from './warpcatalog';

/**
 * Player class for handling MoQ transport connections, track subscriptions, and UI updates
 */
export class Player {
  private client: Client | null = null;
  private connection: any = null;
  private serverUrl: string;
  private catalogManager: WarpCatalogManager;
  private unregisterCatalogCallback: (() => void) | null = null;
  private unregisterAnnounceCallback: (() => void) | null = null;
  private announceNamespaces: string[][] = [];
  private tracksContainerEl: HTMLElement;
  private statusEl: HTMLElement;
  private announcementsEl: HTMLElement | null = null;
  private logger: ILogger;
  private trackSubscriptions: Map<string, bigint> = new Map(); // Track name -> trackAlias
  
  // Shared media elements for synchronized playback
  private sharedMediaSource: MediaSource | null = null;
  private videoSourceBuffer: SourceBuffer | null = null;
  private audioSourceBuffer: SourceBuffer | null = null;
  private videoMediaSegmentBuffer: MediaSegmentBuffer | null = null;
  private audioMediaSegmentBuffer: MediaSegmentBuffer | null = null;
  private videoMediaBuffer: MediaBuffer | null = null;
  private audioMediaBuffer: MediaBuffer | null = null;
  private videoTrack: WarpTrack | null = null;
  private audioTrack: WarpTrack | null = null;
  
  // Synchronization state
  private videoBufferReady = false;
  private audioBufferReady = false;
  private playbackStarted = false;
  private videoObjectsReceived = 0;
  private audioObjectsReceived = 0;
  private targetBufferDurationMs = 200; // Target buffer duration in milliseconds for playback
  
  // Error handling and recovery
  private recoveryInProgress = false;
  private videoErrorCount = 0;
  private audioErrorCount = 0;
  private maxErrorsBeforeFallback = 5;
  private bufferLowThreshold = 0.3; // 300ms buffer threshold for warning
  private bufferCriticalThreshold = 0.1; // 100ms buffer threshold for recovery action
  private playbackStalled = false;
  private recoveryAttempts = 0;
  private maxRecoveryAttempts = 3;
  private lastErrorTime = 0;

  /**
   * Create a new Player instance
   * @param serverUrl The URL of the MoQ server
   * @param tracksContainerEl The HTML element to display tracks in
   * @param statusEl The HTML element to display connection status
   * @param uiLogger Optional function to log messages to the UI
   */
  constructor(
    serverUrl: string,
    tracksContainerEl: HTMLElement,
    statusEl: HTMLElement,
    _uiLogger?: (message: string, type?: 'info' | 'success' | 'error' | 'warn') => void
  ) {
    this.serverUrl = serverUrl;
    this.tracksContainerEl = tracksContainerEl;
    this.statusEl = statusEl;

    // Get logger for Player component
    this.logger = LoggerFactory.getInstance().getLogger('Player');
    
    // Log initialization
    this.logger.info('Player initialized');
    
    // Initialize the catalog manager with its own logger
    this.catalogManager = new WarpCatalogManager();
    
    // Set up catalog callback to process tracks when catalog is received
    this.catalogManager.setCatalogCallback((catalog) => this.processWarpCatalog(catalog));
  
    // Create announcements section
    this.createAnnouncementsSection();
  }

  /**
   * Set the target buffer duration in milliseconds for playback
   * @param durationMs Duration in milliseconds
   */
  public setTargetBufferDuration(durationMs: number): void {
    const oldValue = this.targetBufferDurationMs;
    this.targetBufferDurationMs = durationMs;
    this.logger.info(`Target buffer duration changed from ${oldValue}ms to ${durationMs}ms`);
  }

  /**
   * Connect to the MoQ server
   */
  async connect(): Promise<void> {
    if (!this.serverUrl) {
      this.logger.error('Please enter a server URL');
      return;
    }

    try {      
      // Create and connect the client
      this.client = new Client({
        url: this.serverUrl,
      });
      
      this.connection = await this.client.connect();
      
      // Update status
      this.statusEl.className = 'status connected';
      this.statusEl.textContent = 'Status: Connected';
      
      this.logger.info('Connected to MoQ server successfully!');
      
      // Create the announcements section
      this.createAnnouncementsSection();
      
      // Listen for announcements - catalog subscription will happen after announcement is received
      this.listenForAnnouncements();
      
      this.logger.info('Waiting for announcements...');
      
      // Handle connection closure
      this.connection.closed().then((error: Error) => {
        this.logger.info(`Connection closed: ${error.message}`);
        this.disconnect();
      }).catch((error: Error) => {
        this.logger.error(`Connection error: ${error.message}`);
        this.disconnect();
      });
      
    } catch (error) {
      this.logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      this.disconnect();
    }
  }

  /**
   * Disconnect from the MoQ server
   */
  disconnect(): void {
    // Unregister catalog callback if registered
    if (this.unregisterCatalogCallback) {
      this.unregisterCatalogCallback();
      this.unregisterCatalogCallback = null;
    }
    
    // Unregister announce callback if registered
    if (this.unregisterAnnounceCallback) {
      this.unregisterAnnounceCallback();
      this.unregisterAnnounceCallback = null;
    }
    
    // Unsubscribe from all tracks
    this.trackSubscriptions.forEach((trackAlias, trackName) => {
      if (this.client) {
        this.logger.info(`Unsubscribing from track: ${trackName}`);
        // No explicit unsubscribe needed as the connection will be closed
      }
    });
    this.trackSubscriptions.clear();
    
    if (this.connection) {
      this.logger.info('Disconnecting from server...');
      this.connection.close();
      this.connection = null;
      this.client = null;
      
      // Clear catalog data
      this.catalogManager.clearCatalog();
      
      // Update status
      this.statusEl.className = 'status disconnected';
      this.statusEl.textContent = 'Status: Disconnected';
      
      // Clear tracks display
      this.tracksContainerEl.innerHTML = '';
      
      // Remove the announcements section completely
      this.removeAnnouncementsSection();
    }
    
    // Clear announcements
    this.announceNamespaces = [];
  }

  /**
   * Listen for announcements from the server
   */
  private async listenForAnnouncements(): Promise<void> {
    if (!this.client) {
      this.logger.error('Cannot listen for announcements: Not connected');
      return;
    }

    try {
      this.logger.info('Listening for announcements...');
      
      // Make sure the announcements section exists
      if (!this.announcementsEl) {
        this.createAnnouncementsSection();
      }
      
      // Subscribe to announcements
      const unregister = this.client.registerAnnounceCallback((namespace: string[]) => {
        // Log that we received an announcement for debugging
        this.logger.info(`Received announcement callback with namespace: ${namespace.join('/')}`);
        
        // Check if we've already seen this namespace
        const namespaceStr = namespace.join('/');
        if (this.announceNamespaces.some(ns => ns.join('/') === namespaceStr)) {
          this.logger.info(`Already processed namespace: ${namespaceStr}`);
          return;
        }
        
        // Store the namespace
        this.announceNamespaces.push(namespace);
        
        // Display the announcement in the UI
        this.displayAnnouncement(namespace);
        
        // Subscribe to the catalog in this namespace
        this.subscribeToCatalog(namespace).catch(error => {
          this.logger.error(`Error subscribing to catalog: ${error instanceof Error ? error.message : String(error)}`);
        });
      });
      
      // Save the unregister function
      this.unregisterAnnounceCallback = unregister;
      
      // Log that we've registered the callback
      this.logger.info('Announcement listener registered successfully');
    } catch (error) {
      this.logger.error(`Error listening for announcements: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Subscribe to the catalog in the given namespace
   * @param namespace The namespace to subscribe to
   */
  private async subscribeToCatalog(namespace: string[]): Promise<void> {
    if (!this.client) {
      this.logger.error('Cannot subscribe to catalog: Not connected');
      return;
    }

    try {
      const namespaceStr = namespace.join('/');
      this.logger.info(`Subscribing to catalog in namespace: ${namespaceStr}`);

      // Subscribe to the "catalog" track in the given namespace
      const unregisterCallback = await this.client.subscribeTrack(
        namespaceStr,
        "catalog",
        (obj: { data: ArrayBuffer }) => {
          try {
            const text = new TextDecoder().decode(obj.data);
            const catalog = JSON.parse(text); // If using CBOR, replace this with CBOR decoding
            // Use the catalog manager to handle the catalog data
            this.catalogManager.handleCatalogData(catalog);
          } catch (e) {
            this.logger.error(`Failed to decode catalog data: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      );

      // Store the unregister function if provided
      if (typeof unregisterCallback === 'function') {
        if (this.unregisterCatalogCallback) {
          this.logger.info('Unregistering previous catalog callback');
          this.unregisterCatalogCallback();
        }
        this.unregisterCatalogCallback = unregisterCallback;
        this.logger.info(`Successfully subscribed to catalog in namespace: ${namespaceStr}`);
      } else {
        this.logger.error(`Failed to subscribe to catalog in namespace: ${namespaceStr}`);
      }
    } catch (error) {
      this.logger.error(`Error subscribing to catalog: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Process the WARP catalog and display track information
   * @param catalog The WARP catalog to process
   */
  private processWarpCatalog(catalog: WarpCatalog): void {
    // Clear previous tracks display
    this.tracksContainerEl.innerHTML = '';
    
    this.logger.info(`Processing WARP catalog version ${catalog.version}`);
    this.logger.info(`Found ${catalog.tracks.length} tracks in catalog`);
    
    // Get video and audio tracks using the catalog manager
    const videoTracks = this.catalogManager.getTracksByType(catalog, 'video');
    const audioTracks = this.catalogManager.getTracksByType(catalog, 'audio');
    
    // Log found tracks
    videoTracks.forEach(track => {
      this.logger.info(`Found video track: ${track.name}`);
    });
    
    audioTracks.forEach(track => {
      this.logger.info(`Found audio track: ${track.name}`);
    });
    
    // Log summary of found tracks
    this.logger.info(`Found ${videoTracks.length} video tracks and ${audioTracks.length} audio tracks`);
    
    // Display tracks in the UI
    this.displayTracks('Video Tracks', videoTracks);
    this.displayTracks('Audio Tracks', audioTracks);
  }

  /**
   * Create the announcements section in the DOM
   */
  private createAnnouncementsSection(): void {
    // Check if announcements section already exists
    if (document.getElementById('announcements')) {
      this.announcementsEl = document.getElementById('announcements');
      return;
    }
    
    // Find the tracks container element - this is our insertion point reference
    if (!this.tracksContainerEl) {
      this.logger.error('Tracks container element is not initialized');
      return;
    }
    
    // Get the parent container
    const container = this.tracksContainerEl.parentElement;
    if (!container) {
      this.logger.error('Could not find parent container for tracks');
      return;
    }
    
    // Create announcements section
    const heading = document.createElement('h3');
    heading.textContent = 'Announcements';
    heading.id = 'announcements-heading';
    
    this.announcementsEl = document.createElement('div');
    this.announcementsEl.id = 'announcements';
    this.announcementsEl.className = 'announcements-container';
    
    // Find the "Available Tracks" heading that is the sibling of tracksContainerEl
    let tracksHeading = null;
    for (let i = 0; i < container.children.length; i++) {
      const child = container.children[i];
      if (child.tagName === 'H3' && child.textContent === 'Available Tracks') {
        tracksHeading = child;
        break;
      }
    }
    
    if (tracksHeading) {
      // Insert before the "Available Tracks" heading
      this.logger.debug('Found "Available Tracks" heading, inserting announcements before it');
      container.insertBefore(heading, tracksHeading);
      container.insertBefore(this.announcementsEl, tracksHeading);
    } else {
      // If we can't find the heading, insert before the tracks container itself
      this.logger.debug('Using tracks container as reference for insertion');
      container.insertBefore(heading, this.tracksContainerEl);
      container.insertBefore(this.announcementsEl, this.tracksContainerEl);
    }
  }
  
  /**
   * Remove the announcements section from the DOM
   */
  private removeAnnouncementsSection(): void {
    // Remove the announcements heading
    const heading = document.getElementById('announcements-heading');
    if (heading && heading.parentNode) {
      heading.parentNode.removeChild(heading);
    }
    
    // Remove the announcements container
    if (this.announcementsEl && this.announcementsEl.parentNode) {
      this.announcementsEl.parentNode.removeChild(this.announcementsEl);
      this.announcementsEl = null;
    }
  }
  
  /**
   * Display an announcement on the page
   * @param namespace The namespace that was announced
   */
  private displayAnnouncement(namespace: string[]): void {
    // Log that we're trying to display an announcement
    this.logger.info(`Attempting to display announcement for namespace: ${namespace.join('/')}`);
    
    if (!this.announcementsEl) {
      this.logger.warn('Announcements element not found, creating it now');
      this.createAnnouncementsSection();
      
      if (!this.announcementsEl) {
        this.logger.error('Failed to create announcements element');
        return;
      }
    }
    
    // Clear any existing announcements
    this.announcementsEl.innerHTML = '';
    
    // Create announcement element with more compact styling
    const announcementEl = document.createElement('div');
    announcementEl.className = 'announcement';
    
    // Create a compact inline display for the namespace
    const namespaceStr = namespace.join('/');
    announcementEl.innerHTML = `
      <div class="announcement-container">
        <span class="announcement-title">Announced Namespace:</span>
        <span class="announcement-namespace">${namespaceStr}</span>
      </div>
    `;
    
    // Add to the announcements container
    this.announcementsEl.appendChild(announcementEl);
    
    // Log the announcement
    this.logger.info(`Successfully displayed announcement for namespace: ${namespaceStr}`);
  }

  /**
   * Display tracks in the UI
   * @param title The title for the tracks section
   * @param tracks The tracks to display
   */
  private displayTracks(title: string, tracks: WarpTrack[]): void {
    if (!this.tracksContainerEl || tracks.length === 0) {
      return;
    }
    
    // Create section
    const section = document.createElement('div');
    section.className = 'tracks-section';
    
    // Add title
    const titleEl = document.createElement('h3');
    titleEl.textContent = title;
    section.appendChild(titleEl);
    
    // Create selector and label in a container
    const selectorContainer = document.createElement('div');
    selectorContainer.className = 'selector-container';
    
    const selectorLabel = document.createElement('label');
    const selectId = `${title.toLowerCase().replace(/\s+/g, '-')}-select`;
    selectorLabel.htmlFor = selectId;
    selectorLabel.textContent = `Select ${title.toLowerCase()}: `;
    selectorContainer.appendChild(selectorLabel);
    
    // Create dropdown select element
    const select = document.createElement('select');
    select.id = selectId;
    select.name = title.toLowerCase().replace(/\s+/g, '-');
    select.className = 'track-select';
    
    // Add tracks to dropdown
    tracks.forEach((track, index) => {
      const option = document.createElement('option');
      option.value = track.name;
      option.dataset.trackName = track.name;
      option.dataset.namespace = track.namespace || '';
      option.textContent = `${track.name}${track.namespace ? ` (${track.namespace})` : ''}`;
      
      // Select first track by default
      if (index === 0) {
        option.selected = true;
      }
      
      // Build tooltip containing track details
      const tooltip = [];
      
      if (track.codec) {
        tooltip.push(`Codec: ${track.codec}`);
      }
      if (track.bitrate) {
        tooltip.push(`Bitrate: ${this.formatBitrate(track.bitrate)}`);
      }
      
      // Add video-specific details
      if (track.width && track.height) {
        tooltip.push(`Resolution: ${track.width}×${track.height}`);
      }
      if (track.framerate) {
        tooltip.push(`Framerate: ${track.framerate} fps`);
      }
      
      // Add audio-specific details
      if (track.samplerate) {
        tooltip.push(`Sample Rate: ${track.samplerate} Hz`);
      }
      if (track.channelConfig) {
        tooltip.push(`Channels: ${track.channelConfig}`);
      }
      
      // Set tooltip as title attribute
      if (tooltip.length > 0) {
        option.title = tooltip.join(' | ');
      }
      
      select.appendChild(option);
    });
    
    // Add details container that will show the selected track's details
    const detailsContainer = document.createElement('div');
    detailsContainer.className = 'track-details-container';
    detailsContainer.id = `${selectId}-details`;
    
    // Event listener to update details when selection changes
    select.addEventListener('change', (_e) => {
      const selectedOption = select.options[select.selectedIndex];
      if (selectedOption.title) {
        detailsContainer.textContent = selectedOption.title;
      } else {
        detailsContainer.textContent = 'No additional details available';
      }
    });
    
    // Trigger change event to populate initial details
    setTimeout(() => {
      select.dispatchEvent(new Event('change'));
    }, 0);
    
    selectorContainer.appendChild(select);
    section.appendChild(selectorContainer);
    section.appendChild(detailsContainer);
    
    this.tracksContainerEl.appendChild(section);
    
    // Add Start button after all track sections are added
    this.addStartButton();
    this.addStopButton();
  }

  /**
   * Add a Stop button to the tracks container
   */
  private addStopButton(): void {
    // Use static Stop button from index.html
    const stopBtn = document.getElementById('stopBtn') as HTMLButtonElement | null;
    if (stopBtn) {
      stopBtn.disabled = false;
      stopBtn.onclick = async () => {
        // Disable the button while stopping to prevent multiple clicks
        stopBtn.disabled = true;
        this.logger.info('Stopping playback and unsubscribing from tracks...');
        
        try {
          await this.stopPlayback();
        } catch (error) {
          this.logger.info(`Error stopping playback: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          // Re-enable the button in case there was an error
          stopBtn.disabled = false;
        }
      };
      stopBtn.style.display = '';
    }
  }

  // Track subscriptions are managed through the trackSubscriptions map

  /**
   * Stop playback and unsubscribe from tracks
   */
  private async stopPlayback(): Promise<void> {
    this.logger.info('stopPlayback called');
    
    // Log the current state of trackSubscriptions
    this.logger.info(`Current trackSubscriptions size: ${this.trackSubscriptions.size}`);
    if (this.trackSubscriptions.size > 0) {
      this.logger.info('Current track subscriptions:');
      this.trackSubscriptions.forEach((alias, key) => {
        this.logger.info(`  - ${key}: ${alias}`);
      });
    } else {
      this.logger.warn('No active track subscriptions found!');
    }
    
    // Stop synchronized playback first
    this.stopSynchronizedPlayback();
    
    // Unsubscribe from all active track subscriptions
    if (this.client && this.trackSubscriptions.size > 0) {
      this.logger.info(`Unsubscribing from ${this.trackSubscriptions.size} active track(s)`);
      
      // Create an array of promises for each unsubscribe operation
      const unsubscribePromises = [];
      
      for (const [trackName, trackAlias] of this.trackSubscriptions.entries()) {
        this.logger.info(`Sending unsubscribe message for track: ${trackName} (alias: ${trackAlias})`);
        try {
          // Add the unsubscribe promise to our array
          unsubscribePromises.push(this.client.unsubscribeTrack(trackAlias));
        } catch (error) {
          this.logger.info(`Error unsubscribing from track ${trackName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      
      // Wait for all unsubscribe operations to complete
      try {
        await Promise.all(unsubscribePromises);
        this.logger.info('Successfully unsubscribed from all tracks');
      } catch (error) {
        this.logger.info(`Error during track unsubscription: ${error instanceof Error ? error.message : String(error)}`);
      }
      
      // Clear the track subscriptions map
      this.trackSubscriptions.clear();
      this.logger.info('Cleared track subscriptions map');
    } else {
      if (!this.client) {
        this.logger.warn('Client is not initialized, cannot unsubscribe from tracks');
      } else {
        this.logger.warn('No active track subscriptions to unsubscribe from');
      }
    }
    
    // Reset video element
    const videoEl = document.getElementById('videoPlayer') as HTMLVideoElement;
    if (videoEl) {
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
    }
    
    // Reset state
    this.resetPlaybackState();
    
    this.logger.info('Playback stopped');
  }
  
  /**
   * Stop synchronized playback and clean up event listeners
   */
  private stopSynchronizedPlayback(): void {
    const videoEl = document.getElementById('videoPlayer') as HTMLVideoElement;
    if (videoEl) {
      // Stop playback
      videoEl.pause();
      
      // Remove synchronization event listener
      videoEl.removeEventListener('timeupdate', this.monitorSync.bind(this));
      
      // Reset playback rate to normal
      videoEl.playbackRate = 1.0;
      
      this.logger.info('[Sync] Synchronized playback stopped and event listeners removed');
    }
  }
  
  /**
   * Reset all playback-related state variables
   */
  private resetPlaybackState(): void {
    // Reset track references
    this.videoTrack = null;
    this.audioTrack = null;
    
    // Reset buffer flags
    this.videoBufferReady = false;
    this.audioBufferReady = false;
    this.playbackStarted = false;
    
    // Reset counters
    this.videoObjectsReceived = 0;
    this.audioObjectsReceived = 0;
    
    // Reset buffer variables
    this.videoSourceBuffer = null;
    this.audioSourceBuffer = null;
    this.videoMediaSegmentBuffer = null;
    this.audioMediaSegmentBuffer = null;
    this.videoMediaBuffer = null;
    this.audioMediaBuffer = null;
    this.sharedMediaSource = null;
    
    // Reset error handling state
    this.recoveryInProgress = false;
    this.videoErrorCount = 0;
    this.audioErrorCount = 0;
    this.playbackStalled = false;
    this.recoveryAttempts = 0;
    this.lastErrorTime = 0;
    
    this.logger.info('Playback state reset');
  }
  
  /**
   * Handle errors on the video element
   * @param event The error event
   */
  private handleVideoElementError(_event: Event): void {
    const videoEl = document.getElementById('videoPlayer') as HTMLVideoElement;
    if (!videoEl) {
      this.logger.error('[ErrorHandler] Video element not found when handling error');
      return;
    }
    
    const error = videoEl.error;
    if (!error) {
      this.logger.error('[ErrorHandler] No error information available');
      return;
    }
    
    // Log the error details
    this.logger.error(`[ErrorHandler] Video element error: ${error.message || 'Unknown error'}`);
    this.logger.error(`[ErrorHandler] Error code: ${error.code}, Message: ${error.message}`);
    
    // Handle different error types
    switch (error.code) {
      case MediaError.MEDIA_ERR_ABORTED:
        this.logger.error('[ErrorHandler] Playback aborted by the user');
        break;
        
      case MediaError.MEDIA_ERR_NETWORK:
        this.logger.error('[ErrorHandler] Network error occurred during playback');
        this.attemptNetworkRecovery();
        break;
        
      case MediaError.MEDIA_ERR_DECODE:
        this.logger.error('[ErrorHandler] Decoding error occurred during playback');
        this.attemptDecodeRecovery();
        break;
        
      case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
        this.logger.error('[ErrorHandler] Format or codec not supported');
        this.handleUnsupportedFormat();
        break;
        
      default:
        this.logger.error('[ErrorHandler] Unknown error occurred');
        this.attemptGenericRecovery();
        break;
    }
  }
  
  /**
   * Attempt to recover from network errors
   */
  private attemptNetworkRecovery(): void {
    if (this.recoveryInProgress) {
      return;
    }
    
    this.recoveryInProgress = true;
    this.recoveryAttempts++;
    
    // Don't try to recover too many times
    if (this.recoveryAttempts > this.maxRecoveryAttempts) {
      this.logger.error('Maximum recovery attempts reached, giving up');
      this.recoveryInProgress = false;
      return;
    }
    
    this.logger.info(`[ErrorHandler] Attempting network recovery (attempt ${this.recoveryAttempts}/${this.maxRecoveryAttempts})`);
    
    // Attempt to find a stable playback position
    const videoEl = document.getElementById('videoPlayer') as HTMLVideoElement;
    if (videoEl && videoEl.buffered.length > 0) {
      // Find a stable position in the buffer (not at the edge)
      for (let i = 0; i < videoEl.buffered.length; i++) {
        const start = videoEl.buffered.start(i);
        const end = videoEl.buffered.end(i);
        
        // If we have more than 1 second of buffer, seek to 200ms after the start
        if (end - start > 1.0) {
          const safePosition = start + 0.2; // 200ms into the buffer
          this.logger.info(`[ErrorHandler] Found stable buffer range [${start.toFixed(2)}-${end.toFixed(2)}], seeking to ${safePosition.toFixed(2)}`);
          
          // Seek to the safe position and try to resume playback
          videoEl.currentTime = safePosition;
          videoEl.play().then(() => {
            this.logger.info('Network recovery successful, playback resumed');
            this.recoveryInProgress = false;
          }).catch(e => {
            this.logger.error(`Failed to resume playback after network recovery: ${e}`);
            this.recoveryInProgress = false;
          });
          
          return;
        }
      }
    }
    
    // If we couldn't find a stable position, wait a bit and try again
    setTimeout(() => {
      this.logger.info('No stable buffer position found, trying again later');
      this.recoveryInProgress = false;
      this.attemptNetworkRecovery();
    }, 2000); // Wait 2 seconds before trying again
  }
  
  /**
   * Attempt to recover from decode errors
   */
  private attemptDecodeRecovery(): void {
    if (this.recoveryInProgress) {
      return;
    }
    
    this.recoveryInProgress = true;
    this.recoveryAttempts++;
    
    // Don't try to recover too many times
    if (this.recoveryAttempts > this.maxRecoveryAttempts) {
      this.logger.error('Maximum recovery attempts reached, giving up');
      this.recoveryInProgress = false;
      return;
    }
    
    this.logger.info(`[ErrorHandler] Attempting decode recovery (attempt ${this.recoveryAttempts}/${this.maxRecoveryAttempts})`);
    
    const videoEl = document.getElementById('videoPlayer') as HTMLVideoElement;
    
    // For decode errors, we'll try to skip ahead slightly
    if (videoEl && videoEl.buffered.length > 0) {
      const currentTime = videoEl.currentTime;
      
      // Skip ahead slightly to try to get past the problematic frame
      const skipAhead = 0.5; // Skip ahead 500ms
      const newPosition = currentTime + skipAhead;
      
      // Check if we can skip ahead
      let canSkip = false;
      for (let i = 0; i < videoEl.buffered.length; i++) {
        if (newPosition >= videoEl.buffered.start(i) && newPosition < videoEl.buffered.end(i)) {
          canSkip = true;
          break;
        }
      }
      
      if (canSkip) {
        this.logger.info(`[ErrorHandler] Skipping ahead from ${currentTime.toFixed(2)} to ${newPosition.toFixed(2)} to bypass decode error`);
        
        // Seek ahead and try to resume playback
        videoEl.currentTime = newPosition;
        videoEl.play().then(() => {
          this.logger.error('Decode recovery successful, playback resumed');
          this.recoveryInProgress = false;
        }).catch(e => {
          this.logger.error(`[ErrorHandler] Failed to resume playback after decode recovery: ${e}`);
          this.recoveryInProgress = false;
        });
        
        return;
      }
    }
    
    // If we can't skip ahead, try general recovery
    this.logger.error('Could not skip ahead, attempting generic recovery');
    this.recoveryInProgress = false;
    this.attemptGenericRecovery();
  }
  
  /**
   * Handle unsupported format errors by falling back to available tracks
   */
  private handleUnsupportedFormat(): void {
    this.logger.warn('Format or codec not supported, checking for fallback options');
    
    if (this.audioSourceBuffer && this.videoSourceBuffer) {
      // Both audio and video are present
      if (this.audioErrorCount > this.videoErrorCount) {
        // Audio seems to be the problem, try to fall back to video only
        this.logger.warn('Audio codec seems problematic, attempting to fall back to video only');
        this.fallbackToVideoOnly();
      } else if (this.videoErrorCount > this.audioErrorCount) {
        // Video seems to be the problem, try to fall back to audio only
        this.logger.warn('Video codec seems problematic, attempting to fall back to audio only');
        this.fallbackToAudioOnly();
      } else {
        // Both seem problematic
        this.logger.error('Both audio and video codecs seem problematic, cannot continue');
      }
    } else if (this.videoSourceBuffer) {
      // Only video is present
      this.logger.error('Video codec not supported and no audio fallback available');
    } else if (this.audioSourceBuffer) {
      // Only audio is present
      this.logger.error('Audio codec not supported and no video fallback available');
    } else {
      this.logger.error('No supported tracks available');
    }
  }
  
  /**
   * Attempt a generic recovery strategy
   */
  private attemptGenericRecovery(): void {
    if (this.recoveryInProgress) {
      return;
    }
    
    this.recoveryInProgress = true;
    this.recoveryAttempts++;
    
    // Don't try to recover too many times
    if (this.recoveryAttempts > this.maxRecoveryAttempts) {
      this.logger.error('Maximum recovery attempts reached, giving up');
      this.recoveryInProgress = false;
      return;
    }
    
    this.logger.info(`[ErrorHandler] Attempting generic recovery (attempt ${this.recoveryAttempts}/${this.maxRecoveryAttempts})`);
    
    const videoEl = document.getElementById('videoPlayer') as HTMLVideoElement;
    if (!videoEl) {
      this.logger.error('Video element not found during recovery');
      this.recoveryInProgress = false;
      return;
    }
    
    // Pause first
    videoEl.pause();
    
    // Check if we have any buffered data
    if (videoEl.buffered.length > 0) {
      // Find the current buffered range
      let rangeIndex = -1;
      for (let i = 0; i < videoEl.buffered.length; i++) {
        if (videoEl.currentTime >= videoEl.buffered.start(i) && 
            videoEl.currentTime <= videoEl.buffered.end(i)) {
          rangeIndex = i;
          break;
        }
      }
      
      if (rangeIndex >= 0) {
        // We found the current range, seek to the middle of it
        const start = videoEl.buffered.start(rangeIndex);
        const end = videoEl.buffered.end(rangeIndex);
        const middle = start + (end - start) / 2;
        
        this.logger.info(`[ErrorHandler] Seeking to middle of buffer range [${start.toFixed(2)}-${end.toFixed(2)}] at ${middle.toFixed(2)}`);
        
        // Seek to the middle and try to resume playback
        videoEl.currentTime = middle;
        
        // Wait a bit then try to play
        setTimeout(() => {
          videoEl.play().then(() => {
            this.logger.error('Generic recovery successful, playback resumed');
            this.recoveryInProgress = false;
          }).catch(e => {
            this.logger.error(`[ErrorHandler] Failed to resume playback after generic recovery: ${e}`);
            this.recoveryInProgress = false;
          });
        }, 500);
      } else {
        // No suitable range found, try to start from the beginning of any range
        if (videoEl.buffered.length > 0) {
          const start = videoEl.buffered.start(0);
          this.logger.info(`[ErrorHandler] No suitable buffer range found, seeking to start of first range at ${start.toFixed(2)}`);
          videoEl.currentTime = start;
          
          // Wait a bit then try to play
          setTimeout(() => {
            videoEl.play().then(() => {
              this.logger.info('Generic recovery successful, playback resumed from start');
              this.recoveryInProgress = false;
            }).catch(e => {
              this.logger.error(`[ErrorHandler] Failed to resume playback from start: ${e}`);
              this.recoveryInProgress = false;
            });
          }, 500);
        } else {
          this.logger.error('No buffered data available for recovery');
          this.recoveryInProgress = false;
        }
      }
    } else {
      this.logger.error('No buffered data available for recovery');
      this.recoveryInProgress = false;
    }
  }
  
  /**
   * Fall back to video-only playback when audio is problematic
   */
  private fallbackToVideoOnly(): void {
    if (!this.videoSourceBuffer || !this.videoTrack) {
      this.logger.error('Cannot fall back to video-only, no video track available');
      return;
    }
    
    this.logger.error('Falling back to video-only playback');
    
    // Clear audio state
    this.audioSourceBuffer = null;
    this.audioMediaSegmentBuffer = null;
    this.audioMediaBuffer = null;
    this.audioTrack = null;
    this.audioBufferReady = false;
    this.audioObjectsReceived = 0;
    
    // If we're already playing, continue with video only
    // Otherwise, start playback with video only
    if (!this.playbackStarted && this.videoBufferReady) {
      const videoEl = document.getElementById('videoPlayer') as HTMLVideoElement;
      if (videoEl) {
        this.startVideoOnlyPlayback(videoEl);
      }
    }
  }
  
  /**
   * Fall back to audio-only playback when video is problematic
   */
  private fallbackToAudioOnly(): void {
    if (!this.audioSourceBuffer || !this.audioTrack) {
      this.logger.error('Cannot fall back to audio-only, no audio track available');
      return;
    }
    
    this.logger.error('Falling back to audio-only playback');
    
    // Clear video state
    this.videoSourceBuffer = null;
    this.videoMediaSegmentBuffer = null;
    this.videoMediaBuffer = null;
    this.videoTrack = null;
    this.videoBufferReady = false;
    this.videoObjectsReceived = 0;
    
    // If we're already playing, continue with audio only
    // Otherwise, start playback with audio only
    if (!this.playbackStarted && this.audioBufferReady) {
      const videoEl = document.getElementById('videoPlayer') as HTMLVideoElement;
      if (videoEl) {
        this.startAudioOnlyPlayback(videoEl);
      }
    }
  }
  
  /**
   * Check for critically low buffer and attempt to recover
   * This is called during the monitorSync process
   */
  private checkBufferHealth(videoBufferAhead: number, audioBufferAhead: number): void {
    const videoEl = document.getElementById('videoPlayer') as HTMLVideoElement;
    if (!videoEl) {return;}
    
    // Convert target buffer from ms to seconds for comparison
    const targetBufferSec = this.targetBufferDurationMs / 1000;
    
    // Check if either buffer is critically low
    const videoCritical = this.videoSourceBuffer && videoBufferAhead < this.bufferCriticalThreshold;
    const audioCritical = this.audioSourceBuffer && audioBufferAhead < this.bufferCriticalThreshold;
    
    // Check if either buffer is below target
    const videoBelowTarget = this.videoSourceBuffer && videoBufferAhead < targetBufferSec;
    const audioBelowTarget = this.audioSourceBuffer && audioBufferAhead < targetBufferSec;
    
    if ((videoCritical || audioCritical) && !this.playbackStalled && !this.recoveryInProgress) {
      this.logger.info(`[BufferHealth] Buffer critically low - Video: ${videoBufferAhead.toFixed(2)}s, Audio: ${audioBufferAhead.toFixed(2)}s, Target: ${targetBufferSec.toFixed(2)}s`);
      
      // Check if we're stalled or about to stall
      if (videoEl.paused || videoEl.readyState < 3) {
        this.playbackStalled = true;
        this.logger.warn('[BufferHealth] Playback stalled due to buffer underrun');
        
        // Attempt to recover
        this.recoverFromBufferUnderrun();
      } else {
        // Not stalled yet, but buffer is critically low
        // Adjust playback rate to give buffer time to build up
        if (videoEl.playbackRate > 0.7) {
          // Reduce playback rate to 70% to allow buffer to build up faster
          const originalRate = videoEl.playbackRate;
          videoEl.playbackRate = 0.7;
          this.logger.info(`[BufferHealth] Reduced playback rate from ${originalRate.toFixed(2)}x to ${videoEl.playbackRate.toFixed(2)}x to prevent stall`);
        }
      }
    } else if (this.playbackStalled && videoBufferAhead > targetBufferSec && audioBufferAhead > targetBufferSec) {
      // We have recovered from stalled state and reached target buffer levels
      this.playbackStalled = false;
      this.logger.info(`[BufferHealth] Playback recovered from stall, buffer levels at target (${targetBufferSec.toFixed(2)}s)`);
      
      // Reset playback rate to normal
      videoEl.playbackRate = 1.0;
    } else if ((videoBelowTarget || audioBelowTarget) && !this.playbackStalled && videoEl.playbackRate >= 1.0) {
      // Buffers below target but not critical - adjust playback rate to allow buffering
      const minBuffer = Math.min(videoBufferAhead || Infinity, audioBufferAhead || Infinity);
      const bufferRatio = minBuffer / targetBufferSec; // How full is our buffer compared to target
      
      if (bufferRatio < 0.5) {
        // Less than 50% of target buffer - slow down more
        const newRate = 0.9;
        if (videoEl.playbackRate > newRate) {
          const originalRate = videoEl.playbackRate;
          videoEl.playbackRate = newRate;
          this.logger.info(`[BufferHealth] Reduced playback rate from ${originalRate.toFixed(2)}x to ${newRate.toFixed(2)}x (buffer at ${(bufferRatio * 100).toFixed(0)}% of target)`);
        }
      }
    } else if (!this.playbackStalled && videoBufferAhead > targetBufferSec * 1.5 && audioBufferAhead > targetBufferSec * 1.5) {
      // Buffer exceeds target by 50% - reset to normal speed if needed
      if (videoEl.playbackRate !== 1.0) {
        videoEl.playbackRate = 1.0;
        this.logger.info(`[BufferHealth] Restored normal playback rate, buffers exceed target by >50%`);
      }
    } else if (this.videoSourceBuffer && this.audioSourceBuffer && 
              videoBufferAhead < this.bufferLowThreshold && 
              audioBufferAhead < this.bufferLowThreshold) {
      // Both buffers are low but not yet critical
      this.logger.info(`[BufferHealth] Buffer levels low - Video: ${videoBufferAhead.toFixed(2)}s, Audio: ${audioBufferAhead.toFixed(2)}s, Target: ${targetBufferSec.toFixed(2)}s`);
    }
  }
  
  /**
   * Attempt to recover from a buffer underrun
   */
  private recoverFromBufferUnderrun(): void {
    if (this.recoveryInProgress) {
      return;
    }

    const targetBufferSec = this.targetBufferDurationMs / 1000;
    
    this.recoveryInProgress = true;
    this.recoveryAttempts++;
    
    const videoEl = document.getElementById('videoPlayer') as HTMLVideoElement;
    if (!videoEl) {
      this.logger.error('[BufferHealth] Video element not found during buffer recovery');
      this.recoveryInProgress = false;
      return;
    }
    
    this.logger.info(`[BufferHealth] Attempting to recover from buffer underrun (attempt ${this.recoveryAttempts}/${this.maxRecoveryAttempts})`);
    
    // If we have any buffered data ahead, skip to it
    if (videoEl.buffered.length > 0) {
      const currentTime = videoEl.currentTime;
      let furthestBufferStart = -1;
      
      // Find the furthest buffered range that is ahead of current time
      for (let i = 0; i < videoEl.buffered.length; i++) {
        const rangeStart = videoEl.buffered.start(i);
        if (rangeStart > currentTime && (furthestBufferStart === -1 || rangeStart > furthestBufferStart)) {
          furthestBufferStart = rangeStart;
        }
      }
      
      if (furthestBufferStart !== -1) {
        // We found a range ahead, seek to it
        const newPosition = furthestBufferStart + targetBufferSec; // Start target buffer from buffered end
        this.logger.info(`[BufferHealth] Found buffered range starting at ${furthestBufferStart.toFixed(2)}, seeking to ${newPosition.toFixed(2)}`);
        
        videoEl.currentTime = newPosition;
        
        // Try to resume playback
        setTimeout(() => {
          videoEl.play().then(() => {
            this.logger.info('[BufferHealth] Buffer recovery successful, playback resumed');
            this.recoveryInProgress = false;
          }).catch(e => {
            this.logger.error(`[BufferHealth] Failed to resume playback after buffer recovery: ${e}`);
            this.recoveryInProgress = false;
          });
        }, 500);
      } else {
        // No range ahead, wait for buffer to build up
        this.logger.info('No buffered data ahead, waiting for buffer to build up');
        
        // Check again in 1 second
        setTimeout(() => {
          // Try to resume playback if we have enough buffer now
          if (videoEl.buffered.length > 0) {
            const currentTime = videoEl.currentTime;
            let hasBufferAhead = false;
            
            for (let i = 0; i < videoEl.buffered.length; i++) {
              if (currentTime >= videoEl.buffered.start(i) && 
                  currentTime < videoEl.buffered.end(i) && 
                  videoEl.buffered.end(i) - currentTime > 0.5) {
                hasBufferAhead = true;
                break;
              }
            }
            
            // Calculate buffer ahead and compare to target
            const targetBufferSec = this.targetBufferDurationMs / 1000;
            let bufferAheadSec = 0;
            
            for (let i = 0; i < videoEl.buffered.length; i++) {
              if (currentTime >= videoEl.buffered.start(i) && currentTime < videoEl.buffered.end(i)) {
                bufferAheadSec = videoEl.buffered.end(i) - currentTime;
                break;
              }
            }
            
            const bufferPercent = (bufferAheadSec / targetBufferSec) * 100;
            
            if (hasBufferAhead) {
              videoEl.play().then(() => {
                this.logger.info(`[BufferHealth] Buffer recovery successful after wait, playback resumed with ${bufferAheadSec.toFixed(2)}s ahead (${bufferPercent.toFixed(0)}% of target)`);
                this.recoveryInProgress = false;
              }).catch(e => {
                this.logger.error(`[BufferHealth] Failed to resume playback after wait: ${e}`);
                this.recoveryInProgress = false;
              });
            } else {
              this.logger.warn(`[BufferHealth] Still insufficient buffer after wait (${bufferAheadSec.toFixed(2)}s, target: ${targetBufferSec.toFixed(2)}s)`);
              this.recoveryInProgress = false;
            }
          } else {
            this.logger.debug('No buffered data available after wait');
            this.recoveryInProgress = false;
          }
        }, 1000);
      }
    } else {
      // No buffered data at all, nothing we can do but wait
      this.logger.debug('No buffered data available, waiting for data');
      
      // Check again in 2 seconds
      setTimeout(() => {
        this.recoveryInProgress = false;
        if (this.playbackStalled) {
          this.recoverFromBufferUnderrun();
        }
      }, 2000);
    }
  }
  
  /**
   * Add a Start button to the tracks container
   */
  private addStartButton(): void {
    // Use static Start button from index.html
    const startBtn = document.getElementById('startBtn') as HTMLButtonElement | null;
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.onclick = () => this.startPlayback();
      startBtn.style.display = '';
    }
  }



  /**
   * Start playback of selected tracks
   */
  private async startPlayback(): Promise<void> {
    // Get selected video track from dropdown
    const videoSelect = document.getElementById('video-tracks-select') as HTMLSelectElement;
    // Get selected audio track from dropdown
    const audioSelect = document.getElementById('audio-tracks-select') as HTMLSelectElement;

    const hasVideoTrack = videoSelect && videoSelect.options.length > 0;
    const hasAudioTrack = audioSelect && audioSelect.options.length > 0;

    if (!hasVideoTrack && !hasAudioTrack) {
      this.logger.error('No tracks available to play');
      return;
    }

    // --- VIDEO PLAYBACK LOGIC ---
    if (hasVideoTrack) {
      const selectedOption = videoSelect.options[videoSelect.selectedIndex];
      const videoTrackName = selectedOption.dataset.trackName || '';
      const videoNamespace = selectedOption.dataset.namespace || '';
      
      this.logger.info(`Selected video track: ${videoNamespace}/${videoTrackName}`);
      
      // Find the video track object from the catalog
      const videoTrack = this.getTrackFromCatalog(videoNamespace, videoTrackName, 'video');
      if (!videoTrack) {
        this.logger.error('Could not find selected video track in catalog');
        return;
      }
      
      // Setup MediaSource and SourceBuffer
      this.setupVideoPlayback(videoTrack);
    }

    // --- AUDIO PLAYBACK LOGIC ---
    if (hasAudioTrack) {
      const selectedOption = audioSelect.options[audioSelect.selectedIndex];
      const audioTrackName = selectedOption.dataset.trackName || '';
      const audioNamespace = selectedOption.dataset.namespace || '';
      
      this.logger.info(`Selected audio track: ${audioNamespace}/${audioTrackName}`);
      
      // Find the audio track object from the catalog
      const audioTrack = this.getTrackFromCatalog(audioNamespace, audioTrackName, 'audio');
      if (!audioTrack) {
        this.logger.error('Could not find selected audio track in catalog');
        return;
      }
      
      this.logger.info('Audio track found in catalog, preparing for setup');
      
      // Setup MediaSource and SourceBuffer for audio
      this.setupAudioPlayback(audioTrack);
    }
  }

  /**
   * Find a track from the catalog by namespace, name, and type
   */
  private getTrackFromCatalog(namespace: string, name: string, kind: string): WarpTrack | undefined {
    return this.catalogManager.getTrackFromCatalog(namespace, name, kind);
  }

  /**
   * Setup MediaSource and SourceBuffer for video playback
   * This will initialize shared resources for both audio and video
   */
  private setupVideoPlayback(track: WarpTrack): void {
    this.logger.info('setupVideoPlayback called');
    
    // Store the video track reference
    this.videoTrack = track;
    
    const videoEl = document.getElementById('videoPlayer') as HTMLVideoElement;
    if (!videoEl) {
      this.logger.error('Video element not found');
      return;
    }
    
    // Reset previous source if any
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    
    // Create and store the shared MediaSource
    this.sharedMediaSource = new MediaSource();
    videoEl.src = URL.createObjectURL(this.sharedMediaSource);
    
    // Create and store media segment buffers for video
    this.videoMediaSegmentBuffer = new MediaSegmentBuffer({
      onSegmentReady: (segment) => {
        this.logger.debug(`[VideoMediaSegmentBuffer] Segment ready with baseMediaDecodeTime: ${segment.trackInfo.baseMediaDecodeTime}, timescale: ${segment.trackInfo.timescale}`);
      }
    });
    
    // Create and store media buffer for video
    this.videoMediaBuffer = new MediaBuffer();
    
    // Setup MediaSource open event
    this.sharedMediaSource.addEventListener('sourceopen', () => {
      this.logger.info(`[SharedMediaSource] sourceopen - readyState: ${this.sharedMediaSource?.readyState}`);
      
      // Create video source buffer
      const videoMimeType = `video/mp4; codecs="${track.codec || 'avc3.640028'}"`;
      this.logger.debug(`[SharedMediaSource] Using video mimeType: ${videoMimeType}`);
      
      try {
        if (!this.sharedMediaSource) {
          this.logger.error('SharedMediaSource is null');
          return;
        }
        
        this.videoSourceBuffer = this.sharedMediaSource.addSourceBuffer(videoMimeType);
        this.logger.info('[VideoSourceBuffer] Created successfully');
      } catch (e) {
        this.logger.error('Could not add VideoSourceBuffer: ' + e);
        return;
      }
      
      // Setup video source buffer event listeners
      this.videoSourceBuffer?.addEventListener('error', (e) => {
        this.logger.error(`[VideoSourceBuffer] ERROR: ${e}`);
      });
      
      this.videoSourceBuffer?.addEventListener('abort', () => {
        this.logger.error('[VideoSourceBuffer] ABORT event');
      });
      
      this.videoSourceBuffer?.addEventListener('update', () => {
        // Update event handler - intentionally empty as we only need to track updateend
      });
      
      this.videoSourceBuffer?.addEventListener('updateend', () => {
        try {
          const ranges = [];
          for (let i = 0; i < (this.videoSourceBuffer?.buffered.length || 0); i++) {
            ranges.push(`[${this.videoSourceBuffer?.buffered.start(i).toFixed(2) || '?'} - ${this.videoSourceBuffer?.buffered.end(i).toFixed(2) || '?'}]`);
          }
          this.logger.debug(`[VideoSourceBuffer] Buffered ranges: ${ranges.join(', ')}`);
        } catch (e) {
          this.logger.error(`[VideoSourceBuffer] Error reading buffered ranges: ${e}`);
        }
      });
      
      // Initialize counter for tracking received video objects
      let videoObjectsReceived = 0;
      
      // Append CMAF init segment for video (base64-decoded)
      if (!track.initData) {
        this.logger.error('No initData found for video track');
        return;
      }
      
      const videoInitSegment = this.base64ToArrayBuffer(track.initData);
      this.logger.info(`[VideoInitSegment] Decoded init segment: ${videoInitSegment.byteLength} bytes`);
      
      try {
        if (!this.videoMediaBuffer || !this.videoMediaSegmentBuffer || !this.videoSourceBuffer) {
          this.logger.error('Video media buffers or source buffer not initialized');
          return;
        }
        
        // Parse the init segment with videoMediaBuffer to get timing info
        const videoTrackInfo = this.videoMediaBuffer.parseInitSegment(videoInitSegment);
        this.logger.info(`[VideoMediaBuffer] Parsed init segment, timescale: ${videoTrackInfo.timescale}`);
        
        // Set the source buffer in the videoMediaSegmentBuffer
        this.videoMediaSegmentBuffer.setSourceBuffer(this.videoSourceBuffer);
        
        // Add the init segment to the video media segment buffer
        const videoInitSegmentObj = this.videoMediaSegmentBuffer.addInitSegment(videoInitSegment);
        
        // Append to video source buffer via mediaSegmentBuffer
        this.videoMediaSegmentBuffer.appendToSourceBuffer(videoInitSegmentObj);
        
        this.logger.info('Added video CMAF init segment to MediaSegmentBuffer and SourceBuffer');
      } catch (e) {
        this.logger.error('Failed to process video CMAF init segment: ' + (e instanceof Error ? e.message : String(e)));
        return;
      }

    // Any previous subscriptions will be managed through the trackSubscriptions map
    
    // Log the current state of trackSubscriptions before subscribing
    this.logger.info(`Current track subscriptions before subscribing: ${this.trackSubscriptions.size}`);
    
    // Subscribe to the video track and store the subscription
    this.subscribeToVideoTrack(track, (obj: { data: ArrayBuffer, timing?: { baseMediaDecodeTime?: number, timescale?: number } }) => {
        try {
          // Check if we have a valid data object
          if (!obj.data) {
            this.logger.error('[VideoMediaBuffer] Received null or undefined data');
            return;
          }
          
          let arrayBuffer: ArrayBuffer;
          
          // If it's already an ArrayBuffer, use it directly
          if (obj.data instanceof ArrayBuffer) {
            arrayBuffer = obj.data;
          }
          // If it's a TypedArray (like Uint8Array), get its buffer
          else if (ArrayBuffer.isView(obj.data)) {
            // Use type assertion to tell TypeScript that this is a TypedArray with a buffer property
            const typedArray = obj.data as Uint8Array;
            
            // Check if this is a view with an offset into a larger buffer
            if (typedArray.byteOffset > 0 || typedArray.byteLength < typedArray.buffer.byteLength) {
              // Create a new ArrayBuffer that contains only the data in this view
              arrayBuffer = typedArray.buffer.slice(typedArray.byteOffset, typedArray.byteOffset + typedArray.byteLength);
            } else {
              // Use the buffer directly if it's the full buffer
              arrayBuffer = typedArray.buffer;
            }
            
            // Replace the original data with the ArrayBuffer for downstream processing
            obj.data = arrayBuffer;
          }
          // Otherwise, it's an invalid type
          else {
            const type = typeof obj.data;
            let constructorName = 'unknown';
            try {
              // Safe way to access constructor name
              if (typeof obj.data === 'object') {
                const dataObj: any = obj.data; // Cast to any to bypass TypeScript error
                if (dataObj.constructor) {
                  constructorName = dataObj.constructor.name;
                }
              }
            } catch (e) {
              // Ignore any errors when trying to access constructor
            }
            this.logger.error(`[VideoMediaBuffer] Received invalid data type: ${type} (${constructorName})`);
            return;
          }
          
          // Check if the ArrayBuffer is empty
          if (arrayBuffer.byteLength === 0) {
            this.logger.error('[VideoMediaBuffer] Received empty ArrayBuffer (zero bytes)');
            return;
          }

          if (!this.videoMediaBuffer || !this.videoMediaSegmentBuffer) {
            this.logger.error('[VideoMediaBuffer] Video buffers not initialized');
            return;
          }

          // Parse the media segment to extract timing information
          const trackInfo = this.videoMediaBuffer.parseMediaSegment(obj.data);
          
          // Add timing information to the object
          obj.timing = {
            baseMediaDecodeTime: trackInfo.baseMediaDecodeTime,
            timescale: trackInfo.timescale
          };
          
          // Add the media segment to the media segment buffer and get the segment object
          const mediaSegment = this.videoMediaSegmentBuffer.addMediaSegment(obj.data);
          
          // Append the segment to the source buffer via mediaSegmentBuffer only
          this.videoMediaSegmentBuffer.appendToSourceBuffer(mediaSegment);
          
          // Track received video objects
          videoObjectsReceived++;
          
          // Only log every 10th segment to reduce logging overhead
          if (videoObjectsReceived % 10 === 0) {
            this.logger.debug(`[VideoMediaSegmentBuffer] Queued segment with baseMediaDecodeTime: ${trackInfo.baseMediaDecodeTime}`);
          }
          
          // Only log detailed information every 10 segments to reduce overhead
          if (videoObjectsReceived % 10 === 0 || videoObjectsReceived <= 5) {
            const pendingCount = this.videoMediaSegmentBuffer['pendingSegments'] ? this.videoMediaSegmentBuffer['pendingSegments'].length : 0;
            this.logger.info(`[VideoSegment] Received segment #${videoObjectsReceived} - ${obj.data.byteLength} bytes. Segments: ${this.videoMediaSegmentBuffer.getSegmentCount()}, Pending: ${pendingCount}`);
            
            if (obj.timing) {
              this.logger.debug(`[VideoSegment] Timing info - baseMediaDecodeTime: ${obj.timing.baseMediaDecodeTime}, timescale: ${obj.timing.timescale}`);
            }
          }

          // Track the number of objects received
          this.videoObjectsReceived = videoObjectsReceived;
          
          // Check if we have enough buffer duration to mark the buffer as ready
          if (!this.videoBufferReady && this.videoMediaSegmentBuffer) {
            const bufferDurationSec = this.videoMediaSegmentBuffer.getBufferDuration();
            const bufferDurationMs = bufferDurationSec * 1000;
            
            if (bufferDurationMs >= this.targetBufferDurationMs) {
              this.videoBufferReady = true;
              this.logger.info(`[Video] Buffer ready with ${bufferDurationMs.toFixed(0)}ms duration (${this.videoObjectsReceived} objects), target: ${this.targetBufferDurationMs}ms`);
              
              // Check if we can start playback (depends on audio buffer state too)
              this.checkBuffersAndStartPlayback();
            }
          }
          
          // Log video element state (only every 30 segments to avoid excessive logging)
          if (videoObjectsReceived % 30 === 0) {
            this.logger.debug(`[Video] readyState: ${videoEl.readyState}, currentTime: ${videoEl.currentTime.toFixed(2)}, paused: ${videoEl.paused}`);
          }
        } catch (e) {
          this.logger.error(`[VideoMediaBuffer] Error parsing media segment: ${e}`);
        }
      });
      
      // MediaSource event listeners
      this.sharedMediaSource?.addEventListener('sourceended', () => {
        this.logger.debug(`[SharedMediaSource] sourceended - readyState: ${this.sharedMediaSource?.readyState}`);
      });
      
      this.sharedMediaSource?.addEventListener('sourceclose', () => {
        this.logger.info(`[SharedMediaSource] sourceclose - readyState: ${this.sharedMediaSource?.readyState}`);
      });
      
      // Now check if we also need to set up an audio SourceBuffer
      if (this.audioTrack) {
        this.logger.info('[SharedMediaSource] Video setup complete, now setting up audio source buffer');
        this.setupAudioSourceBuffer();
      } else {
        this.logger.info('[SharedMediaSource] Video setup complete, no audio track available');
      }
    });
  }

  /**
   * Subscribe to the selected video track and feed objects to the SourceBuffer
   */
  private async subscribeToVideoTrack(track: WarpTrack, onObject: (obj: { data: ArrayBuffer, timing?: { baseMediaDecodeTime?: number, timescale?: number } }) => void): Promise<void> {
    if (!this.client) {
      this.logger.error('Client not initialized');
      return;
    }
    
    const namespace = track.namespace || '';
    const trackName = track.name;
    const trackKey = `${namespace}/${trackName}`;
    
    this.logger.info(`Subscribing to video track: ${trackKey}`);
    this.logger.debug(`Current trackSubscriptions size before subscribing: ${this.trackSubscriptions.size}`);
    
    try {
      // Subscribe to the track and get the track alias
      this.logger.debug('Calling client.subscribeTrack...');
      const trackAlias = await this.client.subscribeTrack(namespace, trackName, (obj: { data: ArrayBuffer }) => {
        onObject(obj);
      });
      this.logger.debug(`Received track alias: ${trackAlias} from client.subscribeTrack`);
      
      // Store the track subscription in the trackSubscriptions map
      this.trackSubscriptions.set(trackKey, trackAlias);
      this.logger.debug(`Added track to trackSubscriptions map with key: ${trackKey}`);
      this.logger.debug(`trackSubscriptions size after adding: ${this.trackSubscriptions.size}`);
      this.logger.debug(`Successfully subscribed to video track ${trackKey} with alias ${trackAlias}`);
      
      // Log all current track subscriptions
      if (this.trackSubscriptions.size > 0) {
        this.logger.info('Current track subscriptions:');
        this.trackSubscriptions.forEach((alias, key) => {
          this.logger.info(`  - ${key}: ${alias}`);
        });
      }
      
      // Track subscriptions are managed through the trackSubscriptions map
      // Unsubscribing will be handled in the stopPlayback method
    } catch (error) {
      this.logger.error(`Error subscribing to video track ${trackKey}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Decode base64 to ArrayBuffer
   */
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Subscribe to a track
   * @param track The track to subscribe to
   */
  private async subscribeToTrack(track: WarpTrack): Promise<void> {
    if (!this.client || !this.connection) {
      this.logger.error('Cannot subscribe to track: Not connected');
      return;
    }

    try {
      const namespace = track.namespace || '';
      const trackName = track.name;
      
      this.logger.info(`Subscribing to track: ${namespace}/${trackName}`);
      
      // Subscribe to the track
      // The client.subscribeTrack method will internally call getNextRequestId()
      // to ensure a unique request ID is used for this subscription
      const trackAlias = await this.client.subscribeTrack(namespace, trackName, (obj: { data: ArrayBuffer }) => {
        this.logger.debug(`Received object for track ${trackName} with size ${obj.data.byteLength} bytes`);
        // Here you would handle the track data, e.g., decode and play video/audio
      });
      
      // Store the subscription
      this.trackSubscriptions.set(`${namespace}/${trackName}`, trackAlias);
      this.logger.info(`Subscribed to track ${namespace}/${trackName} with alias ${trackAlias}`);
      
    } catch (error) {
      this.logger.error(`Error subscribing to track: ${error instanceof Error ? error.message : String(error)}`);
    }
  }


  /**
   * Setup MediaSource and SourceBuffer for audio playback
   * This will share the video element and MediaSource with the video track
   */
  private setupAudioPlayback(track: WarpTrack): void {
    this.logger.debug('setupAudioPlayback called');
    
    // Store the audio track reference
    this.audioTrack = track;
    
    // Log audio track information
    this.logger.info(`Setting up audio playback for track: ${track.name}`);
    this.logger.info(`Audio codec: ${track.codec || 'mp4a.40.2'}`);
    this.logger.info(`Audio MIME type: ${track.mimeType || 'audio/mp4'}`);
    
    if (track.samplerate) {
      this.logger.info(`Audio sample rate: ${track.samplerate} Hz`);
    }
    
    if (track.channelConfig) {
      this.logger.info(`Audio channels: ${track.channelConfig}`);
    }
    
    // Create media buffer and segment buffer for audio
    this.audioMediaBuffer = new MediaBuffer();
    this.audioMediaSegmentBuffer = new MediaSegmentBuffer({
      onSegmentReady: (segment) => {
        this.logger.debug(`[AudioMediaSegmentBuffer] Segment ready with baseMediaDecodeTime: ${segment.trackInfo.baseMediaDecodeTime}, timescale: ${segment.trackInfo.timescale}`);
      }
    });
    
    // Get the video element (we'll use the same element for both audio and video)
    const videoEl = document.getElementById('videoPlayer') as HTMLVideoElement;
    if (!videoEl) {
      this.logger.error('Video element not found, cannot setup audio');
      return;
    }
    
    // Check if MediaSource is already open (from video setup)
    if (!videoEl.src || !videoEl.src.startsWith('blob:')) {
      this.logger.info('MediaSource not set up yet (no blob URL). Audio setup should happen after video setup.');
      return;
    }
    
    // Check if the MediaSource is open and ready for adding source buffers
    if (this.sharedMediaSource?.readyState === 'open') {
      this.logger.info('[SharedMediaSource] MediaSource is open, setting up audio source buffer');
      this.setupAudioSourceBuffer();
    } else {
      this.logger.warn('[SharedMediaSource] MediaSource not open yet, audio source buffer will be set up when MediaSource opens');
      // The video sourceopen handler will call setupAudioSourceBuffer
    }
  }
  
  /**
   * Set up the audio source buffer in the shared MediaSource
   * This is called from either setupAudioPlayback or the video MediaSource sourceopen handler
   */
  private setupAudioSourceBuffer(): void {
    if (!this.audioTrack) {
      this.logger.error('[AudioSourceBuffer] No audio track available for setup');
      return;
    }
    
    if (!this.sharedMediaSource) {
      this.logger.error('[AudioSourceBuffer] Shared MediaSource not initialized');
      return;
    }
    
    if (this.sharedMediaSource.readyState !== 'open') {
      this.logger.error(`[AudioSourceBuffer] Cannot add audio source buffer - MediaSource is in state: ${this.sharedMediaSource.readyState}`);
      return;
    }
    
    if (this.audioSourceBuffer) {
      this.logger.warn('[AudioSourceBuffer] Audio source buffer already initialized');
      return;
    }
    
    // Create audio source buffer
    const audioMimeType = `audio/mp4; codecs="${this.audioTrack.codec || 'mp4a.40.2'}"`;
    this.logger.info(`[AudioSourceBuffer] Using audio mimeType: ${audioMimeType}`);
    
    try {
      this.audioSourceBuffer = this.sharedMediaSource.addSourceBuffer(audioMimeType);
      this.logger.info('[AudioSourceBuffer] Created successfully');
    } catch (e) {
      this.logger.error(`[AudioSourceBuffer] Could not add audio source buffer: ${e}`);
      return;
    }
    
    // Set up event listeners for audio source buffer
    this.audioSourceBuffer.addEventListener('error', (e) => {
      this.logger.error(`[AudioSourceBuffer] ERROR: ${e}`);
    });
    
    this.audioSourceBuffer.addEventListener('abort', () => {
      this.logger.error('[AudioSourceBuffer] ABORT event');
    });
    
    this.audioSourceBuffer.addEventListener('update', () => {
      // Update event handler - intentionally empty as we only need to track updateend
    });
    
    this.audioSourceBuffer.addEventListener('updateend', () => {
      try {
        const ranges = [];
        for (let i = 0; i < (this.audioSourceBuffer?.buffered.length || 0); i++) {
          ranges.push(`[${this.audioSourceBuffer?.buffered.start(i).toFixed(2) || '?'} - ${this.audioSourceBuffer?.buffered.end(i).toFixed(2) || '?'}]`);
        }
        this.logger.debug(`[AudioSourceBuffer] Buffered ranges: ${ranges.join(', ')}`);
      } catch (e) {
        this.logger.error(`[AudioSourceBuffer] Error reading buffered ranges: ${e}`);
      }
    });
    
    // Set the audio source buffer in the media segment buffer
    if (!this.audioMediaSegmentBuffer) {
      this.logger.error('[AudioSourceBuffer] Audio media segment buffer not initialized');
      return;
    }
    
    this.audioMediaSegmentBuffer.setSourceBuffer(this.audioSourceBuffer);
    
    // Process audio init segment if available
    if (!this.audioTrack.initData) {
      this.logger.error('[AudioInitSegment] No initData found for audio track');
      return;
    }
    
    try {
      const audioInitSegment = this.base64ToArrayBuffer(this.audioTrack.initData);
      this.logger.info(`[AudioInitSegment] Decoded init segment: ${audioInitSegment.byteLength} bytes`);
      
      if (!this.audioMediaBuffer) {
        this.logger.info('[AudioMediaBuffer] Audio media buffer not initialized');
        return;
      }
      
      // Parse the init segment to get timing info
      const audioTrackInfo = this.audioMediaBuffer.parseInitSegment(audioInitSegment);
      this.logger.info(`[AudioMediaBuffer] Parsed init segment, timescale: ${audioTrackInfo.timescale}`);
      
      // Add to MediaSegmentBuffer and process
      const audioInitSegmentObj = this.audioMediaSegmentBuffer.addInitSegment(audioInitSegment);
      this.audioMediaSegmentBuffer.appendToSourceBuffer(audioInitSegmentObj);
      
      this.logger.info('[AudioInitSegment] Added audio CMAF init segment to MediaSegmentBuffer and SourceBuffer');
      
      // Subscribe to the audio track now that we're ready to receive data
      this.subscribeToAudioTrack();
    } catch (e) {
      this.logger.error(`[AudioInitSegment] Failed to process audio CMAF init segment: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Subscribe to the audio track
   * This is called once the audio source buffer is set up and ready
   */
  private subscribeToAudioTrack(): void {
    if (!this.audioTrack) {
      this.logger.error('[AudioTrackSubscription] No audio track to subscribe to');
      return;
    }
    
    const namespace = this.audioTrack.namespace || '';
    const trackName = this.audioTrack.name;
    const trackKey = `${namespace}/${trackName}`;
    
    this.logger.info(`[AudioTrackSubscription] Subscribing to audio track: ${trackKey}`);
    
    if (!this.client) {
      this.logger.error('[AudioTrackSubscription] Client not initialized');
      return;
    }
    
    // Define callback function for handling audio objects
    const onAudioObject = (obj: { data: ArrayBuffer, timing?: { baseMediaDecodeTime?: number, timescale?: number } }) => {
      try {
        // Check if we have a valid data object
        if (!obj.data) {
          this.logger.error('[AudioMediaBuffer] Received null or undefined data');
          return;
        }
        
        let arrayBuffer: ArrayBuffer;
        
        // If it's already an ArrayBuffer, use it directly
        if (obj.data instanceof ArrayBuffer) {
          arrayBuffer = obj.data;
        }
        // If it's a TypedArray (like Uint8Array), get its buffer
        else if (ArrayBuffer.isView(obj.data)) {
          // Use type assertion to tell TypeScript that this is a TypedArray with a buffer property
          const typedArray = obj.data as Uint8Array;
          
          // Check if this is a view with an offset into a larger buffer
          if (typedArray.byteOffset > 0 || typedArray.byteLength < typedArray.buffer.byteLength) {
            // Create a new ArrayBuffer that contains only the data in this view
            arrayBuffer = typedArray.buffer.slice(typedArray.byteOffset, typedArray.byteOffset + typedArray.byteLength);
          } else {
            // Use the buffer directly if it's the full buffer
            arrayBuffer = typedArray.buffer;
          }
          
          // Replace the original data with the ArrayBuffer for downstream processing
          obj.data = arrayBuffer;
        }
        // Otherwise, it's an invalid type
        else {
          const type = typeof obj.data;
          let constructorName = 'unknown';
          try {
            // Safe way to access constructor name
            if (typeof obj.data === 'object') {
              const dataObj: any = obj.data; // Cast to any to bypass TypeScript error
              if (dataObj.constructor) {
                constructorName = dataObj.constructor.name;
              }
            }
          } catch (e) {
            // Ignore any errors when trying to access constructor
          }
          this.logger.info(`[AudioMediaBuffer] Received invalid data type: ${type} (${constructorName})`);
          return;
        }
        
        // Check if the ArrayBuffer is empty
        if (arrayBuffer.byteLength === 0) {
          this.logger.warn('[AudioMediaBuffer] Received empty ArrayBuffer (zero bytes)');
          return;
        }

        // Make sure audio buffers are initialized
        if (!this.audioMediaBuffer || !this.audioMediaSegmentBuffer) {
          this.logger.error('[AudioMediaBuffer] Audio buffers not initialized');
          return;
        }

        // Parse the media segment to extract timing information
        const trackInfo = this.audioMediaBuffer.parseMediaSegment(obj.data);
        
        // Add timing information to the object
        obj.timing = {
          baseMediaDecodeTime: trackInfo.baseMediaDecodeTime,
          timescale: trackInfo.timescale
        };
        
        // Add the media segment to the media segment buffer and get the segment object
        const mediaSegment = this.audioMediaSegmentBuffer.addMediaSegment(obj.data);
        
        // Append the segment to the source buffer via mediaSegmentBuffer
        this.audioMediaSegmentBuffer.appendToSourceBuffer(mediaSegment);
        
        // Track the number of audio objects received
        this.audioObjectsReceived++;
        
        // Log timing information periodically (not for every segment to avoid too much logging)
        if (Math.random() < 0.1) { // Log approximately 10% of segments
          this.logger.debug(`[AudioMediaBuffer] Processed segment with baseMediaDecodeTime: ${trackInfo.baseMediaDecodeTime}, timescale: ${trackInfo.timescale}`);
          
          // If we have both audio and video buffers, log their states
          if (this.videoMediaSegmentBuffer && this.audioMediaSegmentBuffer) {
            const videoDuration = this.videoMediaSegmentBuffer.getBufferDuration();
            const audioDuration = this.audioMediaSegmentBuffer.getBufferDuration();
            this.logger.debug(`[Buffer] Video duration: ${videoDuration.toFixed(2)}s, Audio duration: ${audioDuration.toFixed(2)}s, Objects - Video: ${this.videoObjectsReceived}, Audio: ${this.audioObjectsReceived}`);
          }
        }
        
        // Check if we have enough buffer duration to mark the buffer as ready
        if (!this.audioBufferReady && this.audioMediaSegmentBuffer) {
          const bufferDurationSec = this.audioMediaSegmentBuffer.getBufferDuration();
          const bufferDurationMs = bufferDurationSec * 1000;
          
          if (bufferDurationMs >= this.targetBufferDurationMs) {
            this.audioBufferReady = true;
            this.logger.debug(`[Audio] Buffer ready with ${bufferDurationMs.toFixed(0)}ms duration (${this.audioObjectsReceived} objects), target: ${this.targetBufferDurationMs}ms`);
            
            // Check if we can start playback (depends on video buffer state too)
            this.checkBuffersAndStartPlayback();
          }
        }
      } catch (e) {
        this.logger.error(`[AudioMediaBuffer] Error processing audio segment: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    
    // Subscribe to the track and store the subscription
    this.client.subscribeTrack(namespace, trackName, onAudioObject)
      .then((trackAlias) => {
        this.trackSubscriptions.set(trackKey, trackAlias);
        this.logger.info(`[AudioTrackSubscription] Successfully subscribed to audio track ${trackKey} with alias ${trackAlias}`);
      })
      .catch((error) => {
        this.logger.error(`[AudioTrackSubscription] Error subscribing to audio track ${trackKey}: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  /**
   * Check if buffers are ready and start synchronized playback if they are
   * This is called from both audio and video segment processing
   */
  private checkBuffersAndStartPlayback(): void {
    // If playback has already started, we don't need to do anything
    if (this.playbackStarted) {
      return;
    }
    
    const videoEl = document.getElementById('videoPlayer') as HTMLVideoElement;
    if (!videoEl) {
      this.logger.error('[Sync] Video element not found');
      return;
    }
    
    // Check for case where only video track is available (no audio)
    if (!this.audioTrack && this.videoBufferReady) {
      this.logger.info('[Sync] Only video track available, starting playback');
      this.startVideoOnlyPlayback(videoEl);
      return;
    }
    
    // Check for case where only audio track is available (no video)
    if (!this.videoTrack && this.audioBufferReady) {
      this.logger.info('[Sync] Only audio track available, starting playback');
      this.startAudioOnlyPlayback(videoEl);
      return;
    }
    
    // If both tracks are available, we need both buffers to be ready
    if (this.videoBufferReady && this.audioBufferReady) {
      this.logger.info('[Sync] Both audio and video buffers are ready, starting synchronized playback');
      this.startSynchronizedPlayback(videoEl);
    }
    else {
      // Log the buffer status
      this.logger.warn(`[Sync] Buffers not ready yet - Video: ${this.videoBufferReady ? 'Ready' : 'Not ready'}, Audio: ${this.audioBufferReady ? 'Ready' : 'Not ready'}`);
      
      if (this.videoMediaSegmentBuffer && this.audioMediaSegmentBuffer) {
        const videoDuration = this.videoMediaSegmentBuffer.getBufferDuration();
        const audioDuration = this.audioMediaSegmentBuffer.getBufferDuration();
        const videoMs = videoDuration * 1000;
        const audioMs = audioDuration * 1000;
        this.logger.info(`[Sync] Buffer duration - Video: ${videoDuration.toFixed(2)}s (${videoMs.toFixed(0)}ms), Audio: ${audioDuration.toFixed(2)}s (${audioMs.toFixed(0)}ms), Target: ${this.targetBufferDurationMs}ms`);
      }
    }
  }
  
  /**
   * Start playback with only a video track
   */
  private startVideoOnlyPlayback(videoEl: HTMLVideoElement): void {
    if (!this.videoSourceBuffer) {
      this.logger.error('[Sync] Video source buffer not initialized');
      return;
    }
    
    if (this.videoSourceBuffer.buffered.length === 0) {
      this.logger.error('[Sync] Video buffer is empty, cannot start playback');
      return;
    }
    
    // Set the current time to the start of the buffer
    videoEl.currentTime = this.videoSourceBuffer.buffered.start(0);
    
    // Start playback
    videoEl.play()
      .then(() => {
        this.playbackStarted = true;
        this.logger.info('[Sync] Video-only playback started successfully');
      })
      .catch((e) => {
        this.logger.error(`[Sync] Error starting video-only playback: ${e}`);
      });
  }
  
  /**
   * Start playback with only an audio track
   */
  private startAudioOnlyPlayback(videoEl: HTMLVideoElement): void {
    if (!this.audioSourceBuffer) {
      this.logger.error('[Sync] Audio source buffer not initialized');
      return;
    }
    
    if (this.audioSourceBuffer.buffered.length === 0) {
      this.logger.error('[Sync] Audio buffer is empty, cannot start playback');
      return;
    }
    
    // Set the current time to the start of the buffer
    videoEl.currentTime = this.audioSourceBuffer.buffered.start(0);
    
    // Start playback
    videoEl.play()
      .then(() => {
        this.playbackStarted = true;
        this.logger.info('[Sync] Audio-only playback started successfully');
      })
      .catch((e) => {
        this.logger.error(`[Sync] Error starting audio-only playback: ${e}`);
      });
  }
  
  /**
   * Start synchronized playback of audio and video
   */
  private startSynchronizedPlayback(videoEl: HTMLVideoElement): void {
    if (!this.videoSourceBuffer || !this.audioSourceBuffer) {
      this.logger.error('[Sync] Source buffers not initialized');
      return;
    }
    
    if (this.videoSourceBuffer.buffered.length === 0 || this.audioSourceBuffer.buffered.length === 0) {
      this.logger.error('[Sync] One or both buffers are empty, cannot start playback');
      return;
    }
    
    try {
      // Find common buffered range
      const videoStart = this.videoSourceBuffer.buffered.start(0);
      const videoEnd = this.videoSourceBuffer.buffered.end(this.videoSourceBuffer.buffered.length - 1);
      const audioStart = this.audioSourceBuffer.buffered.start(0);
      const audioEnd = this.audioSourceBuffer.buffered.end(this.audioSourceBuffer.buffered.length - 1);
      
      // Get the latest start time and earliest end time
      const commonStart = Math.max(videoStart, audioStart);
      const commonEnd = Math.min(videoEnd, audioEnd);
      
      if (commonStart >= commonEnd) {
        this.logger.error(`[Sync] No common buffered range - Video: [${videoStart.toFixed(2)}-${videoEnd.toFixed(2)}], Audio: [${audioStart.toFixed(2)}-${audioEnd.toFixed(2)}]`);
        return;
      }
      
      this.logger.info(`[Sync] Common buffered range: [${commonStart.toFixed(2)}-${commonEnd.toFixed(2)}]`);
      
      // Set the current time to the common start plus a small offset
      // This ensures we have some buffer ahead and avoids potential timing issues
      const startOffset = 0.1; // 100ms offset from the start
      const playbackStartTime = commonStart + startOffset;
      
      // Make sure we don't exceed the common end
      if (playbackStartTime >= commonEnd) {
        this.logger.error(`[Sync] Start position (${playbackStartTime.toFixed(2)}) exceeds common range end (${commonEnd.toFixed(2)})`);
        return;
      }
      
      // Set up error handling
      videoEl.addEventListener('error', this.handleVideoElementError.bind(this));
      
      // Add event listener for stalled events
      videoEl.addEventListener('stalled', () => {
        this.logger.warn('[Playback] Stalled event detected');
        this.playbackStalled = true;
        this.recoverFromBufferUnderrun();
      });
      
      // Add event listener for waiting events
      videoEl.addEventListener('waiting', () => {
        this.logger.warn('[Playback] Waiting for data');
        // No immediate recovery action for waiting, just log
      });
      
      // Add event listener for monitoring synchronization
      videoEl.addEventListener('timeupdate', this.monitorSync.bind(this));
      
      // Set the current time and start playback
      videoEl.currentTime = playbackStartTime;
      
      // Start playback
      videoEl.play()
        .then(() => {
          this.playbackStarted = true;
          this.logger.info(`[Sync] Synchronized playback started at ${playbackStartTime.toFixed(2)}s`);
        })
        .catch((e) => {
          this.logger.error(`[Sync] Error starting synchronized playback: ${e}`);
          // Attempt generic recovery since play() failed
          this.attemptGenericRecovery();
        });
    } catch (e) {
      this.logger.error(`[Sync] Error setting up synchronized playback: ${e}`);
    }
  }
  
  /**
   * Monitor and maintain audio-video synchronization
   */
  private monitorSync(): void {
    // Always update the UI indicators every time this function is called
    this.updateBufferLevelUI();
    
    // For the sync logic, don't execute too frequently to avoid excessive processing
    if (Math.random() > 0.05) { // Only execute about 5% of the time
      return;
    }
    
    const videoEl = document.getElementById('videoPlayer') as HTMLVideoElement;
    if (!videoEl) {
      return;
    }
    
    try {
      // Check if we have buffered data for both tracks at the current position
      const currentTime = videoEl.currentTime;
      let videoBufferAhead = 0;
      let audioBufferAhead = 0;
      
      // Find how much buffer we have ahead of the current position
      if (this.videoSourceBuffer) {
        for (let i = 0; i < this.videoSourceBuffer.buffered.length; i++) {
          if (currentTime >= this.videoSourceBuffer.buffered.start(i) && 
              currentTime < this.videoSourceBuffer.buffered.end(i)) {
            videoBufferAhead = this.videoSourceBuffer.buffered.end(i) - currentTime;
            break;
          }
        }
      }
      
      if (this.audioSourceBuffer) {
        for (let i = 0; i < this.audioSourceBuffer.buffered.length; i++) {
          if (currentTime >= this.audioSourceBuffer.buffered.start(i) && 
              currentTime < this.audioSourceBuffer.buffered.end(i)) {
            audioBufferAhead = this.audioSourceBuffer.buffered.end(i) - currentTime;
            break;
          }
        }
      }
      
      // Store buffer levels for UI updating
      this.lastVideoBufferAhead = videoBufferAhead;
      this.lastAudioBufferAhead = audioBufferAhead;
      
      // Log buffer ahead information (but not too frequently)
      if (Math.random() < 0.2) { // Only log about 20% of the time within that 5% sample
        this.logger.info(`[Sync] Buffer ahead - Video: ${videoBufferAhead.toFixed(2)}s, Audio: ${audioBufferAhead.toFixed(2)}s`);
      }
      
      // Check buffer health and attempt recovery if needed
      this.checkBufferHealth(videoBufferAhead, audioBufferAhead);
      
      // Only perform sync adjustment if both audio and video are active
      if (this.videoSourceBuffer && this.audioSourceBuffer) {
        // Simple playback rate adjustment based on buffer difference
        // This helps compensate for the slightly fluctuating audio segment durations
        const bufferDifference = Math.abs(videoBufferAhead - audioBufferAhead);
        const normalPlaybackRate = 1.0;
        const maxAdjustment = 0.1; // Maximum 10% speed adjustment
        
        if (bufferDifference > 0.5) { // If buffers are more than 500ms apart
          // Adjust playback rate to help synchronize
          if (videoBufferAhead > audioBufferAhead) {
            // Video is ahead, slow down slightly
            const newRate = Math.max(normalPlaybackRate - maxAdjustment, 0.9);
            if (videoEl.playbackRate !== newRate) {
              videoEl.playbackRate = newRate;
              this.logger.info(`[Sync] Slowing down playback to ${newRate.toFixed(2)}x to help sync`);
            }
          } else {
            // Audio is ahead, speed up slightly
            const newRate = Math.min(normalPlaybackRate + maxAdjustment, 1.1);
            if (videoEl.playbackRate !== newRate) {
              videoEl.playbackRate = newRate;
              this.logger.info(`[Sync] Speeding up playback to ${newRate.toFixed(2)}x to help sync`);
            }
          }
        } else {
          // Buffers are close enough, use normal playback rate
          if (videoEl.playbackRate !== normalPlaybackRate && !this.playbackStalled) {
            videoEl.playbackRate = normalPlaybackRate;
            this.logger.info(`[Sync] Restored normal playback rate`);
          }
        }
      }
    } catch (e) {
      this.logger.error(`[Sync] Error monitoring synchronization: ${e}`);
    }
  }
  
  // Track buffer levels for UI display
  private lastVideoBufferAhead: number = 0;
  private lastAudioBufferAhead: number = 0;
  private lastUpdateTime: number = 0;
  
  /**
   * Update the buffer level and playback latency UI elements
   */
  private updateBufferLevelUI(): void {
    const now = Date.now();
    
    // Only update the UI about twice per second
    if (now - this.lastUpdateTime < 500) {
      return;
    }
    
    this.lastUpdateTime = now;
    
    // Get video element
    const videoEl = document.getElementById('videoPlayer') as HTMLVideoElement;
    if (!videoEl) {
      return;
    }
    
    try {
      // Convert target buffer from ms to seconds for comparison
      const targetBufferMs = this.targetBufferDurationMs;
      
      // Update video buffer level display
      const videoBufferEl = document.getElementById('videoBufferLevel');
      if (videoBufferEl) {
        const videoBufferMs = Math.round(this.lastVideoBufferAhead * 1000);
        videoBufferEl.textContent = this.videoSourceBuffer ? `${videoBufferMs} ms` : 'N/A';
        
        // Add color coding based on comparison to target buffer
        // Red if more than 50% above or 25% below the target value
        if (this.videoSourceBuffer) {
          const bufferRatio = videoBufferMs / targetBufferMs;
          
          if (bufferRatio > 1.5 || bufferRatio < 0.75) {
            videoBufferEl.style.backgroundColor = '#ffebee'; // Light red for out of optimal range
          } else {
            videoBufferEl.style.backgroundColor = '#e3f2fd'; // Default blue for good buffer
          }
        } else {
          videoBufferEl.style.backgroundColor = '#f5f5f5'; // Gray for inactive
        }
      }
      
      // Update audio buffer level display
      const audioBufferEl = document.getElementById('audioBufferLevel');
      if (audioBufferEl) {
        const audioBufferMs = Math.round(this.lastAudioBufferAhead * 1000);
        audioBufferEl.textContent = this.audioSourceBuffer ? `${audioBufferMs} ms` : 'N/A';
        
        // Add color coding based on comparison to target buffer
        // Red if more than 50% above or 25% below the target value
        if (this.audioSourceBuffer) {
          const bufferRatio = audioBufferMs / targetBufferMs;
          
          if (bufferRatio > 1.5 || bufferRatio < 0.75) {
            audioBufferEl.style.backgroundColor = '#ffebee'; // Light red for out of optimal range
          } else {
            audioBufferEl.style.backgroundColor = '#e8f5e9'; // Default green for good buffer
          }
        } else {
          audioBufferEl.style.backgroundColor = '#f5f5f5'; // Gray for inactive
        }
      }
      
      // Calculate and update playback latency
      const playbackLatencyEl = document.getElementById('playbackLatency');
      if (playbackLatencyEl) {
        if (this.playbackStarted) {
        // Calculate playback latency (now - videoEl.currentTime)
        // Latency is the difference between wall clock time and playback time
        // This is always positive in our real-time streaming scenario
        if (videoEl) {
          // Calculate estimated latency in milliseconds given that the media time
          // is synchronized with UTC time
          const latencyMs = Math.round(now - videoEl.currentTime*1000);
          playbackLatencyEl.textContent = `${latencyMs} ms`;
          
          // No variable coloring for latency since we don't know transport latency
          playbackLatencyEl.style.backgroundColor = '#fff3e0'; // Default orange background
        }
      } else {
          playbackLatencyEl.textContent = 'N/A';
          playbackLatencyEl.style.backgroundColor = '#f5f5f5'; // Gray for inactive
        }
      }
    } catch (e) {
      this.logger.error(`[UI] Error updating buffer level UI: ${e}`);
    }
  }

  /**
   * Format bitrate in a human-readable format
   * @param bitrate The bitrate in bits per second
   * @returns Formatted bitrate string
   */
  private formatBitrate(bitrate: number): string {
    if (bitrate >= 1000000) {
      return `${(bitrate / 1000000).toFixed(2)} Mbps`;
    } else if (bitrate >= 1000) {
      return `${(bitrate / 1000).toFixed(2)} kbps`;
    } else {
      return `${bitrate} bps`;
    }
  }
}
