import {
  isWidevineSupported,
  isPlayreadySupported,
  isFairplaySupported,
} from "@eyevinn/is-drm-supported";

import { MediaBuffer, MediaSegmentBuffer } from "./buffer";
import { ILogger, LoggerFactory } from "./logger";
import { EngineChoice, IPlaybackPipeline, resolveEngine } from "./pipeline";
import { MsePipeline } from "./pipeline/msePipeline";
import { WebCodecsLocPipeline } from "./pipeline/webcodecsLocPipeline";
import { Client, DraftVersion } from "./transport/client";
import { MOQObject } from "./transport/tracks";
import {
  WarpCatalog,
  WarpTrack,
  WarpCatalogManager,
  ContentProtection,
  DRMSystem,
} from "./warpcatalog";

/**
 * Player class for handling MOQ transport connections, MSF/CMSF track subscriptions, and UI updates.
 * Conforms to draft-ietf-moq-msf-00 and draft-ietf-moq-cmsf-00.
 */
export class Player {
  private client: Client | null = null;
  private connection: any = null;
  private serverUrl: string;
  private fingerprintUrl?: string;
  private catalogManager: WarpCatalogManager;
  private unregisterCatalogCallback: (() => void) | null = null;
  private unregisterPublishNamespaceCallback: (() => void) | null = null;
  private publishedNamespaces: string[][] = [];
  private selectedNamespace: string[] | null = null;
  private clearKeySupported: boolean | null = null;
  private tracksContainerEl: HTMLElement;
  private statusEl: HTMLElement;
  private publishedNamespacesEl: HTMLElement | null = null;
  private logger: ILogger;
  private trackSubscriptions: Map<string, bigint> = new Map(); // Track name -> trackAlias
  private isDisconnecting: boolean = false; // Flag to prevent recursive disconnect calls
  private onConnectionStateChange: ((connected: boolean) => void) | null = null;
  private draftVersion: DraftVersion = "auto";

  // MSE state lives on MsePipeline; the getters/setters below keep
  // existing call-sites in this file unchanged while the source of truth
  // moves out. Future phases will replace direct delegate access with
  // explicit MsePipeline method calls (attachToVideoElement, etc.).
  private msePipeline!: MsePipeline;

  private get sharedMediaSource(): MediaSource | ManagedMediaSource | null {
    return this.msePipeline.sharedMediaSource;
  }
  private set sharedMediaSource(v: MediaSource | ManagedMediaSource | null) {
    this.msePipeline.sharedMediaSource = v;
  }
  private get usingManagedMediaSource(): boolean {
    return this.msePipeline.usingManagedMediaSource;
  }
  private set usingManagedMediaSource(v: boolean) {
    this.msePipeline.usingManagedMediaSource = v;
  }
  private get videoSourceBuffer(): SourceBuffer | null {
    return this.msePipeline.videoSourceBuffer;
  }
  private set videoSourceBuffer(v: SourceBuffer | null) {
    this.msePipeline.videoSourceBuffer = v;
  }
  private get audioSourceBuffer(): SourceBuffer | null {
    return this.msePipeline.audioSourceBuffer;
  }
  private set audioSourceBuffer(v: SourceBuffer | null) {
    this.msePipeline.audioSourceBuffer = v;
  }
  private get videoMediaSegmentBuffer(): MediaSegmentBuffer | null {
    return this.msePipeline.videoMediaSegmentBuffer;
  }
  private set videoMediaSegmentBuffer(v: MediaSegmentBuffer | null) {
    this.msePipeline.videoMediaSegmentBuffer = v;
  }
  private get audioMediaSegmentBuffer(): MediaSegmentBuffer | null {
    return this.msePipeline.audioMediaSegmentBuffer;
  }
  private set audioMediaSegmentBuffer(v: MediaSegmentBuffer | null) {
    this.msePipeline.audioMediaSegmentBuffer = v;
  }
  private get videoMediaBuffer(): MediaBuffer | null {
    return this.msePipeline.videoMediaBuffer;
  }
  private set videoMediaBuffer(v: MediaBuffer | null) {
    this.msePipeline.videoMediaBuffer = v;
  }
  private get audioMediaBuffer(): MediaBuffer | null {
    return this.msePipeline.audioMediaBuffer;
  }
  private set audioMediaBuffer(v: MediaBuffer | null) {
    this.msePipeline.audioMediaBuffer = v;
  }

  private videoTrack: WarpTrack | null = null;
  private audioTrack: WarpTrack | null = null;

  /** Active WebCodecs pipeline when LOC playback is engaged. */
  private webcodecsPipeline: WebCodecsLocPipeline | null = null;
  /**
   * Display label for the DRM system negotiated for the current playback.
   * One of "Widevine" | "PlayReady" | "FairPlay" | "ClearKey", or null when
   * the session is clear. Surfaced in the engine-legend overlay.
   */
  private activeDrmLabel: string | null = null;
  /** Timer feeding the metric panels while the WebCodecs pipeline is active. */
  private webcodecsMetricsTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Pipeline currently driving the metric panels — points at msePipeline for
   * MSE/CMAF sessions and webcodecsPipeline for LOC sessions. Both implement
   * IPlaybackPipeline.getLatencySnapshot()/getPlaybackRate(), so the UI is
   * engine-agnostic.
   */
  private currentPipeline: IPlaybackPipeline | null = null;

  /**
   * Re-render the Mute/Unmute button label from currentPipeline.getMuted().
   * Assigned by wireMuteButton(); call after every currentPipeline change so
   * the label reflects the active engine, not the previous one. Null until
   * the button has been wired (the user can change currentPipeline before
   * the tracks UI is built, e.g. on disconnect, so callers must guard).
   */
  private refreshMuteLabel: (() => void) | null = null;

  // Synchronization state
  private videoBufferReady = false;
  private audioBufferReady = false;
  private playbackStarted = false;
  private videoObjectsReceived = 0;
  private audioObjectsReceived = 0;
  private minimalBufferMs = 200; // Minimal buffer threshold in milliseconds
  private targetLatencyMs = 300; // Target latency in milliseconds
  private minBufferLevel: number = Infinity; // Track minimum buffer level between segments
  private lastSegmentAppendTime: number = 0; // Track when we last appended a segment

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

  //DRM information
  private widevine = "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed";
  private playready = "9a04f079-9840-4286-ab92-e65be0885f95";
  private fairplay = "94ce86fb-07ff-4f43-adb8-93d2fa968ca2";
  private clearkey = "1077efec-c0b2-4d02-ace3-3c1e52e2fb4b";
  private drmSystems: Record<string, string> = {
    [this.widevine]: "widevine",
    [this.playready]: "playready",
    [this.fairplay]: "fairplay",
    [this.clearkey]: "clearkey",
  };
  private keySystems: Record<string, string> = {
    [this.widevine]: "com.widevine.alpha",
    [this.playready]: "com.microsoft.playready",
    [this.fairplay]: "com.apple.fps",
    [this.clearkey]: "org.w3.clearkey",
  };

  /**
   * Create a new Player instance
   * @param serverUrl The URL of the MOQ server
   * @param tracksContainerEl The HTML element to display tracks in
   * @param statusEl The HTML element to display connection status
   * @param uiLogger Optional function to log messages to the UI
   * @param fingerprintUrl Optional URL to fetch certificate fingerprint for self-signed certificates
   */
  constructor(
    serverUrl: string,
    tracksContainerEl: HTMLElement,
    statusEl: HTMLElement,
    _uiLogger?: (
      message: string,
      type?: "info" | "success" | "error" | "warn",
    ) => void,
    fingerprintUrl?: string,
    draftVersion?: DraftVersion,
  ) {
    this.serverUrl = serverUrl;
    this.fingerprintUrl = fingerprintUrl;
    this.draftVersion = draftVersion || "auto";
    this.tracksContainerEl = tracksContainerEl;
    this.statusEl = statusEl;
    // Get logger for Player component
    this.logger = LoggerFactory.getInstance().getLogger("Player");

    // MSE state owner. Created up front so getter delegates always have a
    // target; dispose() returns it to a clean state on disconnect.
    this.msePipeline = new MsePipeline(this.logger);

    // Log initialization
    this.logger.info("Player initialized");

    // Initialize the catalog manager with its own logger
    this.catalogManager = new WarpCatalogManager();

    // Set up catalog callback to process tracks when catalog is received
    this.catalogManager.setCatalogCallback((catalog) =>
      this.processWarpCatalog(catalog),
    );

    // Create published namespaces section
    this.createPublishedNamespacesSection();

    // When the user changes the render-engine choice, re-render the
    // namespace picker so incompatible namespaces dim out.
    const engineSelect = document.getElementById(
      "engineChoice",
    ) as HTMLSelectElement | null;
    if (engineSelect) {
      engineSelect.addEventListener("change", () => {
        this.renderNamespaceSelector();
        this.ensureSelectableNamespace();
      });
    }
  }

  /**
   * After an engine-choice change, if the currently selected namespace is
   * no longer selectable, switch to the first one that is. Keeps the
   * current selection when it remains compatible.
   */
  private ensureSelectableNamespace(): void {
    const choice = this.currentEngineChoice();
    if (
      this.selectedNamespace &&
      this.isNamespaceSelectable(this.selectedNamespace, choice)
    ) {
      return;
    }
    const next = this.publishedNamespaces.find((ns) =>
      this.isNamespaceSelectable(ns, choice),
    );
    if (next) {
      this.selectNamespace(next);
    }
  }

  /**
   * True when a namespace is a media namespace, the user's render-engine
   * choice can play it, and (if it's a ClearKey/ECCP namespace) the
   * browser actually supports ClearKey. Used by both the namespace
   * selector renderer and the auto-select-on-engine-change logic.
   */
  private isNamespaceSelectable(
    namespace: string[],
    engineChoice: EngineChoice,
  ): boolean {
    if (this.isNonMediaNamespace(namespace)) {
      return false;
    }
    const joined = namespace.join("/");
    if (joined.includes("/eccp-") && !this.clearKeySupported) {
      return false;
    }
    return this.namespaceMatchesEngineChoice(namespace, engineChoice);
  }

  /**
   * Set the buffer control parameters
   * @param minimalBufferMs Minimal buffer level in milliseconds
   * @param targetLatencyMs Target latency in milliseconds
   */
  public setBufferParameters(
    minimalBufferMs: number,
    targetLatencyMs: number,
  ): void {
    if (targetLatencyMs <= minimalBufferMs) {
      this.logger.warn(
        `Target latency (${targetLatencyMs}ms) must be greater than minimal buffer (${minimalBufferMs}ms). Ignoring.`,
      );
      return;
    }

    const oldMinBuffer = this.minimalBufferMs;
    const oldTargetLatency = this.targetLatencyMs;

    this.minimalBufferMs = minimalBufferMs;
    this.targetLatencyMs = targetLatencyMs;

    this.logger.info(
      `Buffer parameters changed - Minimal buffer: ${oldMinBuffer}ms → ${minimalBufferMs}ms, Target latency: ${oldTargetLatency}ms → ${targetLatencyMs}ms`,
    );
  }

  /**
   * Set a callback to be notified when connection state changes
   * @param callback Function called with true when connected, false when disconnected
   */
  public setConnectionStateCallback(
    callback: (connected: boolean) => void,
  ): void {
    this.onConnectionStateChange = callback;
  }

  /**
   * Connect to the MOQ server
   */
  async connect(): Promise<void> {
    if (!this.serverUrl) {
      this.logger.error("Please enter a server URL");
      return;
    }

    try {
      // Reset the disconnecting flag
      this.isDisconnecting = false;

      // Create and connect the client
      this.client = new Client({
        url: this.serverUrl,
        fingerprint: this.fingerprintUrl,
        draftVersion: this.draftVersion,
      });

      this.connection = await this.client.connect();

      // Update status with negotiated version
      const versionStr =
        this.client.negotiatedVersion === 0xff000010 ? "draft-16" : "draft-14";
      this.statusEl.className = "status connected";
      this.statusEl.innerHTML = `<span>●</span> Connected (${versionStr})`;

      this.logger.info("Connected to MOQ server successfully!");

      // Notify connection state change
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(true);
      }

      // ClearKey is not supported in Safari
      this.clearKeySupported = !this.isSafari();
      this.logger.info(`ClearKey supported: ${this.clearKeySupported}`);

      // Create the published namespaces section
      this.createPublishedNamespacesSection();

      // Listen for published namespaces - catalog subscription will happen after namespace is received
      this.listenForPublishedNamespaces();

      this.logger.info("Waiting for published namespaces...");

      // Handle connection closure
      this.connection
        .closed()
        .then((error: Error) => {
          this.logger.info(`Connection closed: ${error.message}`);
          this.disconnect();
        })
        .catch((error: Error) => {
          this.logger.error(`Connection error: ${error.message}`);
          this.disconnect();
        });
    } catch (error) {
      this.logger.error(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.disconnect();
    }
  }

  /**
   * Disconnect from the MOQ server
   */
  disconnect(): void {
    // Prevent recursive calls
    if (this.isDisconnecting) {
      this.logger.debug("Already disconnecting, skipping duplicate call");
      return;
    }

    // Set the flag immediately to prevent any callbacks from trying to use the connection
    this.isDisconnecting = true;
    this.logger.info("Starting disconnect process...");

    // Unregister catalog callback if registered
    if (this.unregisterCatalogCallback) {
      this.unregisterCatalogCallback();
      this.unregisterCatalogCallback = null;
    }

    // Unregister publish namespace callback if registered
    if (this.unregisterPublishNamespaceCallback) {
      this.unregisterPublishNamespaceCallback();
      this.unregisterPublishNamespaceCallback = null;
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
      this.logger.info("Disconnecting from server...");

      // Store references before clearing
      const connection = this.connection;

      // Clear references first to prevent re-entry
      this.connection = null;
      this.client = null;

      // Try to close the connection if it's not already closed
      try {
        connection.close();
      } catch (error) {
        // If there's an error closing, it's likely already closed
        this.logger.debug(
          "Connection already closed or error during close:",
          error,
        );
      }

      // Clear catalog data
      this.catalogManager.clearCatalog();

      // Update status
      this.statusEl.className = "status disconnected";
      this.statusEl.innerHTML = "<span>●</span> Disconnected";

      // Clear tracks display
      this.tracksContainerEl.innerHTML = "";

      // Hide and clear catalog view
      const catalogSection = document.getElementById("catalog-section");
      if (catalogSection) {
        catalogSection.style.display = "none";
      }
      const catalogJson = document.getElementById("catalogJson");
      if (catalogJson) {
        catalogJson.textContent = "";
      }

      // Remove the published namespaces section completely
      this.removePublishedNamespacesSection();
    }

    // Clear published namespaces
    this.publishedNamespaces = [];
    this.selectedNamespace = null;

    // Notify connection state change
    if (this.onConnectionStateChange) {
      this.onConnectionStateChange(false);
    }

    // Reset the flag
    this.isDisconnecting = false;
  }

