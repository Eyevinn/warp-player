/**
 * Wire primitives: Key-Value-Pairs, Message Parameters, location filters and
 * control-message framing, for draft-18 and draft-22. The two drafts share
 * all of it except the parameter registry and the location filter's encoding,
 * so those take the session's Version.
 *
 * These operate on plain byte buffers rather than the stream Reader/Writer,
 * because draft-18 frames every control message with an explicit length
 * (Section 10): the body is read whole and then decoded, and a body that does
 * not consume exactly its declared length is a PROTOCOL_VIOLATION. Encoding
 * works the same way in reverse — the body is built first, then the length is
 * back-patched, since vi64 lengths depend on the values.
 */

import { Version, draftName } from "./version";
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
// Message Parameters (draft-18 Section 10.2, draft-22 Section 9.20)
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
/**
 * LOCATION_FILTER in draft-22 and SUBSCRIPTION_FILTER in draft-18: the same
 * codepoint and purpose, encoded differently. See {@link LocationFilter}.
 */
export const PARAM_LOCATION_FILTER = 0x21n;
export const PARAM_GROUP_ORDER = 0x22n;
/** Draft-22 only. Asks the publisher for a fill fetch stream (Section 3.4). */
export const PARAM_FILL_PARAMETERS = 0x23n;
export const PARAM_SUBGROUP_FILTER = 0x25n;
export const PARAM_OBJECT_ID_FILTER = 0x26n;
export const PARAM_PRIORITY_FILTER = 0x27n;
export const PARAM_OBJECT_PROPERTY_FILTER = 0x28n;
export const PARAM_TRACK_PROPERTY_FILTER = 0x29n;
export const PARAM_NEW_GROUP_REQUEST = 0x32n;
export const PARAM_TRACK_NAMESPACE_PREFIX = 0x34n;
export const PARAM_INCLUDE_PROPERTIES = 0x35n;

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
  /** A location filter, whose wire form is per draft; see LocationFilter. */
  LocationFilter,
  /**
   * A vi64 length, then a count-prefixed parameter block with a registry of
   * its own. FILL_PARAMETERS is the one parameter that uses it.
   */
  Parameters,
}

interface ParamDef {
  name: string;
  encoding: ParamEncoding;
  repeatable: boolean;
  /** The registry inside a ParamEncoding.Parameters value. */
  nested?: ParamRegistry;
}

type ParamRegistry = Map<bigint, ParamDef>;

function param(
  name: string,
  encoding: ParamEncoding,
  repeatable = false,
  nested?: ParamRegistry,
): ParamDef {
  return { name, encoding, repeatable, nested };
}

/**
 * draft-18's table. SUBSCRIPTION_FILTER is a byte string whose content is the
 * filter; LocationFilter's codec reads and writes it.
 */
const PARAMS_18: ParamRegistry = new Map([
  [
    PARAM_OBJECT_DELIVERY_TIMEOUT,
    param("OBJECT_DELIVERY_TIMEOUT", ParamEncoding.Varint),
  ],
  [
    PARAM_AUTHORIZATION_TOKEN,
    param("AUTHORIZATION_TOKEN", ParamEncoding.Bytes, true),
  ],
  [PARAM_RENDEZVOUS_TIMEOUT, param("RENDEZVOUS_TIMEOUT", ParamEncoding.Varint)],
  [
    PARAM_SUBGROUP_DELIVERY_TIMEOUT,
    param("SUBGROUP_DELIVERY_TIMEOUT", ParamEncoding.Varint),
  ],
  [PARAM_EXPIRES, param("EXPIRES", ParamEncoding.Varint)],
  [PARAM_LARGEST_OBJECT, param("LARGEST_OBJECT", ParamEncoding.Location)],
  [PARAM_FILL_TIMEOUT, param("FILL_TIMEOUT", ParamEncoding.Varint)],
  [PARAM_FORWARD, param("FORWARD", ParamEncoding.Uint8)],
  [
    PARAM_SUBSCRIBER_PRIORITY,
    param("SUBSCRIBER_PRIORITY", ParamEncoding.Uint8),
  ],
  [
    PARAM_LOCATION_FILTER,
    param("SUBSCRIPTION_FILTER", ParamEncoding.LocationFilter),
  ],
  [PARAM_GROUP_ORDER, param("GROUP_ORDER", ParamEncoding.Uint8)],
  [PARAM_NEW_GROUP_REQUEST, param("NEW_GROUP_REQUEST", ParamEncoding.Varint)],
  [
    PARAM_TRACK_NAMESPACE_PREFIX,
    param("TRACK_NAMESPACE_PREFIX", ParamEncoding.Namespace),
  ],
]);

