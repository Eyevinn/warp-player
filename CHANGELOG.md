# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.12.0] - 2026-07-06

LOCMAF packaging advanced to v0.3, and catalog retrieval now uses a relative
joining FETCH aligned to the live edge.

### Added

- "Catalog retrieval" mode selector (joining | subscribe | fetch), replacing the
  old FETCH checkbox. The default retrieves the catalog via SUBSCRIBE plus a
  relative joining FETCH (offset 0), so the player starts from the latest catalog
  group aligned to the live edge.
- `subscribeTrackWithInfo` (exposes the request ID and largest location from
  SUBSCRIBE_OK) and `fetchJoiningRelative` on the transport layer; FETCH message
  types `0x02`/`0x03` in the wire encoder.

### Changed

- LOCMAF packaging advanced to **v0.3**. `LOCMAF_SUPPORTED_VERSIONS` is now
  `{"0.3"}` and an absent `locmafVersion` is assumed to be v0.3. The decoder
  mirrors the Go reference module
  [`github.com/Eyevinn/locmaf`](https://github.com/Eyevinn/locmaf) (normative
  spec: the IETF draft `draft-einarsson-moq-locmaf`):
  - `src/locmaf/vi64.ts` — MOQT (draft-18 §1.4.1) leading-ones varints and
    zigzag, replacing the RFC 9000 varint the v0.2 wire used.
  - `src/locmaf/v03/` — element-sequence decoding (genBox / full header /
    delta header / rawBoxes) under the even-scalar / odd-length-prefixed parity
    rule, full 32-bit sample flags, derived-only delta BMDT, and a hand-rolled
    canonical CMAF writer (`mfhd`/`tfhd`/`tfdt`/`trun` + regenerated
    `saiz`/`saio`/`senc` for protected tracks) that is byte-exact against the
    reference golden vectors.
  - `src/locmaf/locmaf.ts` keeps its four-export surface, so `player.ts` is
    unchanged; the version gate now requires `locmafVersion` "0.3".
  - `src/locmaf/v03/vectors.test.ts` runs a golden-vector conformance ladder
    against the sibling `Eyevinn/locmaf` `testdata/vectors` corpus; it skips
    when the corpus is absent.
- `joiningFetchCatalog` is now the default catalog-retrieval path in the player.
  It falls back to a plain subscription when SUBSCRIBE_OK carries no largest
  location (legacy publisher).

### Removed

- The v0.2 LOCMAF decoder (`src/locmaf/v02/`) and its `senc` writer. LOCMAF v0.2
  remains reachable at the `v0.11.0` tag.

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
