/**
 * draft-18 control messages and their framing.
 *
 * Two things about draft-18 shape this module and are worth stating up front,
 * because both differ from draft-16:
 *
 * 1. **Codepoints are scoped to the stream they arrive on.** 0x5 is
 *    REQUEST_ERROR on a request stream and FETCH_HEADER on a unidirectional
 *    data stream. Dispatch must know the stream kind before it can read a type,
 *    so there is no flat message table here.
 *
 * 2. **Responses carry no Request ID.** The request stream *is* the identity of
 *    the request, which is the whole point of the per-request stream model.
 *    Only the seven messages that open a stream carry one.
 */

import {
  ByteReader,
  ByteWriter,
  KeyValuePair,
  Location,
  MAX_CONTROL_MESSAGE_BODY,
  Parameter,
  readKvpList,
  readParameters,
  writeKvpList,
  writeParameters,
} from "./wire18";

// ---------------------------------------------------------------------------
// Codepoints
// ---------------------------------------------------------------------------

export enum CtrlType {
  /** Also the control stream's unidirectional stream type (Table 3). */
  Setup = 0x2f00,
  GoAway = 0x10,

  // These seven open a request stream and MUST be its first message.
  Subscribe = 0x3,
  Publish = 0x1d,
  Fetch = 0x16,
  TrackStatus = 0xd,
  PublishNamespace = 0x6,
  SubscribeNamespace = 0x50,
  SubscribeTracks = 0x51,

  // These are sent on an established request stream.
  RequestUpdate = 0x2,
  RequestOk = 0x7,
  RequestError = 0x5,
  SubscribeOk = 0x4,
  FetchOk = 0x18,
  PublishDone = 0xb,
  Namespace = 0x8,
  NamespaceDone = 0xe,
  PublishBlocked = 0xf,

  /**
   * draft-18's leftover codepoint for PUBLISH_OK. Section 10.5 makes PUBLISH_OK
   * a shorthand for REQUEST_OK and gives it REQUEST_OK's body, but Table 5
   * still lists 0x1E and draft-19 reserves it. A peer may send either, so this
   * is accepted on receive and never sent.
   */
  PublishOk = 0x1e,
}

/** Unidirectional stream types (Table 3). */
export enum StreamType {
  FetchHeader = 0x05,
  Setup = 0x2f00,
  Padding = 0x132b3e28,
}

/**
 * Whether a type may be the first message on a bidirectional stream
 * (Section 3.3). A stream opening with anything else is a PROTOCOL_VIOLATION —
 * including a type that is perfectly valid later on the same stream.
 */
export function opensRequestStream(t: CtrlType): boolean {
  switch (t) {
    case CtrlType.Subscribe:
    case CtrlType.Publish:
    case CtrlType.Fetch:
    case CtrlType.TrackStatus:
    case CtrlType.PublishNamespace:
    case CtrlType.SubscribeNamespace:
    case CtrlType.SubscribeTracks:
      return true;
    default:
      return false;
  }
}

export function ctrlTypeName(t: CtrlType): string {
  return CtrlType[t] ?? `UNKNOWN(0x${t.toString(16)})`;
}

// ---------------------------------------------------------------------------
// Message shapes
// ---------------------------------------------------------------------------

export interface Setup {
  kind: CtrlType.Setup;
  options: KeyValuePair[];
}

export interface Subscribe {
  kind: CtrlType.Subscribe;
  requestId: bigint;
  namespace: Uint8Array[];
  name: Uint8Array;
  parameters: Parameter[];
}

export interface SubscribeOk {
  kind: CtrlType.SubscribeOk;
  trackAlias: bigint;
  parameters: Parameter[];
  trackProperties: KeyValuePair[];
}

/** Which optional structure a FETCH body carries (Section 10.12). */
export enum FetchType {
  Standalone = 0x1,
  RelativeJoining = 0x2,
  AbsoluteJoining = 0x3,
}

/** Names a track and an explicit range; present for FetchType.Standalone. */
export interface StandaloneFetch {
  namespace: Uint8Array[];
  name: Uint8Array;
  start: Location;
  /** The last Object plus one; an Object of 0 requests the whole group. */
  end: Location;
}

/**
 * References a subscription on the same session; present for the two joining
 * types. The publisher derives the range from that subscription, so the
 * fetched and subscribed Objects are contiguous and do not overlap.
 */
