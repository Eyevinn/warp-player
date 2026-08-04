# CTA-608 end-to-end verification (#166)

Browser verification of the map [#157](https://github.com/Eyevinn/warp-player/issues/157)
destination, captured against a live `mlmpub -cc608` with a short-lived EC cert
and the `-sideport` fingerprint on `127.0.0.1`.

Rows 1–4 were captured on 2026-08-03; rows 5 and 6 on 2026-08-04 in real Google
Chrome 150 (`navigator.userAgentData.brands` includes `Google Chrome`), after
the publisher-side ClearKey fix
([Eyevinn/moqlivemock#122](https://github.com/Eyevinn/moqlivemock/issues/122)).

| #   | path          | namespace        | codec | screenshot                | result |
| --- | ------------- | ---------------- | ----- | ------------------------- | ------ |
| 1   | WebCodecs LOC | `msf/clear`      | AVC   | `e2e-1-loc-avc.png`       | pass   |
| 2   | WebCodecs LOC | `msf/clear`      | HEVC  | `e2e-2-loc-hevc.png`      | pass   |
| 3   | MSE CMAF      | `cmsf/clear`     | AVC   | `e2e-3-mse-cmaf-avc.png`  | pass   |
| 4   | MSE CMAF      | `cmsf/clear`     | HEVC  | `e2e-4-mse-cmaf-hevc.png` | pass   |
| —   | MSE LOCMAF    | `cmsf/clear`     | AVC   | (log only)                | pass   |
| 5   | MSE encrypted | `cmsf/eccp-cbcs` | AVC   | `e2e-5-mse-eccp-avc.png`  | pass   |
| 6   | MSE encrypted | `cmsf/eccp-cbcs` | HEVC  | `e2e-6-mse-eccp-hevc.png` | pass   |

Reproduce with:

```sh
mlmpub -cc608 -cert cert.pem -key key.pem -asset assets/test10s \
  -kid 11223344556677889900aabbccddeeff -cenckey ffeeddccbbaa00998877665544332211 \
  -iv 0123456789abcdef0123456789abcdef -sideport 8081 -addr 127.0.0.1:4443
npx webpack serve --port 8090
# http://localhost:8090/?serverUrl=https://127.0.0.1:4443/moq&fingerprintUrl=http://127.0.0.1:8081/fingerprint
```

## Per-run checks

Measured on the encrypted AVC run (row 5) and spot-checked on the others:

- **Grid geometry.** The 32-column grid spans the CTA-608 safe area — 80% of the
  video width (1119 × 0.8 = 895.2 px = 32 × 27.975 px). Row 13 starts at exactly
  column 10 and row 14 at column 8, both integer column positions, and 12 chars
  centred in 32 columns is column 10 as expected. Row boxes are opaque black and
  vertically contiguous (578.78 + 33.57 = 612.35, the next row's top). Row 13 is
  white, row 14 yellow, both monospace.
- **No left drift.** Row left edges were byte-identical across a 3 s window
  spanning three caption changes (424.65 px both samples, drift 0.00 px).
- **Advances once per second, in step.** Sampling the overlay every 200 ms gave a
  new caption at 1000 ms intervals with `GRP n` incrementing by exactly 1 — not
  frozen and not stepping at segment boundaries.
- **Publisher offset.** `GRP n` appears ~0.79 s into the group whose time it
  names (caption `GRP 1785840079` on screen at `currentTime` 1785840079.79),
  consistent with the ~0.63–0.76 s scheduling offset documented in
  [Eyevinn/moqlivemock#118](https://github.com/Eyevinn/moqlivemock/issues/118).
  `GRP n` is on screen during group `n`, so this is the expected constant offset
  rather than a player defect.
- **CC button.** Disabled before playback starts, enabled on captioned tracks
  once playing, starts `CC Off` with `aria-pressed=false`, and toggles cleanly to
  `CC On`. On AV1 it stays disabled with the reason string, since AV1 carries
  CTA-608 in a metadata OBU that neither extractor reads.
- **Switch survival.** Across an AVC → HEVC track switch and an
  `cmsf/eccp-cbcs` (MSE) → `msf/clear` (WebCodecs) namespace **and** engine
  switch: exactly one renderer root throughout, no stuck row carried over from
  the previous session, and captions resume advancing once per second on the new
  engine. The CC on/off intent persists across the switch by design.

Encrypted (ClearKey) video is not blanked in screen captures, so rows 5 and 6
show real decoded frames.

## Defects found and fixed during verification

**1. The CC button enabled itself on AV1 tracks, where captions can never appear.**
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

**2. Overlays stacked, one per Connect.** `browser.ts` builds a fresh `Player`
on every Connect to pick up the current server URL, fingerprint and draft
choice, but never disposed the outgoing one. Its overlay renderer root lives in
the shared `#captionOverlay` container and `DomOverlayLayer.attach()` starts the
resolution loop immediately, so neither was reclaimable: each Connect left
another root **and** another `requestAnimationFrame` loop behind, and captions
were painted by a stack of overlays (two after the first Connect, one more per
reconnect). `Player.dispose()` already did the right thing and simply had no
caller.

Worth noting for the "no duplicated rows" check: stacked overlays are exactly
what that check exists to catch, and it took DOM inspection rather than looking
at the screen to notice — the stacked rows are pixel-identical and land on top
of each other.

## Blocked-then-unblocked: the encrypted rows

Rows 5 and 6 were originally captured in the failure state and filed as
[#175](https://github.com/Eyevinn/warp-player/issues/175), first diagnosed as a
missing-`senc` audio protection-signalling regression. That diagnosis was wrong
on both counts — it was neither a player bug nor a signalling change:

- The absent `senc`/`saiz`/`saio` on cbcs audio is deliberate. mp4ff's
  `EncryptFragment` drops them for full-sample constant-IV encryption per CMAF
  (ISO/IEC 23000-19) Sec. 8.2.2.1, and that behaviour is already in the mp4ff
  that moqlivemock v0.12.0 pins (`v0.52.1-0.20260703130654`), whose audio Chrome
  plays. Audio `tenc` (`isProtected=1`, per-sample IV size 0, 16-byte constant
  IV, pattern 0:0) is structurally identical between v0.12.0 and HEAD.
- The real cause was `mlmpub`'s `/clearkey` endpoint serving the requested KID
  back as the content key while the media was encrypted with `-cenckey`, so EME
  decrypted with the wrong key and the decoder failed on the first packet
  ([Eyevinn/moqlivemock#122](https://github.com/Eyevinn/moqlivemock/issues/122)).
  `encrypted=0` in Chrome's error is the _decrypted_ buffer reaching the decoder,
  not evidence that the sample was treated as clear — that flag is what sent the
  first diagnosis down the signalling path.
