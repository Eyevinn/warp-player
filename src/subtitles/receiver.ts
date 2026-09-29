/**
 * One subtitle track, from MoQ objects to timed cues: the receiver side of
 * paint-model subtitles (https://github.com/Eyevinn/paint-model-subtitles).
 *
 * The algorithm, per sample, after taking every sample's time from its own
 * chunk (tfdt plus the durations before it):
 *
 *  - `stpp`: parse the document and show it over the sample. Every sample is
 *    parsed; that is what plain `stpp` costs.
 *  - `stpc`: a full document is parsed and its presentation states stored
 *    with their own times; a `ttmb` body is spliced into the group's first
 *    document and parsed the same way; a `ttmn` parses nothing and shows the
 *    stored states again. Each sample shows a copy clipped to its own
 *    interval, so the result stays right even if an encoder repeated a
 *    document carrying an `end`.
 *  - `wvtt`: parse the cue boxes and show them over the sample.
 *  - `wvtc`: a `vttn` shows the previous sample's cues again over the new
 *    sample; a `vtte` clears, so there is nothing to continue.
 *
 * The receiver gates on the sample entry of the init segment, never on the
 * codecs string, and counts what it parses: that count is the point of the
 * paint model.
 *
 * A dependent sample (`ttmn`, `ttmb`, `vttn`) needs an earlier sample of the
 * same MoQ group, as it needs an earlier chunk of the same segment. A group
 * whose first object was lost therefore shows nothing until the next group.
 */
import {
  createLocmafTrackState,
  type LocmafTrackState,
} from "../locmaf/locmaf";
import { decodeObject } from "../locmaf/v03/decoder";

import {
  parseCmafSamples,
  sampleEntryType,
  wholeSampleBoxType,
  type TextSample,
} from "./mp4";
import { parseTtml, spliceBody, type TtmlInterval } from "./ttml";
import type { SubtitleCue, TtmlCue, VttCue } from "./types";
import { parseVttCueText, parseVttSample, parseVttSettings } from "./webvtt";

/** The text sample entries this receiver understands. */
export const SUBTITLE_SAMPLE_ENTRIES = [
  "stpp",
  "stpc",
  "wvtt",
  "wvtc",
] as const;
export type SubtitleSampleEntry = (typeof SUBTITLE_SAMPLE_ENTRIES)[number];

/** Where cues go. Called once per cue per sample, clipped to the sample. */
export type SubtitleCueSink = (
  startMs: number,
  endMs: number,
  cue: SubtitleCue,
) => void;

/** What a receiver has received and parsed. */
export interface SubtitleStats {
  /** MoQ objects and their payload bytes, as received. */
  objects: number;
  bytes: number;
  samples: number;
  /** Media time covered by the received samples. */
  mediaMs: number;
  /** TTML documents parsed (full documents plus spliced ttmb bodies). */
  documentsParsed: number;
  /** Of documentsParsed, those rebuilt from a ttmb body. */
  bodySplices: number;
  /** UTF-8 bytes of TTML handed to the parser. */
  xmlBytesParsed: number;
  /** WebVTT cue boxes parsed. */
  cueBoxesParsed: number;
  /** ttmn and vttn samples: shown again without parsing. */
  noChangeSamples: number;
  /** Time spent parsing documents and cue boxes, in ms. */
  parseMs: number;
  /** Samples that could not be shown: missing reference, bad data. */
  droppedSamples: number;
  /** Objects that could not be decoded, such as LOCMAF deltas after a loss. */
  droppedObjects: number;
}

export interface SubtitleObject {
  location: { group: bigint; object: bigint };
  data: Uint8Array;
}

export interface SubtitleReceiverOptions {
  /** The raw CMAF init segment (the catalog init data). */
  initSegment: Uint8Array;
  packaging: "cmaf" | "locmaf";
  /** LOCMAF packaging version from the catalog; checked for LOCMAF tracks. */
  locmafVersion?: string;
  sink?: SubtitleCueSink | null;
  /** Clock for parse timing; performance.now by default. */
  now?: () => number;
  /** Diagnostic hook for dropped objects and samples. */
  onWarning?: (msg: string) => void;
}

const utf8 = new TextDecoder("utf-8");

/** Interned cue payloads are forgotten after this long without use. */
const INTERN_TTL_MS = 30_000;

export class SubtitleTrackReceiver {
  readonly sampleEntry: SubtitleSampleEntry;
  private readonly packaging: "cmaf" | "locmaf";
  private readonly locmaf: LocmafTrackState;
  private sink: SubtitleCueSink | null;
  private readonly now: () => number;
  private readonly warn: (msg: string) => void;
  private readonly stats: SubtitleStats = {
    objects: 0,
    bytes: 0,
    samples: 0,
    mediaMs: 0,
    documentsParsed: 0,
    bodySplices: 0,
    xmlBytesParsed: 0,
    cueBoxesParsed: 0,
    noChangeSamples: 0,
    parseMs: 0,
    droppedSamples: 0,
    droppedObjects: 0,
  };

