/**
 * The subtitle comparison table: per received track, what arrived on the wire
 * and what the player had to parse, per second of media.
 */
import type { SubtitleStatsRow } from "./controller";

/** One row's figures, per second of received media. */
export interface SubtitleFigures {
  kbps: number;
  bytesPerObject: number;
  /** TTML documents or WebVTT cue boxes parsed per second. */
  parsedPerSec: number;
  parsedUnit: "docs" | "cues";
  /** Kilobytes of TTML parsed per second; 0 for WebVTT. */
  xmlKBps: number;
  parseMsPerSec: number;
  /** Share of samples shown again without parsing, in percent. */
  noChangePct: number;
  dropped: number;
}

export function subtitleFigures(row: SubtitleStatsRow): SubtitleFigures {
  const s = row.stats;
  const seconds = s.mediaMs / 1000;
  const perSec = (n: number): number => (seconds > 0 ? n / seconds : 0);
  const isTtml = row.sampleEntry === "stpp" || row.sampleEntry === "stpc";
  return {
    kbps: perSec((s.bytes * 8) / 1000),
    bytesPerObject: s.objects > 0 ? s.bytes / s.objects : 0,
    parsedPerSec: perSec(isTtml ? s.documentsParsed : s.cueBoxesParsed),
    parsedUnit: isTtml ? "docs" : "cues",
    xmlKBps: perSec(s.xmlBytesParsed / 1000),
    parseMsPerSec: perSec(s.parseMs),
    noChangePct: s.samples > 0 ? (100 * s.noChangeSamples) / s.samples : 0,
    dropped: s.droppedSamples + s.droppedObjects,
  };
}

const COLUMNS = [
  "Track",
  "Entry",
  "Packaging",
  "kbit/s",
  "B/object",
  "Parsed/s",
  "XML kB/s",
  "Parse ms/s",
  "No-change",
  "Dropped",
];

/** Replace the contents of `container` with the table for `rows`. */
export function renderSubtitleStats(
  container: HTMLElement,
  rows: SubtitleStatsRow[],
): void {
  const doc = container.ownerDocument;
  if (rows.length === 0) {
    container.replaceChildren();
    return;
  }
  const table = doc.createElement("table");
  table.className = "subtitle-stats";
  const head = doc.createElement("tr");
  for (const title of COLUMNS) {
    const th = doc.createElement("th");
    th.textContent = title;
    head.appendChild(th);
  }
  table.appendChild(head);
  for (const row of rows) {
    const f = subtitleFigures(row);
    const cells = [
      `${row.displayed ? "● " : ""}${row.track.name}`,
      row.sampleEntry,
      row.track.packaging ?? "cmaf",
      f.kbps.toFixed(1),
      f.bytesPerObject.toFixed(0),
      `${f.parsedPerSec.toFixed(1)} ${f.parsedUnit}`,
      f.parsedUnit === "docs" ? f.xmlKBps.toFixed(1) : "–",
      f.parseMsPerSec.toFixed(2),
      `${f.noChangePct.toFixed(0)}%`,
      String(f.dropped),
    ];
    const tr = doc.createElement("tr");
    if (row.displayed) {
      tr.className = "displayed";
    }
    for (const text of cells) {
      const td = doc.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  container.replaceChildren(table);
}
