/**
 * Reading a FETCH response stream (draft-18 Section 11.4.4).
 *
 * draft-18 rewrote this completely. Every FETCH record now begins with
 * Serialization Flags that say which fields are on the wire at all, and almost
 * everything else is expressed as "same as the prior Object" or a delta against
 * it — so a reader cannot decode a record without the state left by the ones
 * before it, and cannot decode Group IDs at all without knowing the Group Order
 * the FETCH was answered in.
 */

import { Reader } from "./stream";
import { GroupOrder } from "./wire18";

/**
 * Serialization Flags below 128 are a bitfield. At or above it, only the End of
 * Range indicators of Table 7 are defined and anything else is a
 * PROTOCOL_VIOLATION.
 */
const FETCH_SUBGROUP_MODE_MASK = 0x03n;
const FETCH_FLAG_OBJECT_ID_DELTA = 0x04n;
const FETCH_FLAG_GROUP_ID_DELTA = 0x08n;
const FETCH_FLAG_PRIORITY = 0x10n;
const FETCH_FLAG_PROPERTIES = 0x20n;
const FETCH_FLAG_DATAGRAM = 0x40n;
const FETCH_SERIALIZATION_FLAG_MAX = 0x7fn;

/** The two-bit Subgroup encoding. Unlike a subgroup stream's, all four are defined. */
const enum FetchSubgroupMode {
  Zero = 0x0,
  Prior = 0x1,
  PriorPlusOne = 0x2,
  Explicit = 0x3,
}

/**
 * What an End of Range indicator says about the Objects it covers: everything
 * between the previous serialized Object and this Location, inclusive.
 */
export const enum EndOfRange {
  None = 0,
  /** The covered Objects are known not to exist. */
  NonExistent = 0x8c,
  /** The publisher cannot determine their status. */
  Unknown = 0x10c,
}

/** One record on a FETCH stream: an Object, or an End of Range indicator. */
export interface FetchObject {
  groupId: bigint;
  subgroupId: bigint;
  objectId: bigint;
  priority: number;
  properties?: Uint8Array;
  payload: Uint8Array;
  endOfRange: EndOfRange;
  /** The Object's Forwarding Preference is Datagram, so it has no Subgroup ID. */
  datagram: boolean;
}

/**
 * Reads records from a stream opened with FETCH_HEADER.
 *
 * The delta encoding refers to two different "prior Objects": Group ID and
 * Object ID advance past an End of Range indicator, while Subgroup ID and
 * Priority carry over from the last *actual* Object, skipping indicators
 * entirely (Section 11.4.4.2). Both are tracked here.
 */
export class FetchStreamReader {
  #r: Reader;
  #groupOrder: GroupOrder;

  #priorGroupId = 0n;
  #priorObjectId = 0n;
  #havePrior = false;

  #priorSubgroupId = 0n;
  #priorPriority = 0;
  #havePriorObject = false;

  constructor(r: Reader, groupOrder: GroupOrder = GroupOrder.Ascending) {
    this.#r = r;
    this.#groupOrder = groupOrder;
  }

