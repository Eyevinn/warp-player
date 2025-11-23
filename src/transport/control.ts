import { ILogger, LoggerFactory } from "../logger";

import { BufferCtrlWriter } from "./bufferctrlwriter";
import { Reader, Writer, KeyValuePair } from "./stream";

// Logger for control message operations
const controlLogger: ILogger = LoggerFactory.getInstance().getLogger("Control");

export type Message = Subscriber | Publisher;

// Sent by subscriber
export type Subscriber = Subscribe | Unsubscribe | AnnounceOk | AnnounceError;

export function isSubscriber(m: Message): m is Subscriber {
  return (
    m.kind === Msg.Subscribe ||
    m.kind === Msg.Unsubscribe ||
    m.kind === Msg.AnnounceOk ||
    m.kind === Msg.AnnounceError
  );
}

// Sent by publisher
export type Publisher =
  | SubscribeOk
  | SubscribeError
  | SubscribeDone
  | Announce
  | Unannounce
  | RequestsBlocked;

export function isPublisher(m: Message): m is Publisher {
  return (
    m.kind === Msg.SubscribeOk ||
    m.kind === Msg.SubscribeError ||
    m.kind === Msg.SubscribeDone ||
    m.kind === Msg.Announce ||
    m.kind === Msg.Unannounce ||
    m.kind === Msg.RequestsBlocked
  );
}

export enum Msg {
  Subscribe = "subscribe",
  SubscribeOk = "subscribe_ok",
  SubscribeError = "subscribe_error",
  SubscribeUpdate = "subscribe_update",
  SubscribeDone = "subscribe_done",
  Unsubscribe = "unsubscribe",
  Announce = "announce",
  AnnounceOk = "announce_ok",
  AnnounceError = "announce_error",
  Unannounce = "unannounce",
  RequestsBlocked = "requests_blocked",
}

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
}

export interface Subscribe {
  kind: Msg.Subscribe;
  requestId: bigint;
  trackAlias: bigint;
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

export interface SubscribeDone {
  kind: Msg.SubscribeDone;
  requestId: bigint;
  code: bigint;
  streamCount: number;
  reason: string;
}

export interface Announce {
  kind: Msg.Announce;
  requestId: bigint;
  namespace: string[];
  params: KeyValuePair[];
}

export interface AnnounceOk {
  kind: Msg.AnnounceOk;
  requestId: bigint;
  namespace: string[];
}

export interface AnnounceError {
  kind: Msg.AnnounceError;
  requestId: bigint;
  code: bigint;
  reason: string;
}

export interface Unannounce {
  kind: Msg.Unannounce;
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
      case Id.SubscribeDone:
        msgType = Msg.SubscribeDone;
        break;
      case Id.SubscribeError:
        msgType = Msg.SubscribeError;
        break;
      case Id.Unsubscribe:
        msgType = Msg.Unsubscribe;
        break;
      case Id.Announce:
        msgType = Msg.Announce;
        break;
      case Id.AnnounceOk:
        msgType = Msg.AnnounceOk;
        break;
      case Id.AnnounceError:
        msgType = Msg.AnnounceError;
        break;
      case Id.Unannounce:
        msgType = Msg.Unannounce;
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
      case Msg.SubscribeDone:
        result = await this.subscribe_done();
        break;
      case Msg.Unsubscribe:
        result = await this.unsubscribe();
        break;
      case Msg.Announce:
        result = await this.announce();
        break;
      case Msg.AnnounceOk:
        result = await this.announce_ok();
        break;
      case Msg.AnnounceError:
        result = await this.announce_error();
        break;
      case Msg.Unannounce:
        result = await this.unannounce();
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

    const trackAlias = await this.r.u62();
    controlLogger.debug(`TrackAlias: ${trackAlias}`);

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
      trackAlias,
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

  private async subscribe_done(): Promise<SubscribeDone> {
    controlLogger.debug("Parsing SubscribeDone message...");
    const requestId = await this.r.u62();
    controlLogger.debug(`Subscribe ID: ${requestId}`);

    const code = await this.r.u62();
    controlLogger.debug(`Code: ${code}`);

    const reason = await this.r.string();
    controlLogger.debug(`Reason: ${reason}`);

    // Read the stream count
    const streamCount = await this.r.u53();
    controlLogger.debug(`Stream count: ${streamCount}`);

    return {
      kind: Msg.SubscribeDone,
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

  private async announce(): Promise<Announce> {
    controlLogger.debug("Parsing Announce message...");
    const requestId = await this.r.u62();
    controlLogger.debug(`Request ID: ${requestId}`);

    const namespace = await this.r.tuple();
    controlLogger.debug(`Namespace: ${namespace.join("/")}`);

    const params = await this.r.keyValuePairs();
    controlLogger.debug(`Parameters: ${params.length}`);

    return {
      kind: Msg.Announce,
      requestId,
      namespace,
      params,
    };
  }

  private async announce_ok(): Promise<AnnounceOk> {
    controlLogger.debug("Parsing AnnounceOk message...");
    const requestId = await this.r.u62();
    controlLogger.debug(`Request ID: ${requestId}`);

    const namespace = await this.r.tuple();
    controlLogger.debug(`Namespace: ${namespace.join("/")}`);

    return {
      kind: Msg.AnnounceOk,
      requestId,
      namespace,
    };
  }

  private async announce_error(): Promise<AnnounceError> {
    controlLogger.debug("Parsing AnnounceError message...");
    const requestId = await this.r.u62();
    controlLogger.debug(`Request ID: ${requestId}`);

    const code = await this.r.u62();
    controlLogger.debug(`Error code: ${code}`);

    const reason = await this.r.string();
    controlLogger.debug(`Error reason: ${reason}`);

    return {
      kind: Msg.AnnounceError,
      requestId,
      code,
      reason,
    };
  }

  private async unannounce(): Promise<Unannounce> {
    controlLogger.debug("Parsing Unannounce message...");
    const namespace = await this.r.tuple();
    controlLogger.debug(`Namespace: ${namespace.join("/")}`);

    return {
      kind: Msg.Unannounce,
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
      case Msg.SubscribeDone:
        writer.marshalSubscribeDone(msg as SubscribeDone);
        break;
      case Msg.Unsubscribe:
        writer.marshalUnsubscribe(msg as Unsubscribe);
        break;
      case Msg.Announce:
        writer.marshalAnnounce(msg as Announce);
        break;
      case Msg.AnnounceOk:
        writer.marshalAnnounceOk(msg as AnnounceOk);
        break;
      case Msg.AnnounceError:
        writer.marshalAnnounceError(msg as AnnounceError);
        break;
      case Msg.Unannounce:
        writer.marshalUnannounce(msg as Unannounce);
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
