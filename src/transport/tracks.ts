import { ILogger, LoggerFactory } from "../logger";

import { Client } from "./client";
import {
  Location,
  CtrlStream,
  Msg,
  Subscribe,
  SubscribeOk,
  Fetch,
  FetchError,
  FetchTypeStandalone,
  FilterType,
  GroupOrder,
  Message,
} from "./control";
import { Reader, KeyValuePair } from "./stream";
import { TrackAliasRegistry } from "./trackaliasregistry";

// Bigint versions of stream types for comparison
const FETCH_HEADER_BIGINT = 0x05n;

/** Check if a stream type is a valid SUBGROUP_HEADER type.
 * Draft-14: 0x10-0x15, 0x18-0x1D
 * Draft-16: adds 0x30-0x35, 0x38-0x3D (with DEFAULT_PRIORITY bit 0x20)
 */
function isSubgroupStreamType(streamType: bigint): boolean {
  // Strip the DEFAULT_PRIORITY bit (0x20) to normalize
  const low = streamType & 0x1fn;
  return (low >= 0x10n && low <= 0x15n) || (low >= 0x18n && low <= 0x1dn);
}

/** Draft-16: returns true when the DEFAULT_PRIORITY bit (0x20) is set */
function hasDefaultPriority(streamType: bigint): boolean {
  return (streamType & 0x20n) !== 0n;
}

// Object received in a data stream
export interface MOQObject {
  trackAlias: bigint;
  location: Location;
  data: Uint8Array;
  // Raw extension-headers blob: a sequence of moqtransport KVPs concatenated
  // (no count or length prefix between pairs). Present only when the object's
  // stream-type flag indicates extensions. Parse with parseMoqExtensions().
  extensions?: Uint8Array;
  // Object status varint, set when payloadLength == 0 (e.g. END_OF_GROUP).
  status?: bigint;
}

// Callback for receiving objects
export type ObjectCallback = (obj: MOQObject) => void;