  /** Read the next record, or null when the stream ends cleanly between records. */
  async next(): Promise<FetchObject | null> {
    if (await this.#r.done()) {
      return null;
    }
    const flags = await this.#r.u62();

    if (flags > FETCH_SERIALIZATION_FLAG_MAX) {
      return this.#readEndOfRange(Number(flags) as EndOfRange);
    }

    const datagram = (flags & FETCH_FLAG_DATAGRAM) !== 0n;
    const hasGroupDelta = (flags & FETCH_FLAG_GROUP_ID_DELTA) !== 0n;
    const hasObjectDelta = (flags & FETCH_FLAG_OBJECT_ID_DELTA) !== 0n;

    // The first record must carry both deltas: there is no prior Object for
    // anything else to refer to.
    if (!this.#havePrior && (!hasGroupDelta || !hasObjectDelta)) {
      throw new Error("FETCH: first object must carry both ID deltas");
    }

    let groupId: bigint;
    if (hasGroupDelta) {
      groupId = this.#resolveGroupId(await this.#r.u62());
    } else {
      groupId = this.#priorGroupId;
    }

    // The Subgroup ID field sits between the two deltas on the wire, even
    // though the Object ID depends on the Group ID Delta.
    let mode = Number(flags & FETCH_SUBGROUP_MODE_MASK) as FetchSubgroupMode;
    if (datagram) {
      // A Datagram Object has no Subgroup ID and the mode bits are to be
      // ignored, so no field is read whatever they say.
      mode = FetchSubgroupMode.Zero;
    }
    let subgroupId = 0n;
    switch (mode) {
      case FetchSubgroupMode.Zero:
        subgroupId = 0n;
        break;
      case FetchSubgroupMode.Prior:
      case FetchSubgroupMode.PriorPlusOne:
        if (!this.#havePriorObject) {
          throw new Error(
            "FETCH: subgroup mode refers to a prior object, none seen",
          );
        }
        subgroupId =
          this.#priorSubgroupId +
          (mode === FetchSubgroupMode.PriorPlusOne ? 1n : 0n);
        break;
      case FetchSubgroupMode.Explicit:
        subgroupId = await this.#r.u62();
        break;
    }

    let objectId: bigint;
    if (hasObjectDelta) {
      const delta = await this.#r.u62();
      // A new Group restarts numbering, so the delta is the absolute Object ID;
      // within a Group it is added to the prior ID. Note it is added as-is,
      // unlike a subgroup stream's delta, which is plus one.
      objectId = hasGroupDelta ? delta : this.#priorObjectId + delta;
    } else {
      objectId = this.#priorObjectId + 1n;
    }

    let priority: number;
    if ((flags & FETCH_FLAG_PRIORITY) !== 0n) {
      priority = await this.#r.u8();
    } else {
      if (!this.#havePriorObject) {
        throw new Error(
          "FETCH: priority inherited from a prior object, none seen",
        );
      }
      priority = this.#priorPriority;
    }

    let properties: Uint8Array | undefined;
    if ((flags & FETCH_FLAG_PROPERTIES) !== 0n) {
      const length = await this.#r.u62();
      if (length > 0n) {
        properties = await this.#r.read(Number(length));
      }
    }

    const payloadLen = await this.#r.u62();
    const payload =
      payloadLen > 0n
        ? await this.#r.read(Number(payloadLen))
        : new Uint8Array();

    const obj: FetchObject = {
      groupId,
      subgroupId,
      objectId,
      priority,
      properties,
      payload,
      endOfRange: EndOfRange.None,
      datagram,
    };
    this.#remember(obj);
    return obj;
  }

  /**
   * Read the Location of an End of Range indicator: Serialization Flags
   * followed by a Group ID and an Object ID, and nothing else.
   *
   * Two readings here are not stated by the draft and were settled against
   * other implementations:
   *
   * - **The two IDs are absolute, not deltas.** Section 11.4.4.2 names them
   *   "the Group ID and Object ID fields" where 11.4.4.1 is careful to say
   *   "Group ID Delta" everywhere, and the delta reading makes the common case
   *   — an indicator covering Objects in the Group it follows — inexpressible,
   *   since an ascending Group ID Delta always advances at least one Group.
   *
   * - **No Object Payload Length is written.** Section 11.4.4.2 does not name
   *   it among the fields it removes and Figure 27 has it unbracketed, which
   *   reads like it stays — but moxygen, quiche, moqtail, moq-go and aiomoqt
   *   all resume at the next record's Serialization Flags, so reading a length
   *   here desynchronises against every one of them.
   */
  async #readEndOfRange(kind: EndOfRange): Promise<FetchObject> {
    if (kind !== EndOfRange.NonExistent && kind !== EndOfRange.Unknown) {
      throw new Error(
        `FETCH: invalid serialization flags 0x${kind.toString(16)}`,
      );
    }
    const groupId = await this.#r.u62();
    const objectId = await this.#r.u62();

    // Only the Location advances: Subgroup ID and Priority still refer to the
    // last real Object.
    this.#priorGroupId = groupId;
    this.#priorObjectId = objectId;
    this.#havePrior = true;

    return {
      groupId,
      subgroupId: this.#priorSubgroupId,
      objectId,
      priority: this.#priorPriority,
      payload: new Uint8Array(),
      endOfRange: kind,
      datagram: false,
    };
  }

  /** Apply a Group ID Delta in the direction the Group Order says. */
  #resolveGroupId(delta: bigint): bigint {
    if (!this.#havePrior) {
      return delta;
    }
    if (this.#groupOrder === GroupOrder.Descending) {
      if (delta >= this.#priorGroupId) {
        throw new Error("FETCH: descending group ID delta underflows");
      }
      return this.#priorGroupId - delta - 1n;
    }
    return this.#priorGroupId + delta + 1n;
  }

  #remember(obj: FetchObject): void {
    this.#priorGroupId = obj.groupId;
    this.#priorObjectId = obj.objectId;
    this.#havePrior = true;
    this.#priorSubgroupId = obj.subgroupId;
    this.#priorPriority = obj.priority;
    this.#havePriorObject = true;
  }
}
