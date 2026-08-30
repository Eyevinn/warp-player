import { ILogger, LoggerFactory } from "../logger";

import { Client } from "./client";
import { FetchStreamReader, EndOfRange } from "./fetchstream";
import {
  CtrlType,
  FetchType,
  type Fetch,
  type Subscribe,
  type SubscribeOk,
} from "./messages18";
import { RequestStream, UniStreamRouter } from "./session18";
import { Reader } from "./stream";
import { TrackAliasRegistry } from "./trackaliasregistry";
import {
  FilterType,
  GroupOrder,
  type Location,
  PARAM_LARGEST_OBJECT,
  findParameter,
  subscriptionFilterParameter,
} from "./wire18";

// Unidirectional stream types (draft-18 Table 3).
const FETCH_HEADER_BIGINT = 0x05n;
const PADDING_STREAM_BIGINT = 0x132b3e28n;

/**
 * The SUBGROUP_HEADER stream type is a bitfield of the form 0b0XX1XXXX
 * (draft-18 Section 11.4.2). Every optional header field is signalled by it,
 * so the type and the header's contents are two views of the same thing.
 */
const SUBGROUP_FLAG_PROPERTIES = 0x01n;
const SUBGROUP_ID_MODE_MASK = 0x06n;
const SUBGROUP_ID_MODE_SHIFT = 1n;
const SUBGROUP_FLAG_END_OF_GROUP = 0x08n;
const SUBGROUP_MARKER = 0x10n;
const SUBGROUP_FLAG_DEFAULT_PRIORITY = 0x20n;
const SUBGROUP_FLAG_FIRST_OBJECT = 0x40n;

/** The two-bit SUBGROUP_ID_MODE field of the stream type. */
export const enum SubgroupIdMode {
  /** The field is omitted; the Subgroup ID is 0. */
  Zero = 0,
  /**
   * The field is omitted; the Subgroup ID is the Object ID of the first Object
   * on the stream, so it is not known until that Object has been read.
   */
  FirstObject = 1,
  /** The Subgroup ID is carried in the header. */
  Explicit = 2,
  /** 0b11, reserved. Sixteen stream types carry it; every one is a violation. */
  Reserved = 3,
}

/** Whether a stream type is a SUBGROUP_HEADER. Bit 4 is the marker. */
function isSubgroupStreamType(streamType: bigint): boolean {
  return (
    (streamType & SUBGROUP_MARKER) !== 0n &&
    streamType <= 0x7fn &&
    (streamType & 0x80n) === 0n
  );
}

function subgroupIdMode(streamType: bigint): SubgroupIdMode {
  return Number(
    (streamType & SUBGROUP_ID_MODE_MASK) >> SUBGROUP_ID_MODE_SHIFT,
  ) as SubgroupIdMode;
}

/** True when the header carries a Properties block on *every* Object. */
function hasProperties(streamType: bigint): boolean {
  return (streamType & SUBGROUP_FLAG_PROPERTIES) !== 0n;
}

/** True when Publisher Priority is omitted and inherited from the track. */
function hasDefaultPriority(streamType: bigint): boolean {
  return (streamType & SUBGROUP_FLAG_DEFAULT_PRIORITY) !== 0n;
}

/**
 * True when this subgroup carries the largest Object in the Group, so a FIN
 * means no Object in the Group beyond the last one received exists. A reset
 * says nothing of the kind.
 */
function isEndOfGroup(streamType: bigint): boolean {
  return (streamType & SUBGROUP_FLAG_END_OF_GROUP) !== 0n;
}

/**
 * True when the first Object on this stream is the first Object the original
 * publisher published in the subgroup. New in draft-18.
 */
