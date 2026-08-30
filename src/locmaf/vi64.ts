/**
 * MOQT vi64 varints, re-exported.
 *
 * The codec itself lives in `src/transport/vi64.ts`: vi64 is defined by
 * draft-ietf-moq-transport §1.4.1, so the transport owns it and LOCMAF is one
 * of its users rather than its home. This module keeps the import path LOCMAF
 * code and its golden-vector tests already use.
 */

export {
  VI64_MAX,
  VI64_MAX_LEN,
  type Vi64Read,
  encodeVi64,
  encodeZigzagVi64,
  readVi64,
  readZigzagVi64,
  vi64Len,
  vi64PeekLen,
} from "../transport/vi64";
