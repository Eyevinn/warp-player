import {
  Subscribe,
  SubscribeOk,
  SubscribeError,
  SubscribeUpdate,
  PublishDone,
  Unsubscribe,
  Fetch,
  PublishNamespace,
  PublishNamespaceOk,
  PublishNamespaceError,
  UnpublishNamespace,
  Location,
  FilterType,
} from "./control";
import { KeyValuePair } from "./stream";
import { Version, isDraft16 } from "./version";

/**
 * Enum for message type IDs, matching the draft-14 specification
 */
enum Id {
  Subscribe = 0x3,
  SubscribeOk = 0x4,
  SubscribeError = 0x5,
  SubscribeUpdate = 0x2,
  PublishDone = 0xb, // draft-14: renamed from SubscribeDone
  Unsubscribe = 0xa,
  Fetch = 0x16,
  PublishNamespace = 0x6, // draft-14: renamed from Announce
  PublishNamespaceOk = 0x7, // draft-14: renamed from AnnounceOk
  PublishNamespaceError = 0x8, // draft-14: renamed from AnnounceError
  UnpublishNamespace = 0x9, // draft-14: renamed from Unannounce
  RequestsBlocked = 0x1a,
  ClientSetup = 0x20,
  ServerSetup = 0x21,
}

/**
 * BufferCtrlWriter class for writing control messages to a buffer
 * following the draft-14 specification.
 *
 * The typical pattern is to instantiate the class and call one of the
 * marshal methods to write a message to the buffer. The format is always:
 * wire format type, 16-bit length, message fields, etc.
 */
// Draft-16 parameter type keys for fields moved from message body to params
const PARAM_FORWARD = 0x10n;
const PARAM_SUBSCRIBER_PRIORITY = 0x20n;
const PARAM_SUBSCRIPTION_FILTER = 0x21n;
const PARAM_GROUP_ORDER = 0x22n;

export class BufferCtrlWriter {
  private buffer: Uint8Array;
  private position: number;
  private tempBuffer: Uint8Array;
  private version: Version;

  constructor(version: Version = Version.DRAFT_14, initialSize: number = 1024) {
    this.buffer = new Uint8Array(initialSize);
    this.position = 0;
    this.tempBuffer = new Uint8Array(8);
    this.version = version;
  }

  /**
   * Ensures the buffer has enough space for the specified number of bytes
   * @param bytesNeeded Number of bytes needed
   */
  private ensureSpace(bytesNeeded: number): void {
    const requiredSize = this.position + bytesNeeded;
    if (requiredSize <= this.buffer.length) {
      return;
    }

    // Double the buffer size or increase to required size, whichever is larger
    const newSize = Math.max(this.buffer.length * 2, requiredSize);
    const newBuffer = new Uint8Array(newSize);
    newBuffer.set(this.buffer.subarray(0, this.position));
    this.buffer = newBuffer;
  }

  /**
   * Gets the current buffer with only the written data
   * @returns A Uint8Array containing the written data
   */
  public getBytes(): Uint8Array {
    return this.buffer.slice(0, this.position);
  }

  /**
   * Resets the buffer to start writing from the beginning
   */
  public reset(): void {
    this.position = 0;
  }

  /**
   * Writes a uint8 value to the buffer
   * @param value The value to write
   */
  private writeUint8(value: number): void {
    this.ensureSpace(1);
    this.buffer[this.position++] = value & 0xff;
  }

  /**
   * Writes a boolean value as a uint8 to the buffer
   * @param value The value to write
   */
  private writeBoolAsUint8(value: boolean): void {
    this.ensureSpace(1);
    this.buffer[this.position++] = value ? 1 : 0;
  }

  /**
   * Writes a uint16 value to the buffer in big-endian format
   * @param value The value to write
   */
  private writeUint16(value: number): void {
    this.ensureSpace(2);
    this.buffer[this.position++] = (value >> 8) & 0xff; // MSB
    this.buffer[this.position++] = value & 0xff; // LSB
  }

