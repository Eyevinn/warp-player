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
