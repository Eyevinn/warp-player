/**
 * WebVTT in ISOBMFF (ISO/IEC 14496-30 §7): the boxes of a `wvtt` sample, and
 * the cue text and settings inside them.
 *
 * A sample is a sequence of `vttc` cue boxes, or one `vtte` empty box, and may
 * carry `vtta` comment boxes. A `vttc` holds optional `vsid` (source id),
 * `iden` (cue identifier), `ctim` (current time), `sttg` (settings) and a
 * `payl` (the cue text).
 */
import { boxesIn } from "./mp4";
import type { RunStyle, TextLine, VttSettings } from "./types";

/** One cue box, parsed. */
export interface VttCueBox {
  sourceId?: number;
  id?: string;
  settings: string;
  text: string;
}

const decoder = new TextDecoder("utf-8");

/** The cue boxes of a sample, in order. An empty list for `vtte` or no cue. */
export function parseVttSample(sample: Uint8Array): VttCueBox[] {
  const cues: VttCueBox[] = [];
  for (const box of boxesIn(sample)) {
    if (box.type !== "vttc") {
      continue; // vtte, vtta
    }
    const cue: VttCueBox = { settings: "", text: "" };
    for (const c of boxesIn(sample, box.body, box.end)) {
      const payload = sample.subarray(c.body, c.end);
      switch (c.type) {
        case "vsid":
          if (payload.length >= 4) {
            cue.sourceId =
              payload[0] * 0x1000000 +
              payload[1] * 0x10000 +
              payload[2] * 0x100 +
              payload[3];
          }
          break;
        case "iden":
          cue.id = decoder.decode(payload);
          break;
        case "sttg":
          cue.settings = decoder.decode(payload);
          break;
        case "payl":
          cue.text = decoder.decode(payload);
          break;
      }
    }
    cues.push(cue);
  }
  return cues;
}

/** Parse a WebVTT cue settings list (WebVTT §4.1.4). Unknown settings are ignored. */
export function parseVttSettings(settings: string): VttSettings {
  const out: VttSettings = { size: 100, align: "center" };
  for (const item of settings.trim().split(/\s+/)) {
    const colon = item.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    const name = item.slice(0, colon);
    const value = item.slice(colon + 1).split(",")[0];
    switch (name) {
      case "line": {
        const percent = value.endsWith("%");
        const n = parseFloat(value);
        if (Number.isFinite(n)) {
          out.line = { value: n, percent };
        }
        break;
      }
      case "position": {
        const n = parseFloat(value);
        if (value.endsWith("%") && Number.isFinite(n)) {
          out.position = n;
        }
        break;
      }
      case "size": {
        const n = parseFloat(value);
        if (value.endsWith("%") && Number.isFinite(n)) {
          out.size = n;
        }
        break;
      }
      case "align":
        if (["start", "center", "end", "left", "right"].includes(value)) {
          out.align = value as VttSettings["align"];
        }
        break;
    }
  }
  return out;
}

/** The WebVTT default colour classes (WebVTT §4.2.2 is silent; these are the de facto set). */
const CLASS_COLORS: Record<string, string> = {
  white: "#ffffff",
  lime: "#00ff00",
  cyan: "#00ffff",
  red: "#ff0000",
  yellow: "#ffff00",
  magenta: "#ff00ff",
  blue: "#0000ff",
  black: "#000000",
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
  lrm: "‎",
  rlm: "‏",
  quot: '"',
  apos: "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent.startsWith("#x")) {
      return String.fromCodePoint(parseInt(ent.slice(2), 16));
    }
    if (ent.startsWith("#")) {
      return String.fromCodePoint(parseInt(ent.slice(1), 10));
    }
    return ENTITIES[ent] ?? m;
  });
}

/**
 * Cue text to styled lines. `b`, `i` and `u` style their text, `c` takes the
 * colour classes (`.yellow`, `.bg_black`, ...), `v` and `lang` add nothing
 * visible, `rt` (ruby text) is dropped and timestamp tags are ignored.
 */
export function parseVttCueText(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let line: TextLine = [];
  const stack: { tag: string; style: RunStyle }[] = [];
  let style: RunStyle = {};
  let hidden = 0; // Inside rt

  const pushText = (raw: string): void => {
    const parts = decodeEntities(raw).split(/\r\n|\r|\n/);
    parts.forEach((part, i) => {
      if (i > 0) {
        lines.push(line);
        line = [];
      }
      if (part.length > 0 && hidden === 0) {
        line.push({ text: part, style });
      }
    });
  };

  const tagRe = /<([^>]*)>/g;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    if (m.index > pos) {
      pushText(text.slice(pos, m.index));
    }
    pos = tagRe.lastIndex;
    const tag = m[1].trim();
    if (tag.startsWith("/")) {
      const name = tag.slice(1).split(/[.\s]/)[0];
      // Close back to the matching tag, as the WebVTT parser does.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === name) {
          stack.length = i;
          break;
        }
      }
      style = stack.length ? stack[stack.length - 1].style : {};
      if (name === "rt" && hidden > 0) {
        hidden--;
      }
      continue;
    }
    if (/^\d/.test(tag)) {
      continue; // <00:01.000> timestamp tag
    }
    const [head] = tag.split(/\s/);
    const [name, ...classes] = head.split(".");
    const next: RunStyle = { ...style };
    switch (name) {
      case "b":
        next.fontWeight = "bold";
        break;
      case "i":
        next.fontStyle = "italic";
        break;
      case "u":
        next.textDecoration = "underline";
        break;
      case "rt":
        hidden++;
        break;
    }
    for (const cls of classes) {
      if (CLASS_COLORS[cls]) {
        next.color = CLASS_COLORS[cls];
      } else if (cls.startsWith("bg_") && CLASS_COLORS[cls.slice(3)]) {
        next.backgroundColor = CLASS_COLORS[cls.slice(3)];
      }
    }
    stack.push({ tag: name, style: next });
    style = next;
  }
  if (pos < text.length) {
    pushText(text.slice(pos));
  }
  lines.push(line);
  while (lines.length > 0 && lines[lines.length - 1].length === 0) {
    lines.pop();
  }
  return lines;
}