  /**
   * Writes a variable-length integer (up to 53 bits)
   * @param value The value to write
   */
  private writeVarInt53(value: number): void {
    if (value < 0) {
      throw new Error(`Underflow, value is negative: ${value}`);
    }

    const MAX_U6 = Math.pow(2, 6) - 1;
    const MAX_U14 = Math.pow(2, 14) - 1;
    const MAX_U30 = Math.pow(2, 30) - 1;
    const MAX_U53 = Number.MAX_SAFE_INTEGER;

    if (value <= MAX_U6) {
      // 1-byte encoding (0xxxxxxx)
      this.ensureSpace(1);
      this.buffer[this.position++] = value;
    } else if (value <= MAX_U14) {
      // 2-byte encoding (10xxxxxx xxxxxxxx)
      this.ensureSpace(2);
      this.buffer[this.position++] = ((value >> 8) & 0x3f) | 0x40;
      this.buffer[this.position++] = value & 0xff;
    } else if (value <= MAX_U30) {
      // 4-byte encoding (110xxxxx xxxxxxxx xxxxxxxx xxxxxxxx)
      this.ensureSpace(4);
      this.buffer[this.position++] = ((value >> 24) & 0x1f) | 0x80;
      this.buffer[this.position++] = (value >> 16) & 0xff;
      this.buffer[this.position++] = (value >> 8) & 0xff;
      this.buffer[this.position++] = value & 0xff;
    } else if (value <= MAX_U53) {
      // 8-byte encoding (1110xxxx xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx xxxxxxxx)
      this.ensureSpace(8);
      const high = Math.floor(value / 0x100000000);
      const low = value % 0x100000000;

      this.buffer[this.position++] = ((high >> 24) & 0x0f) | 0xc0;
      this.buffer[this.position++] = (high >> 16) & 0xff;
      this.buffer[this.position++] = (high >> 8) & 0xff;
      this.buffer[this.position++] = high & 0xff;

      this.buffer[this.position++] = (low >> 24) & 0xff;
      this.buffer[this.position++] = (low >> 16) & 0xff;
      this.buffer[this.position++] = (low >> 8) & 0xff;
      this.buffer[this.position++] = low & 0xff;
    } else {
      throw new Error(`Overflow, value larger than 53-bits: ${value}`);
    }
  }

  /**
   * Writes a variable-length integer (up to 62 bits) as a BigInt
   * @param value The BigInt value to write
   */
  private writeVarInt62(value: bigint): void {
    if (value < 0n) {
      throw new Error(`Underflow, value is negative: ${value}`);
    }

    const MAX_U6 = 2n ** 6n - 1n;
    const MAX_U14 = 2n ** 14n - 1n;
    const MAX_U30 = 2n ** 30n - 1n;
    const MAX_U62 = 2n ** 62n - 1n;

    if (value <= MAX_U6) {
      // 1-byte encoding
      this.writeUint8(Number(value));
    } else if (value <= MAX_U14) {
      // 2-byte encoding
      this.ensureSpace(2);
      this.buffer[this.position++] = Number(((value >> 8n) & 0x3fn) | 0x40n);
      this.buffer[this.position++] = Number(value & 0xffn);
    } else if (value <= MAX_U30) {
      // 4-byte encoding
      this.ensureSpace(4);
      this.buffer[this.position++] = Number(((value >> 24n) & 0x1fn) | 0x80n);
      this.buffer[this.position++] = Number((value >> 16n) & 0xffn);
      this.buffer[this.position++] = Number((value >> 8n) & 0xffn);
      this.buffer[this.position++] = Number(value & 0xffn);
    } else if (value <= MAX_U62) {
      // 8-byte encoding
      this.ensureSpace(8);
      this.buffer[this.position++] = Number(((value >> 56n) & 0x0fn) | 0xc0n);
      this.buffer[this.position++] = Number((value >> 48n) & 0xffn);
      this.buffer[this.position++] = Number((value >> 40n) & 0xffn);
      this.buffer[this.position++] = Number((value >> 32n) & 0xffn);
      this.buffer[this.position++] = Number((value >> 24n) & 0xffn);
      this.buffer[this.position++] = Number((value >> 16n) & 0xffn);
      this.buffer[this.position++] = Number((value >> 8n) & 0xffn);
      this.buffer[this.position++] = Number(value & 0xffn);
    } else {
      throw new Error(`Overflow, value larger than 62-bits: ${value}`);
    }
  }

