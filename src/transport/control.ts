import { ILogger, LoggerFactory } from "../logger";

import { BufferCtrlWriter } from "./bufferctrlwriter";
import { Reader, Writer, KeyValuePair } from "./stream";
import { Version, isDraft16 } from "./version";

// Logger for control message operations
const controlLogger: ILogger = LoggerFactory.getInstance().getLogger("Control");

export type Message = Subscriber | Publisher;

// Sent by subscriber
export type Subscriber =
  | Subscribe
  | Unsubscribe
  | Fetch
  | PublishNamespaceOk
  | PublishNamespaceError;

export function isSubscriber(m: Message): m is Subscriber {
  return (
    m.kind === Msg.Subscribe ||
    m.kind === Msg.Unsubscribe ||
    m.kind === Msg.Fetch ||
    m.kind === Msg.PublishNamespaceOk ||
    m.kind === Msg.PublishNamespaceError
  );
}

// Sent by publisher
export type Publisher =
  | SubscribeOk
  | SubscribeError
  | FetchOk
  | FetchError
  | PublishDone
  | PublishNamespace
  | UnpublishNamespace
  | RequestsBlocked;

export function isPublisher(m: Message): m is Publisher {
  return (
    m.kind === Msg.SubscribeOk ||
    m.kind === Msg.SubscribeError ||
    m.kind === Msg.FetchOk ||
    m.kind === Msg.FetchError ||
    m.kind === Msg.PublishDone ||
    m.kind === Msg.PublishNamespace ||
    m.kind === Msg.UnpublishNamespace ||
    m.kind === Msg.RequestsBlocked
  );
}

export enum Msg {
  Subscribe = "subscribe",
  SubscribeOk = "subscribe_ok",
  SubscribeError = "subscribe_error",
  SubscribeUpdate = "subscribe_update",
  PublishDone = "publish_done", // draft-14: renamed from subscribe_done
  Unsubscribe = "unsubscribe",
  Fetch = "fetch",
  FetchOk = "fetch_ok",
  FetchError = "fetch_error",
  PublishNamespace = "publish_namespace", // draft-14: renamed from announce
  PublishNamespaceOk = "publish_namespace_ok", // draft-14: renamed from announce_ok
  PublishNamespaceError = "publish_namespace_error", // draft-14: renamed from announce_error
  UnpublishNamespace = "unpublish_namespace", // draft-14: renamed from unannounce
  RequestsBlocked = "requests_blocked",
}

enum Id {
  Subscribe = 0x3,
  SubscribeOk = 0x4,
  SubscribeError = 0x5,
  SubscribeUpdate = 0x2,
  PublishDone = 0xb, // draft-14: renamed from SubscribeDone
  Unsubscribe = 0xa,
  Fetch = 0x16,
  FetchOk = 0x18,
  FetchError = 0x19,
  PublishNamespace = 0x6, // draft-14: renamed from Announce
  PublishNamespaceOk = 0x7, // draft-14: renamed from AnnounceOk
  PublishNamespaceError = 0x8, // draft-14: renamed from AnnounceError
  UnpublishNamespace = 0x9, // draft-14: renamed from Unannounce
  RequestsBlocked = 0x1a,
}

export interface Subscribe {
  kind: Msg.Subscribe;
  requestId: bigint;
  // trackAlias removed in draft-14 - publisher assigns it in SUBSCRIBE_OK
  namespace: string[];
  name: string;
  subscriber_priority: number;
  group_order: GroupOrder;
  forward: boolean;
  filterType: FilterType;
  startLocation?: Location;
  endGroup?: bigint;
  params: KeyValuePair[];
}

export enum GroupOrder {
  Publisher = 0x0, // Original publisher's order should be used
  Ascending = 0x1,
  Descending = 0x2,
}

export enum FilterType {
  None = 0x0,
  NextGroupStart = 0x1,
  LatestObject = 0x2,
  AbsoluteStart = 0x3,
  AbsoluteRange = 0x4,
}

export interface Location {
  group: bigint;
  object: bigint;
}

export type Parameters = Map<bigint, Uint8Array | bigint>;

