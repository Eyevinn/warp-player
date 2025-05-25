import { ILogger, LoggerFactory } from "../logger";

import { BufferCtrlWriter } from "./bufferctrlwriter";
import { KeyValuePair, Reader, Writer } from "./stream";

// Logger for setup message operations
const setupLogger: ILogger = LoggerFactory.getInstance().getLogger("Setup");

export type Message = Client | Server;

export enum Version {
  DRAFT_11 = 0xff00000b,
}

enum SetupType {
  Client = 0x20,
  Server = 0x21,
}

export interface Client {
  versions: Version[];
  params?: Parameters;
}

export interface Server {
  version: Version;
  params?: Parameters;
}

export class Stream {
  recv: Decoder;
  send: Encoder;

  constructor(r: Reader, w: Writer) {
    this.recv = new Decoder(r);
    this.send = new Encoder(w);
  }
}

export type Parameters = KeyValuePair[];

export class Decoder {
  r: Reader;

  constructor(r: Reader) {
    this.r = r;
  }

  async client(): Promise<Client> {
    setupLogger.debug("Decoding client setup message...");

    const type: SetupType = await this.r.u53();
    setupLogger.debug(
      `Setup message type: 0x${type.toString(
        16,
      )} (expected 0x${SetupType.Client.toString(16)})`,
    );

    if (type !== SetupType.Client) {
      const errorMsg = `Client SETUP type must be ${SetupType.Client}, got ${type}`;
      setupLogger.error(errorMsg);
      throw new Error(errorMsg);
    }
    // Read the 16-bit MSB length field
    const lengthBytes = await this.r.read(2);
    const messageLength = (lengthBytes[0] << 8) | lengthBytes[1]; // MSB format
    setupLogger.debug(`Message length (16-bit MSB): ${messageLength} bytes`);

    const count = await this.r.u53();
    setupLogger.debug(`Number of supported versions: ${count}`);

    const versions = [];
    for (let i = 0; i < count; i++) {
      const version = await this.r.u53();
      versions.push(version);
      setupLogger.debug(
        `Supported version ${i + 1}: 0x${version.toString(16)}`,
      );
    }

    const params = await this.parameters();
    setupLogger.debug(
      `Parameters: ${params ? `${params.length} parameters` : "none"}`,
    );

    // Log each parameter in detail
    if (params && params.length > 0) {
      params.forEach((param) => {
        if (typeof param.value === "bigint") {
          setupLogger.debug(
            `Parameter ID: ${param.type}, value: ${param.value} (bigint)`,
          );
        } else {
          setupLogger.debug(
            `Parameter ID: ${param.type}, length: ${
              param.value.byteLength
            } bytes, value: ${this.formatBytes(param.value)}`,
          );
        }
      });
    }

    const result = {
      versions,
      params,
    };

    setupLogger.debug("Client setup message decoded:", result);
    return result;
  }

  async server(): Promise<Server> {
    setupLogger.debug("Decoding server setup message...");

    const type: SetupType = await this.r.u53();
    setupLogger.debug(
      `Setup message type: 0x${type.toString(
        16,
      )} (expected 0x${SetupType.Server.toString(16)})`,
    );

    if (type !== SetupType.Server) {
      const errorMsg = `Server SETUP type must be ${SetupType.Server}, got ${type}`;
      setupLogger.error(errorMsg);
      throw new Error(errorMsg);
    }

    // Read the 16-bit MSB length field
    const lengthBytes = await this.r.read(2);
    const messageLength = (lengthBytes[0] << 8) | lengthBytes[1]; // MSB format
    setupLogger.debug(`Message length (16-bit MSB): ${messageLength} bytes`);

    // Store the current position to validate length later
    const startPosition = this.r.getByteLength();

    const version = await this.r.u53();
    setupLogger.debug(`Server selected version: 0x${version.toString(16)}`);

    const params = await this.parameters();
    setupLogger.debug(
      `Parameters: ${params ? `${params.length} parameters` : "none"}`,
    );

    // Log each parameter in detail
    if (params && params.length > 0) {
      params.forEach((param) => {
        if (typeof param.value === "bigint") {
          setupLogger.debug(
            `Parameter ID: ${param.type}, value: ${param.value} (bigint)`,
          );
        } else {
          setupLogger.debug(
            `Parameter ID: ${param.type}, length: ${
              param.value.byteLength
            } bytes, value: ${this.formatBytes(param.value)}`,
          );
        }
      });
    }

    // Validate that we read the expected number of bytes
    const endPosition = this.r.getByteLength();
    const bytesRead = startPosition - endPosition;

    if (bytesRead !== messageLength) {
      const warningMsg = `Message length mismatch: expected ${messageLength} bytes, read ${bytesRead} bytes`;
      setupLogger.warn(warningMsg);
      // Not throwing an error here as we've already read the data
    }

    const result = {
      version,
      params,
    };

    setupLogger.debug("Server setup message decoded:", result);
    return result;
  }