  /**
   * Writes a string to the buffer
   * @param str The string to write
   */
  private writeString(str: string): void {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);

    // Write the length as a varint
    this.writeVarInt53(bytes.length);

    // Write the string bytes
    this.ensureSpace(bytes.length);
    this.buffer.set(bytes, this.position);
    this.position += bytes.length;
  }

  /**
   * Writes a tuple (array of strings) to the buffer
   * @param tuple The tuple to write
   */
  private writeTuple(tuple: string[]): void {
    // Write the count of tuple elements
    this.writeVarInt53(tuple.length);

    // Write each tuple element
    for (const element of tuple) {
      this.writeString(element);
    }
  }

  /**
   * Writes a location to the buffer
   * @param location The location to write
   */
  private writeLocation(location: Location): void {
    this.writeVarInt62(location.group);
    this.writeVarInt62(location.object);
  }

  /**
   * Writes an array of key-value pairs to the buffer
   * @param pairs The key-value pairs to write
   */
  private writeKeyValuePairs(pairs?: KeyValuePair[]): void {
    // Write the number of pairs
    const numPairs = pairs ? pairs.length : 0;
    this.writeVarInt53(numPairs);

    if (!pairs || pairs.length === 0) {
      return;
    }

    for (const pair of pairs) {
      // Write the key type
      this.writeVarInt62(pair.type);

      // Handle the value based on whether the key is odd or even
      if (pair.type % 2n === 0n) {
        // Even keys have bigint values
        if (typeof pair.value !== "bigint") {
          throw new Error(
            `Invalid value type for even key ${
              pair.type
            }: expected bigint, got ${typeof pair.value}`,
          );
        }
        this.writeVarInt62(pair.value);
      } else {
        // Odd keys have Uint8Array values
        if (!(pair.value instanceof Uint8Array)) {
          throw new Error(
            `Invalid value type for odd key ${
              pair.type
            }: expected Uint8Array, got ${typeof pair.value}`,
          );
        }
        this.writeVarInt53(pair.value.byteLength);
        this.ensureSpace(pair.value.byteLength);
        this.buffer.set(pair.value, this.position);
        this.position += pair.value.byteLength;
      }
    }
  }

  /**
   * Writes delta-encoded key-value pairs (draft-16+).
   * Parameters are sorted by ascending type, then each type is encoded
   * as a delta from the previous type.
   */
  private writeDeltaKeyValuePairs(pairs?: KeyValuePair[]): void {
    const numPairs = pairs ? pairs.length : 0;
    this.writeVarInt53(numPairs);

    if (!pairs || pairs.length === 0) {
      return;
    }

    // Sort by ascending type for delta encoding
    const sorted = [...pairs].sort((a, b) => {
      if (a.type < b.type) {
        return -1;
      }
      if (a.type > b.type) {
        return 1;
      }
      return 0;
    });

    let prevType = 0n;
    for (const pair of sorted) {
      // Write delta type
      const delta = pair.type - prevType;
      this.writeVarInt62(delta);
      prevType = pair.type;

      if (pair.type % 2n === 0n) {
        if (typeof pair.value !== "bigint") {
          throw new Error(
            `Invalid value type for even key ${pair.type}: expected bigint`,
          );
        }
        this.writeVarInt62(pair.value);
      } else {
        if (!(pair.value instanceof Uint8Array)) {
          throw new Error(
            `Invalid value type for odd key ${pair.type}: expected Uint8Array`,
          );
        }
        this.writeVarInt53(pair.value.byteLength);
        this.ensureSpace(pair.value.byteLength);
        this.buffer.set(pair.value, this.position);
        this.position += pair.value.byteLength;
      }
    }
  }

  /** Writes params using the appropriate encoding for the current version */
  private writeParams(pairs?: KeyValuePair[]): void {
    if (isDraft16(this.version)) {
      this.writeDeltaKeyValuePairs(pairs);
    } else {
      this.writeKeyValuePairs(pairs);
    }
  }

  /** Encodes a Location into a Uint8Array (for packing into parameter bytes) */
  private encodeLocationBytes(location: Location): Uint8Array {
    const tempWriter = new BufferCtrlWriter(this.version, 16);
    tempWriter.writeVarInt62(location.group);
    tempWriter.writeVarInt62(location.object);
    return tempWriter.getBytes();
  }

  /** Encodes a subscription filter into bytes for the SUBSCRIPTION_FILTER parameter */
  private encodeFilterBytes(
    filterType: FilterType,
    startLocation?: Location,
    endGroup?: bigint,
  ): Uint8Array {
    const tempWriter = new BufferCtrlWriter(this.version, 32);
    tempWriter.writeVarInt53(filterType);
    if (
      filterType === FilterType.AbsoluteStart ||
      filterType === FilterType.AbsoluteRange
    ) {
      if (!startLocation) {
        throw new Error("Missing startLocation for absolute filter");
      }
      tempWriter.writeVarInt62(startLocation.group);
      tempWriter.writeVarInt62(startLocation.object);
    }
    if (filterType === FilterType.AbsoluteRange) {
      if (endGroup === undefined) {
        throw new Error("Missing endGroup for absolute range filter");
      }
      tempWriter.writeVarInt62(endGroup);
    }
    return tempWriter.getBytes();
  }

  /**
   * Helper method to marshal a message with proper type and length
   * @param messageType The message type ID
   * @param writeContent Function to write the message content
   */
  private marshalWithLength(messageType: Id, writeContent: () => void): void {
    // Write the message type
    this.writeUint8(messageType);

    // Reserve space for the 16-bit length field
    const lengthPosition = this.position;
    this.position += 2; // Skip 2 bytes for length

    // Write the message content
    const contentStart = this.position;
    writeContent();
    const contentLength = this.position - contentStart;

    // Go back and write the length
    const currentPosition = this.position;
    this.position = lengthPosition;
    this.writeUint16(contentLength);

    // Restore position
    this.position = currentPosition;
  }

  /**
   * Marshals a Subscribe message to the buffer
   * @param msg The Subscribe message to marshal
   * @returns The BufferCtrlWriter instance for chaining
   */
  public marshalSubscribe(msg: Subscribe): BufferCtrlWriter {
    this.marshalWithLength(Id.Subscribe, () => {
      this.writeVarInt62(msg.requestId);
      this.writeTuple(msg.namespace);
      this.writeString(msg.name);

      if (isDraft16(this.version)) {
        // Draft-16: fields moved to parameters
        const params: KeyValuePair[] = [...(msg.params || [])];
        params.push({
          type: PARAM_FORWARD,
          value: BigInt(msg.forward ? 1 : 0),
        });
        params.push({
          type: PARAM_SUBSCRIBER_PRIORITY,
          value: BigInt(msg.subscriber_priority),
        });
        params.push({
          type: PARAM_SUBSCRIPTION_FILTER,
          value: this.encodeFilterBytes(
            msg.filterType,
            msg.startLocation,
            msg.endGroup,
          ),
        });
        params.push({
          type: PARAM_GROUP_ORDER,
          value: BigInt(msg.group_order),
        });
        this.writeDeltaKeyValuePairs(params);
      } else {
        // Draft-14: inline fields
        this.writeUint8(msg.subscriber_priority);
        this.writeUint8(msg.group_order);
        this.writeBoolAsUint8(msg.forward);
        this.writeUint8(msg.filterType);

        if (
          msg.filterType === FilterType.AbsoluteStart ||
          msg.filterType === FilterType.AbsoluteRange
        ) {
          if (!msg.startLocation) {
            throw new Error("Missing startLocation for absolute filter");
          }
          this.writeLocation(msg.startLocation);
        }

        if (msg.filterType === FilterType.AbsoluteRange) {
          if (!msg.endGroup) {
            throw new Error("Missing endGroup for absolute range filter");
          }
          this.writeVarInt62(msg.endGroup);
        }
        this.writeKeyValuePairs(msg.params);
      }
    });

    return this;
  }

  /**
   * Marshals a SubscribeOk message to the buffer
   * @param msg The SubscribeOk message to marshal
   * @returns The BufferCtrlWriter instance for chaining
   */
  public marshalSubscribeOk(msg: SubscribeOk): BufferCtrlWriter {
    this.marshalWithLength(Id.SubscribeOk, () => {
      // Write the request ID
      this.writeVarInt62(msg.requestId);

      // Write the expires time
      this.writeVarInt62(msg.expires);

      // Write the group order
      this.writeUint8(msg.group_order);

      // Write the content exists flag
      this.writeBoolAsUint8(msg.content_exists);

      // Write the latest group/object info (if any)
      if (msg.content_exists) {
        if (!msg.largest) {
          throw new Error("Missing largest for content_exists");
        }
        this.writeLocation(msg.largest);
      }
      // Write parameters (if any)
      this.writeKeyValuePairs(msg.params);
    });

    return this;
  }

  /**
   * Marshals a SubscribeError message to the buffer
   * @param msg The SubscribeError message to marshal
   * @returns The BufferCtrlWriter instance for chaining
   */
  public marshalSubscribeError(msg: SubscribeError): BufferCtrlWriter {
    this.marshalWithLength(Id.SubscribeError, () => {
      this.writeVarInt62(msg.requestId);
      this.writeVarInt62(msg.code);

      if (isDraft16(this.version)) {
        // Draft-16 REQUEST_ERROR: includes retryInterval
        this.writeVarInt62(msg.retryInterval ?? 0n);
      }

      this.writeString(msg.reason);

      if (!isDraft16(this.version) && msg.trackAlias !== undefined) {
        // Draft-14 only: trackAlias
        this.writeVarInt62(msg.trackAlias);
      }
    });

    return this;
  }

  /**
   * Marshals a PublishDone message to the buffer (draft-14: renamed from SubscribeDone)
   * @param msg The PublishDone message to marshal
   * @returns The BufferCtrlWriter instance for chaining
   */
  public marshalPublishDone(msg: PublishDone): BufferCtrlWriter {
    this.marshalWithLength(Id.PublishDone, () => {
      // Write the request ID
      this.writeVarInt62(msg.requestId);

      // Write the code
      this.writeVarInt62(msg.code);

      // Write the reason
      this.writeString(msg.reason);

      // Write the stream count
      this.writeVarInt53(msg.streamCount);
    });

    return this;
  }

  /**
   * Marshals a Fetch message to the buffer (standalone fetch type)
   */
  public marshalFetch(msg: Fetch): BufferCtrlWriter {
    this.marshalWithLength(Id.Fetch, () => {
      this.writeVarInt62(msg.requestId);
      this.writeUint8(msg.subscriberPriority);
      this.writeUint8(msg.groupOrder);
      this.writeVarInt62(BigInt(msg.fetchType));
      // Standalone fetch includes namespace, trackName, start/end
      this.writeTuple(msg.namespace);
      this.writeString(msg.trackName);
      this.writeVarInt62(msg.startGroup);
      this.writeVarInt62(msg.startObject);
      this.writeVarInt62(msg.endGroup);
      this.writeVarInt62(msg.endObject);
      this.writeKeyValuePairs(msg.params);
    });
    return this;
  }

  /**
   * Marshals a PublishNamespace message to the buffer (draft-14: renamed from Announce)
   * @param msg The PublishNamespace message to marshal
   * @returns The BufferCtrlWriter instance for chaining
   */
  public marshalPublishNamespace(msg: PublishNamespace): BufferCtrlWriter {
    this.marshalWithLength(Id.PublishNamespace, () => {
      this.writeVarInt62(msg.requestId);
      this.writeTuple(msg.namespace);
      this.writeParams(msg.params);
    });

    return this;
  }

  /**
   * Marshals a PublishNamespaceOk / REQUEST_OK message to the buffer
   */
  public marshalPublishNamespaceOk(msg: PublishNamespaceOk): BufferCtrlWriter {
    this.marshalWithLength(Id.PublishNamespaceOk, () => {
      this.writeVarInt62(msg.requestId);
      if (isDraft16(this.version)) {
        // Draft-16 REQUEST_OK includes parameters
        this.writeDeltaKeyValuePairs([]);
      }
    });

    return this;
  }

  /**
   * Marshals an Unsubscribe message to the buffer
   * @param msg The Unsubscribe message to marshal
   * @returns The BufferCtrlWriter instance for chaining
   */
  public marshalUnsubscribe(msg: Unsubscribe): BufferCtrlWriter {
    this.marshalWithLength(Id.Unsubscribe, () => {
      this.writeVarInt62(msg.requestId);
    });

    return this;
  }

  /**
   * Marshals a PublishNamespaceError message to the buffer (draft-14: renamed from AnnounceError)
   * @param msg The PublishNamespaceError message to marshal
   * @returns The BufferCtrlWriter instance for chaining
   */
  public marshalPublishNamespaceError(
    msg: PublishNamespaceError,
  ): BufferCtrlWriter {
    this.marshalWithLength(Id.PublishNamespaceError, () => {
      // Write the request ID
      this.writeVarInt62(msg.requestId);

      // Write the error code
      this.writeVarInt62(msg.code);

      // Write the error reason
      this.writeString(msg.reason);
    });

    return this;
  }

  /**
   * Marshals an UnpublishNamespace message to the buffer (draft-14: renamed from Unannounce)
   * @param msg The UnpublishNamespace message to marshal
   * @returns The BufferCtrlWriter instance for chaining
   */
  public marshalUnpublishNamespace(msg: UnpublishNamespace): BufferCtrlWriter {
    this.marshalWithLength(Id.UnpublishNamespace, () => {
      // Write the namespace
      this.writeTuple(msg.namespace);
    });

    return this;
  }

  /**
   * Marshals a Client setup message to the buffer
   * @param msg The Client setup message to marshal
   * @returns The BufferCtrlWriter instance for chaining
   */
  public marshalClientSetup(msg: {
    versions: number[];
    params?: KeyValuePair[];
  }): BufferCtrlWriter {
    this.marshalWithLength(Id.ClientSetup, () => {
      if (!isDraft16(this.version)) {
        // Draft-14: include version list for in-band negotiation
        this.writeVarInt53(msg.versions.length);
        for (const version of msg.versions) {
          this.writeVarInt53(version);
        }
      }
      // Draft-16 omits version list (negotiated via protocol)
      this.writeParams(msg.params);
    });

    return this;
  }

  public marshalServerSetup(msg: {
    version: number;
    params?: KeyValuePair[];
  }): BufferCtrlWriter {
    this.marshalWithLength(Id.ServerSetup, () => {
      if (!isDraft16(this.version)) {
        // Draft-14: include selected version
        this.writeVarInt53(msg.version);
      }
      // Draft-16 omits selected version (negotiated via protocol)
      this.writeParams(msg.params);
    });

    return this;
  }

  /**
   * Marshals a SubscribeUpdate / REQUEST_UPDATE message to the buffer
   */
  public marshalSubscribeUpdate(msg: SubscribeUpdate): BufferCtrlWriter {
    this.marshalWithLength(Id.SubscribeUpdate, () => {
      this.writeVarInt62(msg.requestId);
      // draft-14: SubscriptionRequestID; draft-16 calls it Existing Request ID
      // In warp-player the field name on the interface hasn't changed
      // but we need to check if this field exists. For draft-14:
      // requestId is the new request ID, and we need the subscription request ID.
      // Looking at the interface, requestId serves as REQUEST_UPDATE's own ID in draft-16
      // and startLocation/endGroup/etc are inline in draft-14 or in params in draft-16.

      if (isDraft16(this.version)) {
        // Draft-16: all fields in parameters
        const params: KeyValuePair[] = [...(msg.params || [])];
        params.push({
          type: PARAM_FORWARD,
          value: BigInt(msg.forward ? 1 : 0),
        });
        params.push({
          type: PARAM_SUBSCRIBER_PRIORITY,
          value: BigInt(msg.subscriberPriority),
        });
        // Encode filter
        const filterType =
          msg.endGroup > 0n
            ? FilterType.AbsoluteRange
            : FilterType.AbsoluteStart;
        params.push({
          type: PARAM_SUBSCRIPTION_FILTER,
          value: this.encodeFilterBytes(
            filterType,
            msg.startLocation,
            msg.endGroup,
          ),
        });
        this.writeDeltaKeyValuePairs(params);
      } else {
        // Draft-14: inline fields
        this.writeLocation(msg.startLocation);
        this.writeVarInt62(msg.endGroup);
        this.writeUint8(msg.subscriberPriority);
        this.writeBoolAsUint8(msg.forward);
        this.writeKeyValuePairs(msg.params);
      }
    });

    return this;
  }
}