export interface SubscribeOk {
  kind: Msg.SubscribeOk;
  requestId: bigint;
  trackAlias: bigint; // Added in draft-14 - publisher assigns track alias
  expires: bigint;
  group_order: GroupOrder;
  content_exists: boolean;
  largest?: Location;
  params: KeyValuePair[];
}

export interface SubscribeError {
  kind: Msg.SubscribeError;
  requestId: bigint;
  code: bigint;
  retryInterval?: bigint; // draft-16: minimum ms before retry (0 = don't retry)
  reason: string;
  trackAlias?: bigint; // draft-14 only
}

export interface SubscribeUpdate {
  kind: Msg.SubscribeUpdate;
  requestId: bigint;
  startLocation: Location;
  endGroup: bigint;
  subscriberPriority: number;
  forward: boolean;
  params: KeyValuePair[];
}

export interface Unsubscribe {
  kind: Msg.Unsubscribe;
  requestId: bigint;
}

export const FetchTypeStandalone = 0x01;

export interface Fetch {
  kind: Msg.Fetch;
  requestId: bigint;
  subscriberPriority: number;
  groupOrder: number;
  fetchType: number;
  namespace: string[];
  trackName: string;
  startGroup: bigint;
  startObject: bigint;
  endGroup: bigint;
  endObject: bigint;
  params: KeyValuePair[];
}

export interface FetchOk {
  kind: Msg.FetchOk;
  requestId: bigint;
  groupOrder: number;
  endOfTrack: number;
  endGroup: bigint;
  endObject: bigint;
  params: KeyValuePair[];
}

export interface FetchError {
  kind: Msg.FetchError;
  requestId: bigint;
  code: bigint;
  retryInterval?: bigint; // draft-16
  reason: string;
}

export interface PublishDone {
  kind: Msg.PublishDone;
  requestId: bigint;
  code: bigint;
  streamCount: number;
  reason: string;
}

export interface PublishNamespace {
  kind: Msg.PublishNamespace;
  requestId: bigint;
  namespace: string[];
  params: KeyValuePair[];
}

export interface PublishNamespaceOk {
  kind: Msg.PublishNamespaceOk;
  requestId: bigint;
  namespace?: string[]; // draft-14 only; draft-16 REQUEST_OK has params instead
}

export interface PublishNamespaceError {
  kind: Msg.PublishNamespaceError;
  requestId: bigint;
  code: bigint;
  reason: string;
}

export interface UnpublishNamespace {
  kind: Msg.UnpublishNamespace;
  namespace: string[];
}

export interface RequestsBlocked {
  kind: Msg.RequestsBlocked;
  maximumRequestId: bigint;
}

export class CtrlStream {
  private decoder: Decoder;
  private encoder: Encoder;

  #mutex = Promise.resolve();

  constructor(r: Reader, w: Writer, version: Version = Version.DRAFT_14) {
    this.decoder = new Decoder(r, version);
    this.encoder = new Encoder(w, version);
  }

  // Will error if two messages are read at once.
  async recv(): Promise<Message> {
    controlLogger.debug("Attempting to receive a control message...");
    const msg = await this.decoder.message();
    controlLogger.debug("Received control message:", msg);
    return msg;
  }

  async send(msg: Message): Promise<void> {
    const unlock = await this.#lock();
    try {
      controlLogger.debug("Sending control message:", msg);
      await this.encoder.message(msg);
    } finally {
      unlock();
    }
  }

  async #lock(): Promise<() => void> {
    // Make a new promise that we can resolve later.
    let done: () => void;
    const p = new Promise<void>((resolve) => {
      done = () => resolve();
    });

    // Wait until the previous lock is done, then resolve our lock.
    const lock = this.#mutex.then(() => done);

    // Update the mutex
    this.#mutex = lock.then(() => p);

    // Return the unlock function
    return lock;
  }
}

// Draft-16 parameter type keys for decoding
const PARAM_EXPIRES = 0x08n;
const PARAM_LARGEST_OBJECT = 0x09n;
const PARAM_GROUP_ORDER = 0x22n;

