import { ILogger, LoggerFactory } from "../logger";

import { BufferCtrlWriter } from "./bufferctrlwriter";
import { Reader, Writer, KeyValuePair } from "./stream";

// Logger for control message operations
const controlLogger: ILogger = LoggerFactory.getInstance().getLogger("Control");

export type Message = Subscriber | Publisher;

// Sent by subscriber
export type Subscriber =
  | Subscribe
  | Unsubscribe
  | PublishNamespaceOk
  | PublishNamespaceError;

export function isSubscriber(m: Message): m is Subscriber {
  return (
    m.kind === Msg.Subscribe ||
    m.kind === Msg.Unsubscribe ||
    m.kind === Msg.PublishNamespaceOk ||
    m.kind === Msg.PublishNamespaceError
  );
}

// Sent by publisher
export type Publisher =
  | SubscribeOk
  | SubscribeError
  | PublishDone
  | PublishNamespace
  | UnpublishNamespace
  | RequestsBlocked;

export function isPublisher(m: Message): m is Publisher {
  return (
    m.kind === Msg.SubscribeOk ||
    m.kind === Msg.SubscribeError ||
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
  reason: string;
  trackAlias: bigint;
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
  namespace: string[];
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

  constructor(r: Reader, w: Writer) {
    this.decoder = new Decoder(r);
    this.encoder = new Encoder(w);
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

export class Decoder {
  r: Reader;

  constructor(r: Reader) {
    this.r = r;
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

  private async subscribe_ok(): Promise<SubscribeOk> {
    controlLogger.debug("Parsing SubscribeOk message...");
    const requestId = await this.r.u62();
    controlLogger.debug(`Request ID: ${requestId}`);

    // draft-14: trackAlias is now in SUBSCRIBE_OK (assigned by publisher)
    const trackAlias = await this.r.u62();
    controlLogger.debug(`Track Alias: ${trackAlias}`);

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

  private async subscribe_error(): Promise<SubscribeError> {
    controlLogger.debug("Parsing SubscribeError message...");
    const requestId = await this.r.u62();
    controlLogger.debug(`Subscribe ID: ${requestId}`);

    const code = await this.r.u62();
    controlLogger.debug(`Code: ${code}`);

    const reason = await this.r.string();
    controlLogger.debug(`Reason: ${reason}`);

    const trackAlias = await this.r.u62();
    controlLogger.debug(`Track Alias: ${trackAlias}`);

    return {
      kind: Msg.SubscribeError,
      requestId,
      code,
      reason,
      trackAlias,
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

    const params = await this.r.keyValuePairs();
    controlLogger.debug(`Parameters: ${params.length}`);

    return {
      kind: Msg.PublishNamespace,
      requestId,
      namespace,
      params,
    };
  }

  private async publish_namespace_ok(): Promise<PublishNamespaceOk> {
    controlLogger.debug("Parsing PublishNamespaceOk message...");
    const requestId = await this.r.u62();
    controlLogger.debug(`Request ID: ${requestId}`);

    const namespace = await this.r.tuple();
    controlLogger.debug(`Namespace: ${namespace.join("/")}`);

    return {
      kind: Msg.PublishNamespaceOk,
      requestId,
      namespace,
    };
  }

  private async publish_namespace_error(): Promise<PublishNamespaceError> {
    controlLogger.debug("Parsing PublishNamespaceError message...");
    const requestId = await this.r.u62();
    controlLogger.debug(`Request ID: ${requestId}`);

    const code = await this.r.u62();
    controlLogger.debug(`Error code: ${code}`);

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

  constructor(w: Writer) {
    this.w = w;
  }

  async message(msg: Message): Promise<void> {
    controlLogger.debug(`Encoding message of type: ${msg.kind}`);

    // Create a BufferCtrlWriter to marshal the message
    const writer = new BufferCtrlWriter();

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
