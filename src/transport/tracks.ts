import { ILogger, LoggerFactory } from "../logger";

import { Client } from "./client";
import {
  Location,
  CtrlStream,
  Msg,
  Subscribe,
  SubscribeOk,
  FilterType,
  GroupOrder,
  Message,
} from "./control";
import { Reader, KeyValuePair } from "./stream";
import { TrackAliasRegistry } from "./trackaliasregistry";

// Bigint versions of stream types for comparison
const FETCH_HEADER_BIGINT = 0x05n;
const SUBGROUP_HEADER_START_BIGINT = 0x08n;
const SUBGROUP_HEADER_END_BIGINT = 0x0dn;

// Object received in a data stream
export interface MoQObject {
  trackAlias: bigint;
  location: Location;
  data: Uint8Array;
}

// Callback for receiving objects
export type ObjectCallback = (obj: MoQObject) => void;

// Tracks manager to handle incoming data streams
export class TracksManager {
  private wt: WebTransport;
  private objectCallbacks: Map<string, ObjectCallback[]> = new Map();
  private trackRegistry: TrackAliasRegistry = new TrackAliasRegistry();
  private controlStream: CtrlStream | null = null;
  private nextRequestId: bigint = 0n;
  private client: Client | null = null;
  private logger: ILogger;
  private isClosing: boolean = false;

  constructor(wt: WebTransport, controlStream?: CtrlStream, client?: Client) {
    this.wt = wt;
    this.controlStream = controlStream || null;
    this.client = client || null;
    this.logger = LoggerFactory.getInstance().getLogger("Tracks");
    this.startListeningForStreams();
  }

  /**
   * Set the control stream for sending control messages
   */
  public setControlStream(controlStream: CtrlStream): void {
    this.controlStream = controlStream;
    this.logger.debug("Control stream set for tracks manager");
  }

  /**
   * Set the client for message handling
   */
  public setClient(client: Client): void {
    this.client = client;
    this.logger.debug("Client set for tracks manager");
  }

  /**
   * Get the next request ID (even numbers for client requests)
   */
  private getNextRequestId(): bigint {
    const requestId = this.nextRequestId;
    this.nextRequestId += 2n;
    return requestId;
  }

  /**
   * Start listening for incoming unidirectional streams
   */
  private async startListeningForStreams() {
    this.logger.info("Starting to listen for incoming unidirectional streams");

    try {
      const reader = this.wt.incomingUnidirectionalStreams.getReader();

      while (true) {
        const { value: stream, done } = await reader.read();

        if (done) {
          this.logger.debug("Incoming stream reader is done");
          break;
        }

        // Handle the stream in a separate task
        this.handleIncomingStream(stream).catch((error) => {
          this.logger.error("Error handling incoming stream:", error);
        });
      }
    } catch (error) {
      this.logger.error("Error listening for incoming streams:", error);
    }
  }

  /**
   * Handle an incoming unidirectional stream
   */
  private async handleIncomingStream(stream: ReadableStream<Uint8Array>) {
    this.logger.debug("Received new incoming unidirectional stream");

    const reader = new Reader(new Uint8Array(), stream);

    try {
      // Read the stream type
      const streamType = await reader.u62();
      this.logger.debug(`Incoming Unidirectional Stream. Type: ${streamType}`);

      // Check if this is a SUBGROUP_HEADER stream
      if (
        streamType >= SUBGROUP_HEADER_START_BIGINT &&
        streamType <= SUBGROUP_HEADER_END_BIGINT
      ) {
        await this.handleSubgroupStream(reader, streamType);
      } else if (streamType === FETCH_HEADER_BIGINT) {
        // Handle FETCH_HEADER streams if needed
        this.logger.debug("Received FETCH_HEADER stream (not implemented yet)");
      } else {
        this.logger.warn(`Unknown stream type: ${streamType}`);
      }
    } catch (error) {
      // Suppress errors during shutdown - they are expected
      if (!this.isClosing) {
        this.logger.error("Error processing incoming stream:", error);
      } else {
        this.logger.debug("Stream processing ended during shutdown");
      }
    } finally {
      reader.close();
    }
  }

