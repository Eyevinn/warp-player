/**
 * MOQ Transport protocol version.
 *
 * This player speaks draft-18 and nothing else. Drafts 14 and 16 are gone for
 * the same reason `moqtransport` dropped them: from draft-17 the ALPN *is* the
 * version negotiation, and the wire below it changed enough — a different
 * variable-length integer encoding, a control stream pair in place of one
 * bidirectional stream, per-request streams — that carrying both would mean
 * maintaining two codecs rather than branching a few fields.
 */
export enum Version {
  DRAFT_18 = 0xff000012,
}

/** WebTransport subprotocol / ALPN string for draft-18. */
export const PROTOCOL_DRAFT_18 = "moqt-18";

/** Every protocol string this player will negotiate, in preference order. */
export const SUPPORTED_PROTOCOLS = [PROTOCOL_DRAFT_18];

/** Map a negotiated WebTransport subprotocol to its version. */
export function versionForProtocol(protocol: string | undefined): Version {
  if (protocol === PROTOCOL_DRAFT_18) {
    return Version.DRAFT_18;
  }
  throw new Error(
    `server negotiated ${protocol ? `"${protocol}"` : "no subprotocol"}; ` +
      `this player supports ${SUPPORTED_PROTOCOLS.join(", ")}`,
  );
}
