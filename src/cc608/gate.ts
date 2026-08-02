// Where the CTA-608 caption sink goes, and whether extraction runs at all.
//
// Extracted from Player so the rule is a pure function with an explicit truth
// table rather than a sequence of side effects buried in DOM-heavy code. The
// player applies the result; this decides it.
//
// Two inputs are deliberately kept apart:
//
//   * `enabled` is the user's *intent* from the CC toggle. It persists across
//     track and namespace switches, so a detour through an uncaptioned track
//     does not silently discard the user's choice.
//   * `available` is whether the selected video track advertises the CTA-608
//     accessibility descriptor. It is a property of the stream.
//
// Captions are active only when both hold. The toggle gates **extraction as
// well as rendering** — see `Player.applyCaptionState`.

import { Engine } from "../pipeline";

export interface CaptionGateInput {
  /** The user's CC toggle intent. */
  enabled: boolean;
  /** Whether the selected video track advertises in-band CTA-608. */
  available: boolean;
  /** The engine currently playing, or null when nothing is playing. */
  engine: Engine | null;
}

export interface CaptionGateOutput {
  /**
   * Captions should be decoded and painted. Drives the overlay's enabled
   * state and both extractors' `setCc608Enabled`.
   */
  active: boolean;
  /** Install the caption sink on the MSE path (Player owns that extractor). */
  mseSink: boolean;
  /** Install the caption sink on the WebCodecs pipeline's extractor. */
  webcodecsSink: boolean;
}

/**
 * Resolve the caption gate.
 *
 * A sink goes only to the engine that is actually playing: each extractor is
 * fed exclusively by its own path, so installing on both would build a decoder
 * that never receives a sample. With no engine, no sink is installed anywhere —
 * which is also what teardown wants.
 */
export function resolveCaptionGate(input: CaptionGateInput): CaptionGateOutput {
  const active = input.enabled && input.available && input.engine !== null;
  return {
    active,
    mseSink: active && input.engine === "mse",
    webcodecsSink: active && input.engine === "webcodecs",
  };
}