  /**
   * Handle a SUBGROUP_HEADER stream with automatic buffering and retry
   * Inspired by moqtail's RecvDataStream buffering approach
   */
  private async handleSubgroupStream(reader: Reader, streamType: bigint) {
    try {
      // Read the track alias
      const trackAlias = await reader.u62();

      // Read the group ID
      const groupId = await reader.u62();
      this.logger.debug(`Track alias: ${trackAlias} Group ID: ${groupId}`);

      // Determine subgroup ID based on the stream type
      // According to section 9.4.2, there are 6 defined Type values for SUBGROUP_HEADER (0x08-0x0D)
      let subgroupId: bigint | null = null;
      const hasExtensions =
        streamType === 0x09n || streamType === 0x0bn || streamType === 0x0dn;

      if (streamType === 0x08n || streamType === 0x09n) {
        // Type 0x08-0x09: Subgroup ID is implicitly 0
        subgroupId = 0n;
        this.logger.debug(`Subgroup ID: ${subgroupId} (implicit)`);
      } else if (streamType === 0x0an || streamType === 0x0bn) {
        // Type 0x0A-0x0B: Subgroup ID is the first Object ID (will be set when first object is read)
        this.logger.debug("Subgroup ID will be set to the first Object ID");
      } else if (streamType === 0x0cn || streamType === 0x0dn) {
        // Type 0x0C-0x0D: Subgroup ID is explicitly provided
        subgroupId = await reader.u62();
        this.logger.debug(`Subgroup ID: ${subgroupId} (explicit)`);
      }

      // Read the Publisher Priority (as specified in the SUBGROUP_HEADER format)
      const publisherPriority = await reader.u8();
      this.logger.debug(`Publisher Priority: ${publisherPriority}`);

      // Buffer for objects while waiting for track registration
      const bufferedObjects: MoQObject[] = [];
      const RETRY_INTERVAL_MS = 100;
      const MAX_RETRIES = 5; // 500ms total
      const MAX_BUFFERED_OBJECTS = 50;

      // Process objects in the stream
      let isFirstObject = true;
      while (!(await reader.done())) {
        // Read the object ID
        const objectId = await reader.u62();
        this.logger.debug(`Object ID: ${objectId}`);

        // If this is the first object and subgroupId is null (types 0x0A-0x0B),
        // set the subgroupId to the objectId
        if (isFirstObject && subgroupId === null) {
          subgroupId = objectId;
          this.logger.debug(
            `Subgroup ID set to first Object ID: ${subgroupId}`,
          );
        }
        isFirstObject = false;

        // Handle extension headers if present
        let extensions: Uint8Array | null = null;
        if (hasExtensions) {
          const extensionHeadersLength = await reader.u62();
          if (extensionHeadersLength > 0n) {
            // Convert bigint to number for reading bytes
            const extensionLength = Number(extensionHeadersLength);
            extensions = await reader.read(extensionLength);
            this.logger.debug(
              `Read ${extensionLength} bytes of extension headers`,
            );
          }
        }

        // Read the object payload length
        const payloadLength = await reader.u62();
        this.logger.debug(`Object payload length: ${payloadLength}`);

        // Read object status if payload length is zero
        let objectStatus: bigint | null = null;
        if (payloadLength === 0n) {
          objectStatus = await reader.u62();
          this.logger.debug(`Object status: ${objectStatus}`);
        }

        // Read the object data
        const data =
          payloadLength > 0n
            ? await reader.read(Number(payloadLength))
            : new Uint8Array();
        if (payloadLength > 0n) {
          this.logger.debug(`Read ${data.byteLength} bytes of object data`);
        }

        // Create the MoQObject with additional properties from the improved parsing
        const obj: MoQObject = {
          trackAlias,
          location: {
            group: groupId,
            object: objectId,
            // Include subgroup if available
            ...(subgroupId !== null && { subgroup: subgroupId }),
          },
          data,
          // Include extensions if available
          ...(extensions !== null && { extensions }),
          // Include object status if available
          ...(objectStatus !== null && { status: objectStatus }),
        };

        // Try to deliver immediately with retry logic
        let delivered = false;
        let retryCount = 0;

        while (!delivered && retryCount < MAX_RETRIES) {
          // Check if closing early to exit gracefully
          if (this.isClosing) {
            this.logger.debug(
              `Track ${trackAlias} data discarded during shutdown ` +
                `(buffered ${bufferedObjects.length} objects)`,
            );
            return; // Exit gracefully during shutdown
          }

          const trackInfo =
            this.trackRegistry.getTrackInfoFromAlias(trackAlias);

          if (trackInfo && trackInfo.callbacks.length > 0) {
            // Track registered! Deliver buffered objects first
            if (bufferedObjects.length > 0) {
              this.logger.info(
                `Track ${trackAlias} now registered, delivering ${bufferedObjects.length} buffered objects`,
              );
              for (const bufferedObj of bufferedObjects) {
                for (const callback of trackInfo.callbacks) {
                  callback(bufferedObj);
                }
              }
              bufferedObjects.length = 0; // Clear buffer
            }

            // Deliver current object
            for (const callback of trackInfo.callbacks) {
              callback(obj);
            }
            delivered = true;
          } else {
            // Track not registered yet, buffer and retry
            if (retryCount === 0) {
              this.logger.debug(
                `Track ${trackAlias} not registered yet, buffering object (group=${groupId}, obj=${objectId})`,
              );
              bufferedObjects.push(obj);

              // Enforce buffer size limit
              if (bufferedObjects.length > MAX_BUFFERED_OBJECTS) {
                this.logger.warn(
                  `Buffer overflow for track ${trackAlias}, dropping oldest object ` +
                    `(buffered: ${bufferedObjects.length})`,
                );
                bufferedObjects.shift();
              }
            }

            retryCount++;
            if (retryCount < MAX_RETRIES) {
              this.logger.debug(
                `Retry ${retryCount}/${MAX_RETRIES} for track ${trackAlias} ` +
                  `(buffered: ${bufferedObjects.length})`,
              );
              await new Promise((resolve) =>
                setTimeout(resolve, RETRY_INTERVAL_MS),
              );
              // Check again after waiting in case close() was called during sleep
              if (this.isClosing) {
                this.logger.debug(
                  `Track ${trackAlias} data discarded during shutdown ` +
                    `(buffered ${bufferedObjects.length} objects)`,
                );
                return; // Exit gracefully during shutdown
              }
            } else {
              // Timeout after 500ms
              if (this.isClosing) {
                // During shutdown, this is expected - just log and discard
                this.logger.debug(
                  `Track ${trackAlias} data discarded during shutdown ` +
                    `(buffered ${bufferedObjects.length} objects)`,
                );
                return; // Exit gracefully during shutdown
              } else {
                // Connection is broken, fail the stream
                const errorMsg =
                  `Track ${trackAlias} not registered after ${MAX_RETRIES * RETRY_INTERVAL_MS}ms. ` +
                  `SUBSCRIBE_OK not received in time. Connection may be broken. ` +
                  `(buffered ${bufferedObjects.length} objects that will be discarded)`;

                this.logger.error(errorMsg);
                throw new Error(errorMsg);
              }
            }
          }
        }
      }

      this.logger.debug(
        `Finished processing SUBGROUP_HEADER stream for track ${trackAlias}`,
      );
    } catch (error) {
      // Suppress errors during shutdown - they are expected
      if (!this.isClosing) {
        this.logger.error("Error processing SUBGROUP_HEADER stream:", error);
        throw error;
      } else {
        this.logger.debug(
          "SUBGROUP_HEADER stream processing ended during shutdown",
        );
      }
    }
  }

