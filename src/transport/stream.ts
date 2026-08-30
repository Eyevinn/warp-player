import {
  VI64_MAX,
  VI64_MAX_LEN,
  encodeVi64,
  readVi64,
  vi64PeekLen,
} from "./vi64";

export interface KeyValuePair {
  type: bigint;
  value: bigint | Uint8Array;
}

const MAX_U31 = Math.pow(2, 31) - 1;
const MAX_U53 = Number.MAX_SAFE_INTEGER;

// Reader wraps a stream and provides convenience methods for reading pieces from a stream
export class Reader {
  #buffer: Uint8Array;
  #stream: ReadableStream<Uint8Array>;
  #reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(buffer: Uint8Array, stream: ReadableStream<Uint8Array>) {
    this.#buffer = buffer;
    this.#stream = stream;
    this.#reader = this.#stream.getReader();
  }

  getByteLength(): number {
    return this.#buffer.byteLength;
  }

  // Get a copy of the current buffer
  getBuffer(): Uint8Array {
    return new Uint8Array(this.#buffer);
  }

  // Adds more data to the buffer, returning true if more data was added.
  async #fill(): Promise<boolean> {
    const result = await this.#reader.read();
    if (result.done) {
      return false;
    }

    const buffer = new Uint8Array(result.value);

    if (this.#buffer.byteLength === 0) {
      this.#buffer = buffer;
    } else {
      const temp = new Uint8Array(this.#buffer.byteLength + buffer.byteLength);
      temp.set(this.#buffer);
      temp.set(buffer, this.#buffer.byteLength);
      this.#buffer = temp;
    }

    return true;
  }

  // Add more data to the buffer until it's at least size bytes.
  async #fillTo(size: number) {
    while (this.#buffer.byteLength < size) {
      if (!(await this.#fill())) {
        throw new Error("unexpected end of stream");
      }
    }
  }

  // Consumes the first size bytes of the buffer.
  #slice(size: number): Uint8Array {
    const result = new Uint8Array(
      this.#buffer.buffer,
      this.#buffer.byteOffset,
      size,
    );
    this.#buffer = new Uint8Array(
      this.#buffer.buffer,
      this.#buffer.byteOffset + size,
    );

    return result;
  }

  async read(size: number): Promise<Uint8Array> {
    if (size === 0) {
      return new Uint8Array();
    }

    await this.#fillTo(size);
    return this.#slice(size);
  }

  async readAll(): Promise<Uint8Array> {
    // eslint-disable-next-line no-empty
    while (await this.#fill()) {}
    return this.#slice(this.#buffer.byteLength);
  }

  async tuple(): Promise<string[]> {
    // Get the count of tuple elements
    const count = await this.u53();

    // Read each tuple element individually
    const tupleElements: string[] = [];
    for (let i = 0; i < count; i++) {
      // Each element is a varint length followed by that many bytes
      const length = await this.u53();
      const bytes = await this.read(length);
      const element = new TextDecoder().decode(bytes);
      tupleElements.push(element);
    }

    return tupleElements;
  }

  async string(maxLength?: number): Promise<string> {
    const length = await this.u53();
    if (maxLength !== undefined && length > maxLength) {
      throw new Error(
        `string length ${length} exceeds max length ${maxLength}`,
      );
    }

    const buffer = await this.read(length);
    return new TextDecoder().decode(buffer);
  }

  async u8(): Promise<number> {
    await this.#fillTo(1);
    return this.#slice(1)[0];
  }

  async u8Bool(): Promise<boolean> {
    await this.#fillTo(1);
    return this.#slice(1)[0] !== 0;
  }

  // Returns a Number using 53-bits, the max Javascript can use for integer math
  async u53(): Promise<number> {
    const v = await this.u62();
    if (v > MAX_U53) {
      throw new Error("value larger than 53-bits; use v62 instead");
    }

    return Number(v);
  }

  // Returns a Number using 53-bits and tracks the number of bytes read
  async u53WithSize(): Promise<{ value: number; bytesRead: number }> {
    const result = await this.u62WithSize();
    const v = result.value;
    if (v > MAX_U53) {
      throw new Error("value larger than 53-bits; use v62 instead");
    }

    return { value: Number(v), bytesRead: result.bytesRead };
  }

  // NOTE: Returns a bigint instead of a number since it may be larger than 53-bits
  async u62(): Promise<bigint> {
    return (await this.u62WithSize()).value;
  }

  // Returns a bigint and tracks the number of bytes read
  // Returns a bigint and tracks the number of bytes read.
  //
  // draft-18 varints (vi64) carry the length as leading one-bits in the first
  // byte, so the length is known from that byte alone and the value spans up
  // to 9 bytes -- the full unsigned 64-bit range, not RFC 9000's 62 bits.
  async u62WithSize(): Promise<{ value: bigint; bytesRead: number }> {
    await this.#fillTo(1);
    const size = vi64PeekLen(this.#buffer[0]);
    await this.#fillTo(size);
    const { value, bytesRead } = readVi64(this.#slice(size), 0);
    return { value, bytesRead };
  }

  async keyValuePairs(): Promise<KeyValuePair[]> {
    const numPairs = await this.u53();
    const result: KeyValuePair[] = [];
    for (let i = 0; i < numPairs; i++) {
      const key = await this.u62();
      if (key % 2n === 0n) {
        const value = await this.u62();
        result.push({ type: key, value });
      } else {
        const length = await this.u53();
        const value = await this.read(length);
        result.push({ type: key, value });
      }
    }
    return result;
  }

  async done(): Promise<boolean> {
    if (this.#buffer.byteLength > 0) {
      return false;
    }
    return !(await this.#fill());
  }

  async close(): Promise<void> {
    this.#reader.releaseLock();
    await this.#stream.cancel();
  }

  release(): [Uint8Array, ReadableStream<Uint8Array>] {
    this.#reader.releaseLock();
    return [this.#buffer, this.#stream];
  }
}

// Writer wraps a stream and writes chunks of data
export class Writer {
  #scratch: Uint8Array;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #stream: WritableStream<Uint8Array>;

  constructor(stream: WritableStream<Uint8Array>) {
    this.#stream = stream;
    // 9 bytes: the longest vi64 encoding (draft-18 Section 1.4.1).
    this.#scratch = new Uint8Array(VI64_MAX_LEN);
    this.#writer = this.#stream.getWriter();
  }

  async u8(v: number): Promise<void> {
    await this.write(this.setUint8(this.#scratch, v));
  }

  async i32(v: number): Promise<void> {
    if (Math.abs(v) > MAX_U31) {
      throw new Error(`overflow, value larger than 32-bits: ${v}`);
    }

    // We don't use a VarInt, so it always takes 4 bytes.
    await this.write(this.setInt32(this.#scratch, v));
  }

  async u53(v: number): Promise<void> {
    if (v < 0) {
      throw new Error(`underflow, value is negative: ${v}`);
    } else if (v > MAX_U53) {
      throw new Error(`overflow, value larger than 53-bits: ${v}`);
    }

    await this.write(this.setVint53(this.#scratch, v));
  }

  async u62(v: bigint): Promise<void> {
    if (v < 0) {
      throw new Error(`underflow, value is negative: ${v}`);
    } else if (v > VI64_MAX) {
      throw new Error(`overflow, value larger than 64-bits: ${v}`);
    }

    await this.write(this.setVint62(this.#scratch, v));
  }

  setUint8(dst: Uint8Array, v: number): Uint8Array {
    dst[0] = v;
    return dst.slice(0, 1);
  }

  setUint16(dst: Uint8Array, v: number): Uint8Array {
    const view = new DataView(dst.buffer, dst.byteOffset, 2);
    view.setUint16(0, v);

    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  setInt32(dst: Uint8Array, v: number): Uint8Array {
    const view = new DataView(dst.buffer, dst.byteOffset, 4);
    view.setInt32(0, v);

    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  setUint32(dst: Uint8Array, v: number): Uint8Array {
    const view = new DataView(dst.buffer, dst.byteOffset, 4);
    view.setUint32(0, v);

    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  setVint53(dst: Uint8Array, v: number): Uint8Array {
    if (v > MAX_U53) {
      throw new Error(`overflow, value larger than 53-bits: ${v}`);
    }
    return this.setVint62(dst, BigInt(v));
  }

  // Encodes v as a draft-18 vi64. The result is up to 9 bytes, so callers
  // relying on the scratch buffer must size it for VI64_MAX_LEN.
  setVint62(dst: Uint8Array, v: bigint): Uint8Array {
    if (v < 0n || v > VI64_MAX) {
      throw new Error(`overflow, value out of unsigned 64-bit range: ${v}`);
    }
    const enc = encodeVi64(v);
    dst.set(enc, 0);
    return dst.slice(0, enc.length);
  }

  setUint64(dst: Uint8Array, v: bigint): Uint8Array {
    const view = new DataView(dst.buffer, dst.byteOffset, 8);
    view.setBigUint64(0, v);

    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  concatBuffer(bufferArray: (Uint8Array | undefined)[]): Uint8Array {
    let length = 0;
    bufferArray.forEach((buffer) => {
      if (buffer === undefined) {
        return;
      }
      length += buffer.length;
    });
    let offset = 0;
    const result = new Uint8Array(length);
    bufferArray.forEach((buffer) => {
      if (buffer === undefined) {
        return;
      }
      result.set(buffer, offset);
      offset += buffer.length;
    });
    return result;
  }

  encodeTuple(buffer: Uint8Array, tuple: string[]): Uint8Array {
    const tupleBytes = new TextEncoder().encode(tuple.join("/"));

    return this.concatBuffer([
      this.setVint53(buffer, tuple.length),
      this.setVint53(buffer, tupleBytes.length),
      tupleBytes,
    ]);
  }

  encodeString(buffer: Uint8Array, str: string): Uint8Array {
    const strBytes = new TextEncoder().encode(str);

    return this.concatBuffer([
      this.setVint53(buffer, strBytes.length),
      strBytes,
    ]);
  }

  async write(v: Uint8Array): Promise<void> {
    await this.#writer.write(v);
  }

  async tuple(arr: string[]): Promise<void> {
    // Write the count of tuple elements
    await this.u53(arr.length);

    // Write each tuple element individually
    for (let i = 0; i < arr.length; i++) {
      const element = arr[i];
      const bytes = new TextEncoder().encode(element);

      // Each element is a varint length followed by that many bytes
      await this.u53(bytes.length);
      await this.write(bytes);
    }
  }

  async string(str: string): Promise<void> {
    const data = new TextEncoder().encode(str);
    await this.u53(data.byteLength);
    await this.write(data);
  }

  async close(): Promise<void> {
    this.#writer.releaseLock();
    await this.#stream.close();
  }

  release(): WritableStream<Uint8Array> {
    this.#writer.releaseLock();
    return this.#stream;
  }
}
