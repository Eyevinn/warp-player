import { ILogger, LoggerFactory } from "../logger";

import { Msg, FilterType, Subscribe, CtrlStream, Message } from "./control";
import * as Setup from "./setup";
import * as Stream from "./stream";
import { TracksManager, ObjectCallback } from "./tracks";

export interface ClientConfig {
  url: string;

  // If set, the server fingerprint will be fetched from this URL.
  // This is required to use self-signed certificates with Chrome
  fingerprint?: string;
}

// Type for message handlers based on message kind and request ID
type MessageHandler = (message: Message) => void;

export class Client {
  #fingerprint: Promise<WebTransportHash | undefined>;
  readonly config: ClientConfig;
  // Track the next request ID to use (client IDs are even, starting at 0)
  #nextRequestId: bigint = 0n;
  // Store the trackAlias used for catalog subscription
  // eslint-disable-next-line no-unused-private-class-members
  #catalogTrackAlias: bigint | null = null;
  // Reference to the tracks manager
  #tracksManager: TracksManager | null = null;
  // Logger instance
  private logger: ILogger;

  // Message handling system
  // Maps message kind to a map of request IDs to handlers
  #messageHandlers: Map<Msg, Map<bigint, MessageHandler>> = new Map();

  constructor(config: ClientConfig) {
    this.config = config;
    this.logger = LoggerFactory.getInstance().getLogger("Client");

    this.#fingerprint = this.#fetchFingerprint(config.fingerprint).catch(
      (e) => {
        this.logger.warn(`Failed to fetch fingerprint: ${e}`);
        return undefined;
      },
    );
  }

  // Store announce callbacks
  #announceCallbacks: Set<(namespace: string[]) => void> = new Set();

  async connect(): Promise<Connection> {
    // Create WebTransport options
    const options: WebTransportOptions = {};

    const fingerprint = await this.#fingerprint;
    if (fingerprint) {
      options.serverCertificateHashes = [fingerprint];
      const valueArray =
        fingerprint.value instanceof Uint8Array
          ? fingerprint.value
          : new Uint8Array(fingerprint.value as ArrayBuffer);
      this.logger.debug(
        `Using certificate fingerprint: algorithm=${fingerprint.algorithm}, value=${Array.from(
          valueArray,
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")}`,
      );
    }

    this.logger.info(`Connecting to ${this.config.url}...`);
    const wt = new WebTransport(this.config.url, options);
    await wt.ready;
    this.logger.info("WebTransport connection established");

    const stream = await wt.createBidirectionalStream();
    this.logger.info("Bidirectional stream created");

    const writer = new Stream.Writer(stream.writable);
    const reader = new Stream.Reader(new Uint8Array(), stream.readable);

    const setup = new Setup.Stream(reader, writer);

    // Send the client setup message
    this.logger.info("Sending client setup message");
    await setup.send.client({
      versions: [Setup.Version.DRAFT_11],
    });

    // Receive the server setup message
    this.logger.info("Waiting for server setup message");
    const server = await setup.recv.server();
    this.logger.info("Received server setup:", server);

    if (server.version !== Setup.Version.DRAFT_11) {
      throw new Error(`Unsupported server version: ${server.version}`);
    }

    // Create control stream for handling control messages
    const control = new CtrlStream(reader, writer);
    this.logger.info("Control stream established");

    // Create tracks manager for handling data streams
    this.#tracksManager = new TracksManager(wt, control, this);
    this.logger.info(
      "Tracks manager created with control stream and client reference",
    );

    // Create a Connection object with the client instance to access request ID management
    const connection = new Connection(wt, control, this);

    // Start listening for control messages
    this.#listenForControlMessages(control);

    return connection;
  }

  /**
   * Get the next available request ID and increment for future use
   * According to the MoQ Transport spec, client request IDs are even numbers starting at 0
   * and increment by 2 for each new request
   */
  getNextRequestId(): bigint {
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 2n;
    this.logger.debug(`Generated new request ID: ${requestId}`);
    return requestId;
  }

  async #fetchFingerprint(url?: string): Promise<WebTransportHash | undefined> {
    if (!url) {
      return;
    }

    this.logger.info(`Fetching server certificate fingerprint from ${url}`);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch fingerprint: ${response.status} ${response.statusText}`,
        );
      }
      const hexString = await response.text();
      this.logger.debug(`Fetched fingerprint hex: ${hexString}`);

      // Remove any whitespace
      const cleanHex = hexString.trim();

      const hexBytes = new Uint8Array(cleanHex.length / 2);
      for (let i = 0; i < hexBytes.length; i += 1) {
        hexBytes[i] = parseInt(cleanHex.slice(2 * i, 2 * i + 2), 16);
      }

      return {
        algorithm: "sha-256",
        value: hexBytes,
      };
    } catch (error) {
      this.logger.error(`Failed to fetch fingerprint: ${error}`);
      throw error;
    }
  }

  /**
   * Register a handler for a specific message kind and request ID
   * @param kind The message kind to handle
   * @param requestId The request ID to match
   * @param handler The handler function to call when a matching message is received
   * @returns A function to unregister the handler
   */
  registerMessageHandler(
    kind: Msg,
    requestId: bigint,
    handler: MessageHandler,
  ): () => void {
    this.logger.debug(
      `Registering handler for message kind ${kind} with requestId ${requestId}`,
    );

    // Initialize the map for this message kind if it doesn't exist
    if (!this.#messageHandlers.has(kind)) {
      this.#messageHandlers.set(kind, new Map());
    }

    // Get the map for this message kind
    const handlersForKind = this.#messageHandlers.get(kind);

    // This should never be null since we just initialized it if needed
    if (!handlersForKind) {
      throw new Error(`Handler map for message kind ${kind} not found`);
    }

    // Register the handler for this request ID
    handlersForKind.set(requestId, handler);

    // Return a function to unregister the handler
    return () => {
      this.logger.debug(
        `Unregistering handler for message kind ${kind} with requestId ${requestId}`,
      );
      const handlersMap = this.#messageHandlers.get(kind);
      if (handlersMap) {
        handlersMap.delete(requestId);
      }
    };
  }

  /**
   * Listen for control messages and dispatch them to registered handlers
   */
  async #listenForControlMessages(control: CtrlStream) {
    this.logger.info("Starting to listen for control messages");
    try {
      while (true) {
        const msg = await control.recv();

        if (msg.kind === Msg.Announce) {
          this.logger.info(
            `Received announce message with namespace: ${msg.namespace.join(
              "/",
            )}`,
          );

          // Notify all registered announce callbacks
          this.#announceCallbacks.forEach((callback) => {
            try {
              callback(msg.namespace);
            } catch (error) {
              this.logger.error(
                `Error in announce callback: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          });
        } else if ("requestId" in msg) {
          // For messages with request IDs, check if we have a handler registered
          const requestId = msg.requestId as bigint;
          const handlersForKind = this.#messageHandlers.get(msg.kind);

          if (handlersForKind && handlersForKind.has(requestId)) {
            this.logger.debug(
              `Found handler for message kind ${msg.kind} with requestId ${requestId}`,
            );
            try {
              // Call the handler with the message
              const handler = handlersForKind.get(requestId);
              if (handler) {
                handler(msg);
              } else {
                this.logger.warn(
                  `Handler for message kind ${msg.kind} with requestId ${requestId} was null`,
                );
              }

              // Remove the handler after it's been called (one-time use)
              handlersForKind.delete(requestId);
            } catch (error) {
              this.logger.error(
                `Error in message handler for kind ${
                  msg.kind
                } with requestId ${requestId}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          } else {
            this.logger.debug(
              `No handler found for message kind ${msg.kind} with requestId ${requestId}`,
            );
          }
        } else {
          this.logger.debug(
            `Received message of kind ${msg.kind} without a request ID`,
          );
        }
      }
    } catch (error) {
      // Check if this is a WebTransportError due to session closure
      if (
        error instanceof Error &&
        error.message.includes("session is closed")
      ) {
        this.logger.debug(
          "Control message listener stopped: connection closed",
        );
      } else {
        this.logger.error("Error while listening for control messages:", error);
      }
    }
  }

  /**
   * Subscribe to a track
   * @param subscribeParams Parameters for the subscribe message
   * @returns The track alias assigned to the subscription
   */
  async subscribe(subscribeParams: {
    track_namespace: string;
    track_name: string;
    group_order: number;
    forward: boolean;
    filterType: FilterType;
    startLocation?: any;
    endGroup?: bigint;
    params?: Stream.KeyValuePair[];
  }): Promise<bigint> {
    if (!this.#tracksManager) {
      throw new Error("Cannot subscribe: Tracks manager not initialized");
    }

    // Get a connection to send the subscribe message
    const connection = await this.connect();
    const control = connection.control;

    // Create a subscribe message
    const requestId = connection.getNextRequestId();

    // In the MoQ Transport protocol, the client assigns the track alias
    // We'll use the requestId as the track alias for simplicity
    const trackAlias = requestId;

    const subscribeMsg: Subscribe = {
      kind: Msg.Subscribe,
      requestId,
      trackAlias, // Client assigns the track alias
      namespace: [subscribeParams.track_namespace], // Namespace is an array of strings
      name: subscribeParams.track_name,
      subscriber_priority: 0, // Default priority
      group_order: subscribeParams.group_order,
      forward: subscribeParams.forward,
      filterType: subscribeParams.filterType,
      startLocation: subscribeParams.startLocation,
      endGroup: subscribeParams.endGroup,
      params: subscribeParams.params || [],
    };

    this.logger.info(
      `Subscribing to track: ${subscribeParams.track_namespace}/${subscribeParams.track_name}`,
    );

    // Send the subscribe message
    await control.send(subscribeMsg);

    // Wait for the subscribe response
    const response = await control.recv();

    if (response.kind !== Msg.SubscribeOk) {
      throw new Error(`Subscribe failed: ${JSON.stringify(response)}`);
    }

    this.logger.info(`Subscribed to track with alias: ${trackAlias}`);

    return trackAlias;
  }

  /**
   * Register a callback for objects on a specific track
   * @param trackAlias The track alias to register the callback for
   * @param callback The callback function to call when objects are received
   */
  registerObjectCallback(trackAlias: bigint, callback: ObjectCallback): void {
    if (!this.#tracksManager) {
      throw new Error(
        "Cannot register object callback: Tracks manager not initialized",
      );
    }

    this.logger.info(`Registering object callback for track ${trackAlias}`);
    this.#tracksManager.registerObjectCallback(trackAlias, callback);
  }

  /**
   * Unregister a callback for objects on a specific track
   * @param trackAlias The track alias to unregister the callback for
   * @param callback The callback function to unregister
   */
  unregisterObjectCallback(trackAlias: bigint, callback: ObjectCallback): void {
    if (!this.#tracksManager) {
      throw new Error(
        "Cannot unregister object callback: Tracks manager not initialized",
      );
    }

    this.logger.info(`Unregistering object callback for track ${trackAlias}`);
    this.#tracksManager.unregisterObjectCallback(trackAlias, callback);
  }

  /**
   * Subscribe to a track by namespace and track name
   * @param namespace The namespace of the track
   * @param trackName The name of the track
   * @param callback The callback function to call when objects are received
   * @returns The track alias assigned to the subscription
   */
  async subscribeTrack(
    namespace: string,
    trackName: string,
    callback: ObjectCallback,
  ): Promise<bigint> {
    if (!this.#tracksManager) {
      throw new Error("Cannot subscribe: Tracks manager not initialized");
    }

    this.logger.info(`Client subscribing to track ${namespace}:${trackName}`);
    return this.#tracksManager.subscribeTrack(namespace, trackName, callback);
  }

  /**
   * Unsubscribe from a track by track alias
   * @param trackAlias The track alias to unsubscribe from
   * @returns A promise that resolves when the unsubscribe message has been sent
   */
  async unsubscribeTrack(trackAlias: bigint): Promise<void> {
    if (!this.#tracksManager) {
      throw new Error("Cannot unsubscribe: Tracks manager not initialized");
    }

    this.logger.info(
      `Client unsubscribing from track with alias ${trackAlias}`,
    );
    await this.#tracksManager.unsubscribeTrack(trackAlias);
  }

  /**
   * Register a callback to be notified when an announce message is received
   * @param callback Function that will be called with the namespace when an announce message is received
   * @returns A function to unregister the callback
   */
  registerAnnounceCallback(
    callback: (namespace: string[]) => void,
  ): () => void {
    this.logger.info("Registering announce callback");
    this.#announceCallbacks.add(callback);

    // Return a function to unregister the callback
    return () => {
      this.logger.info("Unregistering announce callback");
      this.#announceCallbacks.delete(callback);
    };
  }

  /**
   * Close the client connection
   */
  close(): void {
    this.logger.info("Closing client connection");
    // Clear all callbacks
    this.#announceCallbacks.clear();

    if (this.#tracksManager) {
      this.#tracksManager.close();
      this.#tracksManager = null;
    }
  }
}

export class Connection {
  // The established WebTransport session
  #wt: WebTransport;
  #control: CtrlStream;
  #client: Client;
  private logger: ILogger;

  constructor(wt: WebTransport, control: CtrlStream, client: Client) {
    this.#wt = wt;
    this.#control = control;
    this.#client = client;
    this.logger = LoggerFactory.getInstance().getLogger("Connection");
  }

  /**
   * Get the control stream for sending messages
   */
  get control(): CtrlStream {
    return this.#control;
  }

  /**
   * Get the next request ID from the client
   */
  getNextRequestId(): bigint {
    return this.#client.getNextRequestId();
  }

  close(code = 0, reason = ""): void {
    this.logger.info(`Closing connection with code ${code}: ${reason}`);
    this.#wt.close({ closeCode: code, reason });
  }

  async closed(): Promise<Error> {
    try {
      await this.#wt.closed;
      return new Error("Connection closed");
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  }
}