  /**
   * Register a callback for receiving objects for a specific track
   */
  public registerObjectCallback(
    trackAlias: bigint,
    callback: ObjectCallback,
  ): void {
    const key = trackAlias.toString();
    this.logger.info(
      `Registering object callback for track ${trackAlias} (key: ${key})`,
    );

    // Register the callback in the track registry
    const trackInfo = this.trackRegistry.getTrackInfoFromAlias(trackAlias);
    if (trackInfo) {
      this.trackRegistry.registerCallback(trackAlias, callback);
      this.logger.info(
        `Registered callback in track registry for ${trackInfo.namespace}:${trackInfo.trackName} (alias: ${trackAlias})`,
      );
    }

    // Also register in the legacy objectCallbacks map for backward compatibility
    if (!this.objectCallbacks.has(key)) {
      this.logger.info(`Creating new callback array for track ${trackAlias}`);
      this.objectCallbacks.set(key, []);
    } else {
      const callbacks = this.objectCallbacks.get(key);
      if (callbacks) {
        this.logger.info(
          `Adding to existing callback array for track ${trackAlias}, current count: ${callbacks.length}`,
        );
      }
    }

    const callbacksAfterAdd = this.objectCallbacks.get(key);
    if (!callbacksAfterAdd) {
      throw new Error(
        `Callback array for track ${trackAlias} not found despite being created`,
      );
    }

    callbacksAfterAdd.push(callback);
    this.logger.info(
      `Successfully registered object callback for track ${trackAlias}, new count: ${callbacksAfterAdd.length}`,
    );

    // Log all current callback keys for debugging
    const keys = Array.from(this.objectCallbacks.keys());
    this.logger.debug(`Current registered callback keys: ${keys.join(", ")}`);
  }