  /** The MoQ group being received; dependent samples never cross it. */
  private group: bigint | null = null;
  /** stpc: the group's first document, which ttmb bodies are spliced into. */
  private headDocument: string | null = null;
  /** stpc: the presentation states of the last parsed document, unclipped. */
  private stored: { interval: TtmlInterval; cue: TtmlCue }[] | null = null;
  /** wvtc: the cues of the previous sample. */
  private previousVtt: VttCue[] | null = null;
  /** End of the latest sample, the clock for forgetting interned payloads. */
  private lastSampleEndMs = 0;

  /** Payloads by content, so a continuing cue is the same object. */
  private readonly interned = new Map<
    string,
    { cue: SubtitleCue; lastMs: number }
  >();

  constructor(options: SubtitleReceiverOptions) {
    const entry = sampleEntryType(options.initSegment);
    if (
      !entry ||
      !(SUBTITLE_SAMPLE_ENTRIES as readonly string[]).includes(entry)
    ) {
      throw new Error(
        `not a subtitle track: sample entry ${entry ?? "(none)"}`,
      );
    }
    this.sampleEntry = entry as SubtitleSampleEntry;
    this.packaging = options.packaging;
    // The LOCMAF track state also carries the init context (timescale and
    // trex defaults) that plain CMAF chunks need.
    this.locmaf = createLocmafTrackState(
      { name: "subtitles", locmafVersion: options.locmafVersion },
      options.initSegment,
    );
    this.sink = options.sink ?? null;
    this.now = options.now ?? (() => performance.now());
    this.warn = options.onWarning ?? (() => undefined);
  }

  /** True for the paint-model sample entries. */
  get isPaintModel(): boolean {
    return this.sampleEntry === "stpc" || this.sampleEntry === "wvtc";
  }

  /** Start or stop handing cues to a sink. Parsing and counting go on regardless. */
  setSink(sink: SubtitleCueSink | null): void {
    this.sink = sink;
  }

  getStats(): Readonly<SubtitleStats> {
    return { ...this.stats };
  }

  /** Receive one MoQ object of the track. */
  receiveObject(obj: SubtitleObject): void {
    this.stats.objects++;
    this.stats.bytes += obj.data.length;
    if (obj.data.length === 0) {
      return; // An object status such as end of group.
    }
    if (obj.location.group !== this.group) {
      this.startGroup(obj.location.group);
    }
    let samples: TextSample[];
    try {
      samples = this.samplesOf(obj.data);
    } catch (err) {
      this.stats.droppedObjects++;
      this.warn(
        `subtitles: dropping object ${obj.location.group}/${obj.location.object}: ${String(err)}`,
      );
      this.dropGroupState();
      return;
    }
    for (const sample of samples) {
      this.stats.samples++;
      this.stats.mediaMs += sample.endMs - sample.startMs;
      try {
        this.processSample(sample);
      } catch (err) {
        this.stats.droppedSamples++;
        this.warn(
          `subtitles: dropping sample at ${sample.startMs} ms: ${String(err)}`,
        );
        this.dropGroupState();
      }
    }
  }

  private startGroup(group: bigint): void {
    this.group = group;
    this.dropGroupState();
    this.locmaf.group.reset();
    const oldest = this.lastSampleEndMs - INTERN_TTL_MS;
    for (const [key, entry] of this.interned) {
      if (entry.lastMs < oldest) {
        this.interned.delete(key);
      }
    }
  }

  private dropGroupState(): void {
    this.headDocument = null;
    this.stored = null;
    this.previousVtt = null;
  }

  private samplesOf(data: Uint8Array): TextSample[] {
    if (this.packaging === "cmaf") {
      return parseCmafSamples(data, this.locmaf.ctx);
    }
    const result = decodeObject(data, this.locmaf.group, this.locmaf.ctx);
    if (result.raw !== undefined) {
      return parseCmafSamples(result.raw, this.locmaf.ctx);
    }
    const eff = result.eff;
    if (!eff) {
      return [];
    }
    const toMs = (t: number): number => (t * 1000) / this.locmaf.ctx.timescale;
    const samples: TextSample[] = [];
    let t = Number(eff.bmdt);
    let offset = 0;
    for (let i = 0; i < eff.sampleCount; i++) {
      const size = eff.sizes[i];
      samples.push({
        startMs: toMs(t),
        endMs: toMs(t + eff.durations[i]),
        flags: eff.flags[i],
        data: eff.mdatPayload.subarray(offset, offset + size),
      });
      t += eff.durations[i];
      offset += size;
    }
    return samples;
  }