  /**
   * Listen for published namespaces from the server
   */
  private async listenForPublishedNamespaces(): Promise<void> {
    if (!this.client) {
      this.logger.error(
        "Cannot listen for published namespaces: Not connected",
      );
      return;
    }

    try {
      this.logger.info("Listening for published namespaces...");

      // Make sure the published namespaces section exists
      if (!this.publishedNamespacesEl) {
        this.createPublishedNamespacesSection();
      }

      // Subscribe to published namespaces
      const unregister = this.client.registerPublishNamespaceCallback(
        (namespace: string[]) => {
          // Log that we received a published namespace for debugging
          this.logger.info(
            `Received publish namespace callback with namespace: ${namespace.join(
              "/",
            )}`,
          );

          // Check if we've already seen this namespace
          const namespaceStr = namespace.join("/");
          if (
            this.publishedNamespaces.some((ns) => ns.join("/") === namespaceStr)
          ) {
            this.logger.info(`Already processed namespace: ${namespaceStr}`);
            return;
          }

          // Store the namespace
          this.publishedNamespaces.push(namespace);

          // Re-render the namespace selector with all known namespaces
          this.renderNamespaceSelector();

          // Auto-select the first media namespace if none is selected yet
          // Skip non-media namespaces (e.g. moq-test/interop)
          if (
            this.selectedNamespace === null &&
            !this.isNonMediaNamespace(namespace)
          ) {
            this.selectNamespace(namespace);
          }
        },
      );

      // Save the unregister function
      this.unregisterPublishNamespaceCallback = unregister;

      // Log that we've registered the callback
      this.logger.info("Publish namespace listener registered successfully");
    } catch (error) {
      this.logger.error(
        `Error listening for published namespaces: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Known non-media namespace prefixes. These are surfaced in the namespace
   * picker as inert labels rather than selectable buttons because warp-player
   * has no playback path for them today: `moq-test` is the interop test
   * namespace, `moq-mi/*` carries moq-mi packaging which doesn't have a
   * pipeline implementation yet.
   */
  private static readonly NON_MEDIA_PREFIXES = ["moq-test", "moq-mi"];

  /** Read the current value of the render-engine dropdown, default "auto". */
  private currentEngineChoice(): EngineChoice {
    const sel = document.getElementById(
      "engineChoice",
    ) as HTMLSelectElement | null;
    const v = sel?.value ?? "auto";
    return v === "mse" || v === "webcodecs" ? v : "auto";
  }

  /**
   * Decide whether a published namespace is compatible with the user's
   * render-engine choice. mlmpub's namespace prefix encodes the packaging:
   *   cmsf/* -> CMAF (MSE)
   *   msf/*  -> LOC (WebCodecs)
   * For Auto we accept everything; for unknown prefixes we accept too,
   * since the wire doesn't otherwise tell us packaging until we subscribe
   * to the catalog.
   */
  private namespaceMatchesEngineChoice(
    namespace: string[],
    engineChoice: EngineChoice,
  ): boolean {
    if (engineChoice === "auto") {
      return true;
    }
    const joined = namespace.join("/");
    if (joined.startsWith("cmsf/")) {
      return engineChoice === "mse";
    }
    if (joined.startsWith("msf/")) {
      return engineChoice === "webcodecs";
    }
    return true;
  }

  private isNonMediaNamespace(namespace: string[]): boolean {
    // Namespaces arrive on the wire either as a real multi-element tuple
    // (e.g. ["moq-test", "interop"]) or as a single tuple element that
    // already contains slashes (e.g. ["moq-mi/clear"], the form mlmpub
    // emits for its content namespaces). Compare against the slash-joined
    // form so both shapes are recognised.
    const joined = namespace.join("/");
    return Player.NON_MEDIA_PREFIXES.some(
      (prefix) => joined === prefix || joined.startsWith(prefix + "/"),
    );
  }

  /**
   * Select a namespace: unsubscribe from previous catalog, clear tracks,
   * subscribe to the new namespace's catalog.
   */
  private selectNamespace(namespace: string[]): void {
    const namespaceStr = namespace.join("/");
    this.logger.info(`Selecting namespace: ${namespaceStr}`);

    // Unsubscribe from previous catalog if any
    if (this.unregisterCatalogCallback) {
      this.logger.info("Unsubscribing from previous catalog");
      this.unregisterCatalogCallback();
      this.unregisterCatalogCallback = null;
    }

    // Clear previous catalog and tracks display
    this.catalogManager.clearCatalog();
    this.tracksContainerEl.innerHTML = "";

    // Hide start/stop buttons until new tracks are loaded
    const startBtn = document.getElementById("startBtn") as HTMLButtonElement;
    if (startBtn) {
      startBtn.disabled = true;
    }

    this.selectedNamespace = namespace;

    // Update the visual selection state
    this.renderNamespaceSelector();

    // Check if we should use FETCH instead of SUBSCRIBE
    const useFetch = (
      document.getElementById("useFetchCatalog") as HTMLInputElement
    )?.checked;

    if (useFetch) {
      this.fetchCatalog(namespace).catch((error) => {
        this.logger.error(
          `Error fetching catalog: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    } else {
      this.subscribeToCatalog(namespace).catch((error) => {
        this.logger.error(
          `Error subscribing to catalog: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
  }

  /**
   * Subscribe to the catalog in the given namespace
   * @param namespace The namespace to subscribe to
   */
  private async subscribeToCatalog(namespace: string[]): Promise<void> {
    if (!this.client) {
      this.logger.error("Cannot subscribe to catalog: Not connected");
      return;
    }

    try {
      const namespaceStr = namespace.join("/");
      this.logger.info(`Subscribing to catalog in namespace: ${namespaceStr}`);

      // Subscribe to the "catalog" track in the given namespace
      const trackAlias = await this.client.subscribeTrack(
        namespaceStr,
        "catalog",
        (obj: MOQObject) => {
          try {
            const text = new TextDecoder().decode(obj.data);
            const catalog = JSON.parse(text); // If using CBOR, replace this with CBOR decoding
            // Use the catalog manager to handle the catalog data
            this.catalogManager.handleCatalogData(catalog, namespaceStr);
          } catch (e) {
            this.logger.error(
              `Failed to decode catalog data: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        },
      );

      // Store the track alias and create an unregister function
      if (trackAlias !== undefined) {
        // Create an unregister function that uses the track alias
        const unregisterFunc = () => {
          // Don't try to unsubscribe if we're already disconnecting
          if (this.isDisconnecting) {
            this.logger.debug("Skipping catalog unsubscribe during disconnect");
            return;
          }
          this.logger.info(
            `Unsubscribing from catalog track with alias ${trackAlias}`,
          );
          this.client?.unsubscribeTrack(trackAlias).catch((err) => {
            this.logger.error(`Failed to unsubscribe from catalog: ${err}`);
          });
        };

        if (this.unregisterCatalogCallback) {
          this.logger.info("Unregistering previous catalog callback");
          this.unregisterCatalogCallback();
        }
        this.unregisterCatalogCallback = unregisterFunc;
        this.logger.info(
          `Successfully subscribed to catalog in namespace: ${namespaceStr} with track alias: ${trackAlias}`,
        );
      } else {
        this.logger.error(
          `Failed to subscribe to catalog in namespace: ${namespaceStr} - no track alias returned`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Error subscribing to catalog: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Fetch the catalog using FETCH (one-shot) instead of SUBSCRIBE
   */
  private async fetchCatalog(namespace: string[]): Promise<void> {
    if (!this.client) {
      this.logger.error("Cannot fetch catalog: Not connected");
      return;
    }

    const namespaceStr = namespace.join("/");
    this.logger.info(`Fetching catalog in namespace: ${namespaceStr}`);

    try {
      await this.client.fetchTrack(
        namespaceStr,
        "catalog",
        (obj: MOQObject) => {
          try {
            const text = new TextDecoder().decode(obj.data);
            const catalog = JSON.parse(text);
            this.catalogManager.handleCatalogData(catalog, namespaceStr);
          } catch (e) {
            this.logger.error(
              `Failed to decode fetched catalog data: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        },
      );

      this.logger.info(
        `Successfully fetched catalog in namespace: ${namespaceStr}`,
      );
    } catch (error) {
      this.logger.error(
        `Error fetching catalog: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Process the MSF/CMSF catalog and display track information
   * @param catalog The MSF/CMSF catalog to process
   */
  private processWarpCatalog(catalog: WarpCatalog): void {
    // Clear previous tracks display
    this.tracksContainerEl.innerHTML = "";

    this.logger.info(`Processing MSF/CMSF catalog version ${catalog.version}`);
    this.logger.info(`Found ${catalog.tracks.length} tracks in catalog`);

    // Get video and audio tracks using the catalog manager
    const videoTracks = this.catalogManager.getTracksByType(catalog, "video");
    const audioTracks = this.catalogManager.getTracksByType(catalog, "audio");

    // Log found tracks
    videoTracks.forEach((track) => {
      this.logger.info(`Found video track: ${track.name}`);
    });

    audioTracks.forEach((track) => {
      this.logger.info(`Found audio track: ${track.name}`);
    });

    // Log summary of found tracks
    this.logger.info(
      `Found ${videoTracks.length} video tracks and ${audioTracks.length} audio tracks`,
    );

    // Determine DRM label from catalog contentProtections
    const drmLabel = this.getDrmLabel();

    // Display tracks in the UI
    this.displayTracks("video-tracks", `Video Tracks${drmLabel}`, videoTracks);
    this.displayTracks("audio-tracks", `Audio Tracks${drmLabel}`, audioTracks);

    // Update catalog JSON view
    const catalogSection = document.getElementById("catalog-section");
    const catalogJson = document.getElementById("catalogJson");
    if (catalogJson) {
      // Shorten initData for readability
      const displayCatalog = {
        ...catalog,
        tracks: catalog.tracks.map((t: WarpTrack & { initData?: string }) => {
          if (t.initData && t.initData.length > 40) {
            return {
              ...t,
              initData: t.initData.substring(0, 40) + "...",
            };
          }
          return t;
        }),
      };
      catalogJson.textContent = JSON.stringify(displayCatalog, null, 2);
    }

    // Add catalog toggle button if not already present
    if (
      this.tracksContainerEl &&
      !document.getElementById("catalogToggleBtn")
    ) {
      const btn = document.createElement("a");
      btn.id = "catalogToggleBtn";
      btn.href = "#";
      btn.textContent = "Show catalog";
      btn.style.cssText =
        "font-size: 0.75rem; color: var(--text-secondary); cursor: pointer; display: inline-block; margin-top: 0.5rem;";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        if (catalogSection) {
          const visible = catalogSection.style.display !== "none";
          catalogSection.style.display = visible ? "none" : "";
          btn.textContent = visible ? "Show catalog" : "Hide catalog";
        }
      });
      this.tracksContainerEl.appendChild(btn);
    }
  }

  /**
   * Get a DRM label string from the current catalog's contentProtections.
   * Returns e.g. " 🔒 Widevine" or " 🔒 ClearKey" or "" if no DRM.
   */
  private getDrmLabel(): string {
    const catalog = this.catalogManager.getCatalog();
    if (
      !catalog?.contentProtections ||
      catalog.contentProtections.length === 0
    ) {
      return "";
    }
    const systemNames: string[] = [];
    for (const cp of catalog.contentProtections) {
      const sysId = cp.drmSystem?.systemID;
      if (sysId) {
        const name = this.drmSystems[sysId];
        if (name && !systemNames.includes(name)) {
          systemNames.push(name);
        }
      }
    }
    if (systemNames.length === 0) {
      return "";
    }
    return ` 🔒 ${systemNames.join(", ")}`;
  }

  /**
   * Create the published namespaces section in the DOM
   */
  private createPublishedNamespacesSection(): void {
    // Check if published namespaces section already exists
    if (document.getElementById("published-namespaces")) {
      this.publishedNamespacesEl = document.getElementById(
        "published-namespaces",
      );
      return;
    }

    // Find the tracks container element - this is our insertion point reference
    if (!this.tracksContainerEl) {
      this.logger.error("Tracks container element is not initialized");
      return;
    }

    // Get the parent container
    const container = this.tracksContainerEl.parentElement;
    if (!container) {
      this.logger.error("Could not find parent container for tracks");
      return;
    }

    // Create published namespaces container before the tracks container
    this.publishedNamespacesEl = document.createElement("div");
    this.publishedNamespacesEl.id = "published-namespaces";
    this.publishedNamespacesEl.className = "published-namespaces-container";

    container.insertBefore(this.publishedNamespacesEl, this.tracksContainerEl);
  }

  /**
   * Remove the published namespaces section from the DOM
   */
  private removePublishedNamespacesSection(): void {
    // Remove the published namespaces container
    if (this.publishedNamespacesEl && this.publishedNamespacesEl.parentNode) {
      this.publishedNamespacesEl.parentNode.removeChild(
        this.publishedNamespacesEl,
      );
      this.publishedNamespacesEl = null;
    }
  }

  /**
   * Render the namespace selector showing all known namespaces as buttons.
   * The currently selected namespace is highlighted.
   */
  private renderNamespaceSelector(): void {
    if (!this.publishedNamespacesEl) {
      this.createPublishedNamespacesSection();
      if (!this.publishedNamespacesEl) {
        this.logger.error("Failed to create published namespaces element");
        return;
      }
    }

    this.publishedNamespacesEl.innerHTML = "";
    this.publishedNamespacesEl.style.cssText =
      "display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap;";

    const selectedStr = this.selectedNamespace?.join("/") ?? "";

    const mediaNs = this.publishedNamespaces.filter(
      (ns) => !this.isNonMediaNamespace(ns),
    );
    const otherNs = this.publishedNamespaces.filter((ns) =>
      this.isNonMediaNamespace(ns),
    );

    const engineChoice = this.currentEngineChoice();

    // Media namespace buttons on the left
    const mediaGroup = document.createElement("div");
    mediaGroup.style.cssText = "display: flex; gap: 0.5rem; flex-wrap: wrap;";

    for (const ns of mediaNs) {
      const nsStr = ns.join("/");
      const isEccp = nsStr.includes("/eccp-");
      const engineCompatible = this.namespaceMatchesEngineChoice(
        ns,
        engineChoice,
      );
      const disabled = (isEccp && !this.clearKeySupported) || !engineCompatible;

      const btn = document.createElement("button");
      btn.className =
        "namespace-btn" +
        (nsStr === selectedStr ? " selected" : "") +
        (disabled ? " disabled" : "");
      btn.textContent = nsStr;
      if (!engineCompatible) {
        btn.title = `${engineChoice === "mse" ? "MSE" : "WebCodecs"} engine cannot play this namespace`;
      } else if (disabled) {
        btn.title = "ClearKey not supported in this browser";
      }

      if (!disabled) {
        btn.addEventListener("click", () => {
          if (nsStr !== selectedStr) {
            this.selectNamespace(ns);
          }
        });
      }
      mediaGroup.appendChild(btn);
    }
    this.publishedNamespacesEl.appendChild(mediaGroup);

    // Non-media namespaces as a small list on the right
    if (otherNs.length > 0) {
      const otherGroup = document.createElement("div");
      otherGroup.style.cssText =
        "max-height: 3rem; overflow-y: auto; text-align: right;";

      for (const ns of otherNs) {
        const nsStr = ns.join("/");
        const item = document.createElement("div");
        item.style.cssText =
          "font-size: 0.7rem; color: var(--text-secondary); white-space: nowrap; text-decoration: line-through; opacity: 0.5;";
        item.textContent = nsStr;
        item.title = "Non-content namespace";
        otherGroup.appendChild(item);
      }
      this.publishedNamespacesEl.appendChild(otherGroup);
    }
  }

  /**
   * Display tracks in the UI
   * @param id Stable ID base for the select element (e.g. "video-tracks")
   * @param title Display title for the section heading
   * @param tracks The tracks to display
   */
  private displayTracks(id: string, title: string, tracks: WarpTrack[]): void {
    if (!this.tracksContainerEl || tracks.length === 0) {
      return;
    }

    // Create section
    const section = document.createElement("div");
    section.className = "tracks-section";

    // Add title
    const titleEl = document.createElement("h3");
    titleEl.textContent = title;
    section.appendChild(titleEl);

    // Create selector container with dropdown and details side by side
    const selectorContainer = document.createElement("div");
    selectorContainer.className = "selector-container";

    const selectId = `${id}-select`;

    // Create dropdown select element
    const select = document.createElement("select");
    select.id = selectId;
    select.name = title.toLowerCase().replace(/\s+/g, "-");
    select.className = "track-select";

    // Add tracks to dropdown
    tracks.forEach((track, index) => {
      const option = document.createElement("option");
      option.value = track.name;
      option.dataset.trackName = track.name;
      option.dataset.namespace = track.namespace || "";
      option.textContent = track.name;

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
        option.title = tooltip.join(" | ");
      }

      select.appendChild(option);
    });

    // Add details container that will show the selected track's details
    const detailsContainer = document.createElement("div");
    detailsContainer.className = "track-details-container";
    detailsContainer.id = `${selectId}-details`;

    // Event listener to update details when selection changes
    select.addEventListener("change", (_e) => {
      const selectedOption = select.options[select.selectedIndex];
      if (selectedOption.title) {
        detailsContainer.textContent = selectedOption.title;
      } else {
        detailsContainer.textContent = "No additional details available";
      }
    });

    // Trigger change event to populate initial details
    setTimeout(() => {
      select.dispatchEvent(new Event("change"));
    }, 0);

    selectorContainer.appendChild(select);
    selectorContainer.appendChild(detailsContainer);
    section.appendChild(selectorContainer);

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
    const stopBtn = document.getElementById(
      "stopBtn",
    ) as HTMLButtonElement | null;
    if (stopBtn) {
      stopBtn.disabled = false;
      stopBtn.onclick = async () => {
        // Disable the button while stopping to prevent multiple clicks
        stopBtn.disabled = true;
        this.logger.info("Stopping playback and unsubscribing from tracks...");

        try {
          await this.stopPlayback();
        } catch (error) {
          this.logger.info(
            `Error stopping playback: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          // Re-enable the button in case there was an error
          stopBtn.disabled = false;
        }
      };
      stopBtn.style.display = "";
    }

    this.wireMuteButton();
  }

  /**
   * Activate and wire up the Mute / Unmute toggle. Routed through the
   * active pipeline so it works regardless of engine: MsePipeline forwards
   * to videoElement.muted, WebCodecsLocPipeline drives a GainNode between
   * each AudioBufferSourceNode and the AudioContext destination. We need
   * a custom button because (a) Safari's native video controls don't
   * expose a mute toggle the same way Chrome's do, and (b) the WebCodecs
   * path hides the <video> entirely.
   */
  private wireMuteButton(): void {
    const muteBtn = document.getElementById(
      "muteBtn",
    ) as HTMLButtonElement | null;
    if (!muteBtn) {
      return;
    }
    this.refreshMuteLabel = () => {
      const muted = this.currentPipeline?.getMuted() ?? true;
      // 🔇 = speaker with cancellation stroke (muted state, click to unmute)
      // 🔊 = speaker with three sound waves (audible state, click to mute)
      const icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = muted ? "🔇" : "🔊";
      muteBtn.replaceChildren(
        icon,
        document.createTextNode(muted ? " Unmute" : " Mute"),
      );
    };
    muteBtn.disabled = false;
    this.refreshMuteLabel();
    muteBtn.onclick = () => {
      const pipeline = this.currentPipeline;
      if (!pipeline) {
        return;
      }
      const next = !pipeline.getMuted();
      pipeline.setMuted(next);
      this.refreshMuteLabel?.();
    };
  }

  // Track subscriptions are managed through the trackSubscriptions map

  /**
   * Stop playback and unsubscribe from tracks
   */
  private async stopPlayback(): Promise<void> {
    this.logger.info("stopPlayback called");

    // Log the current state of trackSubscriptions
    this.logger.info(
      `Current trackSubscriptions size: ${this.trackSubscriptions.size}`,
    );
    if (this.trackSubscriptions.size > 0) {
      this.logger.info("Current track subscriptions:");
      this.trackSubscriptions.forEach((alias, key) => {
        this.logger.info(`  - ${key}: ${alias}`);
      });
    } else {
      this.logger.warn("No active track subscriptions found!");
    }

    // Stop synchronized playback first
    this.stopSynchronizedPlayback();

    // Unsubscribe from all active track subscriptions
    if (this.client && this.trackSubscriptions.size > 0) {
      this.logger.info(
        `Unsubscribing from ${this.trackSubscriptions.size} active track(s)`,
      );

      // Create an array of promises for each unsubscribe operation
      const unsubscribePromises = [];

      for (const [trackName, trackAlias] of this.trackSubscriptions.entries()) {
        this.logger.info(
          `Sending unsubscribe message for track: ${trackName} (alias: ${trackAlias})`,
        );
        try {
          // Add the unsubscribe promise to our array
          unsubscribePromises.push(this.client.unsubscribeTrack(trackAlias));
        } catch (error) {
          this.logger.info(
            `Error unsubscribing from track ${trackName}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      // Wait for all unsubscribe operations to complete
      try {
        await Promise.all(unsubscribePromises);
        this.logger.info("Successfully unsubscribed from all tracks");
      } catch (error) {
        this.logger.info(
          `Error during track unsubscription: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      // Clear the track subscriptions map
      this.trackSubscriptions.clear();
      this.logger.info("Cleared track subscriptions map");
    } else {
      if (!this.client) {
        this.logger.warn(
          "Client is not initialized, cannot unsubscribe from tracks",
        );
      } else {
        this.logger.warn("No active track subscriptions to unsubscribe from");
      }
    }

    // Tear down the WebCodecs pipeline if active.
    if (this.webcodecsMetricsTimer !== null) {
      clearInterval(this.webcodecsMetricsTimer);
      this.webcodecsMetricsTimer = null;
    }
    if (this.webcodecsPipeline) {
      try {
        await this.webcodecsPipeline.dispose();
      } catch (e) {
        this.logger.warn(
          `Error disposing WebCodecsLoc pipeline: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      this.webcodecsPipeline = null;
    }

    // Reset video element
    const videoEl = document.getElementById("videoPlayer") as HTMLVideoElement;
    if (videoEl) {
      videoEl.pause();
      videoEl.removeAttribute("src");
      videoEl.load();
    }

    // Reset state
    this.resetPlaybackState();

    this.logger.info("Playback stopped");
  }

  /**
   * Stop synchronized playback and clean up event listeners
   */
  private stopSynchronizedPlayback(): void {
    const videoEl = document.getElementById("videoPlayer") as HTMLVideoElement;
    if (videoEl) {
      // Stop playback
      videoEl.pause();

      // Remove synchronization event listener
      videoEl.removeEventListener("timeupdate", this.monitorSync.bind(this));

      // Reset playback rate to normal
      videoEl.playbackRate = 1.0;

      this.logger.info(
        "[Sync] Synchronized playback stopped and event listeners removed",
      );
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

    // Reset buffer variables. dispose() returns a promise but we don't need
    // to await it here — the legacy MSE flow tears down synchronously.
    void this.msePipeline.dispose();
    this.currentPipeline = null;
    this.refreshMuteLabel?.();
    this.activeDrmLabel = null;
    this.updateEngineLegend();

    // Reset error handling state
    this.recoveryInProgress = false;
    this.videoErrorCount = 0;
    this.audioErrorCount = 0;
    this.playbackStalled = false;
    this.recoveryAttempts = 0;
    this.lastErrorTime = 0;

    this.logger.info("Playback state reset");
  }

  /**
   * Handle errors on the video element
   * @param event The error event
   */
  private handleVideoElementError(_event: Event): void {
    const videoEl = document.getElementById("videoPlayer") as HTMLVideoElement;
    if (!videoEl) {
      this.logger.error(
        "[ErrorHandler] Video element not found when handling error",
      );
      return;
    }

    const error = videoEl.error;
    if (!error) {
      this.logger.error("[ErrorHandler] No error information available");
      return;
    }

    // Log the error details
    this.logger.error(
      `[ErrorHandler] Video element error: ${error.message || "Unknown error"}`,
    );
    this.logger.error(
      `[ErrorHandler] Error code: ${error.code}, Message: ${error.message}`,
    );

    // Handle different error types
    switch (error.code) {
      case MediaError.MEDIA_ERR_ABORTED:
        this.logger.error("[ErrorHandler] Playback aborted by the user");
        break;

      case MediaError.MEDIA_ERR_NETWORK:
        this.logger.error(
          "[ErrorHandler] Network error occurred during playback",
        );
        this.attemptNetworkRecovery();
        break;

      case MediaError.MEDIA_ERR_DECODE:
        this.logger.error(
          "[ErrorHandler] Decoding error occurred during playback",
        );
        this.attemptDecodeRecovery();
        break;

      case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
        this.logger.error("[ErrorHandler] Format or codec not supported");
        this.handleUnsupportedFormat();
        break;

      default:
        this.logger.error("[ErrorHandler] Unknown error occurred");
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
      this.logger.error("Maximum recovery attempts reached, giving up");
      this.recoveryInProgress = false;
      return;
    }

    this.logger.info(
      `[ErrorHandler] Attempting network recovery (attempt ${this.recoveryAttempts}/${this.maxRecoveryAttempts})`,
    );

    // Attempt to find a stable playback position
    const videoEl = document.getElementById("videoPlayer") as HTMLVideoElement;
    if (videoEl && videoEl.buffered.length > 0) {
      // Find a stable position in the buffer (not at the edge)
      for (let i = 0; i < videoEl.buffered.length; i++) {
        const start = videoEl.buffered.start(i);
        const end = videoEl.buffered.end(i);

        // If we have more than 1 second of buffer, seek to 200ms after the start
        if (end - start > 1.0) {
          const safePosition = start + 0.2; // 200ms into the buffer
          this.logger.info(
            `[ErrorHandler] Found stable buffer range [${start.toFixed(
              2,
            )}-${end.toFixed(2)}], seeking to ${safePosition.toFixed(2)}`,
          );

          // Seek to the safe position and try to resume playback
          videoEl.currentTime = safePosition;
          videoEl
            .play()
            .then(() => {
              this.logger.info("Network recovery successful, playback resumed");
              this.recoveryInProgress = false;
            })
            .catch((e) => {
              this.logger.error(
                `Failed to resume playback after network recovery: ${e}`,
              );
              this.recoveryInProgress = false;
            });

          return;
        }
      }
    }

    // If we couldn't find a stable position, wait a bit and try again
    setTimeout(() => {
      this.logger.info("No stable buffer position found, trying again later");
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
      this.logger.error("Maximum recovery attempts reached, giving up");
      this.recoveryInProgress = false;
      return;
    }

    this.logger.info(
      `[ErrorHandler] Attempting decode recovery (attempt ${this.recoveryAttempts}/${this.maxRecoveryAttempts})`,
    );

    const videoEl = document.getElementById("videoPlayer") as HTMLVideoElement;

    // For decode errors, we'll try to skip ahead slightly
    if (videoEl && videoEl.buffered.length > 0) {
      const currentTime = videoEl.currentTime;

      // Skip ahead slightly to try to get past the problematic frame
      const skipAhead = 0.5; // Skip ahead 500ms
      const newPosition = currentTime + skipAhead;

      // Check if we can skip ahead
      let canSkip = false;
      for (let i = 0; i < videoEl.buffered.length; i++) {
        if (
          newPosition >= videoEl.buffered.start(i) &&
          newPosition < videoEl.buffered.end(i)
        ) {
          canSkip = true;
          break;
        }
      }

      if (canSkip) {
        this.logger.info(
          `[ErrorHandler] Skipping ahead from ${currentTime.toFixed(
            2,
          )} to ${newPosition.toFixed(2)} to bypass decode error`,
        );

        // Seek ahead and try to resume playback
        videoEl.currentTime = newPosition;
        videoEl
          .play()
          .then(() => {
            this.logger.error("Decode recovery successful, playback resumed");
            this.recoveryInProgress = false;
          })
          .catch((e) => {
            this.logger.error(
              `[ErrorHandler] Failed to resume playback after decode recovery: ${e}`,
            );
            this.recoveryInProgress = false;
          });

        return;
      }
    }

    // If we can't skip ahead, try general recovery
    this.logger.error("Could not skip ahead, attempting generic recovery");
    this.recoveryInProgress = false;
    this.attemptGenericRecovery();
  }

  /**
   * Handle unsupported format errors by falling back to available tracks
   */
  private handleUnsupportedFormat(): void {
    this.logger.warn(
      "Format or codec not supported, checking for fallback options",
    );

    if (this.audioSourceBuffer && this.videoSourceBuffer) {
      // Both audio and video are present
      if (this.audioErrorCount > this.videoErrorCount) {
        // Audio seems to be the problem, try to fall back to video only
        this.logger.warn(
          "Audio codec seems problematic, attempting to fall back to video only",
        );
        this.fallbackToVideoOnly();
      } else if (this.videoErrorCount > this.audioErrorCount) {
        // Video seems to be the problem, try to fall back to audio only
        this.logger.warn(
          "Video codec seems problematic, attempting to fall back to audio only",
        );
        this.fallbackToAudioOnly();
      } else {
        // Both seem problematic
        this.logger.error(
          "Both audio and video codecs seem problematic, cannot continue",
        );
      }
    } else if (this.videoSourceBuffer) {
      // Only video is present
      this.logger.error(
        "Video codec not supported and no audio fallback available",
      );
    } else if (this.audioSourceBuffer) {
      // Only audio is present
      this.logger.error(
        "Audio codec not supported and no video fallback available",
      );
    } else {
      this.logger.error("No supported tracks available");
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
      this.logger.error("Maximum recovery attempts reached, giving up");
      this.recoveryInProgress = false;
      return;
    }

    this.logger.info(
      `[ErrorHandler] Attempting generic recovery (attempt ${this.recoveryAttempts}/${this.maxRecoveryAttempts})`,
    );

    const videoEl = document.getElementById("videoPlayer") as HTMLVideoElement;
    if (!videoEl) {
      this.logger.error("Video element not found during recovery");
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
        if (
          videoEl.currentTime >= videoEl.buffered.start(i) &&
          videoEl.currentTime <= videoEl.buffered.end(i)
        ) {
          rangeIndex = i;
          break;
        }
      }

      if (rangeIndex >= 0) {
        // We found the current range, seek to the middle of it
        const start = videoEl.buffered.start(rangeIndex);
        const end = videoEl.buffered.end(rangeIndex);
        const middle = start + (end - start) / 2;

        this.logger.info(
          `[ErrorHandler] Seeking to middle of buffer range [${start.toFixed(
            2,
          )}-${end.toFixed(2)}] at ${middle.toFixed(2)}`,
        );

        // Seek to the middle and try to resume playback
        videoEl.currentTime = middle;

        // Wait a bit then try to play
        setTimeout(() => {
          videoEl
            .play()
            .then(() => {
              this.logger.error(
                "Generic recovery successful, playback resumed",
              );
              this.recoveryInProgress = false;
            })
            .catch((e) => {
              this.logger.error(
                `[ErrorHandler] Failed to resume playback after generic recovery: ${e}`,
              );
              this.recoveryInProgress = false;
            });
        }, 500);
      } else {
        // No suitable range found, try to start from the beginning of any range
        if (videoEl.buffered.length > 0) {
          const start = videoEl.buffered.start(0);
          this.logger.info(
            `[ErrorHandler] No suitable buffer range found, seeking to start of first range at ${start.toFixed(
              2,
            )}`,
          );
          videoEl.currentTime = start;

          // Wait a bit then try to play
          setTimeout(() => {
            videoEl
              .play()
              .then(() => {
                this.logger.info(
                  "Generic recovery successful, playback resumed from start",
                );
                this.recoveryInProgress = false;
              })
              .catch((e) => {
                this.logger.error(
                  `[ErrorHandler] Failed to resume playback from start: ${e}`,
                );
                this.recoveryInProgress = false;
              });
          }, 500);
        } else {
          this.logger.error("No buffered data available for recovery");
          this.recoveryInProgress = false;
        }
      }
    } else {
      this.logger.error("No buffered data available for recovery");
      this.recoveryInProgress = false;
    }
  }

  /**
   * Fall back to video-only playback when audio is problematic
   */
  private fallbackToVideoOnly(): void {
    if (!this.videoSourceBuffer || !this.videoTrack) {
      this.logger.error(
        "Cannot fall back to video-only, no video track available",
      );
      return;
    }

    this.logger.error("Falling back to video-only playback");

    // Clear audio state
    this.msePipeline.clearAudio();
    this.audioTrack = null;
    this.audioBufferReady = false;
    this.audioObjectsReceived = 0;

    // If we're already playing, continue with video only
    // Otherwise, start playback with video only
    if (!this.playbackStarted && this.videoBufferReady) {
      const videoEl = document.getElementById(
        "videoPlayer",
      ) as HTMLVideoElement;
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
      this.logger.error(
        "Cannot fall back to audio-only, no audio track available",
      );
      return;
    }

    this.logger.error("Falling back to audio-only playback");

    // Clear video state
    this.msePipeline.clearVideo();
    this.videoTrack = null;
    this.videoBufferReady = false;
    this.videoObjectsReceived = 0;

    // If we're already playing, continue with audio only
    // Otherwise, start playback with audio only
    if (!this.playbackStarted && this.audioBufferReady) {
      const videoEl = document.getElementById(
        "videoPlayer",
      ) as HTMLVideoElement;
      if (videoEl) {
        this.startAudioOnlyPlayback(videoEl);
      }
    }
  }

  /**
   * Track the minimum buffer level before appending new segments
   */
  private trackMinimumBufferLevel(): void {
    const videoEl = document.getElementById("videoPlayer") as HTMLVideoElement;
    if (!videoEl || !this.playbackStarted) {
      return;
    }

    const currentTime = videoEl.currentTime;
    const now = Date.now();

    // Reset minimum buffer tracking every 2 seconds to avoid getting stuck
    if (now - this.lastSegmentAppendTime > 2000) {
      this.minBufferLevel = Infinity;
      this.logger.debug(`[BufferTracking] Reset minimum buffer tracking`);
    }

    // Calculate current buffer levels
    if (this.videoSourceBuffer && !this.videoSourceBuffer.updating) {
      const videoRanges = this.videoSourceBuffer.buffered;
      if (videoRanges.length > 0) {
        for (let i = 0; i < videoRanges.length; i++) {
          if (
            currentTime >= videoRanges.start(i) &&
            currentTime <= videoRanges.end(i)
          ) {
            const videoBufferAhead = videoRanges.end(i) - currentTime;
            this.minBufferLevel = Math.min(
              this.minBufferLevel,
              videoBufferAhead * 1000,
            );
            break;
          }
        }
      }
    }

    if (this.audioSourceBuffer && !this.audioSourceBuffer.updating) {
      const audioRanges = this.audioSourceBuffer.buffered;
      if (audioRanges.length > 0) {
        for (let i = 0; i < audioRanges.length; i++) {
          if (
            currentTime >= audioRanges.start(i) &&
            currentTime <= audioRanges.end(i)
          ) {
            const audioBufferAhead = audioRanges.end(i) - currentTime;
            this.minBufferLevel = Math.min(
              this.minBufferLevel,
              audioBufferAhead * 1000,
            );
            break;
          }
        }
      }
    }

    this.lastSegmentAppendTime = now;

    // Log occasionally
    if (Math.random() < 0.05) {
      this.logger.debug(
        `[BufferTracking] Minimum buffer level: ${this.minBufferLevel.toFixed(
          0,
        )}ms`,
      );
    }
  }

  /**
   * Get the average segment duration in seconds for a given buffer
   */
  private getAverageSegmentDuration(buffer: MediaSegmentBuffer): number {
    const segments = buffer.getAllSegments();
    if (segments.length === 0) {
      return 0;
    }

    let totalDuration = 0;
    let segmentCount = 0;

    // Look at recent segments (last 10 or so)
    const recentSegments = segments.slice(-10);

    for (const segment of recentSegments) {
      if (
        segment.trackInfo &&
        segment.trackInfo.duration &&
        segment.trackInfo.timescale
      ) {
        const durationInSeconds =
          segment.trackInfo.duration / segment.trackInfo.timescale;
        totalDuration += durationInSeconds;
        segmentCount++;
      }
    }

    return segmentCount > 0 ? totalDuration / segmentCount : 0;
  }

  /**
   * Update just the playback rate display
   */
  private updatePlaybackRateDisplay(): void {
    const videoEl = document.getElementById("videoPlayer") as HTMLVideoElement;
    const playbackRateEl = document.getElementById("playbackRate");

    if (playbackRateEl && videoEl && this.playbackStarted) {
      const rate = videoEl.playbackRate;
      playbackRateEl.textContent = `${rate.toFixed(3)}x`; // Show 3 decimal places

      // Color coding based on playback rate
      if (Math.abs(rate - 1.0) < 0.005) {
        playbackRateEl.style.color = "#10b981"; // Green for very close to normal
      } else if (Math.abs(rate - 1.0) < 0.02) {
        playbackRateEl.style.color = "#f59e0b"; // Orange for minor adjustment
      } else {
        playbackRateEl.style.color = "#ef4444"; // Red for significant adjustment
      }
    }
  }

  /**
   * Check buffer health and control playback rate based on minimal buffer and target latency
   * This is called during the monitorSync process
   */
  private checkBufferHealth(
    videoBufferAhead: number,
    audioBufferAhead: number,
  ): void {
    const videoEl = document.getElementById("videoPlayer") as HTMLVideoElement;
    if (!videoEl) {
      return;
    }

    // Convert parameters to seconds for comparison
    const minimalBufferSec = this.minimalBufferMs / 1000;
    const targetLatencySec = this.targetLatencyMs / 1000;

    // Calculate actual latency assuming media timestamps are NTP-synchronized
    // Latency = current wall clock time - media presentation time
    // This requires both player and media producer to have synchronized clocks
    let currentLatencyMs = Date.now() - videoEl.currentTime * 1000;

    // Sanity check - if latency is negative or unreasonably large, fall back to buffer-based estimate
    if (currentLatencyMs < 0 || currentLatencyMs > 30000) {
      this.logger.warn(
        `[BufferHealth] Unusual latency value: ${currentLatencyMs}ms, falling back to buffer-based estimate`,
      );
      const avgBufferAhead = (videoBufferAhead + audioBufferAhead) / 2;
      currentLatencyMs = avgBufferAhead * 1000;
    }

    const currentLatencySec = currentLatencyMs / 1000;

    // For buffer control, use the current buffer levels, not the historical minimum
    // The minBufferLevel tracking is for monitoring purposes only
    const effectiveMinBuffer = Math.min(videoBufferAhead, audioBufferAhead);

    // Check if either buffer is critically low
    const videoCritical =
      this.videoSourceBuffer && videoBufferAhead < this.bufferCriticalThreshold;
    const audioCritical =
      this.audioSourceBuffer && audioBufferAhead < this.bufferCriticalThreshold;

    // Stage 1: Check if minimum buffer constraint is violated
    const belowMinimalBuffer = effectiveMinBuffer < minimalBufferSec;

    // Stage 2: Check if we're above or below target latency
    const aboveTargetLatency = currentLatencySec > targetLatencySec;
    const belowTargetLatency = currentLatencySec < targetLatencySec;

    // Debug logging - log every 10th call to see the effect
    if (Math.random() < 0.1) {
      const trackedMin =
        this.minBufferLevel !== Infinity ? this.minBufferLevel : -1;
      this.logger.info(
        `[BufferHealth] Current buffer: ${(effectiveMinBuffer * 1000).toFixed(
          0,
        )}ms (threshold: ${
          this.minimalBufferMs
        }ms), Tracked min: ${trackedMin.toFixed(
          0,
        )}ms, Latency: ${currentLatencyMs.toFixed(0)}ms (target: ${
          this.targetLatencyMs
        }ms), Rate: ${videoEl.playbackRate.toFixed(
          2,
        )}x, Conditions: belowMin=${belowMinimalBuffer}, aboveLat=${aboveTargetLatency}, belowLat=${belowTargetLatency}`,
      );
    }

    if (
      (videoCritical || audioCritical) &&
      !this.playbackStalled &&
      !this.recoveryInProgress
    ) {
      this.logger.info(
        `[BufferHealth] Buffer critically low - Video: ${videoBufferAhead.toFixed(
          2,
        )}s, Audio: ${audioBufferAhead.toFixed(2)}s`,
      );

      // Check if we're stalled or about to stall
      if (videoEl.paused || videoEl.readyState < 3) {
        this.playbackStalled = true;
        this.logger.warn(
          "[BufferHealth] Playback stalled due to buffer underrun",
        );

        // Attempt to recover
        this.recoverFromBufferUnderrun();
      } else {
        // Not stalled yet, but buffer is critically low
        // Adjust playback rate to give buffer time to build up
        if (videoEl.playbackRate > 0.7) {
          // Reduce playback rate to 70% to allow buffer to build up faster
          const originalRate = videoEl.playbackRate;
          videoEl.playbackRate = 0.7;
          this.logger.info(
            `[BufferHealth] Reduced playback rate from ${originalRate.toFixed(
              2,
            )}x to ${videoEl.playbackRate.toFixed(2)}x to prevent stall`,
          );
          this.updatePlaybackRateDisplay();
        }
      }
    } else if (this.playbackStalled && effectiveMinBuffer > minimalBufferSec) {
      // We have recovered from stalled state and have enough buffer
      this.playbackStalled = false;
      this.logger.info(
        `[BufferHealth] Playback recovered from stall, buffer above minimal threshold`,
      );

      // Reset playback rate to normal
      videoEl.playbackRate = 1.0;
      this.updatePlaybackRateDisplay();
    } else if (belowMinimalBuffer && !this.playbackStalled) {
      // Priority 1: Minimal buffer constraint violated - slow down to build buffer
      const newRate = 0.97;
      if (Math.abs(videoEl.playbackRate - newRate) >= 0.01) {
        videoEl.playbackRate = newRate;
        this.logger.info(
          `[BufferHealth] Below minimal buffer (${(
            effectiveMinBuffer * 1000
          ).toFixed(0)}ms < ${
            this.minimalBufferMs
          }ms), reducing rate to ${newRate.toFixed(2)}x`,
        );
        this.updatePlaybackRateDisplay();
      }
    } else if (
      !belowMinimalBuffer &&
      aboveTargetLatency &&
      !this.playbackStalled
    ) {
      // Priority 2: Above target latency - speed up to reduce latency
      const latencyError =
        (currentLatencyMs - this.targetLatencyMs) / this.targetLatencyMs;

      // Non-linear gain: starts at 3% for large errors, reduces as we approach target
      const baseGain = 0.03;
      const gainReduction = Math.exp(-Math.abs(latencyError) * 10); // Exponential reduction
      const effectiveGain = baseGain * (1 - gainReduction * 0.8); // Reduce gain by up to 80% as we approach target

      const newRate = Math.min(1.02, 1.0 + latencyError * effectiveGain);

      if (Math.abs(videoEl.playbackRate - newRate) >= 0.001) {
        // Lower threshold for small adjustments
        videoEl.playbackRate = newRate;
        this.logger.info(
          `[BufferHealth] Above target latency (${currentLatencyMs.toFixed(
            0,
          )}ms > ${
            this.targetLatencyMs
          }ms), increasing rate to ${newRate.toFixed(3)}x (gain: ${(
            effectiveGain * 100
          ).toFixed(1)}%)`,
        );
        this.updatePlaybackRateDisplay();
      }
    } else if (
      !belowMinimalBuffer &&
      belowTargetLatency &&
      !this.playbackStalled
    ) {
      // Below target latency - slow down to increase latency (avoid getting too close to live edge)
      const latencyError =
        (this.targetLatencyMs - currentLatencyMs) / this.targetLatencyMs;

      // Non-linear gain: more aggressive reduction for latency overshoot
      // Use higher base gain but stronger reduction near target
      const baseGain = 0.05;
      const gainReduction = Math.exp(-Math.abs(latencyError) * 15); // Stronger exponential reduction
      const effectiveGain = baseGain * (1 - gainReduction * 0.9); // Reduce gain by up to 90% as we approach target

      const newRate = Math.max(0.95, 1.0 - latencyError * effectiveGain);

      if (Math.abs(videoEl.playbackRate - newRate) >= 0.001) {
        // Lower threshold for small adjustments
        videoEl.playbackRate = newRate;
        this.logger.info(
          `[BufferHealth] Below target latency (${currentLatencyMs.toFixed(
            0,
          )}ms < ${this.targetLatencyMs}ms), reducing rate to ${newRate.toFixed(
            3,
          )}x to increase latency (gain: ${(effectiveGain * 100).toFixed(1)}%)`,
        );
        this.updatePlaybackRateDisplay();
      }
    } else {
      // Log why we're not adjusting
      if (Math.random() < 0.05) {
        this.logger.debug(
          `[BufferHealth] No adjustment needed - belowMin: ${belowMinimalBuffer}, aboveLat: ${aboveTargetLatency}, belowLat: ${belowTargetLatency}, stalled: ${
            this.playbackStalled
          }, rate: ${videoEl.playbackRate.toFixed(2)}x`,
        );
      }

      // Only reset to 1.0 if we're actually within target range (with some tolerance)
      const withinTargetRange =
        !belowMinimalBuffer &&
        Math.abs(currentLatencyMs - this.targetLatencyMs) <
          this.targetLatencyMs * 0.1;

      if (
        !this.playbackStalled &&
        Math.abs(videoEl.playbackRate - 1.0) >= 0.01 &&
        withinTargetRange
      ) {
        videoEl.playbackRate = 1.0;
        this.logger.info(
          `[BufferHealth] Within 10% of target latency, restoring normal playback rate`,
        );
        this.updatePlaybackRateDisplay();
      }
    }
  }

  /**
   * Attempt to recover from a buffer underrun
   */
  private recoverFromBufferUnderrun(): void {
    if (this.recoveryInProgress) {
      return;
    }

    const minimalBufferSec = this.minimalBufferMs / 1000;

    this.recoveryInProgress = true;
    this.recoveryAttempts++;

    const videoEl = document.getElementById("videoPlayer") as HTMLVideoElement;
    if (!videoEl) {
      this.logger.error(
        "[BufferHealth] Video element not found during buffer recovery",
      );
      this.recoveryInProgress = false;
      return;
    }

    this.logger.info(
      `[BufferHealth] Attempting to recover from buffer underrun (attempt ${this.recoveryAttempts}/${this.maxRecoveryAttempts})`,
    );

    // If we have any buffered data ahead, skip to it
    if (videoEl.buffered.length > 0) {
      const currentTime = videoEl.currentTime;
      let furthestBufferStart = -1;

      // Find the furthest buffered range that is ahead of current time
      for (let i = 0; i < videoEl.buffered.length; i++) {
        const rangeStart = videoEl.buffered.start(i);
        if (
          rangeStart > currentTime &&
          (furthestBufferStart === -1 || rangeStart > furthestBufferStart)
        ) {
          furthestBufferStart = rangeStart;
        }
      }

      if (furthestBufferStart !== -1) {
        // We found a range ahead, seek to it
        const newPosition = furthestBufferStart + minimalBufferSec; // Start minimal buffer from buffered end
        this.logger.info(
          `[BufferHealth] Found buffered range starting at ${furthestBufferStart.toFixed(
            2,
          )}, seeking to ${newPosition.toFixed(2)}`,
        );

        videoEl.currentTime = newPosition;

        // Try to resume playback
        setTimeout(() => {
          videoEl
            .play()
            .then(() => {
              this.logger.info(
                "[BufferHealth] Buffer recovery successful, playback resumed",
              );
              this.recoveryInProgress = false;
            })
            .catch((e) => {
              this.logger.error(
                `[BufferHealth] Failed to resume playback after buffer recovery: ${e}`,
              );
              this.recoveryInProgress = false;
            });
        }, 500);
      } else {
        // No range ahead, wait for buffer to build up
        this.logger.info(
          "No buffered data ahead, waiting for buffer to build up",
        );

        // Check again in 1 second
        setTimeout(() => {
          // Try to resume playback if we have enough buffer now
          if (videoEl.buffered.length > 0) {
            const currentTime = videoEl.currentTime;
            let hasBufferAhead = false;

            for (let i = 0; i < videoEl.buffered.length; i++) {
              if (
                currentTime >= videoEl.buffered.start(i) &&
                currentTime < videoEl.buffered.end(i) &&
                videoEl.buffered.end(i) - currentTime > 0.5
              ) {
                hasBufferAhead = true;
                break;
              }
            }

            // Calculate buffer ahead and compare to minimal buffer
            const minimalBufferSec = this.minimalBufferMs / 1000;
            let bufferAheadSec = 0;

            for (let i = 0; i < videoEl.buffered.length; i++) {
              if (
                currentTime >= videoEl.buffered.start(i) &&
                currentTime < videoEl.buffered.end(i)
              ) {
                bufferAheadSec = videoEl.buffered.end(i) - currentTime;
                break;
              }
            }

            const bufferPercent = (bufferAheadSec / minimalBufferSec) * 100;

            if (hasBufferAhead) {
              videoEl
                .play()
                .then(() => {
                  this.logger.info(
                    `[BufferHealth] Buffer recovery successful after wait, playback resumed with ${bufferAheadSec.toFixed(
                      2,
                    )}s ahead (${bufferPercent.toFixed(0)}% of target)`,
                  );
                  this.recoveryInProgress = false;
                })
                .catch((e) => {
                  this.logger.error(
                    `[BufferHealth] Failed to resume playback after wait: ${e}`,
                  );
                  this.recoveryInProgress = false;
                });
            } else {
              this.logger.warn(
                `[BufferHealth] Still insufficient buffer after wait (${bufferAheadSec.toFixed(
                  2,
                )}s, minimal: ${minimalBufferSec.toFixed(2)}s)`,
              );
              this.recoveryInProgress = false;
            }
          } else {
            this.logger.debug("No buffered data available after wait");
            this.recoveryInProgress = false;
          }
        }, 1000);
      }
    } else {
      // No buffered data at all, nothing we can do but wait
      this.logger.debug("No buffered data available, waiting for data");

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
    const startBtn = document.getElementById(
      "startBtn",
    ) as HTMLButtonElement | null;
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.onclick = () => this.startPlayback();
      startBtn.style.display = "";
    }
  }

  /**
   * Start playback of selected tracks
   */
  private async startPlayback(): Promise<void> {
    // Get selected video track from dropdown
    const videoSelect = document.getElementById(
      "video-tracks-select",
    ) as HTMLSelectElement;
    // Get selected audio track from dropdown
    const audioSelect = document.getElementById(
      "audio-tracks-select",
    ) as HTMLSelectElement;

    const hasVideoTrack = videoSelect && videoSelect.options.length > 0;
    const hasAudioTrack = audioSelect && audioSelect.options.length > 0;

    if (!hasVideoTrack && !hasAudioTrack) {
      this.logger.error("No tracks available to play");
      return;
    }

    let videoTrack: WarpTrack | undefined;
    let audioTrack: WarpTrack | undefined;

    // --- VIDEO PLAYBACK LOGIC ---
    if (hasVideoTrack) {
      const selectedOption = videoSelect.options[videoSelect.selectedIndex];
      const videoTrackName = selectedOption.dataset.trackName || "";
      const videoNamespace = selectedOption.dataset.namespace || "";

      this.logger.info(
        `Selected video track: ${videoNamespace}/${videoTrackName}`,
      );

      // Find the video track object from the catalog
      videoTrack = this.getTrackFromCatalog(
        videoNamespace,
        videoTrackName,
        "video",
      );
      if (!videoTrack) {
        this.logger.error("Could not find selected video track in catalog");
        return;
      }
      this.logger.info("Video track found in catalog, preparing for setup");
    }

    // --- AUDIO PLAYBACK LOGIC ---
    if (hasAudioTrack) {
      const selectedOption = audioSelect.options[audioSelect.selectedIndex];
      const audioTrackName = selectedOption.dataset.trackName || "";
      const audioNamespace = selectedOption.dataset.namespace || "";

      this.logger.info(
        `Selected audio track: ${audioNamespace}/${audioTrackName}`,
      );

      // Find the audio track object from the catalog
      audioTrack = this.getTrackFromCatalog(
        audioNamespace,
        audioTrackName,
        "audio",
      );
      if (!audioTrack) {
        this.logger.error("Could not find selected audio track in catalog");
        return;
      }

      this.logger.info("Audio track found in catalog, preparing for setup");
    }
    // Warn if HEVC + Widevine — not fully compatible in Chrome
    if (
      videoTrack?.codec?.startsWith("hvc") &&
      videoTrack?.contentProtectionRefIDs
    ) {
      const catalog = this.catalogManager.getCatalog();
      const isWidevine = catalog?.contentProtections?.some(
        (cp: ContentProtection) => cp.drmSystem?.systemID === this.widevine,
      );
      if (isWidevine) {
        this.logger.warn(
          "HEVC with Widevine (CENC) is not fully supported in Chrome. Consider selecting an AVC track instead.",
        );
      }
    }

    const tracks = [videoTrack, audioTrack].filter(
      (track) => track?.contentProtectionRefIDs !== undefined,
    ) as WarpTrack[];
    if (
      this.catalogManager.getCatalog()?.contentProtections &&
      tracks.length > 0
    ) {
      const drmSucess = await this.setupDRM(tracks);
      if (!drmSucess) {
        return;
      }
    } else {
      this.logger.info("DRM information not found, skipping DRM setup");
    }

    // Pick the render engine. The dropdown lets the user force MSE or
    // WebCodecs; "auto" falls back to packaging-based selection.
    const engineSelect = document.getElementById(
      "engineChoice",
    ) as HTMLSelectElement | null;
    const engineChoice = (engineSelect?.value ?? "auto") as EngineChoice;
    let engine: "mse" | "webcodecs";
    try {
      engine = resolveEngine(
        engineChoice,
        videoTrack ?? null,
        audioTrack ?? null,
      );
    } catch (e) {
      this.logger.error(
        `Engine choice "${engineChoice}" cannot play the selected tracks: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }

    if (engine === "webcodecs") {
      if (!videoTrack) {
        this.logger.error(
          "WebCodecs engine requires a video track; aborting Start",
        );
        return;
      }
      const locAudio =
        audioTrack && audioTrack.packaging === "loc" ? audioTrack : null;
      await this.setupLocPlayback(videoTrack, locAudio);
      return;
    }

    // Setup MediaSource and SourceBuffer for audio and video
    if (audioTrack) {
      this.setupAudioPlayback(audioTrack);
    }
    if (videoTrack) {
      this.setupVideoPlayback(videoTrack);
    }
  }

  /**
   * WebCodecs LOC playback entry point. Subscribes to the LOC video and (if
   * present) LOC audio track and routes objects into the pipeline.
   */
  private async setupLocPlayback(
    videoTrack: WarpTrack,
    audioTrack: WarpTrack | null,
  ): Promise<void> {
    this.logger.info(
      `[WebCodecsLoc] Setting up LOC playback for ${videoTrack.namespace}/${videoTrack.name}` +
        (audioTrack ? ` + ${audioTrack.namespace}/${audioTrack.name}` : ""),
    );
    this.videoTrack = videoTrack;
    if (audioTrack) {
      this.audioTrack = audioTrack;
    }

    const videoEl = document.getElementById("videoPlayer") as HTMLVideoElement;
    if (!videoEl) {
      this.logger.error("Video element not found");
      return;
    }
    // Stop and detach the legacy MSE element so its decoder doesn't fight
    // with the canvas overlay.
    videoEl.pause();
    videoEl.removeAttribute("src");
    videoEl.srcObject = null;
    videoEl.load();

    const pipeline = new WebCodecsLocPipeline();
    try {
      await pipeline.setup({
        videoTrack,
        audioTrack,
        targets: { videoElement: videoEl },
        buffer: {
          minimalBufferMs: this.minimalBufferMs,
          targetLatencyMs: this.targetLatencyMs,
        },
        logger: this.logger,
      });
    } catch (e) {
      this.logger.error(
        `[WebCodecsLoc] setup failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }

    this.webcodecsPipeline = pipeline;
    this.currentPipeline = pipeline;
    this.refreshMuteLabel?.();
    this.playbackStarted = true;
    this.updateEngineLegend();

    // The hidden <video> element doesn't fire timeupdate while WebCodecs is
    // active, so drive the metric-panel refresh ourselves.
    this.webcodecsMetricsTimer = setInterval(() => {
      this.updateBufferLevelUI();
    }, 250);

    await this.subscribeToVideoTrack(videoTrack, (obj) => {
      pipeline.routeObject("video", obj as unknown as MOQObject);
    });
    if (audioTrack) {
      await this.subscribeLocAudioTrack(audioTrack, (obj) => {
        pipeline.routeObject("audio", obj);
      });
    }
  }

  /**
   * Subscribe to a LOC audio track and route MOQObjects into the pipeline.
   * The legacy MSE-aware subscribeToAudioTrack assumes a SourceBuffer pipeline
   * and pre-existing MediaSegmentBuffer state, neither of which apply to
   * WebCodecs LOC.
   */
  private async subscribeLocAudioTrack(
    track: WarpTrack,
    onObject: (obj: MOQObject) => void,
  ): Promise<void> {
    if (!this.client) {
      this.logger.error("Client not initialized");
      return;
    }
    const namespace = track.namespace || "";
    const trackKey = `${namespace}/${track.name}`;
    this.logger.info(`Subscribing to LOC audio track: ${trackKey}`);
    try {
      const trackAlias = await this.client.subscribeTrack(
        namespace,
        track.name,
        onObject,
      );
      this.trackSubscriptions.set(trackKey, trackAlias);
    } catch (error) {
      this.logger.error(
        `Error subscribing to LOC audio track ${trackKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Find a track from the catalog by namespace, name, and type
   */
  private getTrackFromCatalog(
    namespace: string,
    name: string,
    kind: string,
  ): WarpTrack | undefined {
    return this.catalogManager.getTrackFromCatalog(namespace, name, kind);
  }

  /**
   * @param tracks A list containing at most a video and audio warp track. The tracks are required to be protected.
   * @returns
   */
  private async setupDRM(tracks: WarpTrack[]): Promise<boolean> {
    try {
      let candidates: ContentProtection[] = [];
      let videoMimeType: string | undefined;
      let audioMimeType: string | undefined;
      for (const track of tracks) {
        const refIDs = track.contentProtectionRefIDs;
        if (!refIDs) {
          continue;
        }
        if (track.role === "video") {
          videoMimeType = this.msePipeline.generateVideoMimeType(track.codec);
        } else if (track.role === "audio") {
          audioMimeType = this.msePipeline.generateAudioMimeType(track.codec);
        }

        candidates = this.selectContentProtections(refIDs); //If several protected tracks exist, the last's DRM systems are chosen
        this.logger.info("candidates", candidates);
        this.logger.info(
          `DRM track: role=${track.role}, codec=${track.codec}, videoMimeType=${videoMimeType}, audioMimeType=${audioMimeType}`,
        );
        if (candidates.length === 0) {
          this.logger.error("No drm system found");
          return false;
        }
      }
      // Log all DRM systems available in this browser
      const availableSystems: string[] = [];
      if (await isWidevineSupported()) {
        availableSystems.push("widevine");
      }
      if (await isPlayreadySupported()) {
        availableSystems.push("playready");
      }
      if (await isFairplaySupported()) {
        availableSystems.push("fairplay");
      }
      this.logger.info(
        `Available DRM systems in browser: ${availableSystems.length > 0 ? availableSystems.join(", ") : "none"}`,
      );

      let selectedSystemID: string | null = null;
      let selectedDrmSystem: DRMSystem | null = null;
      let selectedInitDataType: string | null = null;
      let access: MediaKeySystemAccess | null = null;

      for (const candidate of candidates) {
        if (!candidate.drmSystem.systemID) {
          this.logger.error("DRM system SystemID is undefined, trying next");
          continue;
        }
        let drmSystemSupported = false;
        switch (candidate.drmSystem.systemID) {
          case this.widevine:
            drmSystemSupported = await isWidevineSupported();
            break;
          case this.playready:
            drmSystemSupported = await isPlayreadySupported();
            break;
          case this.fairplay:
            drmSystemSupported = await isFairplaySupported();
            break;
          case this.clearkey:
            try {
              await navigator.requestMediaKeySystemAccess("org.w3.clearkey", [
                {
                  initDataTypes: ["cenc"],
                  videoCapabilities: [
                    { contentType: 'video/mp4; codecs="avc1.4D401F"' },
                  ],
                },
              ]);
              drmSystemSupported = true;
            } catch {
              drmSystemSupported = false; // Safari does not support ClearKey
            }
            break;
        }
        if (!drmSystemSupported) {
          this.logger.info(
            `DRM system ${this.drmSystems[candidate.drmSystem.systemID]} not supported, trying next.`,
          );
          continue;
        }

        const isFairplay = candidate.drmSystem.systemID === this.fairplay;

        // Build capability config for requestMediaKeySystemAccess.
        // FairPlay is special: it does not use PSSH from the catalog.
        // Instead, init data arrives via the "encrypted" event on the
        // video element once encrypted segments are appended. However,
        // the capability check still needs valid codecs and initDataTypes.
        const buildConfig = (
          initDataTypes: string[],
          encryptionScheme?: string,
        ): MediaKeySystemConfiguration => ({
          initDataTypes,
          ...(videoMimeType && {
            videoCapabilities: [
              {
                contentType: videoMimeType,
                ...(encryptionScheme && { encryptionScheme }),
              },
            ],
          }),
          ...(audioMimeType && {
            audioCapabilities: [
              {
                contentType: audioMimeType,
                ...(encryptionScheme && { encryptionScheme }),
              },
            ],
          }),
        });

        // For FairPlay, try multiple configurations and key system strings.
        // Safari may accept different combos depending on version.
        const configsToTry: {
          keySystem: string;
          initDataType: string;
          config: MediaKeySystemConfiguration[];
        }[] = [];

        if (isFairplay) {
          configsToTry.push({
            keySystem: "com.apple.fps",
            initDataType: "sinf",
            config: [buildConfig(["sinf"], "cbcs")],
          });
        } else {
          configsToTry.push({
            keySystem: this.keySystems[candidate.drmSystem.systemID],
            initDataType: "cenc",
            config: [buildConfig(["cenc"])],
          });
        }

        for (const attempt of configsToTry) {
          try {
            this.logger.info(
              `Trying ${attempt.keySystem} with config: ${JSON.stringify(attempt.config)}`,
            );
            access = await navigator.requestMediaKeySystemAccess(
              attempt.keySystem,
              attempt.config,
            );
            selectedSystemID = candidate.drmSystem.systemID;
            selectedDrmSystem = candidate.drmSystem;
            selectedInitDataType = attempt.initDataType;
            this.activeDrmLabel = this.drmDisplayLabel(selectedSystemID);
            const resolvedConfig = access.getConfiguration();
            this.logger.info(
              `DRM accepted: keySystem=${attempt.keySystem}, initDataType=${attempt.initDataType}, resolvedConfig=${JSON.stringify(resolvedConfig)}`,
            );
            break;
          } catch (e) {
            this.logger.info(
              `Config rejected for ${attempt.keySystem}: ${e instanceof Error ? e.message : e}`,
            );
          }
        }

        if (access) {
          break;
        }
        this.logger.error(
          `Unable to setup DRM system ${this.drmSystems[candidate.drmSystem.systemID] ?? candidate.drmSystem.systemID}`,
        );
      }

      if (
        !access ||
        !selectedSystemID ||
        !selectedDrmSystem ||
        !selectedInitDataType
      ) {
        this.logger.error("No supported DRM system found");
        return false;
      }

      const keys = await access.createMediaKeys();
      const videoElement = document.getElementById(
        "videoPlayer",
      ) as HTMLVideoElement;

      // FairPlay requires a server certificate before key sessions can work
      if (
        selectedSystemID === this.fairplay &&
        selectedDrmSystem.certURL?.url
      ) {
        this.logger.info(
          `Fetching FairPlay server certificate from ${selectedDrmSystem.certURL.url}`,
        );
        const certResponse = await fetch(selectedDrmSystem.certURL.url);
        if (!certResponse.ok) {
          this.logger.error(
            `Failed to fetch FairPlay certificate: ${certResponse.statusText}`,
          );
          return false;
        }
        const certData = await certResponse.arrayBuffer();
        await keys.setServerCertificate(new Uint8Array(certData));
        this.logger.info("FairPlay server certificate set successfully");
      }

      await videoElement.setMediaKeys(keys);

      // FairPlay does not have PSSH data in the catalog/manifest.
      // Instead, init data arrives via the "encrypted" event on the video
      // element when encrypted media segments are appended to the MSE
      // SourceBuffer. We set up an event-driven flow here.
      if (selectedSystemID === this.fairplay) {
        this.logger.info(
          "FairPlay: waiting for encrypted event on video element",
        );
        const drmSystem = selectedDrmSystem;
        const systemID = selectedSystemID;
        videoElement.addEventListener("encrypted", async (event) => {
          this.logger.info(
            `FairPlay encrypted event: initDataType=${event.initDataType}, initData length=${event.initData?.byteLength}`,
          );
          if (!event.initData) {
            this.logger.error("FairPlay encrypted event has no initData");
            return;
          }
          const session = videoElement.mediaKeys?.createSession();
          if (!session) {
            this.logger.error(
              "Failed to create MediaKeySession from encrypted event",
            );
            return;
          }
          session.addEventListener("message", (msg) =>
            this.handleMessage(
              msg as MediaKeyMessageEvent,
              session,
              drmSystem,
              systemID,
            ),
          );
          try {
            await session.generateRequest("sinf", event.initData);
            this.logger.info("FairPlay generateRequest succeeded");
          } catch (e) {
            this.logger.error(`FairPlay generateRequest failed: ${e}`);
          }
        });
        return true;
      }

      // Widevine / PlayReady / ClearKey: proactive flow using PSSH from catalog
      const session = videoElement.mediaKeys?.createSession();
      if (!session) {
        this.logger.error("Failed to create MediaKeySession");
        return false;
      }

      session.addEventListener("message", (msg) =>
        this.handleMessage(
          msg as MediaKeyMessageEvent,
          session,
          selectedDrmSystem,
          selectedSystemID,
        ),
      );

      if (!selectedDrmSystem.pssh) {
        this.logger.error(
          `Failed to find PSSH for DRM system ${this.drmSystems[selectedSystemID]}`,
        );
        return false;
      }
      const initData = this.base64ToArrayBuffer(selectedDrmSystem.pssh);
      this.logger.info("initData", this.arrayBufferToBase64(initData));
      await session.generateRequest(selectedInitDataType, initData);
      return true;
    } catch (e) {
      this.logger.error(`EME Initialization failed: ${e}`);
      return false;
    }
  }

  /**
   * Match contentProtectionRefIDs from the track, to the corresponding contenProtections refIDs
   */
  private selectContentProtections(refIDs: string[]): Array<ContentProtection> {
    const protections: Array<ContentProtection> = [];
    for (const refID of refIDs) {
      const cps = this.catalogManager.getCatalog()?.contentProtections;
      if (cps) {
        for (const cp of cps) {
          if (refID === cp.refID) {
            protections.push(cp);
          }
        }
      }
    }
    return protections;
  }

  /**
   * Handles EME session message calls. Makes a request to the DRM license server and passes that response to EME
   */
  private async handleMessage(
    event: MediaKeyMessageEvent,
    session: MediaKeySession,
    drmSystem: DRMSystem,
    systemID: string,
  ): Promise<void> {
    const licenseURL = drmSystem.laURL?.url;
    if (!licenseURL) {
      this.logger.error(
        "License URL not configured, cannot request license server",
      );
      return;
    }
    let license: BufferSource | undefined;
    if (systemID === this.widevine) {
      license = await this.makeWidevineRequest(event, licenseURL);
    } else if (systemID === this.clearkey) {
      license = await this.makeClearkeyRequest(event, licenseURL);
    } else if (systemID === this.playready) {
      license = await this.makePlayreadyRequest(event, licenseURL);
    } else if (systemID === this.fairplay) {
      license = await this.makeFairplayRequest(event, licenseURL);
    }
    if (!license) {
      this.logger.error("No license found.");
      return;
    }
    try {
      await session.update(license);
      this.logger.info("Successfully updated MediaKeySession with license");
    } catch (e) {
      this.logger.error(`Failed to update MediaKeySession: ${e}`);
    }
  }

  private async makeClearkeyRequest(
    event: MediaKeyMessageEvent,
    licenseUrl: string,
  ): Promise<BufferSource | undefined> {
    const request = JSON.parse(new TextDecoder().decode(event.message)) as {
      kids: string[];
    };
    const response = await fetch(licenseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      this.logger.error(`ClearKey request failed: ${response.statusText}`);
      return;
    }

    interface clearkeyResponse {
      kty: string;
      k: string;
      kid: string;
    }

    const { keys } = (await response.json()) as { keys: clearkeyResponse[] };

    if (keys.length === 0) {
      this.logger.error("No matching ClearKey keys found for requested kids");
      return;
    }
    return new TextEncoder().encode(JSON.stringify({ keys }));
  }

  private async makeWidevineRequest(
    event: MediaKeyMessageEvent,
    licenseUrl: string,
  ): Promise<BufferSource | undefined> {
    const licenseResponse = await fetch(licenseUrl, {
      method: "POST",
      body: event.message,
    });
    return await licenseResponse.arrayBuffer();
  }

  private async makePlayreadyRequest(
    event: MediaKeyMessageEvent,
    licenseUrl: string,
  ): Promise<BufferSource | undefined> {
    const xml = new TextDecoder("utf-16").decode(event.message);
    const dom = new DOMParser().parseFromString(xml, "application/xml");

    // Extract custom HTTP headers from XML
    const headers = new Headers();
    for (const header of Array.from(dom.getElementsByTagName("HttpHeader"))) {
      headers.set(
        header.getElementsByTagName("name")[0].textContent,
        header.getElementsByTagName("value")[0].textContent,
      );
    }

    // Extract and decode the base64 challenge
    const challenge = dom.getElementsByTagName("Challenge")[0].textContent;
    const licenseResponse = await fetch(licenseUrl, {
      method: "POST",
      headers,
      body: this.base64ToArrayBuffer(challenge),
    });
    return await licenseResponse.arrayBuffer();
  }

  private async makeFairplayRequest(
    event: MediaKeyMessageEvent,
    licenseUrl: string,
  ): Promise<BufferSource | undefined> {
    const licenseResponse = await fetch(licenseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: event.message,
    });
    return await this.parseCkcResponse(licenseResponse);
  }

  /**
   * Parse a FairPlay CKC (Content Key Context) response.
   * License servers return CKC in various formats: raw binary, base64 text,
   * XML-wrapped (<ckc>base64</ckc>), or JSON-wrapped ({ckc/CkcMessage/License: base64}).
   */
  private async parseCkcResponse(
    response: Response,
  ): Promise<ArrayBuffer | undefined> {
    const contentType = response.headers.get("content-type") || "";

    // Binary response — return as-is
    if (contentType.includes("application/octet-stream")) {
      return await response.arrayBuffer();
    }

    const text = await response.text();

    // JSON-wrapped CKC
    if (
      contentType.includes("application/json") ||
      text.trimStart()[0] === "{"
    ) {
      try {
        const json = JSON.parse(text) as Record<string, string>;
        const b64 = json["ckc"] ?? json["CkcMessage"] ?? json["License"];
        if (b64) {
          return this.base64ToArrayBuffer(b64);
        }
      } catch {
        this.logger.error("Failed to parse FairPlay JSON CKC response");
        return undefined;
      }
    }

    // XML-wrapped CKC: <ckc>base64</ckc>
    if (contentType.includes("xml") || text.trimStart()[0] === "<") {
      const match = text.match(/<ckc>([\s\S]*?)<\/ckc>/);
      if (match?.[1]) {
        return this.base64ToArrayBuffer(match[1].trim());
      }
    }

    // Plain base64 text
    try {
      return this.base64ToArrayBuffer(text.trim());
    } catch {
      this.logger.error("Failed to decode FairPlay CKC response as base64");
      return undefined;
    }
  }

  /**
   * Setup MediaSource and SourceBuffer for video playback
   * This will initialize shared resources for both audio and video
   */
  private setupVideoPlayback(track: WarpTrack): void {
    this.logger.info("setupVideoPlayback called");

    // Store the video track reference
    this.videoTrack = track;

    const videoEl = document.getElementById("videoPlayer") as HTMLVideoElement;
    if (!videoEl) {
      this.logger.error("Video element not found");
      return;
    }

    // The MsePipeline now drives the metric panels through getLatencySnapshot();
    // hand it the <video> element so it can read currentTime / playbackRate.
    this.msePipeline.attachVideoElement(videoEl);
    this.currentPipeline = this.msePipeline;
    this.refreshMuteLabel?.();
    this.updateEngineLegend();

    // Reset previous source if any
    videoEl.pause();
    videoEl.removeAttribute("src");
    videoEl.srcObject = null;
    videoEl.load();

    // Create the appropriate MediaSource implementation.
    // iOS Safari does not support MediaSource but provides ManagedMediaSource
    // (Safari 17+). ManagedMediaSource must be attached via srcObject.
    if (
      typeof ManagedMediaSource !== "undefined" &&
      typeof MediaSource === "undefined"
    ) {
      this.sharedMediaSource = new ManagedMediaSource();
      this.usingManagedMediaSource = true;
      videoEl.disableRemotePlayback = true;
      // ManagedMediaSource is a valid MediaProvider in Safari, but our type
      // declaration doesn't extend MediaSource (the APIs differ), so we cast.
      videoEl.srcObject = this.sharedMediaSource as unknown as MediaSource;
      this.logger.info(
        "[SharedMediaSource] Using ManagedMediaSource (iOS/Safari)",
      );
    } else {
      this.sharedMediaSource = new MediaSource();
      this.usingManagedMediaSource = false;
      videoEl.src = URL.createObjectURL(this.sharedMediaSource);
      this.logger.info("[SharedMediaSource] Using standard MediaSource");
    }

    // Create and store media segment buffers for video
    this.videoMediaSegmentBuffer = new MediaSegmentBuffer({
      onSegmentReady: (segment) => {
        this.logger.debug(
          `[VideoMediaSegmentBuffer] Segment ready with baseMediaDecodeTime: ${segment.trackInfo.baseMediaDecodeTime}, timescale: ${segment.trackInfo.timescale}`,
        );
      },
    });

    // Create and store media buffer for video
    this.videoMediaBuffer = new MediaBuffer();

    // Setup MediaSource open event
    this.sharedMediaSource.addEventListener("sourceopen", () => {
      this.logger.info(
        `[SharedMediaSource] sourceopen - readyState: ${this.sharedMediaSource?.readyState}`,
      );

      try {
        if (!this.sharedMediaSource) {
          this.logger.error("SharedMediaSource is null");
          return;
        }

        // Create video source buffer
        const videoMimeType = this.msePipeline.generateVideoMimeType(
          track.codec,
        );
        this.logger.debug(
          `[SharedMediaSource] Using video mimeType: ${videoMimeType}`,
        );

        this.videoSourceBuffer =
          this.sharedMediaSource.addSourceBuffer(videoMimeType);
        this.logger.info("[VideoSourceBuffer] Created successfully");
      } catch (e) {
        this.logger.error("Could not add VideoSourceBuffer: " + e);
        return;
      }

      // Setup video source buffer event listeners
      this.videoSourceBuffer?.addEventListener("error", (e) => {
        this.logger.error(`[VideoSourceBuffer] ERROR: ${e}`);
      });

      this.videoSourceBuffer?.addEventListener("abort", () => {
        this.logger.error("[VideoSourceBuffer] ABORT event");
      });

      this.videoSourceBuffer?.addEventListener("update", () => {
        // Update event handler - intentionally empty as we only need to track updateend
      });

      this.videoSourceBuffer?.addEventListener("updateend", () => {
        try {
          const ranges = [];
          for (
            let i = 0;
            i < (this.videoSourceBuffer?.buffered.length || 0);
            i++
          ) {
            ranges.push(
              `[${
                this.videoSourceBuffer?.buffered.start(i).toFixed(2) || "?"
              } - ${this.videoSourceBuffer?.buffered.end(i).toFixed(2) || "?"}]`,
            );
          }
          this.logger.debug(
            `[VideoSourceBuffer] Buffered ranges: ${ranges.join(", ")}`,
          );
        } catch (e) {
          this.logger.error(
            `[VideoSourceBuffer] Error reading buffered ranges: ${e}`,
          );
        }
      });

      // Initialize counter for tracking received video objects
      let videoObjectsReceived = 0;

      // Append CMAF init segment for video (base64-decoded)
      if (!track.initData) {
        this.logger.error("No initData found for video track");
        return;
      }

      const videoInitSegment = this.base64ToArrayBuffer(track.initData);
      this.logger.info(
        `[VideoInitSegment] Decoded init segment: ${videoInitSegment.byteLength} bytes`,
      );

      try {
        if (
          !this.videoMediaBuffer ||
          !this.videoMediaSegmentBuffer ||
          !this.videoSourceBuffer
        ) {
          this.logger.error(
            `[Video] Initialization failed. Missing: ${[
              !this.videoMediaBuffer && "MediaBuffer",
              !this.videoMediaSegmentBuffer && "SegmentBuffer",
              !this.videoSourceBuffer && "SourceBuffer",
            ]
              .filter(Boolean)
              .join(", ")}`,
          );
          return;
        }

        this.msePipeline.processInitSegment(
          videoInitSegment,
          this.videoMediaBuffer,
          this.videoMediaSegmentBuffer,
          this.videoSourceBuffer,
          "Video",
        );
      } catch (e) {
        this.logger.error(
          `[VideoInitSegment] Failed to process audio CMAF init segment: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return;
      }

      // Any previous subscriptions will be managed through the trackSubscriptions map

      // Log the current state of trackSubscriptions before subscribing
      this.logger.info(
        `Current track subscriptions before subscribing: ${this.trackSubscriptions.size}`,
      );

      // Subscribe to the video track and store the subscription
      this.subscribeToVideoTrack(
        track,
        (obj: {
          data: Uint8Array | ArrayBuffer;
          timing?: { baseMediaDecodeTime?: number; timescale?: number };
        }) => {
          try {
            // Check if we have a valid data object
            if (!obj.data) {
              this.logger.error(
                "[VideoMediaBuffer] Received null or undefined data",
              );
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
              if (
                typedArray.byteOffset > 0 ||
                typedArray.byteLength < typedArray.buffer.byteLength
              ) {
                // Create a new ArrayBuffer that contains only the data in this view
                arrayBuffer = typedArray.buffer.slice(
                  typedArray.byteOffset,
                  typedArray.byteOffset + typedArray.byteLength,
                ) as ArrayBuffer;
              } else {
                // Use the buffer directly if it's the full buffer
                arrayBuffer = typedArray.buffer as ArrayBuffer;
              }

              // Replace the original data with the ArrayBuffer for downstream processing
              obj.data = arrayBuffer;
            }
            // Otherwise, it's an invalid type
            else {
              const type = typeof obj.data;
              let constructorName = "unknown";
              try {
                // Safe way to access constructor name
                if (typeof obj.data === "object") {
                  const dataObj: any = obj.data; // Cast to any to bypass TypeScript error
                  if (dataObj.constructor) {
                    constructorName = dataObj.constructor.name;
                  }
                }
              } catch {
                // Ignore any errors when trying to access constructor
              }
              this.logger.error(
                `[VideoMediaBuffer] Received invalid data type: ${type} (${constructorName})`,
              );
              return;
            }

            // Check if the ArrayBuffer is empty
            if (arrayBuffer.byteLength === 0) {
              this.logger.error(
                "[VideoMediaBuffer] Received empty ArrayBuffer (zero bytes)",
              );
              return;
            }

            if (!this.videoMediaBuffer || !this.videoMediaSegmentBuffer) {
              this.logger.error(
                "[VideoMediaBuffer] Video buffers not initialized",
              );
              return;
            }

            // Parse the media segment to extract timing information
            const trackInfo = this.videoMediaBuffer.parseMediaSegment(obj.data);

            // Add timing information to the object
            obj.timing = {
              baseMediaDecodeTime: trackInfo.baseMediaDecodeTime,
              timescale: trackInfo.timescale,
            };

            // Add the media segment to the media segment buffer and get the segment object
            const mediaSegment = this.videoMediaSegmentBuffer.addMediaSegment(
              obj.data,
            );

            // Track buffer level before appending (this is the minimum point)
            this.trackMinimumBufferLevel();

            // Append the segment to the source buffer via mediaSegmentBuffer only
            this.videoMediaSegmentBuffer.appendToSourceBuffer(mediaSegment);

            // Track received video objects
            videoObjectsReceived++;

            // Only log every 10th segment to reduce logging overhead
            if (videoObjectsReceived % 10 === 0) {
              this.logger.debug(
                `[VideoMediaSegmentBuffer] Queued segment with baseMediaDecodeTime: ${trackInfo.baseMediaDecodeTime}`,
              );
            }

            // Only log detailed information every 10 segments to reduce overhead
            if (videoObjectsReceived % 10 === 0 || videoObjectsReceived <= 5) {
              const pendingCount = this.videoMediaSegmentBuffer[
                "pendingSegments"
              ]
                ? this.videoMediaSegmentBuffer["pendingSegments"].length
                : 0;
              this.logger.info(
                `[VideoSegment] Received segment #${videoObjectsReceived} - ${
                  obj.data.byteLength
                } bytes. Segments: ${this.videoMediaSegmentBuffer.getSegmentCount()}, Pending: ${pendingCount}`,
              );

              if (obj.timing) {
                this.logger.debug(
                  `[VideoSegment] Timing info - baseMediaDecodeTime: ${obj.timing.baseMediaDecodeTime}, timescale: ${obj.timing.timescale}`,
                );
              }
            }

            // Track the number of objects received
            this.videoObjectsReceived = videoObjectsReceived;

            // Check if we have enough buffer duration to mark the buffer as ready
            if (!this.videoBufferReady && this.videoMediaSegmentBuffer) {
              const bufferDurationSec =
                this.videoMediaSegmentBuffer.getBufferDuration();
              const bufferDurationMs = bufferDurationSec * 1000;

              if (bufferDurationMs >= this.targetLatencyMs) {
                this.videoBufferReady = true;
                this.logger.info(
                  `[Video] Buffer ready with ${bufferDurationMs.toFixed(
                    0,
                  )}ms duration (${
                    this.videoObjectsReceived
                  } objects), target latency: ${this.targetLatencyMs}ms`,
                );

                // Check if we can start playback (depends on audio buffer state too)
                this.checkBuffersAndStartPlayback();
              }
            }

            // Log video element state (only every 30 segments to avoid excessive logging)
            if (videoObjectsReceived % 30 === 0) {
              this.logger.debug(
                `[Video] readyState: ${
                  videoEl.readyState
                }, currentTime: ${videoEl.currentTime.toFixed(2)}, paused: ${
                  videoEl.paused
                }`,
              );
            }
          } catch (e) {
            this.logger.error(
              `[VideoMediaBuffer] Error parsing media segment: ${e}`,
            );
          }
        },
      );

      // MediaSource event listeners
      this.sharedMediaSource?.addEventListener("sourceended", () => {
        this.logger.debug(
          `[SharedMediaSource] sourceended - readyState: ${this.sharedMediaSource?.readyState}`,
        );
      });

      this.sharedMediaSource?.addEventListener("sourceclose", () => {
        this.logger.info(
          `[SharedMediaSource] sourceclose - readyState: ${this.sharedMediaSource?.readyState}`,
        );
      });

      // Now check if we also need to set up an audio SourceBuffer
      if (this.audioTrack) {
        this.logger.info(
          "[SharedMediaSource] Video setup complete, now setting up audio source buffer",
        );
        this.setupAudioSourceBuffer();
      } else {
        this.logger.info(
          "[SharedMediaSource] Video setup complete, no audio track available",
        );
      }
    });
  }

  /**
   * Subscribe to the selected video track and feed objects to the SourceBuffer
   */
  private async subscribeToVideoTrack(
    track: WarpTrack,
    onObject: (obj: {
      data: Uint8Array | ArrayBuffer;
      timing?: { baseMediaDecodeTime?: number; timescale?: number };
    }) => void,
  ): Promise<void> {
    if (!this.client) {
      this.logger.error("Client not initialized");
      return;
    }

    const namespace = track.namespace || "";
    const trackName = track.name;
    const trackKey = `${namespace}/${trackName}`;

    this.logger.info(`Subscribing to video track: ${trackKey}`);
    this.logger.debug(
      `Current trackSubscriptions size before subscribing: ${this.trackSubscriptions.size}`,
    );

    try {
      // Subscribe to the track and get the track alias
      this.logger.debug("Calling client.subscribeTrack...");
      const trackAlias = await this.client.subscribeTrack(
        namespace,
        trackName,
        (obj: MOQObject) => {
          onObject(obj);
        },
      );
      this.logger.debug(
        `Received track alias: ${trackAlias} from client.subscribeTrack`,
      );

      // Store the track subscription in the trackSubscriptions map
      this.trackSubscriptions.set(trackKey, trackAlias);
      this.logger.debug(
        `Added track to trackSubscriptions map with key: ${trackKey}`,
      );
      this.logger.debug(
        `trackSubscriptions size after adding: ${this.trackSubscriptions.size}`,
      );
      this.logger.debug(
        `Successfully subscribed to video track ${trackKey} with alias ${trackAlias}`,
      );

      // Log all current track subscriptions
      if (this.trackSubscriptions.size > 0) {
        this.logger.info("Current track subscriptions:");
        this.trackSubscriptions.forEach((alias, key) => {
          this.logger.info(`  - ${key}: ${alias}`);
        });
      }

      // Track subscriptions are managed through the trackSubscriptions map
      // Unsubscribing will be handled in the stopPlayback method
    } catch (error) {
      this.logger.error(
        `Error subscribing to video track ${trackKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }

  /**
   * Decode base64 to ArrayBuffer
   */
  private isSafari(): boolean {
    const ua = navigator.userAgent;
    return (
      ua.includes("Safari") &&
      !ua.includes("Chrome") &&
      !ua.includes("Chromium")
    );
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  private base64URLToArrayBuffer(base64url: string): ArrayBuffer {
    let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4 !== 0) {
      base64 += "=";
    }
    return this.base64ToArrayBuffer(base64);
  }

  private arrayBufferToBase64Url(buffer: BufferSource): string {
    const bytes =
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  private arrayBufferToBase64(buffer: BufferSource): string {
    const bytes =
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/=+$/, "");
  }

  /**
   * Subscribe to a track
   * @param track The track to subscribe to
   */
  private async subscribeToTrack(track: WarpTrack): Promise<void> {
    if (!this.client || !this.connection) {
      this.logger.error("Cannot subscribe to track: Not connected");
      return;
    }

    try {
      const namespace = track.namespace || "";
      const trackName = track.name;

      this.logger.info(`Subscribing to track: ${namespace}/${trackName}`);

      // Subscribe to the track
      // The client.subscribeTrack method will internally call getNextRequestId()
      // to ensure a unique request ID is used for this subscription
      const trackAlias = await this.client.subscribeTrack(
        namespace,
        trackName,
        (obj: MOQObject) => {
          this.logger.debug(
            `Received object for track ${trackName} with size ${obj.data.byteLength} bytes`,
          );
          // Here you would handle the track data, e.g., decode and play video/audio
        },
      );

      // Store the subscription
      this.trackSubscriptions.set(`${namespace}/${trackName}`, trackAlias);
      this.logger.info(
        `Subscribed to track ${namespace}/${trackName} with alias ${trackAlias}`,
      );
    } catch (error) {
      this.logger.error(
        `Error subscribing to track: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Setup MediaSource and SourceBuffer for audio playback
   * This will share the video element and MediaSource with the video track
   */
  private setupAudioPlayback(track: WarpTrack): void {
    this.logger.debug("setupAudioPlayback called");

    // Store the audio track reference
    this.audioTrack = track;

    // Log audio track information
    this.logger.info(`Setting up audio playback for track: ${track.name}`);
    this.logger.info(`Audio codec: ${track.codec || "mp4a.40.2"}`);
    this.logger.info(`Audio MIME type: ${track.mimeType || "audio/mp4"}`);

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
        this.logger.debug(
          `[AudioMediaSegmentBuffer] Segment ready with baseMediaDecodeTime: ${segment.trackInfo.baseMediaDecodeTime}, timescale: ${segment.trackInfo.timescale}`,
        );
      },
    });

    // Get the video element (we'll use the same element for both audio and video)
    const videoEl = document.getElementById("videoPlayer") as HTMLVideoElement;
    if (!videoEl) {
      this.logger.error("Video element not found, cannot setup audio");
      return;
    }

    // Check if MediaSource is already set up (from video setup).
    // Standard MediaSource uses a blob: URL, ManagedMediaSource uses srcObject.
    const mediaSourceAttached = this.usingManagedMediaSource
      ? videoEl.srcObject !== null
      : videoEl.src && videoEl.src.startsWith("blob:");
    if (!mediaSourceAttached) {
      this.logger.info(
        "MediaSource not set up yet. Audio setup should happen after video setup.",
      );
      return;
    }

    // Check if the MediaSource is open and ready for adding source buffers
    if (this.sharedMediaSource?.readyState === "open") {
      this.logger.info(
        "[SharedMediaSource] MediaSource is open, setting up audio source buffer",
      );
      this.setupAudioSourceBuffer();
    } else {
      this.logger.warn(
        "[SharedMediaSource] MediaSource not open yet, audio source buffer will be set up when MediaSource opens",
      );
      // The video sourceopen handler will call setupAudioSourceBuffer
    }
  }

  /**
   * Set up the audio source buffer in the shared MediaSource
   * This is called from either setupAudioPlayback or the video MediaSource sourceopen handler
   */
  private setupAudioSourceBuffer(): void {
    if (!this.audioTrack) {
      this.logger.error(
        "[AudioSourceBuffer] No audio track available for setup",
      );
      return;
    }

    if (!this.sharedMediaSource) {
      this.logger.error(
        "[AudioSourceBuffer] Shared MediaSource not initialized",
      );
      return;
    }

    if (this.sharedMediaSource.readyState !== "open") {
      this.logger.error(
        `[AudioSourceBuffer] Cannot add audio source buffer - MediaSource is in state: ${this.sharedMediaSource.readyState}`,
      );
      return;
    }

    if (this.audioSourceBuffer) {
      this.logger.warn(
        "[AudioSourceBuffer] Audio source buffer already initialized",
      );
      return;
    }

    try {
      // Create audio source buffer
      const audioMimeType = this.msePipeline.generateAudioMimeType(
        this.audioTrack.codec,
      );
      this.logger.info(
        `[AudioSourceBuffer] Using audio mimeType: ${audioMimeType}`,
      );

      this.audioSourceBuffer =
        this.sharedMediaSource.addSourceBuffer(audioMimeType);
      this.logger.info("[AudioSourceBuffer] Created successfully");
    } catch (e) {
      this.logger.error(
        `[AudioSourceBuffer] Could not add audio source buffer: ${e}`,
      );
      return;
    }

    // Set up event listeners for audio source buffer
    this.audioSourceBuffer.addEventListener("error", (e) => {
      this.logger.error(`[AudioSourceBuffer] ERROR: ${e}`);
    });

    this.audioSourceBuffer.addEventListener("abort", () => {
      this.logger.error("[AudioSourceBuffer] ABORT event");
    });

    this.audioSourceBuffer.addEventListener("update", () => {
      // Update event handler - intentionally empty as we only need to track updateend
    });

    this.audioSourceBuffer.addEventListener("updateend", () => {
      try {
        const ranges = [];
        for (
          let i = 0;
          i < (this.audioSourceBuffer?.buffered.length || 0);
          i++
        ) {
          ranges.push(
            `[${
              this.audioSourceBuffer?.buffered.start(i).toFixed(2) || "?"
            } - ${this.audioSourceBuffer?.buffered.end(i).toFixed(2) || "?"}]`,
          );
        }
        this.logger.debug(
          `[AudioSourceBuffer] Buffered ranges: ${ranges.join(", ")}`,
        );
      } catch (e) {
        this.logger.error(
          `[AudioSourceBuffer] Error reading buffered ranges: ${e}`,
        );
      }
    });

    // Set the audio source buffer in the media segment buffer
    if (!this.audioMediaSegmentBuffer) {
      this.logger.error(
        "[AudioSourceBuffer] Audio media segment buffer not initialized",
      );
      return;
    }

    this.audioMediaSegmentBuffer.setSourceBuffer(this.audioSourceBuffer);

    // Process audio init segment if available
    if (!this.audioTrack.initData) {
      this.logger.error("[AudioInitSegment] No initData found for audio track");
      return;
    }

    try {
      const audioInitSegment = this.base64ToArrayBuffer(
        this.audioTrack.initData,
      );
      this.logger.info(
        `[AudioInitSegment] Decoded init segment: ${audioInitSegment.byteLength} bytes`,
      );

      if (
        !this.audioMediaBuffer ||
        !this.audioMediaSegmentBuffer ||
        !this.audioSourceBuffer
      ) {
        this.logger.info(
          `[Audio] Initialization failed. Missing: ${[
            !this.audioMediaBuffer && "MediaBuffer",
            !this.audioMediaSegmentBuffer && "SegmentBuffer",
            !this.audioSourceBuffer && "SourceBuffer",
          ]
            .filter(Boolean)
            .join(", ")}`,
        );
        return;
      }

      this.msePipeline.processInitSegment(
        audioInitSegment,
        this.audioMediaBuffer,
        this.audioMediaSegmentBuffer,
        this.audioSourceBuffer,
        "Audio",
      );

      // Subscribe to the audio track now that we're ready to receive data
      this.subscribeToAudioTrack();
    } catch (e) {
      this.logger.error(
        `[AudioInitSegment] Failed to process audio CMAF init segment: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Subscribe to the audio track
   * This is called once the audio source buffer is set up and ready
   */
  private subscribeToAudioTrack(): void {
    if (!this.audioTrack) {
      this.logger.error(
        "[AudioTrackSubscription] No audio track to subscribe to",
      );
      return;
    }

    const namespace = this.audioTrack.namespace || "";
    const trackName = this.audioTrack.name;
    const trackKey = `${namespace}/${trackName}`;

    this.logger.info(
      `[AudioTrackSubscription] Subscribing to audio track: ${trackKey}`,
    );

    if (!this.client) {
      this.logger.error("[AudioTrackSubscription] Client not initialized");
      return;
    }

    // Define callback function for handling audio objects
    const onAudioObject = (obj: {
      data: Uint8Array | ArrayBuffer;
      timing?: { baseMediaDecodeTime?: number; timescale?: number };
    }) => {
      try {
        // Check if we have a valid data object
        if (!obj.data) {
          this.logger.error(
            "[AudioMediaBuffer] Received null or undefined data",
          );
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
          if (
            typedArray.byteOffset > 0 ||
            typedArray.byteLength < typedArray.buffer.byteLength
          ) {
            // Create a new ArrayBuffer that contains only the data in this view
            arrayBuffer = typedArray.buffer.slice(
              typedArray.byteOffset,
              typedArray.byteOffset + typedArray.byteLength,
            ) as ArrayBuffer;
          } else {
            // Use the buffer directly if it's the full buffer
            arrayBuffer = typedArray.buffer as ArrayBuffer;
          }

          // Replace the original data with the ArrayBuffer for downstream processing
          obj.data = arrayBuffer;
        }
        // Otherwise, it's an invalid type
        else {
          const type = typeof obj.data;
          let constructorName = "unknown";
          try {
            // Safe way to access constructor name
            if (typeof obj.data === "object") {
              const dataObj: any = obj.data; // Cast to any to bypass TypeScript error
              if (dataObj.constructor) {
                constructorName = dataObj.constructor.name;
              }
            }
          } catch {
            // Ignore any errors when trying to access constructor
          }
          this.logger.info(
            `[AudioMediaBuffer] Received invalid data type: ${type} (${constructorName})`,
          );
          return;
        }

        // Check if the ArrayBuffer is empty
        if (arrayBuffer.byteLength === 0) {
          this.logger.warn(
            "[AudioMediaBuffer] Received empty ArrayBuffer (zero bytes)",
          );
          return;
        }

        // Make sure audio buffers are initialized
        if (!this.audioMediaBuffer || !this.audioMediaSegmentBuffer) {
          this.logger.error("[AudioMediaBuffer] Audio buffers not initialized");
          return;
        }

        // Parse the media segment to extract timing information
        const trackInfo = this.audioMediaBuffer.parseMediaSegment(obj.data);

        // Add timing information to the object
        obj.timing = {
          baseMediaDecodeTime: trackInfo.baseMediaDecodeTime,
          timescale: trackInfo.timescale,
        };

        // Add the media segment to the media segment buffer and get the segment object
        const mediaSegment = this.audioMediaSegmentBuffer.addMediaSegment(
          obj.data,
        );

        // Track buffer level before appending (this is the minimum point)
        this.trackMinimumBufferLevel();

        // Append the segment to the source buffer via mediaSegmentBuffer
        this.audioMediaSegmentBuffer.appendToSourceBuffer(mediaSegment);

        // Track the number of audio objects received
        this.audioObjectsReceived++;

        // Log timing information periodically (not for every segment to avoid too much logging)
        if (Math.random() < 0.1) {
          // Log approximately 10% of segments
          this.logger.debug(
            `[AudioMediaBuffer] Processed segment with baseMediaDecodeTime: ${trackInfo.baseMediaDecodeTime}, timescale: ${trackInfo.timescale}`,
          );

          // If we have both audio and video buffers, log their states
          if (this.videoMediaSegmentBuffer && this.audioMediaSegmentBuffer) {
            const videoDuration =
              this.videoMediaSegmentBuffer.getBufferDuration();
            const audioDuration =
              this.audioMediaSegmentBuffer.getBufferDuration();
            this.logger.debug(
              `[Buffer] Video duration: ${videoDuration.toFixed(
                2,
              )}s, Audio duration: ${audioDuration.toFixed(
                2,
              )}s, Objects - Video: ${this.videoObjectsReceived}, Audio: ${
                this.audioObjectsReceived
              }`,
            );
          }
        }

        // Check if we have enough buffer duration to mark the buffer as ready
        if (!this.audioBufferReady && this.audioMediaSegmentBuffer) {
          const bufferDurationSec =
            this.audioMediaSegmentBuffer.getBufferDuration();
          const bufferDurationMs = bufferDurationSec * 1000;

          if (bufferDurationMs >= this.targetLatencyMs) {
            this.audioBufferReady = true;
            this.logger.debug(
              `[Audio] Buffer ready with ${bufferDurationMs.toFixed(
                0,
              )}ms duration (${
                this.audioObjectsReceived
              } objects), target latency: ${this.targetLatencyMs}ms`,
            );

            // Check if we can start playback (depends on video buffer state too)
            this.checkBuffersAndStartPlayback();
          }
        }
      } catch (e) {
        this.logger.error(
          `[AudioMediaBuffer] Error processing audio segment: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    };

    // Subscribe to the track and store the subscription
    this.client
      .subscribeTrack(namespace, trackName, onAudioObject)
      .then((trackAlias) => {
        this.trackSubscriptions.set(trackKey, trackAlias);
        this.logger.info(
          `[AudioTrackSubscription] Successfully subscribed to audio track ${trackKey} with alias ${trackAlias}`,
        );
      })
      .catch((error) => {
        this.logger.error(
          `[AudioTrackSubscription] Error subscribing to audio track ${trackKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
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

    const videoEl = document.getElementById("videoPlayer") as HTMLVideoElement;
    if (!videoEl) {
      this.logger.error("[Sync] Video element not found");
      return;
    }

    // Check for case where only video track is available (no audio)
    if (!this.audioTrack && this.videoBufferReady) {
      this.logger.info("[Sync] Only video track available, starting playback");
      this.startVideoOnlyPlayback(videoEl);
      return;
    }

    // Check for case where only audio track is available (no video)
    if (!this.videoTrack && this.audioBufferReady) {
      this.logger.info("[Sync] Only audio track available, starting playback");
      this.startAudioOnlyPlayback(videoEl);
      return;
    }

    // If both tracks are available, we need both buffers to be ready
    if (this.videoBufferReady && this.audioBufferReady) {
      this.logger.info(
        "[Sync] Both audio and video buffers are ready, starting synchronized playback",
      );
      this.startSynchronizedPlayback(videoEl);
    } else {
      // Log the buffer status
      this.logger.warn(
        `[Sync] Buffers not ready yet - Video: ${
          this.videoBufferReady ? "Ready" : "Not ready"
        }, Audio: ${this.audioBufferReady ? "Ready" : "Not ready"}`,
      );

      if (this.videoMediaSegmentBuffer && this.audioMediaSegmentBuffer) {
        const videoDuration = this.videoMediaSegmentBuffer.getBufferDuration();
        const audioDuration = this.audioMediaSegmentBuffer.getBufferDuration();
        const videoMs = videoDuration * 1000;
        const audioMs = audioDuration * 1000;
        this.logger.info(
          `[Sync] Buffer duration - Video: ${videoDuration.toFixed(
            2,
          )}s (${videoMs.toFixed(0)}ms), Audio: ${audioDuration.toFixed(
            2,
          )}s (${audioMs.toFixed(0)}ms), Target latency: ${
            this.targetLatencyMs
          }ms`,
        );
      }
    }
  }

  /**
   * Start playback with only a video track
   */
  private startVideoOnlyPlayback(videoEl: HTMLVideoElement): void {
    if (!this.videoSourceBuffer) {
      this.logger.error("[Sync] Video source buffer not initialized");
      return;
    }

    if (this.videoSourceBuffer.buffered.length === 0) {
      this.logger.error("[Sync] Video buffer is empty, cannot start playback");
      return;
    }

    // Set the current time to the start of the buffer
    videoEl.currentTime = this.videoSourceBuffer.buffered.start(0);

    // Start playback
    videoEl
      .play()
      .then(() => {
        this.playbackStarted = true;
        this.logger.info("[Sync] Video-only playback started successfully");
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
      this.logger.error("[Sync] Audio source buffer not initialized");
      return;
    }

    if (this.audioSourceBuffer.buffered.length === 0) {
      this.logger.error("[Sync] Audio buffer is empty, cannot start playback");
      return;
    }

    // Set the current time to the start of the buffer
    videoEl.currentTime = this.audioSourceBuffer.buffered.start(0);

    // Start playback
    videoEl
      .play()
      .then(() => {
        this.playbackStarted = true;
        this.logger.info("[Sync] Audio-only playback started successfully");
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
      this.logger.error("[Sync] Source buffers not initialized");
      return;
    }

    if (
      this.videoSourceBuffer.buffered.length === 0 ||
      this.audioSourceBuffer.buffered.length === 0
    ) {
      this.logger.error(
        "[Sync] One or both buffers are empty, cannot start playback",
      );
      return;
    }

    try {
      // Find common buffered range
      const videoStart = this.videoSourceBuffer.buffered.start(0);
      const videoEnd = this.videoSourceBuffer.buffered.end(
        this.videoSourceBuffer.buffered.length - 1,
      );
      const audioStart = this.audioSourceBuffer.buffered.start(0);
      const audioEnd = this.audioSourceBuffer.buffered.end(
        this.audioSourceBuffer.buffered.length - 1,
      );

      // Get the latest start time and earliest end time
      const commonStart = Math.max(videoStart, audioStart);
      const commonEnd = Math.min(videoEnd, audioEnd);

      if (commonStart >= commonEnd) {
        this.logger.error(
          `[Sync] No common buffered range - Video: [${videoStart.toFixed(
            2,
          )}-${videoEnd.toFixed(2)}], Audio: [${audioStart.toFixed(
            2,
          )}-${audioEnd.toFixed(2)}]`,
        );
        return;
      }

      this.logger.info(
        `[Sync] Common buffered range: [${commonStart.toFixed(
          2,
        )}-${commonEnd.toFixed(2)}]`,
      );

      // Set the current time to the common start plus a small offset
      // This ensures we have some buffer ahead and avoids potential timing issues
      const startOffset = 0.1; // 100ms offset from the start
      const playbackStartTime = commonStart + startOffset;

      // Make sure we don't exceed the common end
      if (playbackStartTime >= commonEnd) {
        this.logger.error(
          `[Sync] Start position (${playbackStartTime.toFixed(
            2,
          )}) exceeds common range end (${commonEnd.toFixed(2)})`,
        );
        return;
      }

      // Set up error handling
      videoEl.addEventListener(
        "error",
        this.handleVideoElementError.bind(this),
      );

      // Add event listener for stalled events
      videoEl.addEventListener("stalled", () => {
        this.logger.warn("[Playback] Stalled event detected");
        this.playbackStalled = true;
        this.recoverFromBufferUnderrun();
      });

      // Add event listener for waiting events
      videoEl.addEventListener("waiting", () => {
        this.logger.warn("[Playback] Waiting for data");
        // No immediate recovery action for waiting, just log
      });

      // Add event listener for monitoring synchronization
      videoEl.addEventListener("timeupdate", this.monitorSync.bind(this));

      // Set the current time and start playback
      videoEl.currentTime = playbackStartTime;

      // Start playback
      videoEl
        .play()
        .then(() => {
          this.playbackStarted = true;
          this.logger.info(
            `[Sync] Synchronized playback started at ${playbackStartTime.toFixed(
              2,
            )}s`,
          );
        })
        .catch((e) => {
          this.logger.error(
            `[Sync] Error starting synchronized playback: ${e}`,
          );
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
    if (Math.random() > 0.05) {
      // Only execute about 5% of the time
      return;
    }

    const videoEl = document.getElementById("videoPlayer") as HTMLVideoElement;
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
          if (
            currentTime >= this.videoSourceBuffer.buffered.start(i) &&
            currentTime < this.videoSourceBuffer.buffered.end(i)
          ) {
            videoBufferAhead =
              this.videoSourceBuffer.buffered.end(i) - currentTime;
            break;
          }
        }
      }

      if (this.audioSourceBuffer) {
        for (let i = 0; i < this.audioSourceBuffer.buffered.length; i++) {
          if (
            currentTime >= this.audioSourceBuffer.buffered.start(i) &&
            currentTime < this.audioSourceBuffer.buffered.end(i)
          ) {
            audioBufferAhead =
              this.audioSourceBuffer.buffered.end(i) - currentTime;
            break;
          }
        }
      }

      // Store buffer levels for UI updating
      this.lastVideoBufferAhead = videoBufferAhead;
      this.lastAudioBufferAhead = audioBufferAhead;

      // Log buffer ahead information (but not too frequently)
      if (Math.random() < 0.2) {
        // Only log about 20% of the time within that 5% sample
        this.logger.info(
          `[Sync] Buffer ahead - Video: ${videoBufferAhead.toFixed(
            2,
          )}s, Audio: ${audioBufferAhead.toFixed(2)}s`,
        );
      }

      // Check buffer health and attempt recovery if needed
      this.checkBufferHealth(videoBufferAhead, audioBufferAhead);

      // Only perform sync adjustment if both audio and video are active
      // AND if the buffer health check didn't already adjust the playback rate
      if (this.videoSourceBuffer && this.audioSourceBuffer) {
        // Simple playback rate adjustment based on buffer difference
        // This helps compensate for the slightly fluctuating audio segment durations
        const bufferDifference = Math.abs(videoBufferAhead - audioBufferAhead);

        if (bufferDifference > 0.5) {
          // If buffers are more than 500ms apart
          // Only adjust for sync if we're not already adjusting for buffer health
          const currentRate = videoEl.playbackRate;

          if (videoBufferAhead > audioBufferAhead) {
            // Video is ahead, slow down slightly - but respect buffer health decisions
            const syncRate = 0.9;
            if (currentRate > syncRate && currentRate <= 1.0) {
              videoEl.playbackRate = syncRate;
              this.logger.info(
                `[Sync] Slowing down playback to ${syncRate.toFixed(
                  2,
                )}x to help sync`,
              );
              this.updatePlaybackRateDisplay();
            }
          } else {
            // Audio is ahead, speed up slightly - but respect buffer health decisions
            const syncRate = 1.1;
            if (currentRate < syncRate && currentRate >= 1.0) {
              videoEl.playbackRate = syncRate;
              this.logger.info(
                `[Sync] Speeding up playback to ${syncRate.toFixed(
                  2,
                )}x to help sync`,
              );
              this.updatePlaybackRateDisplay();
            }
          }
        }
        // Remove the else block that was resetting to normal rate - let buffer health control this
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
   * Paint the Playback-Information cards (Video Buffer, Audio Buffer,
   * Latency, Playback Rate) from a pipeline-supplied snapshot. Used by the
   * WebCodecs LOC path; the MSE path still reads from <video>/SourceBuffer
   * directly further below.
   */
  private renderMetricPanelsFromSnapshot(
    snapshot: {
      currentLatencyMs: number | null;
      videoBufferedAheadS: number;
      audioBufferedAheadS: number;
    },
    playbackRate: number,
  ): void {
    const minimalBufferMs = this.minimalBufferMs;
    const paintBuffer = (
      el: HTMLElement | null,
      ms: number,
      hasTrack: boolean,
    ) => {
      if (!el) {
        return;
      }
      el.textContent = hasTrack ? `${Math.round(ms)} ms` : "N/A";
      if (!hasTrack) {
        el.style.color = "#6b7280";
        if (el.parentElement) {
          el.parentElement.style.backgroundColor = "";
        }
        return;
      }
      if (ms < minimalBufferMs) {
        el.style.color = "#ef4444";
        if (el.parentElement) {
          el.parentElement.style.backgroundColor = "#fee2e2";
        }
      } else if (ms < minimalBufferMs + 50) {
        el.style.color = "#f59e0b";
        if (el.parentElement) {
          el.parentElement.style.backgroundColor = "#fef3c7";
        }
      } else {
        el.style.color = "";
        if (el.parentElement) {
          el.parentElement.style.backgroundColor = "";
        }
      }
    };

    paintBuffer(
      document.getElementById("videoBufferLevel"),
      snapshot.videoBufferedAheadS * 1000,
      this.videoTrack !== null,
    );
    paintBuffer(
      document.getElementById("audioBufferLevel"),
      snapshot.audioBufferedAheadS * 1000,
      this.audioTrack !== null,
    );

    const latencyEl = document.getElementById("playbackLatency");
    if (latencyEl) {
      if (snapshot.currentLatencyMs === null) {
        latencyEl.textContent = "N/A";
        latencyEl.style.color = "#6b7280";
      } else {
        latencyEl.textContent = `${Math.round(snapshot.currentLatencyMs)} ms`;
        latencyEl.style.color = "";
      }
    }

    const rateEl = document.getElementById("playbackRate");
    if (rateEl) {
      rateEl.textContent = `${playbackRate.toFixed(3)}x`;
      // Tri-state coloring matches the legacy MSE indicator so MSE and
      // WebCodecs sessions render identically.
      const delta = Math.abs(playbackRate - 1.0);
      if (delta < 0.005) {
        rateEl.style.color = "#10b981";
      } else if (delta < 0.02) {
        rateEl.style.color = "#f59e0b";
      } else {
        rateEl.style.color = "#ef4444";
      }
    }
  }

  /** Map a DRM system UUID to a human-readable label for the legend overlay. */
  private drmDisplayLabel(systemId: string): string {
    switch (systemId) {
      case this.widevine:
        return "Widevine";
      case this.playready:
        return "PlayReady";
      case this.fairplay:
        return "FairPlay";
      case this.clearkey:
        return "ClearKey";
      default:
        return systemId;
    }
  }

  /**
   * Refresh the top-right overlay listing the active engine, DRM, and the
   * selected video / audio track names. Hidden when no playback is active.
   */
  private updateEngineLegend(): void {
    const el = document.getElementById("engineLegend");
    if (!el) {
      return;
    }
    if (!this.currentPipeline) {
      el.classList.remove("active");
      el.replaceChildren();
      return;
    }

    const engineLabel =
      this.currentPipeline.engine === "webcodecs" ? "WebCodecs" : "MSE";
    const rows: Array<[string, string]> = [];
    if (this.selectedNamespace && this.selectedNamespace.length > 0) {
      rows.push(["Namespace", this.selectedNamespace.join("/")]);
    }
    rows.push(["Engine", engineLabel]);
    rows.push(["DRM", this.activeDrmLabel ?? "None"]);
    if (this.videoTrack?.name) {
      rows.push(["Video", this.videoTrack.name]);
    }
    if (this.audioTrack?.name) {
      rows.push(["Audio", this.audioTrack.name]);
    }

    el.replaceChildren();
    for (const [key, val] of rows) {
      const row = document.createElement("div");
      row.className = "row";
      const k = document.createElement("span");
      k.className = "key";
      k.textContent = `${key}:`;
      const v = document.createElement("span");
      v.className = "val";
      v.textContent = val;
      row.append(k, v);
      el.appendChild(row);
    }
    el.classList.add("active");
  }

  /**
   * Buffer-health rate controller for the WebCodecs pipeline. Mirrors the
   * latency-targeting branches of checkBufferHealth(), but reads/writes
   * through IPlaybackPipeline instead of <video>. No stall-recovery branch:
   * WebCodecs has no native "stalled" state — the decoder just empties.
   */
  private adjustWebCodecsRate(
    pipeline: IPlaybackPipeline,
    snap: {
      currentLatencyMs: number | null;
      videoBufferedAheadS: number;
      audioBufferedAheadS: number;
    },
    currentRate: number,
  ): void {
    if (snap.currentLatencyMs === null) {
      return;
    }

    const minimalBufferSec = this.minimalBufferMs / 1000;
    const targetLatencyMs = this.targetLatencyMs;
    const currentLatencyMs = snap.currentLatencyMs;

    // Use the lower of the two buffers when audio is present, otherwise just
    // video — matches the legacy controller's effectiveMinBuffer semantics.
    const effectiveMinBuffer = this.audioTrack
      ? Math.min(snap.videoBufferedAheadS, snap.audioBufferedAheadS)
      : snap.videoBufferedAheadS;
    const belowMinimalBuffer = effectiveMinBuffer < minimalBufferSec;
    const aboveTargetLatency = currentLatencyMs > targetLatencyMs;
    const belowTargetLatency = currentLatencyMs < targetLatencyMs;

    let newRate: number | null = null;
    if (belowMinimalBuffer) {
      // Buffer underrun risk — slow down to let it grow.
      newRate = 0.97;
    } else if (aboveTargetLatency) {
      // Above target latency — speed up modestly, capped at 1.02.
      const latencyError =
        (currentLatencyMs - targetLatencyMs) / targetLatencyMs;
      const baseGain = 0.03;
      const gainReduction = Math.exp(-Math.abs(latencyError) * 10);
      const effectiveGain = baseGain * (1 - gainReduction * 0.8);
      newRate = Math.min(1.02, 1.0 + latencyError * effectiveGain);
    } else if (belowTargetLatency) {
      // Below target latency — slow down modestly, floored at 0.95.
      const latencyError =
        (targetLatencyMs - currentLatencyMs) / targetLatencyMs;
      const baseGain = 0.05;
      const gainReduction = Math.exp(-Math.abs(latencyError) * 15);
      const effectiveGain = baseGain * (1 - gainReduction * 0.9);
      newRate = Math.max(0.95, 1.0 - latencyError * effectiveGain);
    }

    if (newRate === null) {
      return;
    }
    if (Math.abs(currentRate - newRate) < 0.001) {
      return;
    }
    pipeline.setPlaybackRate(newRate);
    if (Math.random() < 0.1) {
      this.logger.debug(
        `[BufferHealth] WebCodecs rate ${currentRate.toFixed(3)}→${newRate.toFixed(3)}` +
          ` (latency ${currentLatencyMs.toFixed(0)}ms target ${targetLatencyMs}ms,` +
          ` minBuf ${(effectiveMinBuffer * 1000).toFixed(0)}ms)`,
      );
    }
  }

  /**
   * Update the buffer level and playback latency UI elements through the
   * active pipeline's snapshot. Both MsePipeline and WebCodecsLocPipeline
   * implement IPlaybackPipeline, so the UI is engine-agnostic.
   */
  private updateBufferLevelUI(): void {
    const now = Date.now();

    // Only update the UI about twice per second
    if (now - this.lastUpdateTime < 500) {
      return;
    }

    this.lastUpdateTime = now;

    const pipeline = this.currentPipeline;
    if (pipeline && this.playbackStarted) {
      try {
        const snap = pipeline.getLatencySnapshot();
        const rate = pipeline.getPlaybackRate();
        this.renderMetricPanelsFromSnapshot(snap, rate);
        // The legacy MSE controller in checkBufferHealth() runs from
        // monitorSync (timeupdate-driven) and writes videoEl.playbackRate
        // directly. With WebCodecs the <video> never advances, so route the
        // pipeline through a snapshot-based equivalent.
        if (pipeline.engine === "webcodecs") {
          this.adjustWebCodecsRate(pipeline, snap, rate);
        }
      } catch (e) {
        this.logger.error(`[UI] Error updating buffer level UI: ${e}`);
      }
      return;
    }

    // No active pipeline yet — show inactive placeholders.
    const inactive = (id: string) => {
      const el = document.getElementById(id);
      if (!el) {
        return;
      }
      el.textContent = "N/A";
      el.style.color = "#6b7280";
      if (el.parentElement) {
        el.parentElement.style.backgroundColor = "";
      }
    };
    inactive("videoBufferLevel");
    inactive("audioBufferLevel");
    inactive("playbackLatency");
    inactive("playbackRate");
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