  /**
   * Unregister a callback for a specific track
   */
  public unregisterObjectCallback(
    trackAlias: bigint,
    callback: ObjectCallback,
  ): void {
    const key = trackAlias.toString();

    // Unregister from the track registry
    this.trackRegistry.unregisterCallback(trackAlias, callback);

    // Also unregister from the legacy objectCallbacks map for backward compatibility
    if (this.objectCallbacks.has(key)) {
      const callbacks = this.objectCallbacks.get(key);
      if (!callbacks) {
        this.logger.warn(
          `Callback array for track ${trackAlias} was null despite being registered`,
        );
        return;
      }
      const index = callbacks.indexOf(callback);

      if (index !== -1) {
        callbacks.splice(index, 1);
        this.logger.warn(
          `Unregistered object callback for track ${trackAlias} from legacy map`,
        );
      }

      if (callbacks.length === 0) {
        this.objectCallbacks.delete(key);
      }
    }

    const trackInfo = this.trackRegistry.getTrackInfoFromAlias(trackAlias);
    if (trackInfo) {
      this.logger.warn(
        `Unregistered callback for ${trackInfo.namespace}:${trackInfo.trackName} (alias: ${trackAlias})`,
      );
    }
  }

  /**
   * Notify all callbacks registered for a track
   */
  private notifyObjectCallbacks(trackAlias: bigint, obj: MoQObject) {
    const key = trackAlias.toString();
    this.logger.debug(
      `Notifying callbacks for track ${trackAlias} (key: ${key}), object ID: ${obj.location.object}`,
    );

    // First check the track registry for callbacks
    const trackInfo = this.trackRegistry.getTrackInfoFromAlias(trackAlias);
    if (trackInfo && trackInfo.callbacks.length > 0) {
      this.logger.debug(
        `Found ${trackInfo.callbacks.length} callbacks in registry for track ${trackAlias}`,
      );

      for (let i = 0; i < trackInfo.callbacks.length; i++) {
        try {
          this.logger.debug(
            `Executing registry callback #${i + 1} for track ${trackAlias}`,
          );
          trackInfo.callbacks[i](obj);
          this.logger.debug(
            `Successfully executed registry callback #${
              i + 1
            } for track ${trackAlias}`,
          );
        } catch (error) {
          this.logger.error(
            `Error in registry object callback #${
              i + 1
            } for track ${trackAlias}:`,
            error,
          );
        }
      }
    }

    // Also check the legacy objectCallbacks map for backward compatibility
    if (this.objectCallbacks.has(key)) {
      const callbacks = this.objectCallbacks.get(key);
      if (!callbacks) {
        this.logger.warn(
          `Callback array for track ${trackAlias} was null despite being registered`,
        );
        return;
      }
      this.logger.debug(
        `Found ${callbacks.length} callbacks in legacy map for track ${trackAlias}`,
      );

      for (let i = 0; i < callbacks.length; i++) {
        try {
          this.logger.debug(
            `Executing legacy callback #${i + 1} for track ${trackAlias}`,
          );
          callbacks[i](obj);
          this.logger.debug(
            `Successfully executed legacy callback #${
              i + 1
            } for track ${trackAlias}`,
          );
        } catch (error) {
          this.logger.error(
            `Error in legacy object callback #${
              i + 1
            } for track ${trackAlias}:`,
            error,
          );
        }
      }
    } else if (!trackInfo || trackInfo.callbacks.length === 0) {
      this.logger.warn(
        `No callbacks found for track ${trackAlias} (key: ${key})`,
      );

      // Log all current callback keys for debugging
      const keys = Array.from(this.objectCallbacks.keys());
      this.logger.debug(`Current registered callback keys: ${keys.join(", ")}`);
    }
  }