export class Decoder {
  r: Reader;
  private version: Version;

  constructor(r: Reader, version: Version = Version.DRAFT_14) {
    this.r = r;
    this.version = version;
  }

  private async msg(): Promise<Msg> {
    controlLogger.debug("Reading message type...");
    const t = await this.r.u53();
    controlLogger.debug(`Raw message type: 0x${t.toString(16)}`);

    // Read the 16-bit MSB length field
    const lengthBytes = await this.r.read(2);
    const messageLength = (lengthBytes[0] << 8) | lengthBytes[1]; // MSB format
    controlLogger.debug(
      `Message length (16-bit MSB): ${messageLength} bytes, actual length: ${this.r.getByteLength()}`,
    );

    let msgType: Msg;
    switch (t as Id) {
      case Id.Subscribe:
        msgType = Msg.Subscribe;
        break;
      case Id.SubscribeOk:
        msgType = Msg.SubscribeOk;
        break;
      case Id.PublishDone:
        msgType = Msg.PublishDone;
        break;
      case Id.SubscribeError:
        msgType = Msg.SubscribeError;
        break;
      case Id.Unsubscribe:
        msgType = Msg.Unsubscribe;
        break;
      case Id.FetchOk:
        msgType = Msg.FetchOk;
        break;
      case Id.FetchError:
        msgType = Msg.FetchError;
        break;
      case Id.PublishNamespace:
        msgType = Msg.PublishNamespace;
        break;
      case Id.PublishNamespaceOk:
        msgType = Msg.PublishNamespaceOk;
        break;
      case Id.PublishNamespaceError:
        msgType = Msg.PublishNamespaceError;
        break;
      case Id.UnpublishNamespace:
        msgType = Msg.UnpublishNamespace;
        break;
      case Id.RequestsBlocked:
        msgType = Msg.RequestsBlocked;
        break;
      default:
        const errorMsg = `Unknown message type: 0x${t.toString(16)}`;
        controlLogger.error(errorMsg);
        throw new Error(errorMsg);
    }

    controlLogger.debug(
      `Parsed message type: ${msgType} (0x${t.toString(16)})`,
    );
    return msgType;
  }

  async message(): Promise<Message> {
    controlLogger.debug("Parsing control message...");
    const t = await this.msg();

    let result: Message;
    switch (t) {
      case Msg.Subscribe:
        result = await this.subscribe();
        break;
      case Msg.SubscribeOk:
        result = await this.subscribe_ok();
        break;
      case Msg.SubscribeError:
        result = await this.subscribe_error();
        break;
      case Msg.PublishDone:
        result = await this.publish_done();
        break;
      case Msg.FetchOk:
        result = await this.fetch_ok();
        break;
      case Msg.FetchError:
        result = await this.fetch_error();
        break;
      case Msg.Unsubscribe:
        result = await this.unsubscribe();
        break;
      case Msg.PublishNamespace:
        result = await this.publish_namespace();
        break;
      case Msg.PublishNamespaceOk:
        result = await this.publish_namespace_ok();
        break;
      case Msg.PublishNamespaceError:
        result = await this.publish_namespace_error();
        break;
      case Msg.UnpublishNamespace:
        result = await this.unpublish_namespace();
        break;
      case Msg.RequestsBlocked:
        result = await this.requests_blocked();
        break;
      default:
        const errorMsg = `Unsupported message type: ${(t as any).kind}`;
        controlLogger.error(errorMsg);
        throw new Error(errorMsg);
    }

    controlLogger.debug("Successfully parsed control message:", result);
    return result;
  }

