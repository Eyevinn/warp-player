# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Migrated to MoQ Transport draft-18. This is a breaking change with no
compatibility shim: the player no longer speaks drafts 14 or 16, and needs a
draft-18 server such as `mlmpub` at moqtransport v0.11.0 or later.

### Changed

- **The transport speaks draft-18 (`moqt-18`) and nothing else.** From
  draft-17 the ALPN _is_ the version negotiation -- SETUP carries no version
  field -- so a server that does not offer `moqt-18` cannot be spoken to and
  the connection fails rather than falling back. Drafts 14 and 16 were dropped
  for the same reason `moqtransport` dropped them: the wire below the ALPN
  changed enough that carrying both would mean maintaining two codecs rather
  than branching a few fields.
- **Varints are vi64**, the leading-ones encoding of draft-18 Section 1.4.1,
  not the RFC 9000 two-bit-prefix form. The codec `src/locmaf/vi64.ts` already
  had for LOCMAF is now the canonical one at `src/transport/vi64.ts` -- vi64 is
  defined by MOQT, so the transport owns it -- and `src/locmaf/vi64.ts`
  re-exports it so LOCMAF's golden-vector tests are untouched.
- **The control stream is a pair of unidirectional streams**, one per
  direction, replacing the single bidirectional stream. Each side opens its own
  and sends SETUP on it; the leading varint 0x2F00 is simultaneously the stream
  type and SETUP's message type, so opening and sending are one act.
- **Each request owns a bidirectional stream.** The stream is the request's
  identity, so responses carry no Request ID and the `(kind, requestId)`
  dispatch table is gone. Closing the stream is what ends a request -- draft-18
  has no UNSUBSCRIBE or UNANNOUNCE message.
- SUBSCRIBE's fixed fields moved into Message Parameters: subscriber priority,
  group order, forward and the subscription filter are all parameters now, and
  the largest location comes back as the `LARGEST_OBJECT` parameter of
  SUBSCRIBE_OK rather than a field.
- Subgroup stream types gained a FIRST_OBJECT flag, and the reserved
  SUBGROUP_ID_MODE 0b11 is now rejected as a protocol violation.
- FETCH response streams were rewritten: every record begins with Serialization
  Flags, fields are deltas against the prior Object, and End of Range
  indicators stand in for runs of Objects that were not serialized.
- PADDING streams are recognised and drained.

### Fixed

- **The LOC capture timestamp is read from Object Property `0x10`**, not
  `0x06`. MOQT's Properties registry allocates `0x06` to
  SUBGROUP_DELIVERY_TIMEOUT, which is Track scope only, so a `0x06` Object
  Property makes the track malformed from draft-18 onwards.
  draft-ietf-moq-loc-03 renumbered it to `0x0A` for that reason and draft-04
  moved it again to `0x10` as the registry table settled. Object Property types
  are also delta-encoded now, which a draft-16 parser reads as the wrong types
  from the second pair onwards. Together these two made the video buffer read
  as a nonsense figure -- 33378172119 ms in testing -- with playback never
  stabilising.

## [0.13.1] - 2026-08-29

A playback-rate stability fix for the WebCodecs (LOC) engine, and the audible
audio artefact that came with it.

### Fixed

- The WebCodecs latency controller no longer flaps the playback rate. Its
  input is `Date.now() - lastPresentedMs`, and the picture clock only advances
  when a frame is painted, so the reading is a sawtooth one frame interval
  deep — 40 ms at 25 fps. The rate branches compared it strictly against the
  target, so the controller sat permanently in the speed-up or slow-down
  branch and re-derived a rate every tick, settling into a ~1.003 / ~0.994
  oscillation twice a second.

  Each rate change re-anchors the audio schedule, and `onDecodedAudio`
  recomputes every chunk's start from the anchor rather than from the previous
  chunk's end, so the next chunk shifted by roughly
  `lead × (1/r_new − 1/r_old)` — about 1.8 ms, or 87 samples at 48 kHz. A gap
  or overlap between two `AudioBufferSourceNode`s twice a second, heard as a
  click on the 880 Hz test tone, for both AAC and Opus.

  The reading is now exponentially smoothed, and the controller has
  hysteresis: it engages past 60 ms of error and disengages back to exactly
  1.0x once inside 30 ms. The buffer-underrun guard still bypasses the
  deadband — that is starvation protection, not latency trimming — and the
  in-deadband case sets 1.0 explicitly, so a rate set during a transient can
  no longer persist. The MSE engine is unaffected: `<video>.currentTime` is
  continuous and never carried the sawtooth.

## [0.13.0] - 2026-08-06

