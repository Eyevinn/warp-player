/**
 * draft-18 wire primitives: Key-Value-Pairs, Message Parameters, Subscription
 * Filters and control-message framing.
 *
 * These operate on plain byte buffers rather than the stream Reader/Writer,
 * because draft-18 frames every control message with an explicit length
 * (Section 10): the body is read whole and then decoded, and a body that does
 * not consume exactly its declared length is a PROTOCOL_VIOLATION. Encoding
 * works the same way in reverse — the body is built first, then the length is
 * back-patched, since vi64 lengths depend on the values.
 */

import { VI64_MAX_LEN, encodeVi64, readVi64 } from "./vi64";

/** Largest control-message body. Message Length is a fixed 16-bit field. */
export const MAX_CONTROL_MESSAGE_BODY = 0xffff;

// ---------------------------------------------------------------------------
// A growable write buffer
// ---------------------------------------------------------------------------

/** Accumulates bytes for one control message body. */
export class ByteWriter {
  #buf: Uint8Array;
  #len = 0;

  constructor(initial = 256) {
    this.#buf = new Uint8Array(initial);
  }

  #ensure(extra: number): void {
    if (this.#len + extra <= this.#buf.length) {
      return;
    }
    let cap = this.#buf.length * 2;
    while (cap < this.#len + extra) {
      cap *= 2;
    }
    const next = new Uint8Array(cap);
    next.set(this.#buf.subarray(0, this.#len));
    this.#buf = next;
  }

  u8(v: number): this {
    this.#ensure(1);
    this.#buf[this.#len++] = v & 0xff;
    return this;
  }

  vi64(v: bigint): this {
    this.#ensure(VI64_MAX_LEN);
    const enc = encodeVi64(v);
    this.#buf.set(enc, this.#len);
    this.#len += enc.length;
    return this;
  }

  bytes(b: Uint8Array): this {
    this.#ensure(b.length);
    this.#buf.set(b, this.#len);
    this.#len += b.length;
    return this;
  }

  /** A vi64 length followed by that many bytes. */
  lengthPrefixed(b: Uint8Array): this {
    return this.vi64(BigInt(b.length)).bytes(b);
  }

  /** A Track Namespace: a field count, then each field length-prefixed. */
  namespace(fields: Uint8Array[]): this {
    this.vi64(BigInt(fields.length));
    for (const f of fields) {
      this.lengthPrefixed(f);
    }
    return this;
  }

  get length(): number {
    return this.#len;
  }

  take(): Uint8Array {
    return this.#buf.slice(0, this.#len);
  }
}

/** Reads from a fixed byte buffer, tracking how much has been consumed. */
export class ByteReader {
  #buf: Uint8Array;
  #pos = 0;

  constructor(buf: Uint8Array) {
    this.#buf = buf;
  }

  get remaining(): number {
    return this.#buf.length - this.#pos;
  }

  get done(): boolean {
    return this.#pos >= this.#buf.length;
  }

  u8(): number {
    if (this.#pos >= this.#buf.length) {
      throw new Error("wire18: unexpected end of message body");
    }
    return this.#buf[this.#pos++];
  }