  private formatBytes(bytes: Uint8Array): string {
    if (bytes.length <= 16) {
      return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
    } else {
      const start = Array.from(bytes.slice(0, 8))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      const end = Array.from(bytes.slice(-8))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      return `${start} ... ${end} (${bytes.length} bytes total)`;
    }
  }

  private async parameters(): Promise<Parameters | undefined> {
    const countResult = await this.r.u53WithSize();
    const count = countResult.value;

    setupLogger.debug(
      `Parameter count: ${count}, count field: ${countResult.bytesRead} bytes`,
    );

    if (count === 0) {
      return undefined;
    }

    const params: Parameters = [];

    for (let i = 0; i < count; i++) {
      // Read parameter type (key)
      const typeResult = await this.r.u62WithSize();
      const paramType = typeResult.value;

      // Check if the type is even or odd
      const isEven = paramType % 2n === 0n;

      if (isEven) {
        // Even type: value is a single varint
        const valueResult = await this.r.u62WithSize();
        const value = valueResult.value;
        setupLogger.debug(
          `Parameter ${
            i + 1
          }/${count}: Type ${paramType} (even), Value: ${value} (${
            valueResult.bytesRead
          } bytes)`,
        );

        // Check for duplicates
        const existingIndex = params.findIndex((p) => p.type === paramType);
        if (existingIndex !== -1) {
          setupLogger.warn(
            `Duplicate parameter type: ${paramType}, overwriting previous value`,
          );
          params.splice(existingIndex, 1);
        }

        params.push({ type: paramType, value });
      } else {
        // Odd type: value is a byte sequence with length
        const lengthResult = await this.r.u53WithSize();
        const length = lengthResult.value;

        // Check maximum length (2^16-1)
        if (length > 65535) {
          const errorMsg = `Parameter value length exceeds maximum: ${length} > 65535`;
          setupLogger.error(errorMsg);
          throw new Error(errorMsg);
        }

        // Read the value bytes
        const value = await this.r.read(length);
        // At this point, value should always be a Uint8Array
        setupLogger.debug(
          `Parameter ${
            i + 1
          }/${count}: Type ${paramType} (odd), Length: ${length}, Value: ${this.formatBytes(
            value,
          )}`,
        );

        // Check for duplicates
        const existingIndex = params.findIndex((p) => p.type === paramType);
        if (existingIndex !== -1) {
          setupLogger.warn(
            `Duplicate parameter type: ${paramType}, overwriting previous value`,
          );
          params.splice(existingIndex, 1);
        }

        params.push({ type: paramType, value });
      }
    }

    return params;
  }
}

export class Encoder {
  w: Writer;

  constructor(w: Writer) {
    this.w = w;
  }

  async client(c: Client): Promise<void> {
    setupLogger.debug("Encoding client setup message:", c);

    // Create a BufferCtrlWriter instance
    const writer = new BufferCtrlWriter();

    // Marshal the client setup message
    writer.marshalClientSetup({
      versions: c.versions,
      params: c.params,
    });

    // Get the bytes from the writer
    const bytes = writer.getBytes();
    setupLogger.debug(`Client setup message created: ${bytes.length} bytes`);

    // Write the entire message in a single operation
    await this.w.write(bytes);

    setupLogger.debug("Client setup message sent successfully");
  }

