/**
 * MOQ Transport protocol versions.
 *
 * This player speaks draft-22 and draft-18, the two drafts the IETF 127
 * hackathon targets. From draft-17 the ALPN *is* the version negotiation, so
 * the WebTransport subprotocol the server picks decides the draft for the
 * whole session. Drafts 14 and 16 are gone for the same reason `moqtransport`
 * dropped them: the wire below the ALPN changed enough -- a different
 * variable-length integer encoding, a control stream pair in place of one
 * bidirectional stream, per-request streams -- that carrying them would mean
 * maintaining a second codec rather than branching a few fields. Draft-18 to
 * draft-22 is the second kind of change, so both live in one codec.
 */
export enum Version {
  DRAFT_18 = 0xff000012,
  DRAFT_22 = 0xff000016,
}

/** WebTransport subprotocol / ALPN string for draft-18. */
export const PROTOCOL_DRAFT_18 = "moqt-18";

/** WebTransport subprotocol / ALPN string for draft-22. */
export const PROTOCOL_DRAFT_22 = "moqt-22";

/** Every protocol string this player will negotiate, in preference order. */
export const SUPPORTED_PROTOCOLS = [PROTOCOL_DRAFT_22, PROTOCOL_DRAFT_18];

/** The draft selector's values: "auto" offers every supported draft. */
export type DraftVersion = "auto" | "draft-18" | "draft-22";

/** The protocol strings to offer for a draft selection, in preference order. */
export function protocolsForDraft(draft: DraftVersion = "auto"): string[] {
  switch (draft) {
    case "draft-18":
      return [PROTOCOL_DRAFT_18];
    case "draft-22":
      return [PROTOCOL_DRAFT_22];
    default:
      return [...SUPPORTED_PROTOCOLS];
  }
}

/** Map a negotiated WebTransport subprotocol to its version. */
export function versionForProtocol(protocol: string | undefined): Version {
  if (protocol === PROTOCOL_DRAFT_22) {
    return Version.DRAFT_22;
  }
  if (protocol === PROTOCOL_DRAFT_18) {
    return Version.DRAFT_18;
  }
  throw new Error(
    `server negotiated ${protocol ? `"${protocol}"` : "no subprotocol"}; ` +
      `this player supports ${SUPPORTED_PROTOCOLS.join(", ")}`,
  );
}

/** The draft's name as the UI and the interop runner write it. */
export function draftName(version: Version): string {
  return version === Version.DRAFT_22 ? "draft-22" : "draft-18";
}