export interface JoiningFetch {
  joiningRequestId: bigint;
  /** draft-20 removes this field; draft-18 still carries it. */
  joiningStart: bigint;
}

export interface Fetch {
  kind: CtrlType.Fetch;
  requestId: bigint;
  fetchType: FetchType;
  standalone?: StandaloneFetch;
  joining?: JoiningFetch;
  parameters: Parameter[];
}

export interface FetchOk {
  kind: CtrlType.FetchOk;
  endOfTrack: boolean;
  endLocation: Location;
  parameters: Parameter[];
  trackProperties: KeyValuePair[];
}

export interface RequestOk {
  kind: CtrlType.RequestOk;
  parameters: Parameter[];
  trackProperties: KeyValuePair[];
}

export interface RequestError {
  kind: CtrlType.RequestError;
  errorCode: bigint;
  retryInterval: bigint;
  errorReason: string;
}

export interface PublishDone {
  kind: CtrlType.PublishDone;
  statusCode: bigint;
  streamCount: bigint;
  errorReason: string;
}

export interface PublishNamespace {
  kind: CtrlType.PublishNamespace;
  requestId: bigint;
  namespace: Uint8Array[];
  parameters: Parameter[];
}

export interface SubscribeNamespace {
  kind: CtrlType.SubscribeNamespace;
  requestId: bigint;
  prefix: Uint8Array[];
  parameters: Parameter[];
}

/** NAMESPACE announces a namespace on a SUBSCRIBE_NAMESPACE request stream. */
export interface Namespace {
  kind: CtrlType.Namespace;
  suffix: Uint8Array[];
}

export interface NamespaceDone {
  kind: CtrlType.NamespaceDone;
  suffix: Uint8Array[];
}

export interface GoAway {
  kind: CtrlType.GoAway;
  newSessionUri: string;
  timeout: bigint;
  /** Present only on the control-stream form; draft-19 removes it. */
  requestId?: bigint;
}

export type CtrlMessage =
  | Setup
  | Subscribe
  | SubscribeOk
  | Fetch
  | FetchOk
  | RequestOk
  | RequestError
  | PublishDone
  | PublishNamespace
  | SubscribeNamespace
  | Namespace
  | NamespaceDone
  | GoAway;

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeBody(m: CtrlMessage): Uint8Array {
  const w = new ByteWriter(256);
  switch (m.kind) {
    case CtrlType.Setup:
      // Setup Options are a trailing KVP list: no count, no length.
      writeKvpList(w, m.options);
      break;
    case CtrlType.Subscribe:
      w.vi64(m.requestId).namespace(m.namespace).lengthPrefixed(m.name);
      writeParameters(w, m.parameters);
      break;
    case CtrlType.Fetch:
      w.vi64(m.requestId).vi64(BigInt(m.fetchType));
      if (m.fetchType === FetchType.Standalone) {
        if (!m.standalone) {
          throw new Error("messages18: standalone FETCH without its fields");
        }
        w.namespace(m.standalone.namespace).lengthPrefixed(m.standalone.name);
        w.vi64(m.standalone.start.group).vi64(m.standalone.start.object);
        w.vi64(m.standalone.end.group).vi64(m.standalone.end.object);
      } else {
        if (!m.joining) {
          throw new Error("messages18: joining FETCH without its fields");
        }
        w.vi64(m.joining.joiningRequestId).vi64(m.joining.joiningStart);
      }
      writeParameters(w, m.parameters);
      break;
    case CtrlType.PublishNamespace:
      w.vi64(m.requestId).namespace(m.namespace);
      writeParameters(w, m.parameters);
      break;
    case CtrlType.SubscribeNamespace:
      w.vi64(m.requestId).namespace(m.prefix);
      writeParameters(w, m.parameters);
      break;
    case CtrlType.RequestOk:
      writeParameters(w, m.parameters);
      writeKvpList(w, m.trackProperties);
      break;
    case CtrlType.GoAway:
      w.lengthPrefixed(textEncoder.encode(m.newSessionUri)).vi64(m.timeout);
      if (m.requestId !== undefined) {
        w.vi64(m.requestId);
      }
      break;
    default:
      throw new Error(
        `messages18: ${ctrlTypeName(m.kind)} is not sent by this player`,
      );
  }
  return w.take();
}

