import { ILogger, LoggerFactory } from "../logger";

import {
  CtrlType,
  ctrlTypeName,
  opensRequestStream,
  type CtrlMessage,
  type Setup,
} from "./messages18";
import { encodeCtrlMessage } from "./messages18";
import { ControlStreamPair, UniStreamRouter, readCtrlBody } from "./session18";
import { Reader, Writer } from "./stream";
import {
  TracksManager,
  ObjectCallback,
  SubscribeOptions,
  SubscriptionInfo,
} from "./tracks";
import { Version, SUPPORTED_PROTOCOLS, versionForProtocol } from "./version";

/**
 * Only draft-18 is spoken. The option is kept so the UI can show which draft is
 * in use and so a future draft can be added beside it.
 */
export type DraftVersion = "auto" | "draft-18";

export interface ClientConfig {
  url: string;

  // If set, the server fingerprint will be fetched from this URL.
  // This is required to use self-signed certificates with Chrome
  fingerprint?: string;

  // Protocol draft version. Only "auto" and "draft-18" are meaningful today.
  draftVersion?: DraftVersion;
}

const decoder = new TextDecoder();

export class Client {
  #fingerprint: Promise<WebTransportHash | undefined>;
  readonly config: ClientConfig;
  // Track the next request ID to use (client IDs are even, starting at 0)
  #nextRequestId: bigint = 0n;
  // The negotiated protocol version (set during connect)
  #negotiatedVersion: Version = Version.DRAFT_18;
  // Store the trackAlias used for catalog subscription
  // eslint-disable-next-line no-unused-private-class-members
  #catalogTrackAlias: bigint | null = null;
  // Reference to the tracks manager
  #tracksManager: TracksManager | null = null;
  // Logger instance
  private logger: ILogger;