  private processSample(s: TextSample): void {
    this.lastSampleEndMs = s.endMs;
    switch (this.sampleEntry) {
      case "stpp":
        this.showTtml(this.parseDocument(utf8.decode(s.data), false), s);
        return;
      case "stpc":
        this.stpcSample(s);
        return;
      case "wvtt":
        this.showVtt(this.parseVtt(s.data), s);
        return;
      case "wvtc":
        this.wvtcSample(s);
        return;
    }
  }

  private stpcSample(s: TextSample): void {
    const box = wholeSampleBoxType(s.data, ["ttmn", "ttmb"]);
    if (box === "ttmn") {
      if (!this.stored) {
        this.drop("ttmn without a document to continue");
        return;
      }
      this.stats.noChangeSamples++;
      this.showTtml(this.stored, s);
      return;
    }
    let text: string;
    if (box === "ttmb") {
      const head = this.headDocument;
      const spliced = head
        ? spliceBody(head, utf8.decode(s.data.subarray(8)))
        : null;
      if (!spliced) {
        this.drop("ttmb without a document to take the head from");
        return;
      }
      text = spliced;
    } else {
      text = utf8.decode(s.data);
      // The first full document of the group is the head for its ttmb bodies.
      this.headDocument ??= text;
    }
    this.stored = this.parseDocument(text, box === "ttmb");
    this.showTtml(this.stored, s);
  }

  private wvtcSample(s: TextSample): void {
    if (wholeSampleBoxType(s.data, ["vttn"])) {
      if (!this.previousVtt) {
        this.drop("vttn without cues to continue");
        return;
      }
      this.stats.noChangeSamples++;
      this.showVtt(this.previousVtt, s);
      return;
    }
    this.previousVtt = this.parseVtt(s.data);
    this.showVtt(this.previousVtt, s);
  }

  private drop(reason: string): void {
    this.stats.droppedSamples++;
    this.warn(`subtitles: ${reason}`);
  }

  /** Parse a TTML document, counting it, and intern its presentation states. */
  private parseDocument(
    text: string,
    spliced: boolean,
  ): { interval: TtmlInterval; cue: TtmlCue }[] {
    const t0 = this.now();
    const intervals = parseTtml(text);
    this.stats.parseMs += this.now() - t0;
    this.stats.documentsParsed++;
    if (spliced) {
      this.stats.bodySplices++;
    }
    this.stats.xmlBytesParsed += text.length;
    return intervals.map((interval) => ({
      interval,
      cue: this.intern<TtmlCue>(
        `t${interval.begin}|${JSON.stringify(interval.isd)}`,
        (key) => ({ kind: "ttml", key, isd: interval.isd }),
      ),
    }));
  }

  /** Parse the cue boxes of a WebVTT sample, counting them. */
  private parseVtt(data: Uint8Array): VttCue[] {
    const t0 = this.now();
    const boxes = parseVttSample(data);
    const cues = boxes.map((box) =>
      this.intern<VttCue>(
        `v${box.sourceId ?? ""}|${box.id ?? ""}|${box.settings}|${box.text}`,
        (key) => ({
          kind: "vtt",
          key,
          id: box.id,
          settings: parseVttSettings(box.settings),
          lines: parseVttCueText(box.text),
        }),
      ),
    );
    this.stats.parseMs += this.now() - t0;
    this.stats.cueBoxesParsed += boxes.length;
    return cues;
  }

  private intern<T extends SubtitleCue>(
    key: string,
    make: (key: string) => T,
  ): T {
    const hit = this.interned.get(key);
    if (hit) {
      hit.lastMs = this.lastSampleEndMs;
      return hit.cue as T;
    }
    const cue = make(key);
    this.interned.set(key, { cue, lastMs: this.lastSampleEndMs });
    return cue;
  }

  private showTtml(
    states: { interval: TtmlInterval; cue: TtmlCue }[],
    s: TextSample,
  ): void {
    if (!this.sink) {
      return;
    }
    for (const { interval, cue } of states) {
      const start = Math.max(interval.begin, s.startMs);
      const end = Math.min(interval.end, s.endMs);
      if (end > start) {
        this.sink(start, end, cue);
      }
    }
  }

  private showVtt(cues: VttCue[], s: TextSample): void {
    if (!this.sink || s.endMs <= s.startMs) {
      return;
    }
    for (const cue of cues) {
      this.sink(s.startMs, s.endMs, cue);
    }
  }
}