In-band CTA-608 captions on both render engines, delivered through a general
timed-text overlay seam that WebVTT, IMSC-1 and ograf renderers can also use.

### Added

- Timed-text overlay seam (`src/overlay`): a snapshot timeline with `push`
  (open-ended state) and `addCue` (intervals) channels, resolved by search
  against the picture clock. Renderers own a DOM subtree and are re-rendered
  on change only.
- CTA-608 CC1 captions decoded from in-band SEI on **both** engines — MSE
  (CMAF and LOCMAF) and WebCodecs (LOC) — and painted on the true 32x15 grid
  inside the CTA-608 safe area, with colours, background boxes and the
  pop-on / roll-up / paint-on screen model. Encrypted namespaces are covered
  too: the caption SEI sits in the clear subsample leader, so no key is
  needed to read it.
- CC toggle, enabled only when the selected video track advertises
  `urn:scte:dash:cc:cea-608:2015` **and** its codec can carry CTA-608;
  default off, and struck through when captions are impossible for the track.
- AV1 video on the WebCodecs LOC pipeline: raw OBU temporal units fed to the
  decoder, with keyframes and reconfiguration driven by the in-band sequence
  header. AV1 carries CTA-608 in a metadata OBU rather than an SEI NAL unit,
  so AV1 renditions play but are not captioned.
- `IPlaybackPipeline.getPresentationTimeMs()` — the presentation time of the
  picture on screen, implemented by both render engines.
- End-to-end verification record with screenshots under
  `docs/verification/cc608/`.

### Changed

- TypeScript `target` and `lib` raised to ES2022.
- ESLint 10, with `eslint-plugin-import` replaced by the maintained
  `eslint-plugin-import-x` fork; the two unused prettier packages are gone,
  leaving Prettier to run standalone.

### Fixed

- Overlays no longer stack: each Connect built a fresh `Player` without
  disposing the outgoing one, leaking a renderer root and a
  `requestAnimationFrame` loop every time.
- No background box is painted around a cell holding no glyph — the mid-row
  code that has to precede a coloured row was briefly showing as a lone box
  while a paint-on or roll-up row was still arriving.
- The CC button no longer enables itself on tracks whose codec cannot carry
  CTA-608, where turning it on could never show anything.

## [0.12.0] - 2026-07-06

See the README for details on the catalog, packaging, and buffer control.

### Added

- Catalog-retrieval selector (joining | subscribe | fetch); joining FETCH default.
- Tunable per-engine/browser buffer profiles in `config.json` (`bufferProfiles`).

### Changed

- LOCMAF packaging updated to **v0.3** via the `Eyevinn/locmaf` module.
- Reworked MSE latency control (fixed-cadence loop, live-edge resync); 200/300 ms
  is stable across engines and browsers.
- A CMAF video and a LOCMAF audio may now be selected together.
- Playback starts on the minimal buffer; segment-buffer cap raised 30 → 64.
- Catalog references updated to MSF/CMSF draft-01.

### Removed

- The in-tree LOCMAF v0.2 decoder (available at the `v0.11.0` tag).

## [0.11.0] - 2026-06-04

MSF/CMSF catalog support updated to draft-ietf-moq-msf-01, with the new
catalog-level init data references and string version signaling.

### Changed

- Catalog parsing now follows draft-ietf-moq-msf-01:
  - `version` is a JSON string and is validated: only `"draft-01"` is
    accepted (`MSF_SUPPORTED_VERSION`); catalogs advertising any other
    version are rejected per §5.1.1
  - Initialization data lives in a catalog-level `initDataList`, and each
    track references an entry by `initRef`; a CMAF track and its LOCMAF
    counterpart share one entry. Resolve via
    `WarpCatalogManager.getInitData(track)`
  - Delta updates are an ordered `deltaUpdate` array of `{op, tracks}`
    operations
- The catalog viewer truncates the shared `initDataList` payloads for
  readability instead of the removed per-track `initData` field

### Removed

- LOCMAF v0.1 decoder and its tests; `LOCMAF_SUPPORTED_VERSIONS` is now
  `{"0.2"}` and an absent `locmafVersion` is assumed to be v0.2.
  `src/locmaf/locmaf.ts` is a thin v0.2-only wrapper over
  `src/locmaf/v02/decoder.ts`

## [0.10.0] - 2026-06-02

LOCMAF v0.2 wire-format support, decoded alongside v0.1 and played through
the MSE pipeline.

### Added

- LOCMAF v0.2 decoder under `src/locmaf/v02/`, selected per track via the
  catalog `locmafVersion` field
  - Version dispatch in `src/locmaf/locmaf.ts`: `LOCMAF_SUPPORTED_VERSIONS`
    now accepts both `"0.1"` and `"0.2"`, routing v0.2 tracks to the new
    decoder while v0.1 continues through the existing path
  - Shared `senc` (sample encryption) helpers in `src/locmaf/senc.ts`
    reused across versions
  - Unit tests and a test encoder for the v0.2 wire format