// Tracks manager to handle incoming data streams
export class TracksManager {
  private wt: WebTransport;
  private objectCallbacks: Map<string, ObjectCallback[]> = new Map();
  private fetchCallbacks: Map<bigint, ObjectCallback> = new Map();
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
      // Draft-14: 0x10-0x15, 0x18-0x1D
      // Draft-16: adds 0x30-0x35, 0x38-0x3D (DEFAULT_PRIORITY bit)
      if (isSubgroupStreamType(streamType)) {
        await this.handleSubgroupStream(reader, streamType);
      } else if (streamType === FETCH_HEADER_BIGINT) {
        await this.handleFetchStream(reader);
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
      // Strip the DEFAULT_PRIORITY bit (0x20) to get the base type for SID mode
      // Bit 0: has extensions, Bits 1-2: SID mode (00=zero, 01=firstObjID, 10=explicit)
      // Bit 3: contains End of Group, Bit 5: DEFAULT_PRIORITY (draft-16)
      let subgroupId: bigint | null = null;
      const normalizedType = streamType & 0x1fn; // strip DEFAULT_PRIORITY bit
      const hasExtensions = (normalizedType & 0x01n) === 0x01n;
      const baseType = normalizedType & 0x07n;

      if (baseType === 0x00n || baseType === 0x01n) {
        // ZeroSID: Subgroup ID is implicitly 0
        subgroupId = 0n;
        this.logger.debug(`Subgroup ID: ${subgroupId} (implicit zero)`);
      } else if (baseType === 0x02n || baseType === 0x03n) {
        // NoSID: Subgroup ID is the first Object ID
        this.logger.debug("Subgroup ID will be set to the first Object ID");
      } else if (baseType === 0x04n || baseType === 0x05n) {
        // ExplicitSID: Subgroup ID is explicitly provided
        subgroupId = await reader.u62();
        this.logger.debug(`Subgroup ID: ${subgroupId} (explicit)`);
      }

      // Read Publisher Priority unless DEFAULT_PRIORITY bit is set (draft-16)
      let publisherPriority = 0;
      if (hasDefaultPriority(streamType)) {
        this.logger.debug(
          "Publisher Priority: default (omitted, DEFAULT_PRIORITY bit set)",
        );
      } else {
        publisherPriority = await reader.u8();
        this.logger.debug(`Publisher Priority: ${publisherPriority}`);
      }

      // Buffer for objects while waiting for track registration
      const bufferedObjects: MOQObject[] = [];
      const RETRY_INTERVAL_MS = 100;
      const MAX_RETRIES = 5; // 500ms total
      const MAX_BUFFERED_OBJECTS = 50;

      // Process objects in the stream
      // Object IDs are delta-encoded in subgroup streams (draft-14+):
      // First object: objectId = delta
      // Subsequent objects: objectId = prevObjectId + delta + 1
      let objectCount = 0;
      let prevObjectId = 0n;
      while (!(await reader.done())) {
        // Read the object ID delta
        const objectIdDelta = await reader.u62();
        let objectId: bigint;
        if (objectCount > 0) {
          objectId = prevObjectId + objectIdDelta + 1n;
        } else {
          objectId = objectIdDelta;
        }
        prevObjectId = objectId;
        objectCount++;
        this.logger.debug(`Object ID: ${objectId} (delta: ${objectIdDelta})`);

        // If this is the first object and subgroupId is null (types 0x0A-0x0B),
        // set the subgroupId to the objectId
        if (objectCount === 1 && subgroupId === null) {
          subgroupId = objectId;
          this.logger.debug(
            `Subgroup ID set to first Object ID: ${subgroupId}`,
          );
        }

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

        // Create the MOQObject with additional properties from the improved parsing
        const obj: MOQObject = {
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
  private notifyObjectCallbacks(trackAlias: bigint, obj: MOQObject) {
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
  /**
   * Handle an incoming FETCH_HEADER stream (stream type 0x05).
   * Reads the requestId, then reads objects and dispatches to the registered callback.
   */
  private async handleFetchStream(reader: Reader): Promise<void> {
    const requestId = await reader.u62();
    this.logger.info(`Received FETCH_HEADER stream, requestId=${requestId}`);

    const callback = this.fetchCallbacks.get(requestId);
    if (!callback) {
      this.logger.warn(
        `No callback registered for fetch requestId=${requestId}`,
      );
      return;
    }

    // Read objects from the fetch stream
    // Each object: groupId, subgroupId, objectId, publisherPriority, extensionsLen, [extensions], payloadLen, payload
    while (!(await reader.done())) {
      const groupId = await reader.u62();
      const subgroupId = await reader.u62();
      const objectId = await reader.u62();
      await reader.u8(); // publisherPriority - not needed
      const extensionsLen = await reader.u62();
      if (extensionsLen > 0n) {
        await reader.read(Number(extensionsLen)); // skip extensions
      }
      const payloadLen = await reader.u62();
      const payload =
        payloadLen > 0n
          ? await reader.read(Number(payloadLen))
          : new Uint8Array(0);

      this.logger.debug(
        `Fetch object: group=${groupId}, subgroup=${subgroupId}, obj=${objectId}, len=${payload.length}`,
      );

      callback({
        trackAlias: 0n,
        location: { group: groupId, object: objectId },
        data: payload,
      });
    }

    // Clean up the callback
    this.fetchCallbacks.delete(requestId);
  }

  /**
   * Send a FETCH request for a track and register a callback for the response data.
   * Returns a promise that resolves when the FETCH_OK is received.
   */
  public async fetchTrack(
    namespace: string,
    trackName: string,
    callback: ObjectCallback,
  ): Promise<void> {
    this.logger.info(`Fetching track ${namespace}:${trackName}`);

    if (!this.controlStream) {
      throw new Error("Cannot fetch: Control stream not set");
    }
    if (!this.client) {
      throw new Error("Cannot fetch: Client not set");
    }

    const requestId = this.getNextRequestId();

    const fetchMsg: Fetch = {
      kind: Msg.Fetch,
      requestId,
      subscriberPriority: 0,
      groupOrder: 0, // Publisher order
      fetchType: FetchTypeStandalone,
      namespace: [namespace],
      trackName,
      startGroup: 0n,
      startObject: 0n,
      endGroup: 0n,
      endObject: 0n,
      params: [],
    };

    // Register callback for fetch data before sending the message
    this.fetchCallbacks.set(requestId, callback);

    const client = this.client;

    const fetchPromise = new Promise<void>((resolve, reject) => {
      const unregisterOk = client.registerMessageHandler(
        Msg.FetchOk,
        requestId,
        () => {
          this.logger.info(
            `Received FetchOk for ${namespace}:${trackName}, requestId=${requestId}`,
          );
          unregisterErr();
          resolve();
        },
      );

      const unregisterErr = client.registerMessageHandler(
        Msg.FetchError,
        requestId,
        (response: Message) => {
          const fetchError = response as FetchError;
          this.logger.error(
            `Fetch error for ${namespace}:${trackName}: ${fetchError.reason}`,
          );
          unregisterOk();
          this.fetchCallbacks.delete(requestId);
          reject(new Error(`Fetch error: ${fetchError.reason}`));
        },
      );
    });

    this.logger.info(
      `Sending FETCH for ${namespace}:${trackName} with requestId ${requestId}`,
    );
    await this.controlStream.send(fetchMsg);
    await fetchPromise;
  }

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

    // According to MOQ Transport draft-14, the unsubscribe message must use the same
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
      // Note: The MOQ spec doesn't require an acknowledgment for unsubscribe messages,
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
