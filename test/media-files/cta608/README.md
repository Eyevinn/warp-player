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