  private async subscribe(): Promise<Subscribe> {
    controlLogger.debug("Parsing Subscribe message...");
    const requestId = await this.r.u62();
    controlLogger.debug(`RequestID: ${requestId}`);

    // draft-14: trackAlias removed from SUBSCRIBE (assigned by publisher in SUBSCRIBE_OK)

    const namespace = await this.r.tuple();
    controlLogger.debug(`Namespace: ${namespace.join("/")}`);

    const name = await this.r.string();
    controlLogger.debug(`Name: ${name}`);

    const subscriber_priority = await this.r.u8();
    controlLogger.debug(`Subscriber priority: ${subscriber_priority}`);

    const group_order = await this.decodeGroupOrder();
    controlLogger.debug(`Group order: ${group_order}`);

    const forward = await this.r.u8Bool();
    controlLogger.debug(`Forward: ${forward}`);

    const filterType = await this.r.u8();
    controlLogger.debug(`Filter type: ${filterType}`);

    let startLocation: Location | undefined;
    if (
      filterType === FilterType.AbsoluteStart ||
      filterType === FilterType.AbsoluteRange
    ) {
      startLocation = await this.location();
      controlLogger.debug(`Start Location: ${JSON.stringify(startLocation)}`);
    }

    let endGroup: bigint | undefined;
    if (filterType === FilterType.AbsoluteRange) {
      endGroup = await this.r.u62();
      controlLogger.debug(`End group: ${endGroup}`);
    }

    const params = await this.r.keyValuePairs();
    controlLogger.debug(`Parameters: ${params.length}`);

    return {
      kind: Msg.Subscribe,
      requestId,
      namespace,
      name,
      subscriber_priority,
      group_order,
      forward,
      filterType,
      startLocation,
      endGroup,
      params,
    };
  }

  private async decodeGroupOrder(): Promise<GroupOrder> {
    const orderCode = await this.r.u8();
    controlLogger.debug(`Raw group order code: ${orderCode}`);

    switch (orderCode) {
      case 0:
        return GroupOrder.Publisher;
      case 1:
        return GroupOrder.Ascending;
      case 2:
        return GroupOrder.Descending;
      default:
        const errorMsg = `Invalid GroupOrder value: ${orderCode}`;
        controlLogger.error(errorMsg);
        throw new Error(errorMsg);
    }
  }

  private async location(): Promise<Location> {
    return {
      group: await this.r.u62(),
      object: await this.r.u62(),
    };
  }

