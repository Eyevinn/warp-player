# CTA-608 → DOM grid rendering — THROWAWAY PROTOTYPE

Primary source for **[warp-player #160](https://github.com/Eyevinn/warp-player/issues/160)**
("Prototype CaptionScreen to on-grid DOM rendering"), part of the overlay-seam map
[#157](https://github.com/Eyevinn/warp-player/issues/157).

**This branch is not for merging.** The validated decision goes into `src/overlay/`
via [#164](https://github.com/Eyevinn/warp-player/issues/164); this code was written
under prototype constraints (no tests, no error handling, no abstractions) and should
be rewritten, not promoted.

## Run it

```sh
python3 -m http.server 8099
open http://127.0.0.1:8099/prototype/cta608-grid/cta608-grid-prototype.html
```

`?variant=A|B|C|D`, or ← / → to cycle. Cases in the dropdown; toggles for the
reference grid, safe area, media aspect, font, box width, the `isEmpty()` gap bug,
and per-rAF repaint.

## Variants

|       | Technique                                                                                                                      | Verdict                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| A     | One box per row, whole row stretched with `scaleX` (dash.js [#5078](https://github.com/Dash-Industry-Forum/dash.js/pull/5078)) | rejected — column accuracy depends on a uniform glyph advance    |
| B     | One CSS grid of 32×15, one grid item per painted cell                                                                          | rejected — glyphs sit loose in their cells; 466 nodes worst case |
| C     | One absolutely-positioned box per style run, each fitted individually                                                          | superseded by D                                                  |
| **D** | **C′ — per-run boxes at exact `left`/`width`, plus ONE `scaleX` per paint from a single probe measurement**                    | **chosen**                                                       |

## Files

- `gen-screens.mjs` — generates `screens.json` from the **real** `@svta/cml-608@1.0.3`
  API, so the fixtures are authentic `CaptionScreen`s rather than hand-built guesses.
  Run with the package extracted alongside; see the import path at the top.
- `screens.json` — 7 fixture cases: `mlmpub`, `grid`, `styles`, `rollup`, `stress`,
  `mixed`, `pathological`.
- `proto.template.html` — the page, with `__FIXTURES__` as the injection point.
- `cta608-grid-prototype.html` — built page (template + inlined fixtures).

Rebuild: `node gen-screens.mjs > screens.json` then inline it into the template.

## What it settled

See the resolution comment on #160. In short: exact per-run boxes so backgrounds never
depend on text measurement; one probe-derived `scaleX` shared by every run; span-fill
between the first and last non-empty cell (with a max-gap guard) so background boxes
stay contiguous across default-styled spaces that `isEmpty()` cannot distinguish from
padding; and the overlay tracks the **picture** rect, not the element box.
