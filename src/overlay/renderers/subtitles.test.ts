import type { TtmlCue, VttCue, VttSettings } from "../../subtitles/types";
import type { MediaRect } from "../index";
import { asDom, FakeDocument, type FakeElement } from "../testFakeDom";

import { SubtitleRenderer, VTT_FONT_SIZE, vttBoxLayout } from "./subtitles";

const RECT: MediaRect = { x: 10, y: 20, w: 1000, h: 500 };
const LINE_H = RECT.h * VTT_FONT_SIZE * 1.2;

function vtt(settings: Partial<VttSettings>, lines = 1): VttCue {
  return {
    kind: "vtt",
    key: JSON.stringify(settings),
    settings: { size: 100, align: "center", ...settings },
    lines: Array.from({ length: lines }, (_, i) => [
      { text: `line ${i}`, style: {} },
    ]),
  };
}

describe("vttBoxLayout", () => {
  it("puts a cue without settings at the bottom, full width", () => {
    const l = vttBoxLayout(vtt({}), RECT, 0);
    expect(l.left).toBe(0);
    expect(l.width).toBe(1000);
    expect(l.top).toBeUndefined();
    expect(l.bottom).toBeCloseTo(RECT.h * 0.02);
    expect(l.textAlign).toBe("center");
  });

  it("stacks cues without a line above the ones below", () => {
    expect(vttBoxLayout(vtt({}), RECT, 2).bottom).toBeCloseTo(
      2 * LINE_H + RECT.h * 0.02,
    );
  });

  it("counts non-negative line numbers from the top, negative from the bottom", () => {
    expect(
      vttBoxLayout(vtt({ line: { value: 2, percent: false } }), RECT, 0).top,
    ).toBeCloseTo(2 * LINE_H);
    expect(
      vttBoxLayout(vtt({ line: { value: -1, percent: false } }), RECT, 5)
        .bottom,
    ).toBeCloseTo(RECT.h * 0.02);
    expect(
      vttBoxLayout(vtt({ line: { value: 10, percent: true } }), RECT, 0).top,
    ).toBe(50);
  });

  it("places and clamps the box horizontally", () => {
    const l = vttBoxLayout(vtt({ size: 40, position: 10 }), RECT, 0);
    expect(l.width).toBe(400);
    expect(l.left).toBe(0); // 10% centre would put it off the left edge
    expect(vttBoxLayout(vtt({ size: 40, align: "end" }), RECT, 0).left).toBe(
      600,
    );
    expect(
      vttBoxLayout(vtt({ size: 40, align: "start" }), RECT, 0).textAlign,
    ).toBe("left");
  });
});

describe("SubtitleRenderer", () => {
  it("paints TTML through the injected ISD renderer over the picture box", () => {
    const calls: [unknown, number, number][] = [];
    const renderer = new SubtitleRenderer((isd, el, h, w) => {
      calls.push([isd, h, w]);
      void el;
    });
    const doc = new FakeDocument();
    const root = doc.createElement("div");
    renderer.mount(asDom<HTMLElement>(root));
    const isd = { contents: [], aspectRatio: null };
    const cue: TtmlCue = { kind: "ttml", key: "k", isd };
    renderer.render([cue], RECT, 0);
    expect(calls).toEqual([[isd, 500, 1000]]);
    const box = root.children[0];
    expect(box.style.left).toBe("10px");
    expect(box.style.width).toBe("1000px");
  });

  it("lays out WebVTT cues, and empties the root when nothing is active", () => {
    const renderer = new SubtitleRenderer(null);
    const doc = new FakeDocument();
    const root = doc.createElement("div");
    renderer.mount(asDom<HTMLElement>(root));
    renderer.render([vtt({}, 2)], RECT, 0);
    const text = root
      .descendants()
      .map((e: FakeElement) => e.textContent)
      .filter((t) => t.length > 0);
    expect(text).toEqual(["line 0", "line 1"]);
    renderer.render([], RECT, 0);
    expect(root.children).toHaveLength(0);
    renderer.unmount();
  });
});