  private async parameters(numParams: number): Promise<KeyValuePair[]> {
    const params: KeyValuePair[] = [];
    for (let i = 0; i < numParams; i++) {
      const key = await this.r.u62();
      const isEven = key % 2n === 0n;
      if (isEven) {
        const value = await this.r.u62();
        params.push({ type: key, value: value });
      } else {
        const length = await this.r.u53();
        const value = await this.r.read(length);
        params.push({ type: key, value: value });
      }
    }
    return params;
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

  /** Draft-16: decode delta-encoded parameters from the control stream */
  private async deltaKeyValuePairs(): Promise<KeyValuePair[]> {
    const count = await this.r.u53();
    const params: KeyValuePair[] = [];
    let prevType = 0n;

    for (let i = 0; i < count; i++) {
      const delta = await this.r.u62();
      const paramType = prevType + delta;
      prevType = paramType;

      if (paramType % 2n === 0n) {
        const value = await this.r.u62();
        params.push({ type: paramType, value });
      } else {
        const length = await this.r.u53();
        const value = await this.r.read(length);
        params.push({ type: paramType, value });
      }
    }
    return params;
  }

  /** Read params using the appropriate decoding for the current version */
  private async readParams(): Promise<KeyValuePair[]> {
    if (isDraft16(this.version)) {
      return this.deltaKeyValuePairs();
    }
    return this.r.keyValuePairs();
  }

  /** Helper: find a varint param value by type key */
  private findParamVarInt(
    params: KeyValuePair[],
    key: bigint,
    defaultValue: bigint,
  ): bigint {
    const p = params.find((p) => p.type === key);
    if (p && typeof p.value === "bigint") {
      return p.value;
    }
    return defaultValue;
  }

  /** Helper: find a bytes param value by type key */
  private findParamBytes(
    params: KeyValuePair[],
    key: bigint,
  ): Uint8Array | undefined {
    const p = params.find((p) => p.type === key);
    if (p && p.value instanceof Uint8Array) {
      return p.value;
    }
    return undefined;
  }

  private async subscribe_ok(): Promise<SubscribeOk> {
    controlLogger.debug("Parsing SubscribeOk message...");
    const requestId = await this.r.u62();
    controlLogger.debug(`Request ID: ${requestId}`);

    const trackAlias = await this.r.u62();
    controlLogger.debug(`Track Alias: ${trackAlias}`);

    if (isDraft16(this.version)) {
      // Draft-16: fields are in parameters, followed by track extensions
      const params = await this.deltaKeyValuePairs();

      const expires = this.findParamVarInt(params, PARAM_EXPIRES, 0n);
      const groupOrderVal = this.findParamVarInt(params, PARAM_GROUP_ORDER, 0n);
      const group_order = this.parseGroupOrder(Number(groupOrderVal));
      const largestBytes = this.findParamBytes(params, PARAM_LARGEST_OBJECT);

      let content_exists = false;
      let largest: Location | undefined;
      if (largestBytes && largestBytes.length > 0) {
        content_exists = true;
        largest = this.parseLocationFromBytes(largestBytes);
        controlLogger.debug(
          `Largest: group ${largest.group}, object ${largest.object}`,
        );
      }

      // TODO: read track extensions (currently skip any remaining bytes)

      return {
        kind: Msg.SubscribeOk,
        requestId,
        trackAlias,
        expires,
        group_order,
        content_exists,
        largest,
        params,
      };
    }

    // Draft-14: inline fields
    const expires = await this.r.u62();
    controlLogger.debug(`Expires: ${expires}`);

    const group_order = await this.decodeGroupOrder();
    controlLogger.debug(`Group order: ${group_order}`);

    const content_exists = await this.r.u8Bool();
    controlLogger.debug(`Content exists: ${content_exists}`);

    let largest: Location | undefined;
    if (content_exists) {
      largest = await this.location();
      controlLogger.debug(
        `Largest: group ${largest.group}, object ${largest.object}`,
      );
    }

    const params = await this.r.keyValuePairs();

    return {
      kind: Msg.SubscribeOk,
      requestId,
      trackAlias,
      expires,
      group_order,
      content_exists,
      largest,
      params,
    };
  }

  /** Parse a GroupOrder value from a number (used by both draft-14 and draft-16) */
  private parseGroupOrder(orderCode: number): GroupOrder {
    switch (orderCode) {
      case 0:
        return GroupOrder.Publisher;
      case 1:
        return GroupOrder.Ascending;
      case 2:
        return GroupOrder.Descending;
      default:
        controlLogger.warn(
          `Unknown GroupOrder value: ${orderCode}, using Publisher`,
        );
        return GroupOrder.Publisher;
    }
  }

  /** Parse a Location from raw bytes (for draft-16 parameter values) */
  private parseLocationFromBytes(bytes: Uint8Array): Location {
    // Decode two varints from the byte array
    let offset = 0;
    const { value: group, bytesRead: gb } = this.decodeVarIntFromBytes(
      bytes,
      offset,
    );
    offset += gb;
    const { value: object } = this.decodeVarIntFromBytes(bytes, offset);
    return { group, object };
  }

  /** Decode a QUIC varint from a byte array at a given offset */
  private decodeVarIntFromBytes(
    bytes: Uint8Array,
    offset: number,
  ): { value: bigint; bytesRead: number } {
    const first = bytes[offset];
    const prefix = first >> 6;
    let length: number;
    switch (prefix) {
      case 0:
        length = 1;
        break;
      case 1:
        length = 2;
        break;
      case 2:
        length = 4;
        break;
      case 3:
        length = 8;
        break;
      default:
        throw new Error(`Invalid varint prefix: ${prefix}`);
    }
    let value = BigInt(first & 0x3f);
    for (let i = 1; i < length; i++) {
      value = (value << 8n) | BigInt(bytes[offset + i]);
    }
    return { value, bytesRead: length };
  }

  private async subscribe_error(): Promise<SubscribeError> {
    controlLogger.debug("Parsing SubscribeError / REQUEST_ERROR message...");
    const requestId = await this.r.u62();
    controlLogger.debug(`Request ID: ${requestId}`);

    const code = await this.r.u62();
    controlLogger.debug(`Code: ${code}`);

    let retryInterval: bigint | undefined;
    if (isDraft16(this.version)) {
      // Draft-16 REQUEST_ERROR: includes retryInterval
      retryInterval = await this.r.u62();
      controlLogger.debug(`Retry interval: ${retryInterval}`);
    }

    const reason = await this.r.string();
    controlLogger.debug(`Reason: ${reason}`);

    let trackAlias: bigint | undefined;
    if (!isDraft16(this.version)) {
      // Draft-14 only: trackAlias after reason
      trackAlias = await this.r.u62();
      controlLogger.debug(`Track Alias: ${trackAlias}`);
    }

    return {
      kind: Msg.SubscribeError,
      requestId,
      code,
      retryInterval,
      reason,
      trackAlias,
    };
  }

  private async fetch_ok(): Promise<FetchOk> {
    controlLogger.debug("Parsing FetchOk message...");
    const requestId = await this.r.u62();
    const groupOrder = await this.r.u8();
    const endOfTrack = await this.r.u8();
    const endGroup = await this.r.u62();
    const endObject = await this.r.u62();
    const params = await this.r.keyValuePairs();

    controlLogger.debug(
      `FetchOk: requestId=${requestId}, endOfTrack=${endOfTrack}`,
    );

    return {
      kind: Msg.FetchOk,
      requestId,
      groupOrder,
      endOfTrack,
      endGroup,
      endObject,
      params,
    };
  }

  private async fetch_error(): Promise<FetchError> {
    controlLogger.debug("Parsing FetchError / REQUEST_ERROR message...");
    const requestId = await this.r.u62();
    const code = await this.r.u62();

    let retryInterval: bigint | undefined;
    if (isDraft16(this.version)) {
      retryInterval = await this.r.u62();
    }

    const reason = await this.r.string();

    controlLogger.debug(
      `FetchError: requestId=${requestId}, code=${code}, reason=${reason}`,
    );

    return {
      kind: Msg.FetchError,
      requestId,
      code,
      retryInterval,
      reason,
    };
  }

  private async publish_done(): Promise<PublishDone> {
    controlLogger.debug("Parsing PublishDone message...");
    const requestId = await this.r.u62();
    controlLogger.debug(`Request ID: ${requestId}`);

    const code = await this.r.u62();
    controlLogger.debug(`Code: ${code}`);

    const reason = await this.r.string();
    controlLogger.debug(`Reason: ${reason}`);

    // Read the stream count
    const streamCount = await this.r.u53();
    controlLogger.debug(`Stream count: ${streamCount}`);

    return {
      kind: Msg.PublishDone,
      requestId,
      code,
      streamCount,
      reason,
    };
  }

  private async unsubscribe(): Promise<Unsubscribe> {
    controlLogger.debug("Parsing Unsubscribe message...");
    const requestId = await this.r.u62();
    controlLogger.debug(`Subscribe ID: ${requestId}`);

    return {
      kind: Msg.Unsubscribe,
      requestId,
    };
  }

  private async publish_namespace(): Promise<PublishNamespace> {
    controlLogger.debug("Parsing PublishNamespace message...");
    const requestId = await this.r.u62();
    controlLogger.debug(`Request ID: ${requestId}`);

    const namespace = await this.r.tuple();
    controlLogger.debug(`Namespace: ${namespace.join("/")}`);

    const params = await this.readParams();
    controlLogger.debug(`Parameters: ${params.length}`);

    return {
      kind: Msg.PublishNamespace,
      requestId,
      namespace,
      params,
    };
  }

  private async publish_namespace_ok(): Promise<PublishNamespaceOk> {
    controlLogger.debug("Parsing PublishNamespaceOk / REQUEST_OK message...");
    const requestId = await this.r.u62();
    controlLogger.debug(`Request ID: ${requestId}`);

    if (isDraft16(this.version)) {
      // Draft-16 REQUEST_OK: includes parameters (no namespace)
      const params = await this.deltaKeyValuePairs();
      controlLogger.debug(`Parameters: ${params.length}`);

      return {
        kind: Msg.PublishNamespaceOk,
        requestId,
      };
    }

    // Draft-14: includes namespace
    const namespace = await this.r.tuple();
    controlLogger.debug(`Namespace: ${namespace.join("/")}`);

    return {
      kind: Msg.PublishNamespaceOk,
      requestId,
      namespace,
    };
  }

  private async publish_namespace_error(): Promise<PublishNamespaceError> {
    controlLogger.debug(
      "Parsing PublishNamespaceError / REQUEST_ERROR message...",
    );
    const requestId = await this.r.u62();
    controlLogger.debug(`Request ID: ${requestId}`);

    const code = await this.r.u62();
    controlLogger.debug(`Error code: ${code}`);

    if (isDraft16(this.version)) {
      // Draft-16: retryInterval before reason
      const retryInterval = await this.r.u62();
      controlLogger.debug(`Retry interval: ${retryInterval}`);
    }

    const reason = await this.r.string();
    controlLogger.debug(`Error reason: ${reason}`);

    return {
      kind: Msg.PublishNamespaceError,
      requestId,
      code,
      reason,
    };
  }

  private async unpublish_namespace(): Promise<UnpublishNamespace> {
    controlLogger.debug("Parsing UnpublishNamespace message...");
    const namespace = await this.r.tuple();
    controlLogger.debug(`Namespace: ${namespace.join("/")}`);

    return {
      kind: Msg.UnpublishNamespace,
      namespace,
    };
  }

  private async requests_blocked(): Promise<RequestsBlocked> {
    controlLogger.debug("Parsing REQUESTS_BLOCKED message...");
    const maximumRequestId = await this.r.u62();
    controlLogger.warn(
      `Server sent REQUESTS_BLOCKED: maximum request ID is ${maximumRequestId}`,
    );

    return {
      kind: Msg.RequestsBlocked,
      maximumRequestId,
    };
  }
}

export class Encoder {
  w: Writer;
  private version: Version;

