import { Reader, Writer } from "./stream";

// Custom console logger for browser environment
const logger = {
  log: (message: string, ...args: any[]) => {
    console.log(`[MoQ Setup] ${message}`, ...args);
    // Dispatch a custom event that our UI can listen to
    if (typeof window !== 'undefined') {
      const event = new CustomEvent('moq-log', { 
        detail: { type: 'info', message: `[Setup] ${message}` }
      });
      window.dispatchEvent(event);
    }
  },
  warn: (message: string, ...args: any[]) => {
    console.warn(`[MoQ Setup] ${message}`, ...args);
    if (typeof window !== 'undefined') {
      const event = new CustomEvent('moq-log', { 
        detail: { type: 'warn', message: `[Setup] ${message}` }
      });
      window.dispatchEvent(event);
    }
  },
  error: (message: string, ...args: any[]) => {
    console.error(`[MoQ Setup] ${message}`, ...args);
    if (typeof window !== 'undefined') {
      const event = new CustomEvent('moq-log', { 
        detail: { type: 'error', message: `[Setup] ${message}` }
      });
      window.dispatchEvent(event);
    }
  }
};

export type Message = Client | Server;

export enum Version {
  DRAFT_08 = 0xff000008,
}

enum SetupType {
  Client = 0x40,
  Server = 0x41,
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

export type Parameters = Map<bigint, Uint8Array>;

export class Decoder {
  r: Reader;

  constructor(r: Reader) {
    this.r = r;
  }