function isFirstObject(streamType: bigint): boolean {
  return (streamType & SUBGROUP_FLAG_FIRST_OBJECT) !== 0n;
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

// Options for subscribeTrackWithInfo
export interface SubscribeOptions {
  // Subscription filter type; defaults to NextGroupStart (legacy behavior).
  filterType?: FilterType;
  // Drop objects at or before the SUBSCRIBE_OK largest location before they
  // reach the callback. Used with a joining FETCH, which already covers that
  // range, so the combined delivery is contiguous and non-overlapping.
  skipObjectsUpToLargest?: boolean;
}

// Result of subscribeTrackWithInfo
export interface SubscriptionInfo {
  trackAlias: bigint;
  requestId: bigint;
  largest?: Location;
}

/** Reports whether location a lies strictly after b in (group, object) order */
function afterLocation(a: Location, b: Location): boolean {
  if (a.group !== b.group) {
    return a.group > b.group;
  }
  return a.object > b.object;
}

/** Namespace fields and track names travel as bytes on the wire. */
const encoder = new TextEncoder();

// Tracks manager to handle incoming data streams
export class TracksManager {
  private wt: WebTransport;
  private objectCallbacks: Map<string, ObjectCallback[]> = new Map();
  private fetchCallbacks: Map<bigint, ObjectCallback> = new Map();
  private trackRegistry: TrackAliasRegistry = new TrackAliasRegistry();
  private nextRequestId: bigint = 0n;
  private client: Client | null = null;
  private logger: ILogger;
  private isClosing: boolean = false;
  /** One request stream per subscription; closing it ends the subscription. */
  private subscribeStreams: Map<bigint, RequestStream> = new Map();

  constructor(wt: WebTransport, router: UniStreamRouter, client?: Client) {
    this.wt = wt;
    this.client = client || null;
    this.logger = LoggerFactory.getInstance().getLogger("Tracks");
    // The router owns the accept loop because the peer's control stream
    // arrives on it too, and has to be adopted before SETUP completes.
    router.setDataHandler((reader, streamType) => {
      this.handleDataStream(reader, streamType).catch((error) => {
        if (!this.isClosing) {
          this.logger.error("Error handling incoming stream:", error);
        }
      });
    });
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
   * Handle one incoming unidirectional data stream whose type varint the
   * router has already read.
   */
  private async handleDataStream(reader: Reader, streamType: bigint) {
    this.logger.debug(`Incoming data stream. Type: ${streamType}`);
    try {
      if (isSubgroupStreamType(streamType)) {
        await this.handleSubgroupStream(reader, streamType);
      } else if (streamType === FETCH_HEADER_BIGINT) {
        await this.handleFetchStream(reader);
      } else if (streamType === PADDING_STREAM_BIGINT) {
        // Everything after the stream type is padding to be discarded
        // (Section 11.5.1). Draining it keeps flow control moving.
        this.logger.debug("PADDING stream, draining");
        while (!(await reader.done())) {
          await reader.read(1);
        }
      } else {
        this.logger.warn(`Unknown stream type: ${streamType}`);
      }
    } catch (error) {
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

      // Determine the Subgroup ID from the stream type's SUBGROUP_ID_MODE.
      const mode = subgroupIdMode(streamType);
      if (mode === SubgroupIdMode.Reserved) {
        // 0b11 is reserved; Section 11.4.2 makes it a PROTOCOL_VIOLATION.
        throw new Error(
          `Reserved SUBGROUP_ID_MODE in stream type 0x${streamType.toString(16)}`,
        );
      }

      let subgroupId: bigint | null = null;
      if (mode === SubgroupIdMode.Zero) {
        subgroupId = 0n;
        this.logger.debug("Subgroup ID: 0 (implicit zero)");
      } else if (mode === SubgroupIdMode.Explicit) {
        subgroupId = await reader.u62();
        this.logger.debug(`Subgroup ID: ${subgroupId} (explicit)`);
      } else {
        this.logger.debug("Subgroup ID will be set to the first Object ID");
      }

      // A Properties block is present on *every* Object of this stream when the
      // bit is set, not merely permitted on some: an Object with no properties
      // still writes a Properties Length of 0. The flag belongs to the header,
      // so it is read once here rather than guessed per object.
      const streamHasProperties = hasProperties(streamType);

      this.logger.debug(
        `Stream flags: endOfGroup=${isEndOfGroup(streamType)} firstObject=${isFirstObject(streamType)}`,
      );

      // Read Publisher Priority unless the DEFAULT_PRIORITY bit omits it, in
      // which case Objects inherit the track's default.
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

        // Object Properties, if the header said this stream carries them.
        // draft-18 renamed draft-16's extension headers; the encoding -- a
        // length followed by that many bytes of Key-Value-Pairs -- is the same,
        // so LOC's capture timestamps still ride here.
        let extensions: Uint8Array | null = null;
        if (streamHasProperties) {
          const propertiesLength = await reader.u62();
          if (propertiesLength > 0n) {
            extensions = await reader.read(Number(propertiesLength));
            this.logger.debug(`Read ${propertiesLength} bytes of properties`);
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

    // Group Order decides which way a Group ID Delta moves, so the reader
    // cannot decode without it. This player never asks for Descending, and a
    // FETCH that omitted the parameter is Ascending either way.
    const objects = new FetchStreamReader(reader, GroupOrder.Ascending);
    for (;;) {
      const obj = await objects.next();
      if (obj === null) {
        break;
      }

      if (obj.endOfRange !== EndOfRange.None) {
        // A run of Objects that were not serialized. There is nothing to
        // deliver: they either do not exist or their status is unknown.
        this.logger.debug(
          `Fetch end-of-range 0x${obj.endOfRange.toString(16)} through ` +
            `group=${obj.groupId} obj=${obj.objectId}`,
        );
        continue;
      }

      this.logger.debug(
        `Fetch object: group=${obj.groupId}, subgroup=${obj.subgroupId}, ` +
          `obj=${obj.objectId}, len=${obj.payload.length}`,
      );

      callback({
        trackAlias: 0n,
        location: { group: obj.groupId, object: obj.objectId },
        data: obj.payload,
        ...(obj.properties !== undefined && { extensions: obj.properties }),
      });
    }

    this.fetchCallbacks.delete(requestId);
  }

  /**
   * Send a standalone FETCH for a whole track and register a callback for the
   * response data.
   */
  public async fetchTrack(
    namespace: string,
    trackName: string,
    callback: ObjectCallback,
  ): Promise<void> {
    this.logger.info(`Fetching track ${namespace}:${trackName}`);

    const requestId = this.getNextRequestId();
    const fetch: Fetch = {
      kind: CtrlType.Fetch,
      requestId,
      fetchType: FetchType.Standalone,
      standalone: {
        namespace: [encoder.encode(namespace)],
        name: encoder.encode(trackName),
        start: { group: 0n, object: 0n },
        end: { group: 0n, object: 0n },
      },
      parameters: [],
    };

    // Register before sending: the FETCH_HEADER stream can arrive before
    // FETCH_OK does.
    this.fetchCallbacks.set(requestId, callback);
    await this.sendFetch(fetch, requestId, `${namespace}:${trackName}`);
  }

  /**
   * Send a Relative Joining FETCH tied to an existing subscription.
   *
   * The publisher derives namespace, track and range from the subscription
   * identified by joiningRequestId, so the fetched and subscribed Objects are
   * contiguous and do not overlap. With joiningStart = 0 the FETCH returns the
   * current group from object 0 up to the subscription's start.
   */
  public async fetchJoiningRelative(
    joiningRequestId: bigint,
    joiningStart: bigint,
    callback: ObjectCallback,
  ): Promise<void> {
    this.logger.info(
      `Joining FETCH for subscription requestId=${joiningRequestId}, joiningStart=${joiningStart}`,
    );

    const requestId = this.getNextRequestId();
    const fetch: Fetch = {
      kind: CtrlType.Fetch,
      requestId,
      fetchType: FetchType.RelativeJoining,
      joining: { joiningRequestId, joiningStart },
      parameters: [],
    };

    this.fetchCallbacks.set(requestId, callback);
    await this.sendFetch(fetch, requestId, `joining ${joiningRequestId}`);
  }

  /**
   * Open a FETCH request stream and wait for FETCH_OK.
   *
   * A FETCH response's completion is not its request stream's ending: Section
   * 10.12.3 lets FETCH_OK arrive at any time relative to object delivery,
   * including after the last Object, so the stream is left open once the
   * answer is in and the objects are read from the FETCH_HEADER data stream.
   */
  private async sendFetch(
    fetch: Fetch,
    requestId: bigint,
    label: string,
  ): Promise<void> {
    const stream = await RequestStream.open(this.wt, fetch);
    try {
      for (;;) {
        const msg = await stream.next();
        if (msg === null) {
          throw new Error(`FETCH for ${label} ended without a response`);
        }
        if (msg.kind === CtrlType.FetchOk) {
          this.logger.info(
            `Received FETCH_OK for ${label}, end=` +
              `${msg.endLocation.group}/${msg.endLocation.object}`,
          );
          return;
        }
        if (msg.kind === CtrlType.RequestError) {
          throw new Error(
            `Fetch failed for ${label}: ${msg.errorReason} (code ${msg.errorCode})`,
          );
        }
        this.logger.debug(`Ignoring ${msg.kind} while awaiting FETCH_OK`);
      }
    } catch (error) {
      this.fetchCallbacks.delete(requestId);
      stream.abort(error);
      throw error;
    }
  }

  public async subscribeTrackWithInfo(
    namespace: string,
    trackName: string,
    callback: ObjectCallback,
    options?: SubscribeOptions,
  ): Promise<SubscriptionInfo> {
    this.logger.info(`Subscribing to track ${namespace}:${trackName}`);

    const requestId = this.getNextRequestId();

    // draft-18 moved subscriber priority, group order, forward and the filter
    // out of SUBSCRIBE's fixed fields and into Message Parameters. Only the
    // filter is set here; the rest are left at their defaults, which is what
    // this player wants anyway.
    const subscribe: Subscribe = {
      kind: CtrlType.Subscribe,
      requestId,
      namespace: [encoder.encode(namespace)],
      name: encoder.encode(trackName),
      parameters: [
        subscriptionFilterParameter({
          type: options?.filterType ?? FilterType.NextGroupStart,
        }),
      ],
    };

    // The request's own bidirectional stream carries both the SUBSCRIBE and
    // every response to it, so there is no request-ID dispatch table and no
    // ambiguity about which subscription a response belongs to.
    const stream = await RequestStream.open(this.wt, subscribe);

    let subscribeOk: SubscribeOk;
    try {
      subscribeOk = await this.awaitSubscribeOk(
        stream,
        `${namespace}:${trackName}`,
      );
    } catch (error) {
      stream.abort(error);
      throw error;
    }

    const trackAlias = subscribeOk.trackAlias;

    // LARGEST_OBJECT is a parameter now, not a field. A publisher that has
    // published anything on the track must send it, so its absence means the
    // track is empty so far.
    const largestParam = findParameter(
      subscribeOk.parameters,
      PARAM_LARGEST_OBJECT,
    );
    const largest = largestParam?.location;

    // When a joining FETCH covers everything up to the largest location, drop
    // those objects here so the callback sees each object exactly once.
    let deliverCallback = callback;
    if (options?.skipObjectsUpToLargest && largest) {
      deliverCallback = (obj: MOQObject) => {
        if (!afterLocation(obj.location, largest)) {
          this.logger.debug(
            `Skipping object (group=${obj.location.group}, obj=${obj.location.object}) ` +
              `at or before largest (group=${largest.group}, obj=${largest.object})`,
          );
          return;
        }
        callback(obj);
      };
    }

    this.trackRegistry.registerTrackWithAlias(
      namespace,
      trackName,
      requestId,
      trackAlias,
    );
    this.trackRegistry.registerCallback(trackAlias, deliverCallback);
    // Keep the stream: closing it is how the subscription is ended.
    this.subscribeStreams.set(trackAlias, stream);

    // PUBLISH_DONE and any later REQUEST_ERROR arrive on this same stream.
    void this.drainSubscribeStream(
      stream,
      trackAlias,
      `${namespace}:${trackName}`,
    );

    this.logger.info(
      `Successfully subscribed to ${namespace}:${trackName} with trackAlias ${trackAlias}`,
    );

    return { trackAlias, requestId, largest };
  }

  /** Wait for SUBSCRIBE_OK, turning REQUEST_ERROR and silence into throws. */
  private async awaitSubscribeOk(
    stream: RequestStream,
    label: string,
  ): Promise<SubscribeOk> {
    const timeoutMs = 2000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`Subscribe timeout (${timeoutMs}ms) for ${label}`)),
        timeoutMs,
      );
    });

    try {
      return await Promise.race([this.readSubscribeOk(stream, label), timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private async readSubscribeOk(
    stream: RequestStream,
    label: string,
  ): Promise<SubscribeOk> {
    for (;;) {
      const msg = await stream.next();
      if (msg === null) {
        throw new Error(`Subscribe for ${label} ended without a response`);
      }
      if (msg.kind === CtrlType.SubscribeOk) {
        this.logger.info(
          `Received SUBSCRIBE_OK for ${label}, trackAlias ${msg.trackAlias}`,
        );
        return msg;
      }
      if (msg.kind === CtrlType.RequestError) {
        throw new Error(
          `Subscribe failed for ${label}: ${msg.errorReason} (code ${msg.errorCode})`,
        );
      }
      this.logger.debug(`Ignoring ${msg.kind} while awaiting SUBSCRIBE_OK`);
    }
  }

  /** Read a subscription's stream until the publisher finishes it. */
  private async drainSubscribeStream(
    stream: RequestStream,
    trackAlias: bigint,
    label: string,
  ): Promise<void> {
    try {
      for (;;) {
        const msg = await stream.next();
        if (msg === null) {
          break;
        }
        if (msg.kind === CtrlType.PublishDone) {
          this.logger.info(
            `PUBLISH_DONE for ${label}: status ${msg.statusCode}` +
              (msg.errorReason ? ` (${msg.errorReason})` : ""),
          );
          break;
        }
        this.logger.debug(`Received ${msg.kind} on the ${label} subscription`);
      }
    } catch (error) {
      if (!this.isClosing) {
        this.logger.debug(`Subscription stream for ${label} ended: ${error}`);
      }
    } finally {
      this.subscribeStreams.delete(trackAlias);
    }
  }

  /**
   * Unsubscribe from a track by track alias
   * @param trackAlias The track alias to unsubscribe from
   * @throws Error if control stream is not set
   */
  public async unsubscribeTrack(trackAlias: bigint): Promise<void> {
    this.logger.info(`Unsubscribing from track with alias ${trackAlias}`);

    const stream = this.subscribeStreams.get(trackAlias);
    if (!stream) {
      throw new Error(
        `Cannot unsubscribe: no request stream for alias ${trackAlias}`,
      );
    }

    // draft-18 has no UNSUBSCRIBE message. Closing our side of the request
    // stream is what ends the subscription (Section 10.7).
    await stream.close();
    this.subscribeStreams.delete(trackAlias);
    this.trackRegistry.unregisterAllCallbacks(trackAlias);

    this.logger.info(`Unsubscribed from track with alias ${trackAlias}`);
  }

  public async subscribeTrack(
    namespace: string,
    trackName: string,
    callback: ObjectCallback,
  ): Promise<bigint> {
    const info = await this.subscribeTrackWithInfo(
      namespace,
      trackName,
      callback,
    );
    return info.trackAlias;
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
