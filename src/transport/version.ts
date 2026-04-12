/** MOQ Transport protocol version constants */
export enum Version {
  DRAFT_11 = 0xff00000b,
  DRAFT_14 = 0xff00000e,
  DRAFT_16 = 0xff000010,
}

/** WebTransport protocol strings for version negotiation */
export const PROTOCOL_DRAFT_14 = "moq-00";
export const PROTOCOL_DRAFT_16 = "moqt-16";

/** Draft-16+ uses ALPN/protocol negotiation instead of in-band SETUP version fields */
export function isDraft16(v: Version | number): boolean {
  return v >= Version.DRAFT_16;
}