  async client(): Promise<Client> {
    logger.log("Decoding client setup message...");
    
    const type: SetupType = await this.r.u53();
    logger.log(`Setup message type: ${type} (expected ${SetupType.Client})`);
    
    if (type !== SetupType.Client) {
      const errorMsg = `Client SETUP type must be ${SetupType.Client}, got ${type}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const count = await this.r.u53();
    logger.log(`Number of supported versions: ${count}`);

    const versions = [];
    for (let i = 0; i < count; i++) {
      const version = await this.r.u53();
      versions.push(version);
      logger.log(`Supported version ${i+1}: 0x${version.toString(16)}`);
    }

    const params = await this.parameters();
    logger.log(`Parameters: ${params ? `${params.size} parameters` : 'none'}`);

    const result = {
      versions,
      params,
    };
    
    logger.log("Client setup message decoded:", result);
    return result;
  }

  async server(): Promise<Server> {
    logger.log("Decoding server setup message...");
    
    const type: SetupType = await this.r.u53();
    logger.log(`Setup message type: ${type} (expected ${SetupType.Server})`);
    
    if (type !== SetupType.Server) {
      const errorMsg = `Server SETUP type must be ${SetupType.Server}, got ${type}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const advertisedLength = await this.r.u53();
    const actualLength = this.r.getByteLength();
    logger.log(`Advertised message length: ${advertisedLength}, actual length: ${actualLength}`);
    
    if (advertisedLength !== actualLength) {
      const errorMsg = `Server SETUP message length mismatch: ${advertisedLength} != ${actualLength}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const version = await this.r.u53();
    logger.log(`Server selected version: 0x${version.toString(16)}`);
    
    const params = await this.parameters();
    logger.log(`Parameters: ${params ? `${params.size} parameters` : 'none'}`);
    
    // Log each parameter in detail
    if (params && params.size > 0) {
      params.forEach((value, key) => {
        logger.log(`Parameter ID: ${key}, length: ${value.length} bytes, value: ${this.formatBytes(value)}`);
      });
    }

    const result = {
      version,
      params,
    };
    
    logger.log("Server setup message decoded:", result);
    return result;
  }

  private formatBytes(bytes: Uint8Array): string {
    if (bytes.length <= 16) {
      return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join(' ');
    } else {
      const start = Array.from(bytes.slice(0, 8))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(' ');
      const end = Array.from(bytes.slice(-8))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(' ');
      return `${start} ... ${end} (${bytes.length} bytes total)`;
    }
  }

  private async parameters(): Promise<Parameters | undefined> {
    const count = await this.r.u53();
    logger.log(`Parameter count: ${count}`);
    
    if (count == 0) return undefined;

    const params = new Map<bigint, Uint8Array>();

    for (let i = 0; i < count; i++) {
      const id = await this.r.u62();
      const size = await this.r.u53();
      logger.log(`Parameter ${i+1}/${count}: ID ${id}, size ${size} bytes`);
      
      const value = await this.r.read(size);

      if (params.has(id)) {
        const errorMsg = `Duplicate parameter ID: ${id}`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
      }

      params.set(id, value);
    }

    return params;
  }
}

export class Encoder {
  w: Writer;

  constructor(w: Writer) {
    this.w = w;
  }

  async client(c: Client) {
    logger.log("Encoding client setup message:", c);
    
    let len = 0;
    const msg: Uint8Array[] = [];

    const { versionBytes, versionPayload } = this.buildVersions(c.versions);
    len += versionBytes;
    msg.push(...versionPayload);
    logger.log(`Added ${c.versions.length} versions, ${versionBytes} bytes`);

    // Note: We're not adding role parameter as per requirements
    const params = c.params ?? new Map();
    const { paramData, totalBytes } = this.buildParameters(params);
    len += totalBytes;
    msg.push(...paramData);
    logger.log(`Added ${params.size} parameters, ${totalBytes} bytes`);

    const messageType = this.w.setVint53(new Uint8Array(8), SetupType.Client);
    const messageLength = this.w.setVint53(new Uint8Array(8), len);
    logger.log(`Total message length: ${len} bytes`);

    for (const elem of [messageType, messageLength, ...msg]) {
      await this.w.write(elem);
    }
    
    logger.log("Client setup message sent successfully");
  }

  async server(s: Server) {
    logger.log("Encoding server setup message:", s);
    
    let len = 0;
    const msg: Uint8Array[] = [];

    const version = this.w.setVint53(new Uint8Array(8), s.version);
    len += version.length;
    msg.push(version);
    logger.log(`Added version: 0x${s.version.toString(16)}, ${version.length} bytes`);

    const params = s.params ?? new Map();
    const { paramData, totalBytes } = this.buildParameters(params);
    len += totalBytes;
    msg.push(...paramData);
    logger.log(`Added ${params.size} parameters, ${totalBytes} bytes`);

    const messageType = this.w.setVint53(new Uint8Array(8), SetupType.Server);
    const messageLength = this.w.setVint53(new Uint8Array(8), len);
    logger.log(`Total message length: ${len} bytes`);

    for (const elem of [messageType, messageLength, ...msg]) {
      await this.w.write(elem);
    }
    
    logger.log("Server setup message sent successfully");
  }

  private buildVersions(versions: Version[]) {
    let versionBytes = 0;
    const versionPayload = [];

    const versionLength = this.w.setVint53(new Uint8Array(8), versions.length);
    versionPayload.push(versionLength);
    versionBytes += versionLength.length;
    logger.log(`Version count: ${versions.length}, ${versionLength.length} bytes`);

    for (const v of versions) {
      const version = this.w.setVint53(new Uint8Array(8), v);
      versionPayload.push(version);
      versionBytes += version.length;
      logger.log(`Version: 0x${v.toString(16)}, ${version.length} bytes`);
    }
    return { versionBytes, versionPayload };
  }

  private buildParameters(p: Parameters | undefined): { paramData: Uint8Array[]; totalBytes: number } {
    if (!p) {
      const paramCount = this.w.setUint8(new Uint8Array(8), 0);
      logger.log("No parameters to encode");
      return { paramData: [paramCount], totalBytes: 1 };
    }
    
    const paramBytes = [this.w.setVint53(new Uint8Array(8), p.size)];
    let totalBytes = paramBytes[0].length;
    logger.log(`Parameter count: ${p.size}, ${paramBytes[0].length} bytes`);

    for (const [id, value] of p) {
      const idBytes = this.w.setVint62(new Uint8Array(8), id);
      const sizeBytes = this.w.setVint53(new Uint8Array(8), value.length);
      paramBytes.push(idBytes, sizeBytes, value);
      totalBytes += idBytes.length + sizeBytes.length + value.length;
      logger.log(`Parameter ID: ${id}, size: ${value.length} bytes, total: ${idBytes.length + sizeBytes.length + value.length} bytes`);
    }
    return { paramData: paramBytes, totalBytes };
  }
}
