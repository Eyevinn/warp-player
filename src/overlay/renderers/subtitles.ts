// Text subtitles → DOM, fed by a "cues" channel of SubtitleCue.
//
// TTML is painted by imscJS's own HTML renderer, the same one dash.js uses, so
// regions, styling and line layout follow IMSC. The renderer function is
// injected: imscJS's html.js reads `window` when it loads, and this file must
// stay importable in the node test environment.
//
// WebVTT is laid out here, after the WebVTT rendering rules in outline: a cue
// box of `size`% width centred on `position`, text aligned by `align`, and
// placed on its `line` — counted from the top for a non-negative line number,
// from the bottom for a negative one, a percentage from the top, or the
// bottom line when unset. Text is white on a translucent black background at
// 5% of the picture height, the WebVTT default.

import type {
  SubtitleCue,
  TextLine,
  TtmlCue,
  VttCue,
} from "../../subtitles/types";
import type {
  CuesOf,
  MediaRect,
  OverlayRenderer,
  PresentationMs,
} from "../index";

/** Paints an imscJS ISD into `element`, sized `width` × `height` CSS px. */
export type IsdRenderer = (
  isd: ImscIsd,
  element: HTMLElement,
  height: number,
  width: number,
) => void;

/** WebVTT font size, as a fraction of the picture height. */
export const VTT_FONT_SIZE = 0.05;
/** WebVTT line height, as a multiple of the font size. */
const VTT_LINE_HEIGHT = 1.2;

export class SubtitleRenderer implements OverlayRenderer<CuesOf<SubtitleCue>> {
  private root: HTMLElement | null = null;

  constructor(private readonly renderIsd: IsdRenderer | null) {}

  mount(root: HTMLElement): void {
    this.root = root;
  }

  render(
    cues: CuesOf<SubtitleCue>,
    rect: MediaRect,
    _nowMs: PresentationMs,
  ): void {
    const root = this.root;
    if (!root) {
      return;
    }
    root.replaceChildren();
    const doc = root.ownerDocument;
    const vtt: VttCue[] = [];
    for (const cue of cues) {
      if (cue.kind === "ttml") {
        this.renderTtml(cue, rect, root);
      } else {
        vtt.push(cue);
      }
    }
    if (vtt.length > 0) {
      root.appendChild(layoutVtt(doc, vtt, rect));
    }
  }

  unmount(): void {
    this.root?.replaceChildren();
    this.root = null;
  }

  private renderTtml(cue: TtmlCue, rect: MediaRect, root: HTMLElement): void {
    if (!this.renderIsd) {
      return;
    }
    const box = pictureBox(root.ownerDocument, rect);
    root.appendChild(box);
    this.renderIsd(cue.isd, box, rect.h, rect.w);
  }
}

/** An absolutely positioned box covering the picture. */
function pictureBox(doc: Document, rect: MediaRect): HTMLElement {
  const box = doc.createElement("div");
  box.style.position = "absolute";
  box.style.left = `${rect.x}px`;
  box.style.top = `${rect.y}px`;
  box.style.width = `${rect.w}px`;
  box.style.height = `${rect.h}px`;
  return box;
}

/** Where a WebVTT cue box goes, in CSS px inside the picture. */
export interface VttBoxLayout {
  left: number;
  width: number;
  /** Set for cues placed from the top; `bottom` for cues placed from the bottom. */
  top?: number;
  bottom?: number;
  textAlign: string;
}

/**
 * The box of a WebVTT cue. Cues without a line setting stack upwards from the
 * bottom, `stackLines` lines above the lowest.
 */
export function vttBoxLayout(
  cue: VttCue,
  rect: MediaRect,
  stackLines: number,
): VttBoxLayout {
  const s = cue.settings;
  const width = (rect.w * s.size) / 100;
  // Without a position the box is centred for center alignment, and put at
  // the matching edge for start/left and end/right.
  let center: number;
  if (s.position !== undefined) {
    center = s.position;
  } else if (s.align === "start" || s.align === "left") {
    center = s.size / 2;
  } else if (s.align === "end" || s.align === "right") {
    center = 100 - s.size / 2;
  } else {
    center = 50;
  }
  const left = Math.min(
    Math.max((rect.w * center) / 100 - width / 2, 0),
    rect.w - width,
  );
  const textAlign =
    s.align === "start" ? "left" : s.align === "end" ? "right" : s.align;
  const lineH = rect.h * VTT_FONT_SIZE * VTT_LINE_HEIGHT;
  const line = s.line;
  if (line && line.percent) {
    return { left, width, top: (rect.h * line.value) / 100, textAlign };
  }
  if (line && line.value >= 0) {
    return { left, width, top: line.value * lineH, textAlign };
  }
  const fromBottom = line ? -line.value - 1 : stackLines;
  return { left, width, bottom: fromBottom * lineH + rect.h * 0.02, textAlign };
}

function layoutVtt(
  doc: Document,
  cues: VttCue[],
  rect: MediaRect,
): HTMLElement {
  const container = pictureBox(doc, rect);
  const fontPx = rect.h * VTT_FONT_SIZE;
  let stackLines = 0;
  for (const cue of cues) {
    const layout = vttBoxLayout(cue, rect, stackLines);
    if (!cue.settings.line) {
      stackLines += cue.lines.length;
    }
    const box = doc.createElement("div");
    box.style.position = "absolute";
    box.style.left = `${layout.left}px`;
    box.style.width = `${layout.width}px`;
    if (layout.top !== undefined) {
      box.style.top = `${layout.top}px`;
    } else {
      box.style.bottom = `${layout.bottom ?? 0}px`;
    }
    box.style.textAlign = layout.textAlign;
    box.style.fontFamily = "sans-serif";
    box.style.fontSize = `${fontPx}px`;
    box.style.lineHeight = String(VTT_LINE_HEIGHT);
    box.style.color = "#ffffff";
    box.style.whiteSpace = "pre-line";
    for (const line of cue.lines) {
      box.appendChild(lineElement(doc, line));
    }
    container.appendChild(box);
  }
  return container;
}

function lineElement(doc: Document, line: TextLine): HTMLElement {
  const div = doc.createElement("div");
  const bg = doc.createElement("span");
  bg.style.backgroundColor = "rgba(0, 0, 0, 0.8)";
  bg.style.padding = "0 0.25em";
  for (const run of line) {
    const span = doc.createElement("span");
    span.textContent = run.text;
    const st = run.style;
    if (st.color) {
      span.style.color = st.color;
    }
    if (st.backgroundColor) {
      span.style.backgroundColor = st.backgroundColor;
    }
    if (st.fontStyle) {
      span.style.fontStyle = st.fontStyle;
    }
    if (st.fontWeight) {
      span.style.fontWeight = st.fontWeight;
    }
    if (st.textDecoration) {
      span.style.textDecoration = st.textDecoration;
    }
    bg.appendChild(span);
  }
  div.appendChild(bg);
  return div;
}
