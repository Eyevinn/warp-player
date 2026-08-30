/**
 * The draft-18 session shape: a pair of unidirectional control streams, and one
 * bidirectional stream per request.
 *
 * draft-16 put everything on a single bidirectional control stream and matched
 * responses to requests by Request ID. draft-18 replaces both halves of that:
 *
 * - **The control stream is a pair.** Each side opens its own unidirectional
 *   stream and sends SETUP on it (Section 3.3). There is no client/server
 *   ordering and nothing is negotiated — the version came from the ALPN before
 *   a byte of MOQT was written — so a peer's SETUP only reports the options it
 *   chose. The stream's leading varint, 0x2F00, is simultaneously the
 *   unidirectional stream type and SETUP's own message type, so opening the
 *   stream and sending SETUP are one act.
 *
 * - **Each request owns a bidirectional stream.** The stream *is* the request's
 *   identity, so responses carry no Request ID and there is no dispatch table
 *   to keep. Closing the stream is how a request ends.
 */

import { ILogger, LoggerFactory } from "../logger";

import {
  CtrlMessage,
  CtrlType,
  ctrlTypeName,
  decodeCtrlBody,
  encodeCtrlMessage,
  StreamType,
} from "./messages18";
import { Reader, Writer } from "./stream";

/**
 * Read one length-framed control message from `r`.
 *
 * Returns null at a clean end of stream between messages — for a request stream
 * that is the peer finishing the request, not an error.
 */
async function readCtrlMessage(
  r: Reader,
  onControlStream: boolean,
): Promise<CtrlMessage | null> {
  if (await r.done()) {
    return null;
  }
  const type = Number(await r.u62()) as CtrlType;
  return readCtrlBody(r, type, onControlStream);
}

/**
 * Read the length and body of a message whose type varint has already been
 * consumed.
 *
 * The control stream needs this: its leading varint is both the stream type and
 * the type of its first message, so the caller sniffs the stream type and then
 * hands it back rather than trying to unread it.
 */
export async function readCtrlBody(
  r: Reader,
  type: CtrlType,
  onControlStream: boolean,
): Promise<CtrlMessage> {
  const hi = await r.u8();
  const lo = await r.u8();
  const length = (hi << 8) | lo;
  const body = length > 0 ? await r.read(length) : new Uint8Array();
  return decodeCtrlBody(type, body, onControlStream);
}

/**
 * The two unidirectional streams carrying control messages.
 *
 * The draft forbids closing a control stream for the life of the session:
 * doing so is a PROTOCOL_VIOLATION.
 */
export class ControlStreamPair {
  #writer: Writer;
  #logger: ILogger;
  #peerSetup: CtrlMessage | null = null;

  private constructor(writer: Writer, logger: ILogger) {
    this.#writer = writer;
    this.#logger = logger;
  }

  /**
   * Open our control stream, send SETUP on it, and adopt the peer's.
   *
   * `acceptControlStream` is handed the job of finding the peer's control
   * stream among the incoming unidirectional streams, since the same accept
   * loop also has to route data streams.
   */
  static async establish(
    wt: WebTransport,
    setup: CtrlMessage,
    acceptControlStream: () => Promise<Reader>,
  ): Promise<ControlStreamPair> {
    const logger = LoggerFactory.getInstance().getLogger("ControlStream");

    const stream = await wt.createUnidirectionalStream();
    const writer = new Writer(stream);
    // encodeCtrlMessage writes SETUP's type varint 0x2F00 first, which is also
    // the unidirectional stream type. One write serves both.
    await writer.write(encodeCtrlMessage(setup));
    logger.info("Sent SETUP on our control stream");

    let resolveReady!: () => void;
    let rejectReady!: (e: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const pair = new ControlStreamPair(writer, logger);

    void (async () => {
      try {
        const reader = await acceptControlStream();
        // The stream type varint has already been consumed by the sniffing
        // accept loop, and it is SETUP's type, so read the body directly.
        const peerSetup = await readCtrlBody(reader, CtrlType.Setup, true);
        pair.#peerSetup = peerSetup;
        logger.info("Received peer SETUP");
        resolveReady();
        await pair.#readLoop(reader);
      } catch (e) {
        rejectReady(e);
      }
    })();

    await ready;
    return pair;
  }

  get peerSetup(): CtrlMessage | null {
    return this.#peerSetup;
  }

  async send(msg: CtrlMessage): Promise<void> {
    await this.#writer.write(encodeCtrlMessage(msg));
  }

  /**
   * Drain the peer's control stream.
   *
   * After SETUP the only thing that arrives here is GOAWAY, which this player
   * reads and ignores: nothing it does yet depends on session migration.
   */
  async #readLoop(reader: Reader): Promise<void> {
    for (;;) {
      const msg = await readCtrlMessage(reader, true);
      if (msg === null) {
        return;
      }
      if (msg.kind === CtrlType.GoAway) {
        this.#logger.info(
          `GOAWAY: new session URI "${msg.newSessionUri}" (ignored)`,
        );
      } else {
        this.#logger.warn(
          `Unexpected ${ctrlTypeName(msg.kind)} on the control stream`,
        );
      }
    }
  }
}

