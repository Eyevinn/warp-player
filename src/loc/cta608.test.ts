import { CC608_COLS, Cc608Sink, Cc608Snapshot } from "../cc608/types";
import { ILogger } from "../logger";

import {
  CTA608_PROBE_SAMPLES,
  LocCta608Extractor,
  codecCanCarryCta608,
} from "./cta608";

/* ------------------------------------------------------------------ */
/* Test doubles                                                        */
/* ------------------------------------------------------------------ */

const noop = (): void => undefined;

function nullLogger(): ILogger {
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    getCategory: () => "test",
    setLevel: noop,
  };
}

interface Push {
  timeMs: number;
  screen: Cc608Snapshot | null;
}

class RecordingSink implements Cc608Sink {
  readonly pushes: Push[] = [];
  push(timeMs: number, screen: Cc608Snapshot | null): void {
    this.pushes.push({ timeMs, screen });
  }
  /** Pushes that carry a screen (i.e. not overlay clears). */
  get screens(): Push[] {
    return this.pushes.filter((p) => p.screen !== null);
  }
}

/* ------------------------------------------------------------------ */
/* Synthetic LOC video samples                                         */
/* ------------------------------------------------------------------ */

/** CTA-608 control codes on channel 1, field 1 (unparitied). */
const RCL: CcPair = [0x14, 0x20]; // Resume Caption Loading (pop-on)
const ENM: CcPair = [0x14, 0x2e]; // Erase Non-displayed Memory
const EDM: CcPair = [0x14, 0x2c]; // Erase Displayed Memory
const EOC: CcPair = [0x14, 0x2f]; // End Of Caption (flip)
/** PAC: row 15, white, no underline / with underline. */
const PAC_R15: CcPair = [0x14, 0x60];
const PAC_R15_UNDERLINE: CcPair = [0x14, 0x61];

type CcPair = [number, number];

/** Wrap raw NAL bytes in a 4-byte length prefix. */
function lengthPrefixed(nal: number[]): number[] {
  const n = nal.length;
  return [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
    ...nal,
  ];
}

/**
 * Build a CTA-608 SEI NAL unit (registered ITU-T T.35 user data, ATSC A/53
 * cc_data) carrying `pairs` on field 1 (cc_type 0).
 */
function cta608SeiNal(pairs: CcPair[], codec: "avc" | "hevc"): number[] {
  const cc: number[] = [];
  for (const [d1, d2] of pairs) {
    cc.push(0xfc, d1, d2); // marker bits + cc_valid + cc_type 0 (field 1)
  }
  const payload = [
    0xb5, // itu_t_t35_country_code = 181 (USA)
    0x00,
    0x31, // itu_t_t35_provider_code = 49
    0x47,
    0x41,
    0x39,
    0x34, // user_identifier "GA94"
    0x03, // user_data_type_code = cc_data
    0xc0 | pairs.length, // process_cc_data_flag + cc_count
    0xff, // em_data
    ...cc,
    0xff, // marker bits
  ];
  const header = codec === "avc" ? [0x06] : [0x4e, 0x01]; // AVC SEI / HEVC prefix SEI
  return [
    ...header,
    0x04, // payloadType = user_data_registered_itu_t_t35
    payload.length,
    ...payload,
    0x80, // rbsp_trailing_bits
  ];
}

/** A non-SEI coded-slice NAL, so the walker has to skip something. */
function sliceNal(codec: "avc" | "hevc"): number[] {
  return codec === "avc"
    ? [0x65, 0x88, 0x84, 0x21, 0x0a]
    : [0x02, 0x01, 0xd0, 0x09, 0x7e];
}

/** One LOC video object: length-prefixed slice + optional 608 SEI. */
function sample(pairs: CcPair[] | null, codec: "avc" | "hevc"): Uint8Array {
  const bytes = [...lengthPrefixed(sliceNal(codec))];
  if (pairs && pairs.length > 0) {
    bytes.push(...lengthPrefixed(cta608SeiNal(pairs, codec)));
  }
  return new Uint8Array(bytes);
}

/** Text of a snapshot row, trailing padding trimmed. */
function rowText(screen: Cc608Snapshot, index: number): string {
  return screen.rows[index].cells
    .map((c) => c.uchar)
    .join("")
    .replace(/\s+$/, "");
}

function makeExtractor(
  sink: Cc608Sink,
  codec: string,
  extra: Partial<{ enabled: () => boolean; probeSamples: number }> = {},
): LocCta608Extractor {
  return new LocCta608Extractor({
    sink,
    logger: nullLogger(),
    codec,
    ...extra,
  });
}

