import * as Stream from "./stream";
import * as Setup from "./setup";
import * as Control from "./control";

// Custom console logger for browser environment
const logger = {
  log: (message: string, ...args: any[]) => {
    console.log(`[MoQ] ${message}`, ...args);
    // Dispatch a custom event that our UI can listen to
    if (typeof window !== 'undefined') {
      const event = new CustomEvent('moq-log', { 
        detail: { type: 'info', message }
      });
      window.dispatchEvent(event);
    }
  },
  warn: (message: string, ...args: any[]) => {
    console.warn(`[MoQ] ${message}`, ...args);
    if (typeof window !== 'undefined') {
      const event = new CustomEvent('moq-log', { 
        detail: { type: 'warn', message }
      });
      window.dispatchEvent(event);
    }
  },
  error: (message: string, ...args: any[]) => {
    console.error(`[MoQ] ${message}`, ...args);
    if (typeof window !== 'undefined') {
      const event = new CustomEvent('moq-log', { 
        detail: { type: 'error', message }
      });
      window.dispatchEvent(event);
    }
  }
};

export interface ClientConfig {
  url: string;

  // If set, the server fingerprint will be fetched from this URL.
  // This is required to use self-signed certificates with Chrome
  fingerprint?: string;
}

export class Client {
  #fingerprint: Promise<WebTransportHash | undefined>;
  readonly config: ClientConfig;

  constructor(config: ClientConfig) {
    this.config = config;

    this.#fingerprint = this.#fetchFingerprint(config.fingerprint).catch((e) => {
      logger.warn("Failed to fetch fingerprint: ", e);
      return undefined;
    });
  }

  async connect(): Promise<Connection> {
    // Create WebTransport options
    const options: WebTransportOptions = {};

    const fingerprint = await this.#fingerprint;
    if (fingerprint) options.serverCertificateHashes = [fingerprint];

    logger.log(`Connecting to ${this.config.url}...`);
    const quic = new WebTransport(this.config.url, options);
    await quic.ready;
    logger.log("WebTransport connection established");

    const stream = await quic.createBidirectionalStream();
    logger.log("Bidirectional stream created");

    const writer = new Stream.Writer(stream.writable);
    const reader = new Stream.Reader(new Uint8Array(), stream.readable);

    const setup = new Setup.Stream(reader, writer);

    // Send the client setup message
    logger.log("Sending client setup message");
    await setup.send.client({
      versions: [Setup.Version.DRAFT_08],
    });

    // Receive the server setup message
    logger.log("Waiting for server setup message");
    const server = await setup.recv.server();
    logger.log("Received server setup:", server);

    if (server.version != Setup.Version.DRAFT_08) {
      throw new Error(`Unsupported server version: ${server.version}`);
    }

    // Create control stream for handling control messages
    const control = new Control.Stream(reader, writer);
    logger.log("Control stream established");

    // Start listening for control messages
    this.#listenForControlMessages(control);

    return new Connection(quic, control);
  }

  async #fetchFingerprint(url?: string): Promise<WebTransportHash | undefined> {
    if (!url) return;

    logger.log(`Fetching server certificate fingerprint from ${url}`);
    const response = await fetch(url);
    const hexString = await response.text();

    const hexBytes = new Uint8Array(hexString.length / 2);
    for (let i = 0; i < hexBytes.length; i += 1) {
      hexBytes[i] = parseInt(hexString.slice(2 * i, 2 * i + 2), 16);
    }

    return {
      algorithm: "sha-256",
      value: hexBytes,
    };
  }

  async #listenForControlMessages(control: Control.Stream) {
    logger.log("Starting to listen for control messages");
    
    try {
      // Keep listening for control messages
      while (true) {
        logger.log("Waiting for next control message...");
        const msg = await control.recv();
        logger.log("Received control message:", msg);
        
        // Here you would handle different types of control messages
        if (Control.isPublisher(msg)) {
          logger.log("Received publisher message:", msg.kind);
          // Handle publisher messages
        } else {
          logger.log("Received subscriber message:", msg.kind);
          // Handle subscriber messages
        }
      }
    } catch (error) {
      logger.error("Error while listening for control messages:", error);
    }
  }
}

export class Connection {
  // The established WebTransport session
  #quic: WebTransport;
  #control: Control.Stream;

  constructor(quic: WebTransport, control: Control.Stream) {
    this.#quic = quic;
    this.#control = control;
  }

  close(code = 0, reason = "") {
    this.#quic.close({ closeCode: code, reason });
  }

  async closed(): Promise<Error> {
    try {
      await this.#quic.closed;
      return new Error("Connection closed");
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  }
}