/**
 * One request's bidirectional stream.
 *
 * The opening message is written when the stream is created — Section 3.3
 * requires it to be first — and every response for that request arrives back on
 * the same stream, in order.
 */
export class RequestStream {
  #reader: Reader;
  #writer: Writer;
  #stream: WebTransportBidirectionalStream;
  #logger: ILogger;
  #closed = false;

  private constructor(
    stream: WebTransportBidirectionalStream,
    reader: Reader,
    writer: Writer,
    logger: ILogger,
  ) {
    this.#stream = stream;
    this.#reader = reader;
    this.#writer = writer;
    this.#logger = logger;
  }

  /** Open a bidirectional stream and send `open` as its first message. */
  static async open(
    wt: WebTransport,
    open: CtrlMessage,
  ): Promise<RequestStream> {
    const logger = LoggerFactory.getInstance().getLogger("RequestStream");
    const stream = await wt.createBidirectionalStream();
    const writer = new Writer(stream.writable);
    const reader = new Reader(new Uint8Array(), stream.readable);
    await writer.write(encodeCtrlMessage(open));
    logger.debug(`Opened request stream with ${ctrlTypeName(open.kind)}`);
    return new RequestStream(stream, reader, writer, logger);
  }

  /**
   * Read the next message on this request's stream, or null once the peer has
   * finished it.
   */
  async next(): Promise<CtrlMessage | null> {
    if (this.#closed) {
      return null;
    }
    return readCtrlMessage(this.#reader, false);
  }

  /** Send a follow-up message, such as REQUEST_UPDATE. */
  async send(msg: CtrlMessage): Promise<void> {
    await this.#writer.write(encodeCtrlMessage(msg));
  }

  /**
   * End the request.
   *
   * Closing our side of a request stream is draft-18's replacement for
   * UNSUBSCRIBE and UNANNOUNCE: there is no separate message for either.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      await this.#writer.close();
    } catch (e) {
      this.#logger.debug(`Closing request stream writer: ${e}`);
    }
  }

  /** Abandon the request, which is a reset rather than a graceful close. */
  abort(reason?: unknown): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.#stream.writable.abort(reason);
      void this.#stream.readable.cancel(reason);
    } catch (e) {
      this.#logger.debug(`Aborting request stream: ${e}`);
    }
  }
}

/**
 * Accepts unidirectional streams and routes them by their leading type varint.
 *
 * This has to start before SETUP is sent, not after: with 0-RTT either side may
 * speak first, and Section 3.3 says object streams may arrive before the
 * control streams exist. Data streams that turn up early are held here until
 * the session has something to hand them to, rather than being dropped.
 */
export class UniStreamRouter {
  #logger: ILogger;
  #controlReader: Promise<Reader>;
  #resolveControl!: (r: Reader) => void;
  #rejectControl!: (e: unknown) => void;
  #controlSeen = false;

  /** Set once the session can take data streams; until then they queue. */
  #onData: ((reader: Reader, streamType: bigint) => void) | null = null;
  #pending: { reader: Reader; streamType: bigint }[] = [];

  constructor(wt: WebTransport) {
    this.#logger = LoggerFactory.getInstance().getLogger("UniStreamRouter");
    this.#controlReader = new Promise<Reader>((resolve, reject) => {
      this.#resolveControl = resolve;
      this.#rejectControl = reject;
    });
    void this.#accept(wt);
  }

  /** The peer's control stream, with its type varint already consumed. */
  controlStream(): Promise<Reader> {
    return this.#controlReader;
  }

  /** Hand over data-stream routing, flushing anything that arrived early. */
  setDataHandler(fn: (reader: Reader, streamType: bigint) => void): void {
    this.#onData = fn;
    const queued = this.#pending;
    this.#pending = [];
    if (queued.length > 0) {
      this.#logger.debug(`Flushing ${queued.length} buffered data stream(s)`);
    }
    for (const { reader, streamType } of queued) {
      fn(reader, streamType);
    }
  }

  async #accept(wt: WebTransport): Promise<void> {
    try {
      const streams = wt.incomingUnidirectionalStreams.getReader();
      for (;;) {
        const { value: stream, done } = await streams.read();
        if (done) {
          this.#rejectControl(new Error("connection closed before peer SETUP"));
          return;
        }
        void this.#route(stream);
      }
    } catch (e) {
      this.#rejectControl(e);
    }
  }

  async #route(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = new Reader(new Uint8Array(), stream);
    try {
      const streamType = await reader.u62();
      if (streamType === BigInt(StreamType.Setup)) {
        if (this.#controlSeen) {
          // A second control stream is a PROTOCOL_VIOLATION (Section 3.3).
          throw new Error("peer opened a second control stream");
        }
        this.#controlSeen = true;
        this.#logger.info("Adopted the peer's control stream");
        this.#resolveControl(reader);
        return;
      }
      if (this.#onData) {
        this.#onData(reader, streamType);
      } else {
        this.#pending.push({ reader, streamType });
      }
    } catch (e) {
      this.#logger.error(`Routing incoming stream: ${e}`);
    }
  }
}