const CODECS: Array<{ label: string; codec: string; kind: "avc" | "hevc" }> = [
  { label: "AVC", codec: "avc1.4D401F", kind: "avc" },
  { label: "HEVC", codec: "hvc1.1.6.L93.B0", kind: "hevc" },
];

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("codecCanCarryCta608", () => {
  it("accepts AVC and HEVC and rejects everything else", () => {
    expect(codecCanCarryCta608("avc1.4D401F")).toBe(true);
    expect(codecCanCarryCta608("avc3.4D401F")).toBe(true);
    expect(codecCanCarryCta608("hvc1.1.6.L93.B0")).toBe(true);
    expect(codecCanCarryCta608("hev1.1.6.L93.B0")).toBe(true);
    expect(codecCanCarryCta608("av01.0.04M.08")).toBe(false);
    expect(codecCanCarryCta608("vp09.00.10.08")).toBe(false);
    expect(codecCanCarryCta608(undefined)).toBe(false);
    expect(codecCanCarryCta608("")).toBe(false);
  });
});

describe.each(CODECS)("LocCta608Extractor ($label)", ({ codec, kind }) => {
  /** A pop-on caption "HI" on row 15, spread over three samples. */
  function feedPopOnCaption(ext: LocCta608Extractor, startUs = 0): number {
    const frameUs = 40_000;
    ext.addVideoSample(startUs, sample([RCL, ENM], kind));
    ext.addVideoSample(
      startUs + frameUs,
      sample([PAC_R15, [0x48, 0x49]], kind),
    );
    ext.addVideoSample(startUs + 2 * frameUs, sample([EOC], kind));
    return startUs + 2 * frameUs;
  }

  it("emits the caption on the sample that completes the flip", () => {
    const sink = new RecordingSink();
    const ext = makeExtractor(sink, codec);
    const flipUs = feedPopOnCaption(ext);

    expect(sink.screens).toHaveLength(1);
    const push = sink.screens[0];
    // Timestamped from the sample carrying the EOC, in ms — not from
    // newCue's (unusable) start/end times.
    expect(push.timeMs).toBeCloseTo(flipUs / 1000, 6);
    const screen = push.screen as Cc608Snapshot;
    expect(screen.rows).toHaveLength(1);
    // Row 15 in 608 numbering is index 14.
    expect(screen.rows[0].row).toBe(14);
    expect(rowText(screen, 0)).toBe("HI");
  });

  it("clears the overlay while no caption is displayed", () => {
    const sink = new RecordingSink();
    const ext = makeExtractor(sink, codec);
    ext.addVideoSample(0, sample([RCL, ENM], kind));

    expect(sink.pushes).toHaveLength(1);
    expect(sink.pushes[0]).toEqual({ timeMs: 0, screen: null });
  });

  it("dedupes an unchanged screen across subsequent samples", () => {
    const sink = new RecordingSink();
    const ext = makeExtractor(sink, codec);
    feedPopOnCaption(ext);
    const pushesAfterFlip = sink.pushes.length;

    // Ten further frames with no cc_data at all: the screen is unchanged,
    // so nothing new must reach the sink.
    for (let i = 1; i <= 10; i++) {
      ext.addVideoSample(120_000 + i * 40_000, sample(null, kind));
    }
    expect(sink.pushes).toHaveLength(pushesAfterFlip);
  });

  it("pushes a clear when the caption is erased", () => {
    const sink = new RecordingSink();
    const ext = makeExtractor(sink, codec);
    feedPopOnCaption(ext);
    ext.addVideoSample(200_000, sample([EDM], kind));
    // The clear lands on the EDM sample itself. Cc608Source captures only the
    // cues raised *during* cueSplitAtTime, so cml's own late newCue — which
    // hands over the screen that was just erased — cannot mask the fact that
    // the live screen is now empty.
    const afterEdm = sink.pushes.length;

    // A further empty sample must not push again: the null is deduped.
    ext.addVideoSample(240_000, sample(null, kind));
    expect(sink.pushes).toHaveLength(afterEdm);

    const last = sink.pushes[sink.pushes.length - 1];
    expect(last.screen).toBeNull();
    expect(last.timeMs).toBeCloseTo(200, 6);
  });

  it("re-emits a screen that returns after a clear", () => {
    const sink = new RecordingSink();
    const ext = makeExtractor(sink, codec);
    feedPopOnCaption(ext);
    ext.addVideoSample(200_000, sample([EDM], kind));
    feedPopOnCaption(ext, 240_000);

    expect(sink.screens).toHaveLength(2);
    expect(rowText(sink.screens[1].screen as Cc608Snapshot, 0)).toBe("HI");
  });

  it("keeps exactly CC608_COLS cells per row (cml's Row is 100 wide)", () => {
    const sink = new RecordingSink();
    const ext = makeExtractor(sink, codec);
    feedPopOnCaption(ext);

    const screen = sink.screens[0].screen as Cc608Snapshot;
    expect(CC608_COLS).toBe(32);
    expect(screen.rows[0].cells).toHaveLength(CC608_COLS);
  });

  it("treats a default-styled space as an empty cell", () => {
    const sink = new RecordingSink();
    const ext = makeExtractor(sink, codec);
    // Two spaces (0x20 0x20) in the default pen: cml's isEmpty() cannot tell
    // them from untouched cells, so the row is not recorded and the screen
    // stays empty.
    ext.addVideoSample(0, sample([RCL, ENM], kind));
    ext.addVideoSample(40_000, sample([PAC_R15, [0x20, 0x20]], kind));
    ext.addVideoSample(80_000, sample([EOC], kind));

    expect(sink.screens).toHaveLength(0);
  });

  it("records a row whose only content is the pen stamped by setPAC", () => {
    const sink = new RecordingSink();
    const ext = makeExtractor(sink, codec);
    // A PAC with underline stamps a non-default pen onto the cell under the
    // cursor before any character is written, so the row becomes non-empty
    // even though nothing was typed.
    ext.addVideoSample(0, sample([RCL, ENM], kind));
    ext.addVideoSample(40_000, sample([PAC_R15_UNDERLINE], kind));
    ext.addVideoSample(80_000, sample([EOC], kind));

    expect(sink.screens).toHaveLength(1);
    const screen = sink.screens[0].screen as Cc608Snapshot;
    expect(screen.rows[0].row).toBe(14);
    expect(screen.rows[0].cells[0]).toEqual({
      uchar: " ",
      pen: {
        foreground: "white",
        background: "black",
        underline: true,
        italics: false,
        flash: false,
      },
    });
    expect(rowText(screen, 0)).toBe("");
  });

  it("copies the screen instead of retaining cml's reused CaptionScreen", () => {
    const sink = new RecordingSink();
    const ext = makeExtractor(sink, codec);
    feedPopOnCaption(ext);
    const first = sink.screens[0].screen as Cc608Snapshot;

    // A second, different caption. The library hands out the same mutated
    // CaptionScreen object, so a retained reference would now read "OK".
    ext.addVideoSample(200_000, sample([EDM], kind));
    ext.addVideoSample(240_000, sample([RCL, ENM], kind));
    ext.addVideoSample(280_000, sample([PAC_R15, [0x4f, 0x4b]], kind));
    ext.addVideoSample(320_000, sample([EOC], kind));

    expect(rowText(sink.screens[1].screen as Cc608Snapshot, 0)).toBe("OK");
    expect(rowText(first, 0)).toBe("HI");
  });

  it("drops 608 state on reset so a stale caption cannot be flipped", () => {
    const sink = new RecordingSink();
    const ext = makeExtractor(sink, codec);
    // Preload a caption into non-displayed memory, then hit a discontinuity
    // before the EOC arrives — the mid-group join case.
    ext.addVideoSample(0, sample([RCL, ENM], kind));
    ext.addVideoSample(40_000, sample([PAC_R15, [0x48, 0x49]], kind));
    ext.reset();
    ext.addVideoSample(80_000, sample([EOC], kind));

    expect(sink.screens).toHaveLength(0);
  });

  it("resets first-sight detection so a dormant track is re-probed", () => {
    const sink = new RecordingSink();
    const ext = makeExtractor(sink, codec, { probeSamples: 5 });
    for (let i = 0; i < 5; i++) {
      ext.addVideoSample(i * 40_000, sample(null, kind));
    }
    expect(ext.scanning).toBe(false);

    ext.reset();
    expect(ext.scanning).toBe(true);
    feedPopOnCaption(ext, 400_000);
    expect(sink.screens).toHaveLength(1);
  });
});