  async server(s: Server): Promise<void> {
    setupLogger.debug("Encoding server setup message:", s);

    // Create a BufferCtrlWriter instance
    const writer = new BufferCtrlWriter();

    // Marshal the server setup message
    writer.marshalServerSetup({
      version: s.version,
      params: s.params,
    });

    // Get the bytes from the writer
    const bytes = writer.getBytes();
    setupLogger.debug(`Server setup message created: ${bytes.length} bytes`);

    // Write the entire message in a single operation
    await this.w.write(bytes);

    setupLogger.debug("Server setup message sent successfully");
  }

  private buildVersions(versions: Version[]) {
    let versionBytes = 0;
    const versionPayload = [];

    const versionLength = this.w.setVint53(new Uint8Array(8), versions.length);
    versionPayload.push(versionLength);
    versionBytes += versionLength.length;
    setupLogger.debug(
      `Version count: ${versions.length}, ${versionLength.length} bytes`,
    );

    for (const v of versions) {
      const version = this.w.setVint53(new Uint8Array(8), v);
      versionPayload.push(version);
      versionBytes += version.length;
      setupLogger.debug(
        `Version: 0x${v.toString(16)}, ${version.length} bytes`,
      );
    }
    return { versionBytes, versionPayload };
  }

  private async buildParameters(params?: Parameters): Promise<Uint8Array> {
    // Create a temporary stream to collect the bytes
    const chunks: Uint8Array[] = [];
    const tempStream = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    });

    const w = new Writer(tempStream);

    if (!params || params.length === 0) {
      await w.u53(0);
      setupLogger.debug(
        "No parameters to encode, setting parameter count to 0",
      );
      // Release the writer and combine the chunks
      w.release();
      return this.combineChunks(chunks);
    }

    await w.u53(params.length);
    setupLogger.debug(`Parameter count: ${params.length}`);

    for (const param of params) {
      // Write parameter type (key)
      await w.u62(param.type);

      // Check if the type is even or odd
      const isEven = param.type % 2n === 0n;

      if (isEven) {
        // Even type: value is a single varint
        if (typeof param.value !== "bigint") {
          throw new Error(
            `Even parameter type ${param.type} requires a bigint value`,
          );
        }
        await w.u62(param.value);
        setupLogger.debug(
          `Encoded parameter: Type ${param.type} (even), Value: ${param.value}`,
        );
      } else {
        // Odd type: value is a byte sequence with length
        if (!(param.value instanceof Uint8Array)) {
          throw new Error(
            `Odd parameter type ${param.type} requires a Uint8Array value`,
          );
        }

        // Check maximum length (2^16-1)
        if (param.value.byteLength > 65535) {
          throw new Error(
            `Parameter value length exceeds maximum: ${param.value.byteLength} > 65535`,
          );
        }

        // Write length and value
        await w.u53(param.value.byteLength);
        await w.write(param.value);
        setupLogger.debug(
          `Encoded parameter: Type ${param.type} (odd), Length: ${
            param.value.byteLength
          }, Value: ${this.formatBytes(param.value)}`,
        );
      }
    }

    // Release the writer and combine the chunks
    w.release();
    return this.combineChunks(chunks);
  }

  private combineChunks(chunks: Uint8Array[]): Uint8Array {
    // Calculate total length
    let totalLength = 0;
    for (const chunk of chunks) {
      totalLength += chunk.length;
    }

    // Combine all chunks into a single Uint8Array
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }

  private formatBytes(bytes: Uint8Array): string {
    if (bytes.length <= 16) {
      return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
    } else {
      const start = Array.from(bytes.slice(0, 8))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      const end = Array.from(bytes.slice(-8))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      return `${start} ... ${end} (${bytes.length} bytes total)`;
    }
  }
}