  vi64(): bigint {
    const { value, bytesRead } = readVi64(this.#buf, this.#pos);
    this.#pos += bytesRead;
    return value;
  }

  bytes(n: number): Uint8Array {
    if (this.#pos + n > this.#buf.length) {
      throw new Error("wire18: unexpected end of message body");
    }
    const out = this.#buf.subarray(this.#pos, this.#pos + n);
    this.#pos += n;
    return out;
  }

  lengthPrefixed(): Uint8Array {
    return this.bytes(Number(this.vi64()));
  }

  namespace(): Uint8Array[] {
    const count = Number(this.vi64());
    if (count > MAX_NAMESPACE_FIELDS) {
      throw new Error(`wire18: namespace has ${count} fields, max 32`);
    }
    const fields: Uint8Array[] = [];
    for (let i = 0; i < count; i += 1) {
      fields.push(this.lengthPrefixed());
    }
    return fields;
  }

  /** The rest of the buffer, consumed. */
  rest(): Uint8Array {
    return this.bytes(this.remaining);
  }
}

/** A Track Namespace carries at most 32 fields (Section 2.4.1). */
export const MAX_NAMESPACE_FIELDS = 32;

// ---------------------------------------------------------------------------
// Key-Value-Pairs (Section 1.4.3)
// ---------------------------------------------------------------------------

/**
 * One Key-Value-Pair. The parity of `type` selects the value: an even type
 * carries a varint, an odd type a length-prefixed byte string.
 *
 * `type` is the absolute type; the delta against the preceding one exists only
 * on the wire.
 */
export interface KeyValuePair {
  type: bigint;
  varint?: bigint;
  bytes?: Uint8Array;
}

/**
 * Write a KVP list with types delta-encoded against the previous type.
 * Pairs must be in non-decreasing type order, so they are sorted here.
 *
 * No count and no length is written: this is the trailing "Track Properties"
 * form, which runs to the end of the message body.
 */
export function writeKvpList(w: ByteWriter, pairs: KeyValuePair[]): void {
  const sorted = [...pairs].sort((a, b) => (a.type < b.type ? -1 : 1));
  let prev = 0n;
  for (const p of sorted) {
    w.vi64(p.type - prev);
    prev = p.type;
    if (p.type % 2n === 1n) {
      w.lengthPrefixed(p.bytes ?? new Uint8Array());
    } else {
      w.vi64(p.varint ?? 0n);
    }
  }
}

/** Read KVPs until the reader is exhausted. */
export function readKvpList(r: ByteReader): KeyValuePair[] {
  const pairs: KeyValuePair[] = [];
  let prev = 0n;
  while (!r.done) {
    const type = prev + r.vi64();
    prev = type;
    if (type % 2n === 1n) {
      pairs.push({ type, bytes: r.lengthPrefixed() });
    } else {
      pairs.push({ type, varint: r.vi64() });
    }
  }
  return pairs;
}

/** Read a KVP list introduced by a vi64 byte length. */
export function readKvpListWithLength(r: ByteReader): KeyValuePair[] {
  const length = Number(r.vi64());
  return readKvpList(new ByteReader(r.bytes(length)));
}

// ---------------------------------------------------------------------------
// Message Parameters (Section 10.2)
// ---------------------------------------------------------------------------

export const PARAM_OBJECT_DELIVERY_TIMEOUT = 0x02n;
export const PARAM_AUTHORIZATION_TOKEN = 0x03n;
export const PARAM_RENDEZVOUS_TIMEOUT = 0x04n;
export const PARAM_SUBGROUP_DELIVERY_TIMEOUT = 0x06n;
export const PARAM_EXPIRES = 0x08n;
export const PARAM_LARGEST_OBJECT = 0x09n;
export const PARAM_FILL_TIMEOUT = 0x0an;
export const PARAM_FORWARD = 0x10n;
export const PARAM_SUBSCRIBER_PRIORITY = 0x20n;
export const PARAM_SUBSCRIPTION_FILTER = 0x21n;
export const PARAM_GROUP_ORDER = 0x22n;
export const PARAM_NEW_GROUP_REQUEST = 0x32n;
export const PARAM_TRACK_NAMESPACE_PREFIX = 0x34n;

/**
 * How a Message Parameter's value is encoded.
 *
 * Unlike a Key-Value-Pair, whose value encoding follows from the parity of its
 * type, a Message Parameter's encoding comes from the registry. That is why an
 * unknown parameter cannot be skipped — the parser cannot tell how long its
 * value is — and so why receiving one is fatal rather than ignorable.
 */
export const enum ParamEncoding {
  Uint8,
  Varint,
  Location,
  Bytes,
  Namespace,
}

interface ParamDef {
  name: string;
  encoding: ParamEncoding;
  repeatable: boolean;
}

const PARAM_REGISTRY = new Map<bigint, ParamDef>([
  [
    PARAM_OBJECT_DELIVERY_TIMEOUT,
    {
      name: "OBJECT_DELIVERY_TIMEOUT",
      encoding: ParamEncoding.Varint,
      repeatable: false,
    },
  ],
  [
    PARAM_AUTHORIZATION_TOKEN,
    {
      name: "AUTHORIZATION_TOKEN",
      encoding: ParamEncoding.Bytes,
      repeatable: true,
    },
  ],
  [
    PARAM_RENDEZVOUS_TIMEOUT,
    {
      name: "RENDEZVOUS_TIMEOUT",
      encoding: ParamEncoding.Varint,
      repeatable: false,
    },
  ],
  [
    PARAM_SUBGROUP_DELIVERY_TIMEOUT,
    {
      name: "SUBGROUP_DELIVERY_TIMEOUT",
      encoding: ParamEncoding.Varint,
      repeatable: false,
    },
  ],
  [
    PARAM_EXPIRES,
    { name: "EXPIRES", encoding: ParamEncoding.Varint, repeatable: false },
  ],
  [
    PARAM_LARGEST_OBJECT,
    {
      name: "LARGEST_OBJECT",
      encoding: ParamEncoding.Location,
      repeatable: false,
    },
  ],
  [
    PARAM_FILL_TIMEOUT,
    { name: "FILL_TIMEOUT", encoding: ParamEncoding.Varint, repeatable: false },
  ],
  [
    PARAM_FORWARD,
    { name: "FORWARD", encoding: ParamEncoding.Uint8, repeatable: false },
  ],
  [
    PARAM_SUBSCRIBER_PRIORITY,
    {
      name: "SUBSCRIBER_PRIORITY",
      encoding: ParamEncoding.Uint8,
      repeatable: false,
    },
  ],
  [
    PARAM_SUBSCRIPTION_FILTER,
    {
      name: "SUBSCRIPTION_FILTER",
      encoding: ParamEncoding.Bytes,
      repeatable: false,
    },
  ],
  [
    PARAM_GROUP_ORDER,
    { name: "GROUP_ORDER", encoding: ParamEncoding.Uint8, repeatable: false },
  ],
  [
    PARAM_NEW_GROUP_REQUEST,
    {
      name: "NEW_GROUP_REQUEST",
      encoding: ParamEncoding.Varint,
      repeatable: false,
    },
  ],
  [
    PARAM_TRACK_NAMESPACE_PREFIX,
    {
      name: "TRACK_NAMESPACE_PREFIX",
      encoding: ParamEncoding.Namespace,
      repeatable: false,
    },
  ],
]);

/** A Location: a Group and an Object (Section 1.4.2). */
export interface Location {
  group: bigint;
  object: bigint;
}

/** One Message Parameter. Which field carries the value follows from the registry. */
export interface Parameter {
  type: bigint;
  number?: bigint;
  location?: Location;
  bytes?: Uint8Array;
  namespace?: Uint8Array[];
}

export function parameterName(type: bigint): string {
  return PARAM_REGISTRY.get(type)?.name ?? `UNKNOWN(0x${type.toString(16)})`;
}

/** Write a count-prefixed Message Parameter block, types delta-encoded. */
export function writeParameters(w: ByteWriter, params: Parameter[]): void {
  const sorted = [...params].sort((a, b) => (a.type < b.type ? -1 : 1));
  w.vi64(BigInt(sorted.length));
  let prev = 0n;
  for (const p of sorted) {
    const def = PARAM_REGISTRY.get(p.type);
    if (!def) {
      throw new Error(
        `wire18: cannot encode unknown parameter 0x${p.type.toString(16)}`,
      );
    }
    w.vi64(p.type - prev);
    prev = p.type;
    switch (def.encoding) {
      case ParamEncoding.Uint8: {
        const n = p.number ?? 0n;
        if (n > 255n) {
          throw new Error(
            `wire18: ${def.name} value ${n} does not fit a uint8`,
          );
        }
        w.u8(Number(n));
        break;
      }
      case ParamEncoding.Varint:
        w.vi64(p.number ?? 0n);
        break;
      case ParamEncoding.Location:
        w.vi64(p.location?.group ?? 0n).vi64(p.location?.object ?? 0n);
        break;
      case ParamEncoding.Bytes:
        w.lengthPrefixed(p.bytes ?? new Uint8Array());
        break;
      case ParamEncoding.Namespace:
        w.namespace(p.namespace ?? []);
        break;
    }
  }
}

/** Read a count-prefixed Message Parameter block. */
export function readParameters(r: ByteReader): Parameter[] {
  const count = Number(r.vi64());
  const params: Parameter[] = [];
  const seen = new Set<bigint>();
  let prev = 0n;
  for (let i = 0; i < count; i += 1) {
    const type = prev + r.vi64();
    prev = type;
    const def = PARAM_REGISTRY.get(type);
    if (!def) {
      // Without the registry the value's length is unknown, so the rest of the
      // block cannot be found. Section 10.2 makes this a PROTOCOL_VIOLATION.
      throw new Error(
        `wire18: unknown message parameter 0x${type.toString(16)}`,
      );
    }
    if (seen.has(type) && !def.repeatable) {
      throw new Error(`wire18: ${def.name} repeated`);
    }
    seen.add(type);

    switch (def.encoding) {
      case ParamEncoding.Uint8:
        params.push({ type, number: BigInt(r.u8()) });
        break;
      case ParamEncoding.Varint:
        params.push({ type, number: r.vi64() });
        break;
      case ParamEncoding.Location:
        params.push({ type, location: { group: r.vi64(), object: r.vi64() } });
        break;
      case ParamEncoding.Bytes:
        params.push({ type, bytes: r.lengthPrefixed() });
        break;
      case ParamEncoding.Namespace:
        params.push({ type, namespace: r.namespace() });
        break;
    }
  }
  return params;
}

export function findParameter(
  params: Parameter[],
  type: bigint,
): Parameter | undefined {
  return params.find((p) => p.type === type);
}

// ---------------------------------------------------------------------------
// Subscription Filter (Section 5.1.2)
// ---------------------------------------------------------------------------

export enum FilterType {
  /** Start at {Largest Object.Group + 1, 0}, open ended. */
  NextGroupStart = 0x1,
  /** Start at {Largest Object.Group, Largest Object.Object + 1}, open ended. */
  LargestObject = 0x2,
  /** Start at an explicit Location, open ended. */
  AbsoluteStart = 0x3,
  /** Start at an explicit Location, end at a Group derived from it. */
  AbsoluteRange = 0x4,
}

export interface SubscriptionFilter {
  type: FilterType;
  /** Present for AbsoluteStart and AbsoluteRange. */
  start?: Location;
  /** Present only for AbsoluteRange; the last Group is start.group + this. */
  endGroupDelta?: bigint;
}

function filterHasStart(t: FilterType): boolean {
  return t === FilterType.AbsoluteStart || t === FilterType.AbsoluteRange;
}

/** Encode a filter as the SUBSCRIPTION_FILTER parameter's value. */
export function encodeSubscriptionFilter(f: SubscriptionFilter): Uint8Array {
  const w = new ByteWriter(32);
  w.vi64(BigInt(f.type));
  if (filterHasStart(f.type)) {
    w.vi64(f.start?.group ?? 0n).vi64(f.start?.object ?? 0n);
  }
  if (f.type === FilterType.AbsoluteRange) {
    w.vi64(f.endGroupDelta ?? 0n);
  }
  return w.take();
}

/** Decode a SUBSCRIPTION_FILTER parameter value. */
export function decodeSubscriptionFilter(data: Uint8Array): SubscriptionFilter {
  const r = new ByteReader(data);
  const type = Number(r.vi64()) as FilterType;
  if (!(type in FilterType)) {
    throw new Error(`wire18: invalid subscription filter type ${type}`);
  }
  const f: SubscriptionFilter = { type };
  if (filterHasStart(type)) {
    f.start = { group: r.vi64(), object: r.vi64() };
  }
  if (type === FilterType.AbsoluteRange) {
    f.endGroupDelta = r.vi64();
  }
  if (!r.done) {
    throw new Error("wire18: trailing bytes in subscription filter");
  }
  return f;
}

/** Build the SUBSCRIPTION_FILTER parameter. */
export function subscriptionFilterParameter(f: SubscriptionFilter): Parameter {
  return {
    type: PARAM_SUBSCRIPTION_FILTER,
    bytes: encodeSubscriptionFilter(f),
  };
}

/** Group delivery order (Section 5.1.1). */
export enum GroupOrder {
  Ascending = 0x1,
  Descending = 0x2,
}

/** The subscriber priority a publisher assumes when the parameter is absent. */
export const DEFAULT_SUBSCRIBER_PRIORITY = 128;