  constructor(config: ClientConfig) {
    this.config = config;
    this.logger = LoggerFactory.getInstance().getLogger("Client");

    this.#fingerprint = this.#fetchFingerprint(config.fingerprint).catch(
      (e) => {
        this.logger.warn(`Failed to fetch fingerprint: ${e}`);
        return undefined;
      },
    );
  }

  // Store publish namespace callbacks (draft-14: renamed from announce callbacks)
  #publishNamespaceCallbacks: Set<(namespace: string[]) => void> = new Set();

  async connect(): Promise<Connection> {
    const options: WebTransportOptions = {};

    const fingerprint = await this.#fingerprint;
    if (fingerprint) {
      options.serverCertificateHashes = [fingerprint];
      const valueArray =
        fingerprint.value instanceof Uint8Array
          ? fingerprint.value
          : new Uint8Array(fingerprint.value as ArrayBuffer);
      this.logger.debug(
        `Using certificate fingerprint: algorithm=${fingerprint.algorithm}, value=${Array.from(
          valueArray,
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")}`,
      );
    }

    // From draft-17 the ALPN is the whole of version negotiation: SETUP carries
    // no version field, so a session whose subprotocol we did not offer cannot
    // be spoken at all.
    (options as any).protocols = [...SUPPORTED_PROTOCOLS];
    this.logger.info(
      `Requesting WebTransport protocol: ${SUPPORTED_PROTOCOLS.join(", ")}`,
    );

    this.logger.info(`Connecting to ${this.config.url}...`);
    const wt = new WebTransport(this.config.url, options);
    // Attach a handler to wt.closed up front. When the handshake fails (e.g.
    // self-signed cert with no fingerprint to pin against), Safari rejects
    // both wt.ready and wt.closed; without a handler on closed, Safari
    // surfaces an "Unhandled Promise Rejection: WebTransportError". The
    // rejection is also seen later by Connection.closed() — promises stay
    // rejected, so multiple handlers each see the same value.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    wt.closed.catch(() => {});
    await wt.ready;
    this.logger.info("WebTransport connection established");

    // The negotiated subprotocol is the version. Anything else is fatal rather
    // than something to fall back from -- there is no in-band negotiation left.
    const negotiatedProtocol = (wt as any).protocol as string | undefined;
    const version = versionForProtocol(negotiatedProtocol);
    this.#negotiatedVersion = version;
    this.logger.info(`Negotiated ${negotiatedProtocol} -> draft-18`);

    // Accepting has to start before SETUP: object streams and the peer's own
    // control stream may arrive first, and the router buffers whatever turns
    // up early rather than dropping it.
    const router = new UniStreamRouter(wt);

    // SETUP carries Setup Options and nothing else; the version is already
    // settled. We send none: every option we would set is at its default.
    const setup: Setup = { kind: CtrlType.Setup, options: [] };
    const control = await ControlStreamPair.establish(wt, setup, () =>
      router.controlStream(),
    );
    this.logger.info("Control stream pair established");

    // Each request gets its own bidirectional stream, so the tracks manager
    // needs the connection to open them on.
    this.#tracksManager = new TracksManager(wt, router, this);
    this.logger.info("Tracks manager created");

    const connection = new Connection(wt, control, this);

    // Server-initiated requests -- PUBLISH_NAMESPACE above all -- arrive on
    // bidirectional streams the server opens, not on the control stream.
    void this.#acceptRequestStreams(wt);

    return connection;
  }

  /** Get the negotiated protocol version */
  get negotiatedVersion(): Version {
    return this.#negotiatedVersion;
  }

  /**
   * Get the next available request ID and increment for future use
   * According to the MOQ Transport spec, client request IDs are even numbers starting at 0
   * and increment by 2 for each new request
   */
  getNextRequestId(): bigint {
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 2n;
    this.logger.debug(`Generated new request ID: ${requestId}`);
    return requestId;
  }

  async #fetchFingerprint(url?: string): Promise<WebTransportHash | undefined> {
    if (!url) {
      return;
    }

    this.logger.info(`Fetching server certificate fingerprint from ${url}`);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch fingerprint: ${response.status} ${response.statusText}`,
        );
      }
      const hexString = await response.text();
      this.logger.debug(`Fetched fingerprint hex: ${hexString}`);

      // Remove any whitespace
      const cleanHex = hexString.trim();

      const hexBytes = new Uint8Array(cleanHex.length / 2);
      for (let i = 0; i < hexBytes.length; i += 1) {
        hexBytes[i] = parseInt(cleanHex.slice(2 * i, 2 * i + 2), 16);
      }

      return {
        algorithm: "sha-256",
        value: hexBytes,
      };
    } catch (error) {
      this.logger.error(`Failed to fetch fingerprint: ${error}`);
      throw error;
    }
  }

  /**
   * Accept the request streams the server opens.
   *
   * In draft-18 a server-initiated request is a bidirectional stream whose
   * first message says what it is; PUBLISH_NAMESPACE is the one this player
   * cares about. Anything else is answered with REQUEST_ERROR rather than
   * ignored, so the peer is not left waiting on a stream nobody will read.
   */
  async #acceptRequestStreams(wt: WebTransport): Promise<void> {
    try {
      const streams = wt.incomingBidirectionalStreams.getReader();
      for (;;) {
        const { value: stream, done } = await streams.read();
        if (done) {
          return;
        }
        void this.#handleRequestStream(stream);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("session is closed")
      ) {
        this.logger.debug("Request stream listener stopped: connection closed");
      } else {
        this.logger.error("Error accepting request streams:", error);
      }
    }
  }

  async #handleRequestStream(
    stream: WebTransportBidirectionalStream,
  ): Promise<void> {
    const reader = new Reader(new Uint8Array(), stream.readable);
    const writer = new Writer(stream.writable);
    try {
      const type = Number(await reader.u62()) as CtrlType;
      if (!opensRequestStream(type)) {
        // A bidirectional stream beginning with anything else is a
        // PROTOCOL_VIOLATION, including a type valid later on the same stream.
        throw new Error(`${ctrlTypeName(type)} may not open a request stream`);
      }

      const msg = await readCtrlBody(reader, type, false);
      if (msg.kind !== CtrlType.PublishNamespace) {
        this.logger.info(
          `Rejecting unsupported ${ctrlTypeName(type)} request stream`,
        );
        await writer.write(
          encodeCtrlMessage({
            kind: CtrlType.RequestError,
            // NOT_SUPPORTED. Answering is a legitimate response, and adding a
            // handler later changes no signature.
            errorCode: 0x2n,
            retryInterval: 0n,
            errorReason: "not supported",
          }),
        );
        await writer.close();
        return;
      }

      const namespace = msg.namespace.map((f) => decoder.decode(f));
      this.logger.info(`Received PUBLISH_NAMESPACE for ${namespace.join("/")}`);

      // REQUEST_OK goes back on the request's own stream, and carries no
      // Request ID: the stream is the identity.
      await writer.write(
        encodeCtrlMessage({
          kind: CtrlType.RequestOk,
          parameters: [],
          trackProperties: [],
        }),
      );

      this.#publishNamespaceCallbacks.forEach((callback) => {
        try {
          callback(namespace);
        } catch (error) {
          this.logger.error(`Error in publish namespace callback: ${error}`);
        }
      });

      // The stream stays open: NAMESPACE_DONE and further updates arrive on it.
      await this.#drainNamespaceStream(reader, namespace.join("/"));
    } catch (error) {
      this.logger.error(`Error on incoming request stream: ${error}`);
      try {
        stream.writable.abort(error);
        void stream.readable.cancel(error);
      } catch {
        // The stream may already be gone; nothing else to do.
      }
    }
  }

  async #drainNamespaceStream(reader: Reader, label: string): Promise<void> {
    for (;;) {
      if (await reader.done()) {
        return;
      }
      const type = Number(await reader.u62()) as CtrlType;
      const msg: CtrlMessage = await readCtrlBody(reader, type, false);
      this.logger.debug(`Received ${ctrlTypeName(msg.kind)} for ${label}`);
    }
  }

  /**
   * Register a callback for objects on a specific track
   * @param trackAlias The track alias to register the callback for
   * @param callback The callback function to call when objects are received
   */
  registerObjectCallback(trackAlias: bigint, callback: ObjectCallback): void {
    if (!this.#tracksManager) {
      throw new Error(
        "Cannot register object callback: Tracks manager not initialized",
      );
    }

    this.logger.info(`Registering object callback for track ${trackAlias}`);
    this.#tracksManager.registerObjectCallback(trackAlias, callback);
  }

  /**
   * Unregister a callback for objects on a specific track
   * @param trackAlias The track alias to unregister the callback for
   * @param callback The callback function to unregister
   */
  unregisterObjectCallback(trackAlias: bigint, callback: ObjectCallback): void {
    if (!this.#tracksManager) {
      throw new Error(
        "Cannot unregister object callback: Tracks manager not initialized",
      );
    }

    this.logger.info(`Unregistering object callback for track ${trackAlias}`);
    this.#tracksManager.unregisterObjectCallback(trackAlias, callback);
  }

  /**
   * Subscribe to a track by namespace and track name
   * @param namespace The namespace of the track
   * @param trackName The name of the track
   * @param callback The callback function to call when objects are received
   * @returns The track alias assigned to the subscription
   */
  async subscribeTrack(
    namespace: string,
    trackName: string,
    callback: ObjectCallback,
  ): Promise<bigint> {
    if (!this.#tracksManager) {
      throw new Error("Cannot subscribe: Tracks manager not initialized");
    }

    this.logger.info(`Client subscribing to track ${namespace}:${trackName}`);
    return this.#tracksManager.subscribeTrack(namespace, trackName, callback);
  }

  /**
   * Subscribe to a track and return the subscription's request ID and the
   * largest location from SUBSCRIBE_OK, as needed for a joining FETCH
   * @param options Filter type and joining-fetch dedup behavior
   */
  async subscribeTrackWithInfo(
    namespace: string,
    trackName: string,
    callback: ObjectCallback,
    options?: SubscribeOptions,
  ): Promise<SubscriptionInfo> {
    if (!this.#tracksManager) {
      throw new Error("Cannot subscribe: Tracks manager not initialized");
    }

    this.logger.info(`Client subscribing to track ${namespace}:${trackName}`);
    return this.#tracksManager.subscribeTrackWithInfo(
      namespace,
      trackName,
      callback,
      options,
    );
  }

  /**
   * Send a Relative Joining FETCH tied to an existing subscription
   * @param joiningRequestId The request ID of the subscription to join
   * @param joiningStart Group offset back from the largest group (0 = current group)
   * @param callback The callback for objects delivered on the FETCH stream
   */
  async fetchJoiningRelative(
    joiningRequestId: bigint,
    joiningStart: bigint,
    callback: ObjectCallback,
  ): Promise<void> {
    if (!this.#tracksManager) {
      throw new Error("Cannot fetch: Tracks manager not initialized");
    }

    this.logger.info(
      `Client sending joining FETCH for subscription ${joiningRequestId}`,
    );
    return this.#tracksManager.fetchJoiningRelative(
      joiningRequestId,
      joiningStart,
      callback,
    );
  }

  /**
   * Fetch a track (one-shot retrieval instead of ongoing subscription)
   */
  async fetchTrack(
    namespace: string,
    trackName: string,
    callback: ObjectCallback,
  ): Promise<void> {
    if (!this.#tracksManager) {
      throw new Error("Cannot fetch: Tracks manager not initialized");
    }

    this.logger.info(`Client fetching track ${namespace}:${trackName}`);
    return this.#tracksManager.fetchTrack(namespace, trackName, callback);
  }

  /**
   * Unsubscribe from a track by track alias
   * @param trackAlias The track alias to unsubscribe from
   * @returns A promise that resolves when the unsubscribe message has been sent
   */
  async unsubscribeTrack(trackAlias: bigint): Promise<void> {
    if (!this.#tracksManager) {
      throw new Error("Cannot unsubscribe: Tracks manager not initialized");
    }

    this.logger.info(
      `Client unsubscribing from track with alias ${trackAlias}`,
    );
    await this.#tracksManager.unsubscribeTrack(trackAlias);
  }

  /**
   * Register a callback to be notified when a publish namespace message is received
   * (draft-14: renamed from announce)
   * @param callback Function that will be called with the namespace when a publish namespace message is received
   * @returns A function to unregister the callback
   */
  registerPublishNamespaceCallback(
    callback: (namespace: string[]) => void,
  ): () => void {
    this.logger.info("Registering publish namespace callback");
    this.#publishNamespaceCallbacks.add(callback);

    // Return a function to unregister the callback
    return () => {
      this.logger.info("Unregistering publish namespace callback");
      this.#publishNamespaceCallbacks.delete(callback);
    };
  }

  /**
   * Close the client connection
   */
  close(): void {
    this.logger.info("Closing client connection");
    // Clear all callbacks
    this.#publishNamespaceCallbacks.clear();

    if (this.#tracksManager) {
      this.#tracksManager.close();
      this.#tracksManager = null;
    }
  }
}

export class Connection {
  // The established WebTransport session
  #wt: WebTransport;
  #control: ControlStreamPair;
  #client: Client;
  private logger: ILogger;

  constructor(wt: WebTransport, control: ControlStreamPair, client: Client) {
    this.#wt = wt;
    this.#control = control;
    this.#client = client;
    this.logger = LoggerFactory.getInstance().getLogger("Connection");
  }

  /**
   * The control stream pair. Requests do not go through it -- each opens its
   * own bidirectional stream -- so this is only for session-level messages.
   */
  get control(): ControlStreamPair {
    return this.#control;
  }

  /**
   * Get the next request ID from the client
   */
  getNextRequestId(): bigint {
    return this.#client.getNextRequestId();
  }

  close(code = 0, reason = ""): void {
    this.logger.info(`Closing connection with code ${code}: ${reason}`);
    this.#wt.close({ closeCode: code, reason });
  }

  async closed(): Promise<Error> {
    try {
      await this.#wt.closed;
      return new Error("Connection closed");
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  }
}