  constructor(w: Writer, version: Version = Version.DRAFT_14) {
    this.w = w;
    this.version = version;
  }

  async message(msg: Message): Promise<void> {
    controlLogger.debug(`Encoding message of type: ${msg.kind}`);

    const writer = new BufferCtrlWriter(this.version);

    // Marshal the message based on its type
    switch (msg.kind) {
      case Msg.Subscribe:
        writer.marshalSubscribe(msg as Subscribe);
        break;
      case Msg.SubscribeOk:
        writer.marshalSubscribeOk(msg as SubscribeOk);
        break;
      case Msg.SubscribeError:
        writer.marshalSubscribeError(msg as SubscribeError);
        break;
      case Msg.PublishDone:
        writer.marshalPublishDone(msg as PublishDone);
        break;
      case Msg.Unsubscribe:
        writer.marshalUnsubscribe(msg as Unsubscribe);
        break;
      case Msg.Fetch:
        writer.marshalFetch(msg as Fetch);
        break;
      case Msg.PublishNamespace:
        writer.marshalPublishNamespace(msg as PublishNamespace);
        break;
      case Msg.PublishNamespaceOk:
        writer.marshalPublishNamespaceOk(msg as PublishNamespaceOk);
        break;
      case Msg.PublishNamespaceError:
        writer.marshalPublishNamespaceError(msg as PublishNamespaceError);
        break;
      case Msg.UnpublishNamespace:
        writer.marshalUnpublishNamespace(msg as UnpublishNamespace);
        break;
      default:
        const errorMsg = `Unsupported message type for encoding: ${
          (msg as any).kind
        }`;
        controlLogger.error(errorMsg);
        throw new Error(errorMsg);
    }

    // Get the marshaled bytes and write them to the output stream
    const bytes = writer.getBytes();
    controlLogger.debug(
      `Marshaled ${bytes.length} bytes for message type: ${msg.kind}`,
    );

    // Write the bytes directly to the output stream
    await this.w.write(bytes);
  }

  // All encoding is now handled by the BufferCtrlWriter class
}
