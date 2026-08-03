# CTA-608 end-to-end verification (#166)

Browser verification of the map [#157](https://github.com/Eyevinn/warp-player/issues/157)
destination, captured against a live `mlmpub -cc608` on 2026-08-03 with
Playwright (headed Chromium), a short-lived EC cert and the `-sideport`
fingerprint on `127.0.0.1`.

| #   | path          | namespace        | codec | screenshot                | result                 |
| --- | ------------- | ---------------- | ----- | ------------------------- | ---------------------- |
| 1   | WebCodecs LOC | `msf/clear`      | AVC   | `e2e-1-loc-avc.png`       | pass                   |
| 2   | WebCodecs LOC | `msf/clear`      | HEVC  | `e2e-2-loc-hevc.png`      | pass                   |
| 3   | MSE CMAF      | `cmsf/clear`     | AVC   | `e2e-3-mse-cmaf-avc.png`  | pass                   |
| 4   | MSE CMAF      | `cmsf/clear`     | HEVC  | `e2e-4-mse-cmaf-hevc.png` | pass                   |
| —   | MSE LOCMAF    | `cmsf/clear`     | AVC   | (log only)                | pass                   |
| 5   | MSE encrypted | `cmsf/eccp-cbcs` | AVC   | `e2e-5-mse-eccp-avc.png`  | **blocked — see #175** |
| 6   | MSE encrypted | `cmsf/eccp-cbcs` | HEVC  | `e2e-6-mse-eccp-hevc.png` | **blocked — see #175** |

Screenshots 5 and 6 show the failure state, not a caption defect: encrypted
playback errors on the first audio packet before any frame renders, and it
reproduces with captions off. See
[#175](https://github.com/Eyevinn/warp-player/issues/175).

Reproduce with the recipe in #175, substituting the namespace and track.

## Defect found and fixed during verification

**The CC button enabled itself on AV1 tracks, where captions can never appear.**
`mlmpub` advertises the CTA-608 accessibility descriptor on all of its video
renditions — AV1 included (6/6 AV1, 6/6 AVC, 6/6 HEVC in the catalog) — but AV1
carries CTA-608 in a `metadata_itu_t_t35` OBU rather than an SEI NAL unit, and
neither extractor reads it. #165 gated availability on the descriptor alone, so
the button enabled, the user turned it on, and nothing rendered with no
indication why.

A collision between two individually-correct decisions: #165 gated on the
descriptor, #161/#162 skipped AV1. No unit test would have caught it — every
layer behaved as specified.

Fixed by requiring **both** the descriptor and a codec that can carry it, by
replacing the MSE side's `av01` deny-list with the shared allow-list
`codecCanCarryCta608()` (an unknown codec previously slipped through into the
SEI walker), and by giving the disabled button a reason string.
