# Subtitle test objects

Real `mlmpub` subtitle output (Eyevinn/moqlivemock with mp4ff v0.57.0, branch
`feat/paint-model-subtitles`), used by `src/subtitles/*.test.ts`. Each format
has its init segment, `<format>_init.mp4`, shared by both packagings, and one
file of MoQ objects per packaging, `<format>_<cmaf|locmaf>.objs`.

| Format | Groups | Notes |
|---|---|---|
| `stpp` | 1000000 | a full TTML document in every object |
| `stpc` | 1000000–1000001 | paint model, with body-only `ttmb` samples (`-subsstpcbody`) |
| `wvtt` | 1000000–1000001 | WebVTT cue boxes, `vtte` where nothing shows |
| `wvtc` | 1000000–1000001 | paint model: `vttn` for every restatement |

A group is one second with 25 objects of 40 ms, one per video frame of the
25 fps test content. Its cue starts at the group start (UTC second 1000000 is
1970-01-12T13:46:40Z) and lasts 900 ms, so it ends 20 ms into object 22.

An `.objs` file is the objects in order, each as a 12-byte header of three
big-endian uint32 values — group ID, object ID, payload length — followed by
the payload. They were written by a throwaway test in moqlivemock's
`internal` package that calls `GenSubtitleGroup(st, group, 1000, packaging)`
for a track with `Cadence{TimeScale: 12800, SampleDur: 512, SampleBatch: 1}`
and `Body: true`, and `st.SpecData.GenCMAFInitData()` for the init segment.