describe("LocCta608Extractor gating", () => {
  it("never scans an AV1 track", () => {
    const sink = new RecordingSink();
    const ext = makeExtractor(sink, "av01.0.04M.08");
    expect(ext.scanning).toBe(false);
    // AV1 objects are raw OBUs, not length-prefixed NALUs — scanning them
    // would be meaningless as well as wasteful.
    ext.addVideoSample(0, sample([RCL, ENM], "avc"));
    ext.addVideoSample(40_000, sample([PAC_R15, [0x48, 0x49]], "avc"));
    ext.addVideoSample(80_000, sample([EOC], "avc"));
    expect(sink.pushes).toHaveLength(0);
  });

  it("goes dormant on a track with no captions", () => {
    const sink = new RecordingSink();
    const ext = makeExtractor(sink, "avc1.4D401F", { probeSamples: 3 });
    for (let i = 0; i < 3; i++) {
      expect(ext.scanning).toBe(true);
      ext.addVideoSample(i * 40_000, sample(null, "avc"));
    }
    expect(ext.scanning).toBe(false);

    // Captions appearing after the probe window are ignored — no per-frame
    // scanning cost remains on a track deemed uncaptioned.
    const before = sink.pushes.length;
    ext.addVideoSample(120_000, sample([RCL, ENM], "avc"));
    ext.addVideoSample(160_000, sample([PAC_R15, [0x48, 0x49]], "avc"));
    ext.addVideoSample(200_000, sample([EOC], "avc"));
    expect(sink.pushes).toHaveLength(before);
  });

  it("stays awake as long as captions keep arriving", () => {
    const sink = new RecordingSink();
    const ext = makeExtractor(sink, "avc1.4D401F", { probeSamples: 2 });
    ext.addVideoSample(0, sample([RCL, ENM], "avc"));
    ext.addVideoSample(40_000, sample([PAC_R15, [0x48, 0x49]], "avc"));
    ext.addVideoSample(80_000, sample([EOC], "avc"));
    expect(ext.scanning).toBe(true);
    expect(sink.screens).toHaveLength(1);
  });

  it("uses a probe window covering several seconds by default", () => {
    expect(CTA608_PROBE_SAMPLES).toBeGreaterThanOrEqual(100);
  });

  it("does nothing while the CC toggle is off, and re-probes when it flips on", () => {
    const sink = new RecordingSink();
    let on = false;
    const ext = makeExtractor(sink, "avc1.4D401F", { enabled: () => on });

    expect(ext.scanning).toBe(false);
    ext.addVideoSample(0, sample([RCL, ENM], "avc"));
    ext.addVideoSample(40_000, sample([PAC_R15, [0x48, 0x49]], "avc"));
    ext.addVideoSample(80_000, sample([EOC], "avc"));
    expect(sink.pushes).toHaveLength(0);

    on = true;
    expect(ext.scanning).toBe(true);
    ext.addVideoSample(120_000, sample([RCL, ENM], "avc"));
    ext.addVideoSample(160_000, sample([PAC_R15, [0x4f, 0x4b]], "avc"));
    ext.addVideoSample(200_000, sample([EOC], "avc"));
    expect(sink.screens).toHaveLength(1);
    expect(rowText(sink.screens[0].screen as Cc608Snapshot, 0)).toBe("OK");
  });

  it("clears the overlay once when the CC toggle is turned off", () => {
    const sink = new RecordingSink();
    let on = true;
    const ext = makeExtractor(sink, "avc1.4D401F", { enabled: () => on });
    ext.addVideoSample(0, sample([RCL, ENM], "avc"));
    ext.addVideoSample(40_000, sample([PAC_R15, [0x48, 0x49]], "avc"));
    ext.addVideoSample(80_000, sample([EOC], "avc"));
    expect(sink.screens).toHaveLength(1);

    on = false;
    ext.addVideoSample(120_000, sample(null, "avc"));
    ext.addVideoSample(160_000, sample(null, "avc"));
    const clears = sink.pushes.filter((p) => p.screen === null);
    expect(clears[clears.length - 1].timeMs).toBeCloseTo(120, 6);
    expect(sink.pushes[sink.pushes.length - 1].screen).toBeNull();
    // Only one clear for the toggle-off, not one per frame.
    expect(sink.pushes.filter((p) => p.timeMs === 160).length).toBe(0);
  });

  it("ignores empty payloads", () => {
    const sink = new RecordingSink();
    const ext = makeExtractor(sink, "avc1.4D401F");
    ext.addVideoSample(0, new Uint8Array(0));
    expect(sink.pushes).toHaveLength(0);
  });
});

describe("AVC and HEVC agree", () => {
  it("produces identical snapshots for the same cc_data", () => {
    const avcSink = new RecordingSink();
    const hevcSink = new RecordingSink();
    const avc = makeExtractor(avcSink, "avc1.4D401F");
    const hevc = makeExtractor(hevcSink, "hvc1.1.6.L93.B0");

    const script: Array<CcPair[] | null> = [
      [RCL, ENM],
      [PAC_R15, [0x48, 0x49]],
      [EOC],
      null,
      [EDM],
    ];
    script.forEach((pairs, i) => {
      avc.addVideoSample(i * 40_000, sample(pairs, "avc"));
      hevc.addVideoSample(i * 40_000, sample(pairs, "hevc"));
    });

    expect(hevcSink.pushes).toEqual(avcSink.pushes);
    expect(avcSink.screens).toHaveLength(1);
  });
});
