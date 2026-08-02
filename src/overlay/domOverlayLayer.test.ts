import { CC608_COLS, type Cc608Cell, type Cc608Snapshot } from "../cc608/types";

import { DomOverlayLayer } from "./overlayLayer";
import { Cta608Renderer, computeGrid } from "./renderers/cta608";
import { asDom, FakeCanvas, FakeDocument, FakeElement } from "./testFakeDom";

import type { MediaRect, OverlayRenderer, PresentationMs } from "./index";

/** Records what the layer asked it to paint. */
class RecordingRenderer implements OverlayRenderer<unknown> {
  mounts = 0;
  unmounts = 0;
  readonly calls: Array<{
    state: unknown;
    rect: MediaRect;
    nowMs: PresentationMs;
  }> = [];
  root: FakeElement | null = null;

  mount(root: HTMLElement): void {
    this.mounts++;
    this.root = asDom<FakeElement>(root);
  }

  render(state: unknown, rect: MediaRect, nowMs: PresentationMs): void {
    this.calls.push({ state, rect, nowMs });
  }

  unmount(): void {
    this.unmounts++;
  }
}

interface Harness {
  layer: DomOverlayLayer;
  container: FakeElement;
  surface: FakeCanvas;
  setClockValue(ms: number | null): void;
}

function makeHarness(): Harness {
  const doc = new FakeDocument();
  const container = doc.createElement("div");
  container.setBox(0, 0, 1280, 800);

  const surface = new FakeCanvas(doc);
  surface.width = 1920;
  surface.height = 1080;
  // 16:9 surface at the top of a taller container (controls sit below).
  surface.setBox(0, 0, 1280, 720);

  let clockValue: number | null = null;
  // A no-op scheduler: tick() is driven explicitly so the tests are
  // deterministic and need no rAF.
  const layer = new DomOverlayLayer(asDom<HTMLElement>(container), {
    requestFrame: () => 1,
    cancelFrame: () => undefined,
  });
  layer.setSurface(asDom<HTMLCanvasElement>(surface));
  layer.setClock(() => clockValue);

  return {
    layer,
    container,
    surface,
    setClockValue: (ms) => {
      clockValue = ms;
    },
  };
}