/**
 * The registry inside FILL_PARAMETERS (draft-22 Table 7). It is a scope of its
 * own: anything not listed is a PROTOCOL_VIOLATION there, even a parameter the
 * enclosing message could carry.
 */
const FILL_PARAMS_22: ParamRegistry = new Map([
  [PARAM_FILL_TIMEOUT, param("FILL_TIMEOUT", ParamEncoding.Varint)],
  [
    PARAM_SUBSCRIBER_PRIORITY,
    param("SUBSCRIBER_PRIORITY", ParamEncoding.Uint8),
  ],
  [
    PARAM_LOCATION_FILTER,
    param("LOCATION_FILTER", ParamEncoding.LocationFilter),
  ],
  [PARAM_GROUP_ORDER, param("GROUP_ORDER", ParamEncoding.Uint8)],
  [PARAM_SUBGROUP_FILTER, param("SUBGROUP_FILTER", ParamEncoding.Bytes, true)],
  [PARAM_OBJECT_ID_FILTER, param("OBJECTID_FILTER", ParamEncoding.Bytes, true)],
  [PARAM_PRIORITY_FILTER, param("PRIORITY_FILTER", ParamEncoding.Bytes, true)],
  [
    PARAM_OBJECT_PROPERTY_FILTER,
    param("OBJECT_PROPERTY_FILTER", ParamEncoding.Bytes, true),
  ],
]);

/**
 * draft-22's table: draft-18's, with the filter renamed and re-encoded, plus
 * the fill, the range filters and INCLUDE_PROPERTIES.
 *
 * LOCATION_FILTER carries no Length although its type is odd: Section 9.20
 * gives each parameter its own encoding instead of the Key-Value-Pair parity
 * rule. FILL_PARAMETERS is length-prefixed and its value starts with a count.
 * Both readings are what moq-dev, Meta's relay and moqtail converged on in WG
 * issue #1991. The range filters are kept as their raw bytes; this player
 * never sends one.
 */
const PARAMS_22: ParamRegistry = new Map([
  ...PARAMS_18,
  [
    PARAM_LOCATION_FILTER,
    param("LOCATION_FILTER", ParamEncoding.LocationFilter),
  ],
  [
    PARAM_FILL_PARAMETERS,
    param("FILL_PARAMETERS", ParamEncoding.Parameters, false, FILL_PARAMS_22),
  ],
  [PARAM_SUBGROUP_FILTER, param("SUBGROUP_FILTER", ParamEncoding.Bytes, true)],
  [PARAM_OBJECT_ID_FILTER, param("OBJECTID_FILTER", ParamEncoding.Bytes, true)],
  [PARAM_PRIORITY_FILTER, param("PRIORITY_FILTER", ParamEncoding.Bytes, true)],
  [
    PARAM_OBJECT_PROPERTY_FILTER,
    param("OBJECT_PROPERTY_FILTER", ParamEncoding.Bytes, true),
  ],
  [
    PARAM_TRACK_PROPERTY_FILTER,
    param("TRACK_PROPERTY_FILTER", ParamEncoding.Bytes, true),
  ],
  [PARAM_INCLUDE_PROPERTIES, param("INCLUDE_PROPERTIES", ParamEncoding.Uint8)],
]);

function registryFor(version: Version): ParamRegistry {
  return version === Version.DRAFT_22 ? PARAMS_22 : PARAMS_18;
}

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
  filter?: LocationFilter;
  /** The nested block of FILL_PARAMETERS. */
  parameters?: Parameter[];
}

/** The parameter's name, as draft-22 has it. */
export function parameterName(type: bigint): string {
  return PARAMS_22.get(type)?.name ?? `UNKNOWN(0x${type.toString(16)})`;
}

/** Write a count-prefixed Message Parameter block, types delta-encoded. */
export function writeParameters(
  w: ByteWriter,
  params: Parameter[],
  version: Version,
): void {
  writeParameterBlock(w, params, version, registryFor(version));
}

