import { computeMediaRect, rectsEqual } from "./mediaRect";

describe("computeMediaRect", () => {
  const box = { x: 0, y: 0, w: 1100, h: 619 };

  it("fills the box when the media aspect matches it", () => {
    const rect = computeMediaRect({ x: 0, y: 0, w: 1600, h: 900 }, 1920, 1080);
    expect(rect).toEqual({ x: 0, y: 0, w: 1600, h: 900 });
  });

  it("pillarboxes a 4:3 picture in a 16:9 box", () => {
    const rect = computeMediaRect(box, 640, 480);
    // Full height, width = h * 4/3, centred horizontally.
    expect(rect.h).toBeCloseTo(619, 6);
    expect(rect.w).toBeCloseTo((619 * 4) / 3, 6);
    expect(rect.y).toBeCloseTo(0, 6);
    expect(rect.x).toBeCloseTo((1100 - (619 * 4) / 3) / 2, 6);
    // Bars are symmetric.
    expect(rect.x + rect.w).toBeCloseTo(1100 - rect.x, 6);
  });

  it("letterboxes a 21:9 picture in a 16:9 box", () => {
    const rect = computeMediaRect(box, 2560, 1080);
    expect(rect.w).toBeCloseTo(1100, 6);
    expect(rect.h).toBeCloseTo(1100 / (2560 / 1080), 6);
    expect(rect.x).toBeCloseTo(0, 6);
    expect(rect.y).toBeCloseTo((619 - rect.h) / 2, 6);
    expect(rect.y + rect.h).toBeCloseTo(619 - rect.y, 6);
  });

  it("keeps the surface offset inside the overlay container", () => {
    // The overlay container spans the whole player section, so the surface
    // box is offset within it; the picture rect must carry that offset.
    const rect = computeMediaRect({ x: 12, y: 34, w: 1100, h: 619 }, 640, 480);
    const centred = computeMediaRect(box, 640, 480);
    expect(rect.x).toBeCloseTo(centred.x + 12, 6);
    expect(rect.y).toBeCloseTo(centred.y + 34, 6);
    expect(rect.w).toBeCloseTo(centred.w, 6);
    expect(rect.h).toBeCloseTo(centred.h, 6);
  });

  it("falls back to the element box when the intrinsic size is unknown", () => {
    // A <video> before metadata, or a canvas that has not been sized yet.
    expect(computeMediaRect(box, 0, 0)).toEqual(box);
    expect(computeMediaRect(box, 1920, 0)).toEqual(box);
    expect(computeMediaRect(box, NaN, 1080)).toEqual(box);
  });

  it("returns a zero rect for an unlaid-out box", () => {
    expect(computeMediaRect({ x: 0, y: 0, w: 0, h: 0 }, 1920, 1080)).toEqual({
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    });
  });
});

describe("rectsEqual", () => {
  const a = { x: 1, y: 2, w: 3, h: 4 };

  it("compares within a sub-pixel epsilon", () => {
    expect(rectsEqual(a, { ...a })).toBe(true);
    expect(rectsEqual(a, { ...a, w: 3.0001 })).toBe(true);
    expect(rectsEqual(a, { ...a, w: 3.5 })).toBe(false);
  });

  it("treats null as its own value", () => {
    expect(rectsEqual(null, null)).toBe(true);
    expect(rectsEqual(a, null)).toBe(false);
    expect(rectsEqual(null, a)).toBe(false);
  });
});
