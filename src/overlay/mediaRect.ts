// Geometry for the overlay: where the *picture* actually is.
//
// The overlay container spans the whole `.player-section`, but captions have
// to be laid out against the letterboxed picture inside the active surface —
// a 4:3 stream in a 16:9 element must not put its caption grid over the
// pillarbox bars. Both surfaces we bind to (`<video>` for MSE, `<canvas>`
// for WebCodecs) render their content with `object-fit: contain`, so the
// picture box follows from the intrinsic size alone.

import type { MediaRect } from "./index";

/** The surfaces a pipeline can draw into. */
export type OverlaySurface = HTMLVideoElement | HTMLCanvasElement;

/** A box in the overlay container's coordinate space. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * `object-fit: contain` — the picture rect inside an element box.
 *
 * `box` is the element's border box expressed in the overlay container's
 * coordinate space. `intrinsicW`/`intrinsicH` are the media's natural
 * dimensions; when either is unknown (0, NaN, or before the first frame)
 * the whole element box is returned, which is the right answer for a
 * surface that has not sized itself yet.
 */
export function computeMediaRect(
  box: Box,
  intrinsicW: number,
  intrinsicH: number,
): MediaRect {
  const boxW = Math.max(0, box.w);
  const boxH = Math.max(0, box.h);
  if (
    !Number.isFinite(intrinsicW) ||
    !Number.isFinite(intrinsicH) ||
    intrinsicW <= 0 ||
    intrinsicH <= 0 ||
    boxW <= 0 ||
    boxH <= 0
  ) {
    return { x: box.x, y: box.y, w: boxW, h: boxH };
  }

  const mediaAspect = intrinsicW / intrinsicH;
  const boxAspect = boxW / boxH;
  let w: number;
  let h: number;
  if (mediaAspect > boxAspect) {
    // Wider than the box: full width, letterboxed top and bottom.
    w = boxW;
    h = boxW / mediaAspect;
  } else {
    // Taller than the box: full height, pillarboxed left and right.
    h = boxH;
    w = boxH * mediaAspect;
  }
  return {
    x: box.x + (boxW - w) / 2,
    y: box.y + (boxH - h) / 2,
    w,
    h,
  };
}

/** Intrinsic media dimensions of a surface, or 0x0 when not yet known. */
export function surfaceIntrinsicSize(surface: OverlaySurface): {
  w: number;
  h: number;
} {
  // Duck-typed rather than `instanceof HTMLCanvasElement` so this module can
  // be imported (and unit-tested) outside a DOM.
  if ("videoWidth" in surface) {
    return { w: surface.videoWidth, h: surface.videoHeight };
  }
  return { w: surface.width, h: surface.height };
}

/**
 * The picture rect of `surface`, in `container`'s coordinate space.
 * Returns null when the surface is not laid out (zero-sized or detached).
 */
export function getMediaRect(
  surface: OverlaySurface,
  container: HTMLElement,
): MediaRect | null {
  const surfaceBox = surface.getBoundingClientRect();
  if (surfaceBox.width <= 0 || surfaceBox.height <= 0) {
    return null;
  }
  const containerBox = container.getBoundingClientRect();
  const box: Box = {
    x: surfaceBox.left - containerBox.left,
    y: surfaceBox.top - containerBox.top,
    w: surfaceBox.width,
    h: surfaceBox.height,
  };
  const intrinsic = surfaceIntrinsicSize(surface);
  return computeMediaRect(box, intrinsic.w, intrinsic.h);
}

/** True when two rects are equal to within a sub-pixel epsilon. */
export function rectsEqual(
  a: MediaRect | null,
  b: MediaRect | null,
  epsilon = 0.01,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    Math.abs(a.x - b.x) < epsilon &&
    Math.abs(a.y - b.y) < epsilon &&
    Math.abs(a.w - b.w) < epsilon &&
    Math.abs(a.h - b.h) < epsilon
  );
}

/**
 * Recompute-on-resize plumbing. Observes both the surface and the container
 * (the surface can stay the same size while the container moves) and calls
 * `onResize` whenever either changes. Returns a disposer.
 *
 * Falls back to a window `resize` listener where ResizeObserver is missing.
 */
export function observeSurfaceSize(
  surface: OverlaySurface,
  container: HTMLElement,
  onResize: () => void,
): () => void {
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => onResize());
    observer.observe(surface);
    observer.observe(container);
    return () => observer.disconnect();
  }
  if (typeof window === "undefined") {
    return () => undefined;
  }
  const handler = (): void => onResize();
  window.addEventListener("resize", handler);
  return () => window.removeEventListener("resize", handler);
}