### Fixed

- v0.2 `moof` `track_ID` is derived from the init segment's `tkhd`,
  falling back to `trex`

## [0.9.0] - 2026-05-17

LOCMAF (compressed CMAF) packaging support, decoded into CMAF and played
through the MSE pipeline.

### Added

- LOCMAF packaging support for tracks advertising `packaging: "locmaf"`
  in the CMSF catalog
  - New `src/locmaf/` module parses LOCMAF init, full `moof`, and delta
    `moof` objects per the v0.1 wire format and reconstructs standard
    CMAF init / media segments for the MSE pipeline
  - Header type values `LOCMAF_HEADER_MOOV` (21), `LOCMAF_HEADER_MOOF`
    (23), and `LOCMAF_HEADER_MOOF_DELTA` (25), with QUIC varint encoding
    for length fields
  - `baseMediaDecodeTime` is derived in delta `moof` headers; sample
    sizes are inferred when only one sample is sent per CMAF chunk
  - Receiver gated on `locmafVersion` from the catalog Track
    (`LOCMAF_SUPPORTED_VERSION = "0.1"`)
  - Engine capability matrix updated so `locmaf` routes through MSE
    alongside `cmaf`
- Test fixtures and unit tests under `test/locmaf-test-files/` and
  `src/locmaf/locmaf.test.ts`

### Changed

- MSE pipeline avoids double parsing of LOCMAF/CMAF chunks
- Test media moved to `test/media-files/`
- Bumped development dependencies (TypeScript 5.9 → 6.0,
  `@commitlint/cli` 20 → 21, `@commitlint/config-conventional`)
- Bumped production dependencies (5-update group)
- Bumped `actions/dependency-review-action` GitHub Action from 4 to 5

## [0.8.0] - 2026-05-05

WebCodecs LOC playback engine alongside the existing MSE/CMAF engine.

### Added

- WebCodecs render pipeline for `packaging: "loc"` tracks
  ([draft-mzanaty-moq-loc])
  - AVC (H.264) and HEVC (H.265) video, decoded with `VideoDecoder` and
    drawn onto a canvas overlaid on the `<video>` element via a
    wallclock-anchored `requestAnimationFrame` loop
  - AAC-LC and Opus audio, decoded with `AudioDecoder` and scheduled on
    a single `AudioContext` sharing the video render loop's wallclock
    anchor for gap-free playback
  - LOC parser and decoder helpers under `src/loc/` (NALU walking,
    `AVCDecoderConfigurationRecord` / `HEVCDecoderConfigurationRecord`
    builders, AAC `AudioSpecificConfig` and Opus `OpusHead` synthesis,
    LOC extension-header parsing for capture timestamps)
- Pluggable pipeline abstraction (`IPlaybackPipeline`) with capability
  matrix for (engine × packaging × encryption); `MsePipeline` and
  `WebCodecsLocPipeline` implementations under `src/pipeline/`
- "Render engine" UI selector (`Auto` / `MSE (CMAF)` / `WebCodecs (LOC)`)
  that filters the namespace selector so namespaces incompatible with
  the chosen engine dim out
- Engine legend overlay on the player surface showing active namespace,
  engine, DRM system, and selected video / audio track names
- Mute / Unmute button that drives a `GainNode` for WebCodecs and the
  `<video muted>` attribute for MSE

### Fixed

- Catalog tracks without an explicit `namespace` now inherit the
  announce namespace of the catalog track they were delivered on
- Safari no longer flags `WebTransport.closed` rejection during normal
  disconnect

### Changed

- Bumped development dependencies (@types/node, prettier, webpack)
- Bumped production dependencies (@commitlint/\*, @typescript-eslint/\*,
  globals, html-webpack-plugin, typescript-eslint)

[draft-mzanaty-moq-loc]: https://datatracker.ietf.org/doc/html/draft-mzanaty-moq-loc

## [0.7.1] - 2026-04-12

### Added

- ManagedMediaSource support for iOS Safari playback — the player now
  uses `ManagedMediaSource` when available, falling back to
  `MediaSource` elsewhere

## [0.7.0] - 2026-04-12

### Added

- MOQ Transport draft-16 support with dual draft-14 / draft-16
  negotiation via WebTransport ALPN (`moq-00` / `moqt-16`); UI
  exposes an MOQ Transport draft selector

### Changed