  /**
   * Close the tracks manager and clean up resources
   */
  public close(): void {
    this.logger.debug("Closing tracks manager");
    // Set closing flag to suppress errors from ongoing streams
    this.isClosing = true;
    // Clear all callbacks
    this.objectCallbacks.clear();
    this.trackRegistry.clear();
  }

  /**
   * Subscribe to a track by namespace and track name
   * Returns the track alias that can be used to unsubscribe later
   * @throws Error if control stream is not set
   */
  public async subscribeTrack(
    namespace: string,
    trackName: string,
    callback: ObjectCallback,
  ): Promise<bigint> {
    this.logger.info(`Subscribing to track ${namespace}:${trackName}`);

    if (!this.controlStream) {
      throw new Error("Cannot subscribe: Control stream not set");
    }

    if (!this.client) {
      throw new Error("Cannot subscribe: Client not set");
    }

    // Generate a request ID for this subscription
    const requestId = this.getNextRequestId();

    // Create the subscribe message (draft-14: no trackAlias - publisher assigns it)
    const subscribeMsg: Subscribe = {
      kind: Msg.Subscribe,
      requestId,
      namespace: [namespace],
      name: trackName,
      subscriber_priority: 0,
      group_order: GroupOrder.Publisher,
      forward: true,
      filterType: FilterType.NextGroupStart,
      params: [] as KeyValuePair[],
    };

    this.logger.info(
      `Sending subscribe message for ${namespace}:${trackName} with requestId ${requestId}`,
    );

    try {
      // Store client reference for use in Promise callbacks
      const client = this.client;

      // Set up Promise for SUBSCRIBE_OK response
      const subscribePromise = new Promise<bigint>((resolve, reject) => {
        // Register handler for SUBSCRIBE_OK
        const unregisterOk = client.registerMessageHandler(
          Msg.SubscribeOk,
          requestId,
          (response: Message) => {
            const subscribeOk = response as SubscribeOk;
            this.logger.info(
              `Received SubscribeOk for ${namespace}:${trackName} with requestId ${requestId}, trackAlias ${subscribeOk.trackAlias}`,
            );
            resolve(subscribeOk.trackAlias);
          },
        );

        // Register handler for SUBSCRIBE_ERROR
        const unregisterErr = client.registerMessageHandler(
          Msg.SubscribeError,
          requestId,
          (response: Message) => {
            unregisterOk();
            this.logger.error(
              `Received SubscribeError for ${namespace}:${trackName}: ${JSON.stringify(response)}`,
            );
            reject(new Error(`Subscribe failed: ${JSON.stringify(response)}`));
          },
        );

        // Timeout after 2 seconds
        setTimeout(() => {
          unregisterOk();
          unregisterErr();
          reject(
            new Error(
              `Subscribe timeout (2000ms) for ${namespace}:${trackName} with requestId ${requestId}`,
            ),
          );
        }, 2000);
      });

      // Send the subscribe message
      await this.controlStream.send(subscribeMsg);

      // Wait for SUBSCRIBE_OK (with timeout)
      const trackAlias = await subscribePromise;

      // Register the callback
      // Stream handler will immediately find it and deliver any buffered objects
      this.trackRegistry.registerTrackWithAlias(
        namespace,
        trackName,
        requestId,
        trackAlias,
      );
      this.trackRegistry.registerCallback(trackAlias, callback);

      this.logger.info(
        `Successfully subscribed to ${namespace}:${trackName} with trackAlias ${trackAlias}`,
      );

      return trackAlias;
    } catch (error) {
      this.logger.error(
        `Error subscribing to track ${namespace}:${trackName}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Unsubscribe from a track by track alias
   * @param trackAlias The track alias to unsubscribe from
   * @throws Error if control stream is not set
   */
  public async unsubscribeTrack(trackAlias: bigint): Promise<void> {
    this.logger.info(`Unsubscribing from track with alias ${trackAlias}`);

    if (!this.controlStream) {
      throw new Error("Cannot unsubscribe: Control stream not set");
    }

    if (!this.client) {
      throw new Error("Cannot unsubscribe: Client not set");
    }

    // Get track info from registry if available
    const trackInfo = this.trackRegistry.getTrackInfoFromAlias(trackAlias);
    if (!trackInfo) {
      throw new Error(
        `Cannot unsubscribe: No track info found for alias ${trackAlias}`,
      );
    }

    const trackDescription = `${trackInfo.namespace}:${trackInfo.trackName}`;

    // According to MoQ Transport draft-14, the unsubscribe message must use the same
    // request ID that was used in the original subscribe message
    const requestId = trackInfo.requestId;

    // Need to cast to Message type to satisfy the CtrlStream.send() parameter type
    const unsubscribeMsg = {
      kind: Msg.Unsubscribe,
      requestId,
    } as Message;

    this.logger.info(
      `Sending unsubscribe message for track ${trackDescription} with original requestId ${requestId}`,
    );

    try {
      // Create a Promise that will be resolved after a short delay
      // Note: The MoQ spec doesn't require an acknowledgment for unsubscribe messages,
      // so we'll just wait a short time to allow the message to be sent
      const unsubscribePromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 500); // 500ms delay to allow the message to be sent
      });

      // Send the unsubscribe message
      await this.controlStream.send(unsubscribeMsg);

      // Wait for the unsubscribe to complete (or timeout)
      await unsubscribePromise;

      // Unregister all callbacks for this track
      this.trackRegistry.unregisterAllCallbacks(trackAlias);

      this.logger.info(
        `Successfully unsubscribed from track ${trackDescription}`,
      );
    } catch (error) {
      this.logger.error(
        `Error unsubscribing from track ${trackDescription}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Get track information from track alias
   */
  public getTrackInfo(trackAlias: bigint):
    | {
        namespace: string;
        trackName: string;
        trackAlias: bigint;
        callbacks: ObjectCallback[];
      }
    | undefined {
    return this.trackRegistry.getTrackInfoFromAlias(trackAlias);
  }
}
