import {
  Subscribe,
  SubscribeOk,
  SubscribeError,
  SubscribeDone,
  Unsubscribe,
  Announce,
  AnnounceOk,
  AnnounceError,
  Unannounce,
  Location,
  FilterType,
} from "./control";
import { KeyValuePair } from "./stream";

/**
 * Enum for message type IDs, matching the draft-11 specification
 */
enum Id {
  Subscribe = 0x3,
  SubscribeOk = 0x4,
  SubscribeError = 0x5,
  SubscribeUpdate = 0x2,
  SubscribeDone = 0xb,
  Unsubscribe = 0xa,
  Announce = 0x6,
  AnnounceOk = 0x7,
  AnnounceError = 0x8,
  Unannounce = 0x9,
  RequestsBlocked = 0x1a,
  ClientSetup = 0x20,
  ServerSetup = 0x21,
}

/**
 * BufferCtrlWriter class for writing control messages to a buffer
 * following the draft-11 specification.
 *
 * The typical pattern is to instantiate the class and call one of the
 * marshal methods to write a message to the buffer. The format is always:
 * wire format type, 16-bit length, message fields, etc.
 */
export class BufferCtrlWriter {
  private buffer: Uint8Array;
  private position: number;
  private tempBuffer: Uint8Array;

  /**
   * Creates a new BufferCtrlWriter with an initial buffer size
   * @param initialSize Initial size of the buffer (default: 1024 bytes)
   */
  constructor(initialSize: number = 1024) {
    this.buffer = new Uint8Array(initialSize);
    this.position = 0;
    this.tempBuffer = new Uint8Array(8); // For temporary operations
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
      // Write the subscription ID
      this.writeVarInt62(msg.requestId);

      // Write the track alias
      this.writeVarInt62(msg.trackAlias);

      // Write the namespace
      this.writeTuple(msg.namespace);

      // Write the track name
      this.writeString(msg.name);

      // Write the subscriber priority
      this.writeUint8(msg.subscriber_priority);

      // Write the group order
      this.writeUint8(msg.group_order);

      // Write the forward flag
      this.writeBoolAsUint8(msg.forward);

      // Write the filter type
      this.writeUint8(msg.filterType);

      if (
        msg.filterType === FilterType.AbsoluteStart ||
        msg.filterType === FilterType.AbsoluteRange
      ) {
        // Write the location
        if (!msg.startLocation) {
          throw new Error("Missing startLocation for absolute filter");
        }
        this.writeLocation(msg.startLocation);
      }

      if (msg.filterType === FilterType.AbsoluteRange) {
        // Write the end group
        if (!msg.endGroup) {
          throw new Error("Missing endGroup for absolute range filter");
        }
        this.writeVarInt62(msg.endGroup);
      }
      // Write parameters (if any)
      this.writeKeyValuePairs(msg.params);
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
      // Write the request ID
      this.writeVarInt62(msg.requestId);

      // Write the error code
      this.writeVarInt62(msg.code);

      // Write the error reason
      this.writeString(msg.reason);

      // Write the track alias
      this.writeVarInt62(msg.trackAlias);
    });

    return this;
  }

  /**
   * Marshals a SubscribeDone message to the buffer
   * @param msg The SubscribeDone message to marshal
   * @returns The BufferCtrlWriter instance for chaining
   */
  public marshalSubscribeDone(msg: SubscribeDone): BufferCtrlWriter {
    this.marshalWithLength(Id.SubscribeDone, () => {
      // Write the request ID
      this.writeVarInt62(msg.requestId);

      // Write the code
      this.writeVarInt62(msg.code);

      // Write the reason
      this.writeString(msg.reason);

      // Write the stream count
      this.writeVarInt53(msg.streamCount);

      // Note: reason is already written above, no need to write it twice
    });

    return this;
  }

  /**
   * Marshals an Announce message to the buffer
   * @param msg The Announce message to marshal
   * @returns The BufferCtrlWriter instance for chaining
   */
  public marshalAnnounce(msg: Announce): BufferCtrlWriter {
    this.marshalWithLength(Id.Announce, () => {
      // Write the request ID
      this.writeVarInt62(msg.requestId);

      // Write the namespace
      this.writeTuple(msg.namespace);

      // Convert Parameters map to KeyValuePair array and write them
      this.writeKeyValuePairs(msg.params);
    });

    return this;
  }

  /**
   * Marshals an AnnounceOk message to the buffer
   * @param msg The AnnounceOk message to marshal
   * @returns The BufferCtrlWriter instance for chaining
   */
  public marshalAnnounceOk(msg: AnnounceOk): BufferCtrlWriter {
    this.marshalWithLength(Id.AnnounceOk, () => {
      // Write the request ID
      this.writeVarInt62(msg.requestId);
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
   * Marshals an AnnounceError message to the buffer
   * @param msg The AnnounceError message to marshal
   * @returns The BufferCtrlWriter instance for chaining
   */
  public marshalAnnounceError(msg: AnnounceError): BufferCtrlWriter {
    this.marshalWithLength(Id.AnnounceError, () => {
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
   * Marshals an Unannounce message to the buffer
   * @param msg The Unannounce message to marshal
   * @returns The BufferCtrlWriter instance for chaining
   */
  public marshalUnannounce(msg: Unannounce): BufferCtrlWriter {
    this.marshalWithLength(Id.Unannounce, () => {
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
      // Write version count
      this.writeVarInt53(msg.versions.length);

      // Write each version
      for (const version of msg.versions) {
        this.writeVarInt53(version);
      }

      // Write parameters (if any)
      this.writeKeyValuePairs(msg.params);
    });

    return this;
  }

  /**
   * Marshals a Server setup message to the buffer
   * @param msg The Server setup message to marshal
   * @returns The BufferCtrlWriter instance for chaining
   */
  public marshalServerSetup(msg: {
    version: number;
    params?: KeyValuePair[];
  }): BufferCtrlWriter {
    this.marshalWithLength(Id.ServerSetup, () => {
      // Write the selected version
      this.writeVarInt53(msg.version);

      // Write parameters (if any)
      this.writeKeyValuePairs(msg.params);
    });

    return this;
  }
}