describe("DomOverlayLayer", () => {
  it("mounts a renderer into its own subtree of the container", () => {
    const h = makeHarness();
    const renderer = new RecordingRenderer();
    h.layer.attach("cc608", renderer, "state");

    expect(renderer.mounts).toBe(1);
    expect(h.container.children).toHaveLength(1);
    expect(renderer.root).toBe(h.container.children[0]);
    expect(h.container.children[0].dataset.overlayRenderer).toBe("cc608");
    expect(h.container.children[0].style.pointerEvents).toBe("none");
  });

  it("renders on change only, not on every tick", () => {
    const h = makeHarness();
    const renderer = new RecordingRenderer();
    const channel = h.layer.attach<string>("cc608", renderer, "state");

    h.setClockValue(1000);
    channel.push(1000, "screen-1");
    h.layer.tick();
    h.layer.tick();
    h.layer.tick();
    expect(renderer.calls).toHaveLength(1);
    expect(renderer.calls[0].state).toBe("screen-1");

    h.setClockValue(1500); // same resolved screen — no repaint
    h.layer.tick();
    expect(renderer.calls).toHaveLength(1);

    channel.push(2000, "screen-2");
    h.setClockValue(2000);
    h.layer.tick();
    expect(renderer.calls).toHaveLength(2);
    expect(renderer.calls[1].state).toBe("screen-2");
  });

  it("lays out inside the picture rect, not the container box", () => {
    const h = makeHarness();
    const renderer = new RecordingRenderer();
    h.layer.attach("cc608", renderer, "state");
    h.setClockValue(0);
    h.layer.tick();

    // Container is 1280x800, surface 1280x720 with 16:9 content: the picture
    // fills the surface box and does not extend over the controls below it.
    expect(renderer.calls[0].rect).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
  });

  it("repaints when the picture rect changes", () => {
    const h = makeHarness();
    const renderer = new RecordingRenderer();
    const channel = h.layer.attach<string>("cc608", renderer, "state");
    h.setClockValue(1000);
    channel.push(0, "screen");
    h.layer.tick();
    expect(renderer.calls).toHaveLength(1);

    h.surface.setBox(0, 0, 640, 360);
    h.layer.tick();
    expect(renderer.calls).toHaveLength(2);
    expect(renderer.calls[1].rect).toEqual({ x: 0, y: 0, w: 640, h: 360 });
  });

  it("renders nothing while the clock has no picture yet", () => {
    const h = makeHarness();
    const renderer = new RecordingRenderer();
    const channel = h.layer.attach<string>("cc608", renderer, "state");
    channel.push(1000, "screen");
    h.setClockValue(null);
    h.layer.tick();
    expect(renderer.calls).toHaveLength(1);
    expect(renderer.calls[0].state).toBeNull();
  });

  it("clears channel state and re-mounts on reset()", () => {
    const h = makeHarness();
    const renderer = new RecordingRenderer();
    const channel = h.layer.attach<string>("cc608", renderer, "state");
    h.setClockValue(1000);
    channel.push(0, "stale-screen");
    h.layer.tick();
    expect(renderer.calls).toHaveLength(1);

    h.layer.reset();
    expect(renderer.unmounts).toBe(1);
    expect(renderer.mounts).toBe(2);

    // A stale caption from before a namespace switch must not come back.
    h.layer.tick();
    expect(renderer.calls[renderer.calls.length - 1].state).toBeNull();
  });

  it("stops painting while disabled and repaints on re-enable", () => {
    const h = makeHarness();
    const renderer = new RecordingRenderer();
    const channel = h.layer.attach<string>("cc608", renderer, "state");
    h.setClockValue(1000);
    channel.push(0, "screen");
    h.layer.tick();
    expect(renderer.calls).toHaveLength(1);

    h.layer.setEnabled(false);
    expect(h.layer.isEnabled()).toBe(false);
    expect(h.container.style.display).toBe("none");
    h.layer.tick();
    expect(renderer.calls).toHaveLength(1);

    h.layer.setEnabled(true);
    h.layer.tick();
    expect(renderer.calls).toHaveLength(2);
    expect(h.container.style.display).toBe("");
  });

  it("unmounts and removes the subtree on detach and dispose", () => {
    const h = makeHarness();
    const renderer = new RecordingRenderer();
    h.layer.attach("cc608", renderer, "state");
    h.layer.detach("cc608");
    expect(renderer.unmounts).toBe(1);
    expect(h.container.children).toHaveLength(0);

    const other = new RecordingRenderer();
    h.layer.attach("cc608", other, "state");
    h.layer.dispose();
    expect(other.unmounts).toBe(1);
    expect(h.container.children).toHaveLength(0);
    // Disposed layers are inert.
    h.layer.tick();
    expect(other.calls).toHaveLength(0);
  });
});

/* --- the CTA-608 renderer against the layer ----------------------------- */

function snapshotWith(
  text: string,
  col: number,
  rowIndex: number,
): Cc608Snapshot {
  const cells: Cc608Cell[] = Array.from({ length: CC608_COLS }, () => ({
    uchar: " ",
    pen: {
      foreground: "white",
      background: "black",
      underline: false,
      italics: false,
      flash: false,
    },
  }));
  for (let i = 0; i < text.length; i++) {
    cells[col + i] = { uchar: text[i], pen: cells[col + i].pen };
  }
  return { rows: [{ row: rowIndex, cells }] };
}

describe("Cta608Renderer through the layer", () => {
  it("emits one positioned box per style run and clears on an empty screen", () => {
    const h = makeHarness();
    const renderer = new Cta608Renderer();
    const channel = h.layer.attach<Cc608Snapshot>("cc608", renderer, "state");
    const root = h.container.children[0];

    h.setClockValue(1000);
    channel.push(0, snapshotWith("HELLO", 10, 14));
    h.layer.tick();

    expect(root.children).toHaveLength(1);
    const box = root.children[0];
    const grid = computeGrid({ x: 0, y: 0, w: 1280, h: 720 });
    expect(box.style.left).toBe(`${grid.x + 10 * grid.cellW}px`);
    expect(box.style.top).toBe(`${grid.y + 14 * grid.cellH}px`);
    expect(box.style.width).toBe(`${5 * grid.cellW}px`);
    expect(box.style.height).toBe(`${grid.cellH}px`);
    // The box IS the background.
    expect(box.style.background).toBe("#000000");
    expect(box.style.overflow).toBe("hidden");

    const inner = box.children[0];
    expect(inner.textContent).toBe("HELLO");
    expect(inner.style.transformOrigin).toBe("left top");
    expect(inner.style.whiteSpace).toBe("pre");
    expect(inner.style.color).toBe("#ffffff");

    // A null push clears the overlay from that time onward.
    channel.push(2000, null);
    h.setClockValue(2000);
    h.layer.tick();
    expect(root.children).toHaveLength(0);
  });
});