/**
 * Frame a control message as
 *
 *     Message Type (vi64) | Message Length (16) | Message Body (..)
 *
 * The length is a fixed 16-bit field, so a body that overflows it is
 * unrepresentable and has to be prevented at the source.
 */
export function encodeCtrlMessage(m: CtrlMessage): Uint8Array {
  const body = encodeBody(m);
  if (body.length > MAX_CONTROL_MESSAGE_BODY) {
    throw new Error(
      `messages18: ${ctrlTypeName(m.kind)} body is ${body.length} bytes, max ${MAX_CONTROL_MESSAGE_BODY}`,
    );
  }
  const w = new ByteWriter(body.length + 16);
  w.vi64(BigInt(m.kind));
  w.u8((body.length >> 8) & 0xff).u8(body.length & 0xff);
  w.bytes(body);
  return w.take();
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Decode a message body whose type and length have already been read.
 *
 * `onControlStream` selects between the two GOAWAY shapes: the control-stream
 * form carries a Request ID and the request-stream form does not.
 */
export function decodeCtrlBody(
  type: CtrlType,
  body: Uint8Array,
  onControlStream = false,
): CtrlMessage {
  const r = new ByteReader(body);
  let msg: CtrlMessage;

  switch (type) {
    case CtrlType.Setup:
      msg = { kind: CtrlType.Setup, options: readKvpList(r) };
      break;

    case CtrlType.SubscribeOk:
      msg = {
        kind: CtrlType.SubscribeOk,
        trackAlias: r.vi64(),
        parameters: readParameters(r),
        // Track Properties have no count and no length: they run to the end of
        // the body, which is what makes the 16-bit length load-bearing.
        trackProperties: readKvpList(r),
      };
      break;

    case CtrlType.FetchOk:
      msg = {
        kind: CtrlType.FetchOk,
        endOfTrack: r.u8() !== 0,
        endLocation: { group: r.vi64(), object: r.vi64() },
        parameters: readParameters(r),
        trackProperties: readKvpList(r),
      };
      break;

    // PUBLISH_OK is REQUEST_OK under draft-18's leftover codepoint.
    case CtrlType.RequestOk:
    case CtrlType.PublishOk:
      msg = {
        kind: CtrlType.RequestOk,
        parameters: readParameters(r),
        trackProperties: readKvpList(r),
      };
      break;

    case CtrlType.RequestError: {
      const errorCode = r.vi64();
      const retryInterval = r.vi64();
      const errorReason = textDecoder.decode(r.lengthPrefixed());
      // A Redirect may follow when the code is REDIRECT. This player has no use
      // for one, so the remaining bytes are consumed and dropped rather than
      // decoded — leaving them would trip the trailing-bytes check below.
      if (!r.done) {
        r.rest();
      }
      msg = {
        kind: CtrlType.RequestError,
        errorCode,
        retryInterval,
        errorReason,
      };
      break;
    }

    case CtrlType.PublishDone:
      msg = {
        kind: CtrlType.PublishDone,
        statusCode: r.vi64(),
        streamCount: r.vi64(),
        errorReason: textDecoder.decode(r.lengthPrefixed()),
      };
      break;

    case CtrlType.Namespace:
      msg = { kind: CtrlType.Namespace, suffix: r.namespace() };
      break;

    case CtrlType.NamespaceDone:
      msg = { kind: CtrlType.NamespaceDone, suffix: r.namespace() };
      break;

    case CtrlType.PublishNamespace:
      msg = {
        kind: CtrlType.PublishNamespace,
        requestId: r.vi64(),
        namespace: r.namespace(),
        parameters: readParameters(r),
      };
      break;

    case CtrlType.GoAway: {
      const newSessionUri = textDecoder.decode(r.lengthPrefixed());
      const timeout = r.vi64();
      msg = {
        kind: CtrlType.GoAway,
        newSessionUri,
        timeout,
        ...(onControlStream ? { requestId: r.vi64() } : {}),
      };
      break;
    }

    default:
      throw new Error(
        `messages18: unhandled control message type 0x${type.toString(16)}`,
      );
  }

  // A body that does not decode to exactly its declared length is a
  // PROTOCOL_VIOLATION (Section 10).
  if (!r.done) {
    throw new Error(
      `messages18: ${ctrlTypeName(type)} body has ${r.remaining} trailing bytes`,
    );
  }
  return msg;
}