- Bumped development dependencies (webpack-cli)
- Bumped production dependencies (5-update group)
- Bumped `codecov/codecov-action` GitHub Action from 5 to 6

## [0.6.0] - 2026-04-11

Full [MOQ Transport draft-14][moqt-d14] compliance release.

### Added

- DRM support via Encrypted Media Extensions (EME)
  - ClearKey DRM for development and testing
  - Commercial DRM support (Widevine, PlayReady, FairPlay)
  - DRM configuration via common field at the root level in the CMSF catalog
- Safari 26.4+ and Firefox browser support

### Fixed

- Object ID delta encoding in subgroup streams per draft-14 spec
- FairPlay DRM support with event-driven key session flow
- Updated draft-14 stream types to match specification
- Added PUBLISH_NAMESPACE_OK response to server announcements

### Changed

- Renamed announce terminology to publish namespace per draft-14
- Bumped development dependencies (@types/node, jest, webpack)
- Bumped production dependencies (@commitlint/cli, @typescript-eslint/\*, globals, serve, typescript-eslint)

## [0.5.0] - 2026-01-27

### Added

- Catalog format upgrade to MSF/CMSF v0
  - Implemented draft-ietf-moq-msf-00 for catalog structure
  - Implemented draft-ietf-moq-cmsf-00 for CMAF packaging
  - Updated catalog parsing to support new format
- Navigation improvements
  - External links now open in new tabs to preserve player interface
  - Added proper security attributes (rel="noopener noreferrer") to all external links

### Changed

- Standardized MOQ terminology throughout codebase
  - Changed spelling from MoQ to MOQ in all documentation and code
  - Removed "Media over QUIC" references, replaced with MOQ
  - Updated "MOQ Spec" link to "MOQT Spec" for clarity
  - Renamed `MoQObject` interface to `MOQObject` for consistency

## [0.4.1] - 2026-01-12

### Fixed

- Catalog race condition where data arrives before SUBSCRIBE_OK message
  - Added transport-layer buffering with 500ms retry window
  - Objects buffered locally while waiting for track registration
  - Automatic delivery of buffered objects when track registers
  - Buffer overflow protection (max 50 objects)
- Spurious error messages when stopping playback
  - Added graceful shutdown handling with isClosing flag
  - Suppresses expected errors during normal stop operation

### Changed

- Reduced SUBSCRIBE_OK timeout from 10s to 2s for faster failure detection

### Added

- URL parameter support for connection settings (`?serverUrl=...&fingerprintUrl=...`)
- localStorage persistence for connection settings across page reloads
- `fingerprintUrl` field in config.json
- Configuration priority: URL params → localStorage → config.json → defaults

## [0.4.0] - 2026-01-09

### Added

- Version display in UI header
- REQUESTS_BLOCKED message handling with logging and unit tests
- MAX_REQUEST_ID parameter to CLIENT_SETUP message

### Changed

- Upgraded to MOQ Transport [draft-14][moqt-d14] compatibility
- Updated protocol implementation for draft-14 changes

## [0.2.0] - 2025-05-24

### Added

- WebTransport fingerprint authentication support for self-signed certificates
- Improved buffer and latency control mechanisms
- Component-based configurable logging system
- WebTransport browser support detection with user warning
- Dark theme and modernized UI layout
- GitHub Actions CI/CD workflows with automated testing
- Pre-commit hooks for code quality

### Changed

- Aligned project structure with Eyevinn TypeScript template
- Migrated configuration files to ES modules (.mjs)
- Updated ESLint to v9 with flat config format

### Fixed

- Catalog subscription error handling
- Correct connection state management for Start/Stop buttons

## [0.1.0] - 2025-05-19

### Added

- Initial player implementation following MOQ Transport draft-11
- WebTransport client with bidirectional control stream support
- Catalog parsing and track subscription
- MSE-based media playback with CMAF segment handling
- Basic UI with connection controls and playback information
- Support for video and audio track selection
- Real-time playback metrics (buffer levels, latency, playback rate)

[Unreleased]: https://github.com/Eyevinn/warp-player/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/Eyevinn/warp-player/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/Eyevinn/warp-player/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Eyevinn/warp-player/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/Eyevinn/warp-player/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Eyevinn/warp-player/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Eyevinn/warp-player/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Eyevinn/warp-player/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Eyevinn/warp-player/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Eyevinn/warp-player/compare/v0.2.0...v0.4.0
[0.2.0]: https://github.com/Eyevinn/warp-player/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Eyevinn/warp-player/releases/tag/v0.1.0
[moqt-d11]: https://datatracker.ietf.org/doc/draft-ietf-moq-transport/11/
[moqt-d14]: https://datatracker.ietf.org/doc/draft-ietf-moq-transport/14/
