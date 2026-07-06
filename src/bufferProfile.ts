// Per-(engine × browser) buffer/latency defaults.
//
// The MSE pipeline and the WebCodecs pipeline have very different latency
// floors, and Safari's MSE clock is slower and prefers more lead buffer than
// Chrome's. Rather than a single global default, resolve the buffer target from
// the render engine actually chosen for the session and the browser.
//
// The table is a `base` plus an ordered list of `rules`. Each rule optionally
// matches an `engine` and/or a `browser`; a rule with a field omitted matches
// any value for that field. Rules are applied in order and later matches win,
// so list the most specific rule last. The whole table can be supplied (or
// extended) from config.json — see DEFAULT_BUFFER_PROFILES for the built-in.

import { Engine } from "./pipeline";

export type BrowserKind = "safari" | "other";

export interface BufferValues {
  minimalBuffer: number;
  targetLatency: number;
}

export interface BufferRule {
  engine?: Engine; // "mse" | "webcodecs"; omit to match any engine
  browser?: BrowserKind; // "safari" | "other"; omit to match any browser
  minimalBuffer?: number;
  targetLatency?: number;
}

export interface BufferProfiles {
  base: BufferValues;
  rules?: BufferRule[];
}

// Built-in default used when config.json does not supply `bufferProfiles`.
// 200/300ms works across all engines and browsers now that the latency
// controller samples on a fixed cadence. The rules list is the tuning hook:
// add e.g. { browser: "safari", engine: "mse", targetLatency: 600 } here or in
// config.json if a particular combination needs a different target.
export const DEFAULT_BUFFER_PROFILES: BufferProfiles = {
  base: { minimalBuffer: 200, targetLatency: 300 },
  rules: [],
};

/** Resolve the buffer values for a given engine + browser from a profile table. */
export function resolveBufferProfile(
  engine: Engine,
  browser: BrowserKind,
  profiles: BufferProfiles = DEFAULT_BUFFER_PROFILES,
): BufferValues {
  let minimalBuffer = profiles.base.minimalBuffer;
  let targetLatency = profiles.base.targetLatency;
  for (const rule of profiles.rules ?? []) {
    const engineMatches = rule.engine == null || rule.engine === engine;
    const browserMatches = rule.browser == null || rule.browser === browser;
    if (engineMatches && browserMatches) {
      if (typeof rule.minimalBuffer === "number") {
        minimalBuffer = rule.minimalBuffer;
      }
      if (typeof rule.targetLatency === "number") {
        targetLatency = rule.targetLatency;
      }
    }
  }
  return { minimalBuffer, targetLatency };
}
