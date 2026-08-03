# CTA-608 test fragments

`608_h264.m4s` and `608_h265.m4s` are copied verbatim from the
[Common Media Library](https://github.com/streaming-video-technology-alliance/common-media-library)
(`libs/608/test/fixtures/`), maintained by the Streaming Video Technology
Alliance and licensed under the **Apache License, Version 2.0**.

Each file is a single CMAF media fragment (`styp` + `moof` + `mdat`) with 60
video samples, carrying CTA-608 captions in SEI user-data on two samples. CC1
reads `"eng: 00:01:06:00"` and then `"eng: 00:01:07:00"`; the two fragments
yield byte-identical caption field data despite the different NAL header
sizes.

They cover complementary `trun`/`tfhd` shapes, which is why both are used for
the timeline-mapping tests:

| | `608_h264.m4s` | `608_h265.m4s` |
| --- | --- | --- |
| codec | AVC (1-byte NAL header) | HEVC (2-byte NAL header) |
| timescale | 90000 | 15360 |
| `tfdt.baseMediaDecodeTime` | 5940000 (66 s), version 0 | 0, version 1 |
| sample durations | per-sample in `trun` (3000) | `tfhd.default_sample_duration` (512) |
| sample sizes | per-sample in `trun` | per-sample in `trun` |
| composition offsets | present | present |
| caption samples (decode order) | 0 and 30 | 0 and 29 |

Neither file carries an init segment, so the timescales above are supplied by
the tests. They are pinned by the content itself: the AVC fragment's `tfdt`
divided by 90000 is exactly the 66 s its caption announces, and in both files
the two caption samples are exactly 1.0 s apart in presentation time.

## Encrypted fragments (cbcs subsample encryption)

`enc_cbcs_h264.m4s` and `enc_cbcs_h265.m4s` were captured from
`mlmpub -cc608` on the **`cmsf/drm-cbcs`** namespace (Eyevinn/moqlivemock) and
are used by the encryption tests for
[#163](https://github.com/Eyevinn/warp-player/issues/163). Each is 30
consecutive `moof`+`mdat` pairs — one MoQ object per fragment, one sample per
fragment at 25 fps — concatenated into a single buffer, so they also exercise
the extractor's multi-`moof` path. Timescale for both is **12800**.

Every fragment carries a `senc` box; the media is genuinely encrypted and no
key is needed (or available) to read the captions out of it. The captions are
injected **before** encryption, and cbcs leaves them in the clear:

| | `enc_cbcs_h264.m4s` | `enc_cbcs_h265.m4s` |
| --- | --- | --- |
| codec | AVC `avc1.4D401F` | HEVC `hvc1.1.6.L93.90` |
| fragments / samples | 30 | 30 |
| first sample size | 16875 B | 17829 B |
| subsample layout | 1 subsample: **100 B clear**, 16775 B protected | 1 subsample: **119 B clear**, 17710 B protected |
| NAL #0 | type 6 (SEI), 87 B — **entirely inside the clear run** | type 39 (prefix SEI), 88 B — **entirely inside the clear run** |
| NAL #1 | type 5 (IDR slice, VCL) — extends into the protected run | type 20 (IDR VCL) — extends into the protected run |
| CC1 screen | `04:51:12.000` / `GRP 1785732672` | `04:51:16.000` / `GRP 1785732676` |

That layout is the whole reason the plain length-prefixed walk works unchanged
on encrypted media: the clear leader covers the non-VCL NAL units and the
start of the VCL NAL unit, and **only part of the VCL NAL unit is encrypted**.
NAL length prefixes are never encrypted, so a prefix-driven walk steps over
ciphertext using clear lengths and never interprets an encrypted byte as
structure.

The `cmsf/eccp-cbcs` namespace is **not** represented by a separate fixture,
deliberately: ECCP differs from commercial DRM only in key delivery (ClearKey
`systemID` and a `laURL` the player can actually use), not in the bitstream —
the same encryptor produces the same cbcs subsample layout for both. Capturing
it is also awkward, because `mlmsub` holds the ClearKey and decrypts ECCP
content on the way out, so what it writes is plaintext.