function writeParameterBlock(
  w: ByteWriter,
  params: Parameter[],
  version: Version,
  registry: ParamRegistry,
): void {
  const sorted = [...params].sort((a, b) => (a.type < b.type ? -1 : 1));
  w.vi64(BigInt(sorted.length));
  let prev = 0n;
  for (const p of sorted) {
    const def = registry.get(p.type);
    if (!def) {
      throw new Error(
        `wire18: parameter 0x${p.type.toString(16)} cannot be sent here in ${draftName(version)}`,
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
      case ParamEncoding.LocationFilter:
        writeLocationFilter(
          w,
          p.filter ?? { type: LocationFilterType.None },
          version,
        );
        break;
      case ParamEncoding.Parameters: {
        const inner = new ByteWriter(64);
        writeParameterBlock(
          inner,
          p.parameters ?? [],
          version,
          def.nested ?? new Map(),
        );
        w.lengthPrefixed(inner.take());
        break;
      }
    }
  }
}

/** Read a count-prefixed Message Parameter block. */
export function readParameters(r: ByteReader, version: Version): Parameter[] {
  return readParameterBlock(r, version, registryFor(version));
}

function readParameterBlock(
  r: ByteReader,
  version: Version,
  registry: ParamRegistry,
): Parameter[] {
  const count = Number(r.vi64());
  const params: Parameter[] = [];
  const seen = new Set<bigint>();
  let prev = 0n;
  for (let i = 0; i < count; i += 1) {
    const type = prev + r.vi64();
    prev = type;
    const def = registry.get(type);
    if (!def) {
      // Without the registry the value's length is unknown, so the rest of the
      // block cannot be found. The draft makes this a PROTOCOL_VIOLATION.
      throw new Error(
        `wire18: unknown message parameter 0x${type.toString(16)} in ${draftName(version)}`,
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
      case ParamEncoding.LocationFilter:
        params.push({ type, filter: readLocationFilter(r, version) });
        break;
      case ParamEncoding.Parameters: {
        const inner = new ByteReader(r.lengthPrefixed());
        const nested = readParameterBlock(
          inner,
          version,
          def.nested ?? new Map(),
        );
        if (!inner.done) {
          throw new Error(`wire18: trailing bytes in ${def.name}`);
        }
        params.push({ type, parameters: nested });
        break;
      }
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
// Location filters (draft-22 Section 9.20.9, draft-18 Section 5.1.2)
// ---------------------------------------------------------------------------

/**
 * Which Locations a filter admits, and which of its fields are on the wire.
 *
 * The values are draft-22's. Draft-18's SUBSCRIPTION_FILTER has a Filter Type
 * of its own, numbered 1-4; the codec maps between the two, so the rest of the
 * player speaks only these.
 */
export enum LocationFilterType {
  /** Every Location. What an absent filter means. */
  None = 0x0,
  /**
   * Starts `start.group` Groups before the Next Group and is open ended: 0 is
   * the Next Group, 1 the current one.
   */
  RelativeStart = 0x1,
  /** Starts at `start` and is open ended. */
  AbsoluteStart = 0x2,
  /** Starts at `start` and ends with the last Object of Group start.group + endGroupDelta. */
  AbsoluteGroupEnd = 0x3,
  /** Starts at `start` and ends at {start.group + endGroupDelta, endObject}, inclusive. */
  AbsoluteRange = 0x4,
  /** Starts at the Next Object, {Largest.group, Largest.object + 1}, and is open ended. */
  NextObject = 0x5,
}

/**
 * The value of LOCATION_FILTER (draft-22), or of draft-18's SUBSCRIPTION_FILTER.
 *
 * `start` is the first Location for the three absolute types. RelativeStart
 * uses only `start.group`, which counts Groups back from the Next Group rather
 * than naming one.
 */
export interface LocationFilter {
  type: LocationFilterType;
  start?: Location;
  endGroupDelta?: bigint;
  endObject?: bigint;
}

/** Join at the Next Object, which can be in the middle of a Group. */
export function nextObjectFilter(): LocationFilter {
  return { type: LocationFilterType.NextObject };
}

/** Start `groupsBack` Groups before the Next Group: 0 waits for it, 1 is the current Group. */
export function relativeStartFilter(groupsBack: bigint): LocationFilter {
  return {
    type: LocationFilterType.RelativeStart,
    start: { group: groupsBack, object: 0n },
  };
}

/** Every Object from `start` through the end of Group `endGroup`. */
export function absoluteGroupEndFilter(
  start: Location,
  endGroup: bigint,
): LocationFilter {
  if (endGroup < start.group) {
    throw new Error("wire18: filter ends before it starts");
  }
  return {
    type: LocationFilterType.AbsoluteGroupEnd,
    start,
    endGroupDelta: endGroup - start.group,
  };
}

/** Every Object from `start` through `end`, both inclusive. */
export function absoluteRangeFilter(
  start: Location,
  end: Location,
): LocationFilter {
  if (
    end.group < start.group ||
    (end.group === start.group && end.object < start.object)
  ) {
    throw new Error("wire18: filter ends before it starts");
  }
  return {
    type: LocationFilterType.AbsoluteRange,
    start,
    endGroupDelta: end.group - start.group,
    endObject: end.object,
  };
}

/** Build the LOCATION_FILTER (draft-18: SUBSCRIPTION_FILTER) parameter. */
export function locationFilterParameter(filter: LocationFilter): Parameter {
  return { type: PARAM_LOCATION_FILTER, filter };
}

/** Build FILL_PARAMETERS, which asks a draft-22 publisher for a fill. */
export function fillParameter(inner: Parameter[]): Parameter {
  return { type: PARAM_FILL_PARAMETERS, parameters: inner };
}

/** Draft-18's SUBSCRIPTION_FILTER Filter Types (draft-18 Section 5.1.2). */
const enum FilterType18 {
  NextGroupStart = 0x1,
  LargestObject = 0x2,
  AbsoluteStart = 0x3,
  AbsoluteRange = 0x4,
}

function writeLocationFilter(
  w: ByteWriter,
  f: LocationFilter,
  version: Version,
): void {
  if (version === Version.DRAFT_18) {
    w.lengthPrefixed(encodeFilter18(f));
    return;
  }
  // Draft-22: no Length. The Location Filter Type says which fields follow.
  const start = f.start ?? { group: 0n, object: 0n };
  w.vi64(BigInt(f.type));
  switch (f.type) {
    case LocationFilterType.RelativeStart:
      w.vi64(start.group);
      break;
    case LocationFilterType.AbsoluteStart:
      w.vi64(start.group).vi64(start.object);
      break;
    case LocationFilterType.AbsoluteGroupEnd:
      w.vi64(start.group)
        .vi64(start.object)
        .vi64(f.endGroupDelta ?? 0n);
      break;
    case LocationFilterType.AbsoluteRange:
      w.vi64(start.group)
        .vi64(start.object)
        .vi64(f.endGroupDelta ?? 0n);
      w.vi64(f.endObject ?? 0n);
      break;
  }
}

/**
 * Write draft-18's SUBSCRIPTION_FILTER body. Every draft-18 type is one of
 * draft-22's under another number: Next Group Start is a relative start of 0
 * Groups, Largest Object is the Next Object, and Absolute Range ends with a
 * whole Group. There is no "no filter", but an Absolute Start at {0, 0} admits
 * the same. A relative start further back, or an end inside a Group, cannot be
 * said at all, so those throw rather than ask for something else.
 */
function encodeFilter18(f: LocationFilter): Uint8Array {
  const w = new ByteWriter(32);
  const start = f.start ?? { group: 0n, object: 0n };
  switch (f.type) {
    case LocationFilterType.None:
      w.vi64(BigInt(FilterType18.AbsoluteStart)).vi64(0n).vi64(0n);
      break;
    case LocationFilterType.RelativeStart:
      if (start.group !== 0n) {
        throw new Error(
          "wire18: draft-18 has no filter starting before the Next Group",
        );
      }
      w.vi64(BigInt(FilterType18.NextGroupStart));
      break;
    case LocationFilterType.NextObject:
      w.vi64(BigInt(FilterType18.LargestObject));
      break;
    case LocationFilterType.AbsoluteStart:
      w.vi64(BigInt(FilterType18.AbsoluteStart));
      w.vi64(start.group).vi64(start.object);
      break;
    case LocationFilterType.AbsoluteGroupEnd:
      w.vi64(BigInt(FilterType18.AbsoluteRange));
      w.vi64(start.group)
        .vi64(start.object)
        .vi64(f.endGroupDelta ?? 0n);
      break;
    default:
      throw new Error(
        `wire18: draft-18 cannot express a ${LocationFilterType[f.type]} filter`,
      );
  }
  return w.take();
}

function readLocationFilter(r: ByteReader, version: Version): LocationFilter {
  if (version === Version.DRAFT_18) {
    const inner = new ByteReader(r.lengthPrefixed());
    const f = decodeFilter18(inner);
    if (!inner.done) {
      throw new Error("wire18: trailing bytes in subscription filter");
    }
    return f;
  }
  const type = Number(r.vi64()) as LocationFilterType;
  if (!(type in LocationFilterType)) {
    throw new Error(`wire18: invalid location filter type ${type}`);
  }
  const f: LocationFilter = { type };
  switch (type) {
    case LocationFilterType.RelativeStart:
      f.start = { group: r.vi64(), object: 0n };
      break;
    case LocationFilterType.AbsoluteStart:
      f.start = { group: r.vi64(), object: r.vi64() };
      break;
    case LocationFilterType.AbsoluteGroupEnd:
      f.start = { group: r.vi64(), object: r.vi64() };
      f.endGroupDelta = r.vi64();
      break;
    case LocationFilterType.AbsoluteRange:
      f.start = { group: r.vi64(), object: r.vi64() };
      f.endGroupDelta = r.vi64();
      f.endObject = r.vi64();
      break;
  }
  return f;
}

function decodeFilter18(r: ByteReader): LocationFilter {
  const type = Number(r.vi64());
  switch (type) {
    case FilterType18.NextGroupStart:
      return relativeStartFilter(0n);
    case FilterType18.LargestObject:
      return nextObjectFilter();
    case FilterType18.AbsoluteStart:
      return {
        type: LocationFilterType.AbsoluteStart,
        start: { group: r.vi64(), object: r.vi64() },
      };
    case FilterType18.AbsoluteRange:
      return {
        type: LocationFilterType.AbsoluteGroupEnd,
        start: { group: r.vi64(), object: r.vi64() },
        endGroupDelta: r.vi64(),
      };
  }
  throw new Error(`wire18: invalid subscription filter type ${type}`);
}

/** The largest Group ID, 2^64-1. */
const MAX_GROUP = (1n << 64n) - 1n;

/**
 * Turn a filter into draft-18's explicit FETCH Start and End Locations, the
 * End being the last Object plus one, or Object 0 for the whole Group
 * (draft-18 Section 10.12.1). Draft-18 FETCH has no relative form and no way
 * to say "up to whatever is largest", so an open end becomes the whole of the
 * last possible Group, which the publisher clamps to Largest Object.
 */
export function fetchRange18(f: LocationFilter): {
  start: Location;
  end: Location;
} {
  const start = f.start ?? { group: 0n, object: 0n };
  const lastGroup = start.group + (f.endGroupDelta ?? 0n);
  switch (f.type) {
    case LocationFilterType.None:
      return {
        start: { group: 0n, object: 0n },
        end: { group: MAX_GROUP, object: 0n },
      };
    case LocationFilterType.AbsoluteStart:
      return { start, end: { group: MAX_GROUP, object: 0n } };
    case LocationFilterType.AbsoluteGroupEnd:
      return { start, end: { group: lastGroup, object: 0n } };
    case LocationFilterType.AbsoluteRange: {
      // An End of Object 2^64-1 is the whole Group, and +1 would not fit.
      const endObject = f.endObject ?? 0n;
      return {
        start,
        end: {
          group: lastGroup,
          object: endObject === MAX_GROUP ? 0n : endObject + 1n,
        },
      };
    }
  }
  throw new Error(
    `wire18: draft-18 FETCH cannot express a ${LocationFilterType[f.type]} range`,
  );
}

/** Group delivery order (Section 5.1.1). */
export enum GroupOrder {
  Ascending = 0x1,
  Descending = 0x2,
}

/** The subscriber priority a publisher assumes when the parameter is absent. */
export const DEFAULT_SUBSCRIBER_PRIORITY = 128;

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

const namespaceEncoder = new TextEncoder();

/**
 * Split the slash-joined string form of a namespace into its wire fields.
 *
 * Section 2.4.1 makes a Track Namespace a tuple, and Section 8.4 matches it a
 * field at a time, so sending "cmsf/clear" as a single field costs every relay
 * and namespace subscriber the ability to match the prefix ("cmsf") -- the
 * whole point of the structure. The player keeps the slash-joined string as a
 * namespace's identity, since that is what the track registry keys on and what
 * the UI shows, so the split belongs here at the wire boundary, where it is
 * the exact inverse of the join applied to everything received.
 *
 * Empty fields are dropped: Section 2.4.1 requires each field to carry at
 * least one byte.
 */
export function namespaceFields(namespace: string): Uint8Array[] {
  return namespace
    .split("/")
    .filter((field) => field.length > 0)
    .map((field) => namespaceEncoder.encode(field));
}
