# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development

```bash
# Install dependencies
npm install

# Start development server (HTTPS on port 8080)
npm start
# or
npm run dev

# Build for production
npm run build

# Run tests
npm test

# Run a specific test
npx jest src/buffer/mediaBuffer.test.ts

# Lint code
npm run lint

# Fix linting issues
npm run lint:fix

# Check code styling
npm run pretty

# Fix code formatting issues
npx prettier --write <files>
# or for all files:
npx prettier --write --ignore-unknown .

# Type checking
npm run typecheck
```

### Git Hooks

The project has pre-push hooks that automatically run before pushing:

- TypeScript type checking
- ESLint
- Jest tests

These ensure code quality before changes are pushed to the repository.

## Project Overview

WARP Player is a browser-based TypeScript implementation of a media player,
using the MOQ Transport protocol via WebTransport. It supports MOQ Transport
draft-14 and draft-16 (negotiated through WebTransport ALPN, can be forced
from the UI) and uses the MSF/CMSF catalog format
(draft-ietf-moq-msf-00 / draft-ietf-moq-cmsf-00) to discover media tracks.

Playback runs through one of two interchangeable render pipelines selected
per session:

- **MSE / CMAF** for `packaging: "cmaf"` tracks, with optional EME for
  encrypted content (Widevine, PlayReady, FairPlay, ClearKey).
- **WebCodecs / LOC** for `packaging: "loc"` tracks (draft-mzanaty-moq-loc),
  clear content only, supporting AVC and HEVC video plus AAC and Opus audio.

Both pipelines implement a common `IPlaybackPipeline` interface so the
buffer-control loop, latency reporting, mute toggle, and namespace selector
work uniformly regardless of which engine is active.

### Project Structure

The project follows the Eyevinn TypeScript project template structure:

```
warp-player/
├── src/
│   ├── transport/        # MOQ protocol implementation (draft-14 / draft-16)
│   │   ├── client.ts     # WebTransport client implementation
│   │   ├── setup.ts      # Setup message handling
│   │   ├── tracks.ts     # Track subscription and management
│   │   ├── control.ts    # Control stream handling
│   │   └── version.ts    # Draft version constants and ALPN strings
│   ├── buffer/           # CMAF segment buffering for the MSE pipeline
│   │   ├── mediaBuffer.ts         # CMAF segment parsing
│   │   └── mediaSegmentBuffer.ts  # Buffer management for MSE
│   ├── loc/              # LOC payload helpers for the WebCodecs pipeline
│   │   ├── avc.ts        # AVC NALU walker, AVCDecoderConfigurationRecord
│   │   ├── hevc.ts       # HEVC NALU walker, HEVCDecoderConfigurationRecord
│   │   ├── aac.ts        # AAC AudioSpecificConfig from catalog metadata
│   │   ├── opus.ts       # Opus ID-header (OpusHead) builder
│   │   └── extensions.ts # LOC extension-header parsing (capture timestamps)
│   ├── pipeline/         # Pluggable render pipelines
│   │   ├── index.ts                # IPlaybackPipeline + capability matrix
│   │   ├── msePipeline.ts          # MSE/CMAF pipeline (with optional EME)
│   │   └── webcodecsLocPipeline.ts # WebCodecs/LOC pipeline (clear only)
│   ├── warpcatalog.ts    # MSF/CMSF catalog types and parsing
│   ├── player.ts         # Core player: catalog → tracks → pipeline
│   ├── browser.ts        # Browser entry point and UI handling
│   └── index.html        # HTML template and UI components
├── FINGERPRINT.md        # Documentation for fingerprint feature
├── tsconfig.json         # TypeScript configuration
├── tsconfig.base.json    # Base TypeScript configuration
├── webpack.config.js     # Webpack configuration
├── jest.config.js        # Jest test configuration
├── package.json          # Project dependencies and scripts
└── .github/              # GitHub Actions workflows
    └── workflows/
        ├── ci.yml              # Main CI workflow (lint, test, build)
        ├── commitlint.yml      # Commit message linting
        └── dependency-review.yml # Security checks for dependencies
```

### Core Architecture

The transport used is MOQ Transport, draft-14 or draft-16 (auto-negotiated
via WebTransport ALPN strings `moq-00` and `moqt-16`).

For the catalog, the specification used is MSF (draft-ietf-moq-msf-00)
with CMSF (draft-ietf-moq-cmsf-00) for CMAF packaging. LOC packaging
follows draft-mzanaty-moq-loc.

The codebase is organized into several key modules:

1. **Transport Layer**:
   - Located in `src/transport/`
   - Handles WebTransport connection and MOQ protocol implementation
   - Manages bidirectional control streams and unidirectional data streams
   - Implements client-server setup messaging, track subscription, and data reception

2. **Catalog Layer**:
   - Located in `src/warpcatalog.ts`
   - Parses MSF/CMSF catalogs, including delta updates, content protection,
     and namespace inheritance for tracks that omit an explicit namespace

3. **Buffer Layer (MSE)**:
   - Located in `src/buffer/`
   - Processes incoming media segments (CMAF format)
   - Parses segments and extracts timing information
   - Manages buffering of media segments for the MSE `SourceBuffer`

4. **LOC Layer (WebCodecs)**:
   - Located in `src/loc/`
   - Walks length-prefixed NALUs for AVC/HEVC and synthesizes
     `VideoDecoderConfig.description` (avcC / hvcC) on parameter-set changes
   - Synthesizes `AudioDecoderConfig.description` for AAC (AudioSpecificConfig)
     and Opus (OpusHead) from catalog metadata
   - Parses MoQ Object extension headers to extract LOC capture timestamps

5. **Pipeline Layer**:
   - Located in `src/pipeline/`
   - Defines `IPlaybackPipeline` (`engine`, `setup`, `routeObject`,
     `getLatencySnapshot`, `setBufferConfig`, `setPlaybackRate`,
     `setMuted`, `dispose`) — the common surface used by `player.ts`
   - `MsePipeline` owns the `MediaSource`, `SourceBuffer`s, and (eventually)
     `MediaKeys` / EME state for CMAF tracks
   - `WebCodecsLocPipeline` owns the `VideoDecoder` / `AudioDecoder`,
     a canvas overlay on the `<video>` element, and a wallclock-anchored
     `requestAnimationFrame` render loop synchronized with a single
     `AudioContext` schedule
   - `engineSupports` / `defaultEngineForTracks` / `resolveEngine` encode
     the (engine × packaging × encryption) capability matrix

6. **Player Integration**:
   - Located in `src/player.ts` and `src/browser.ts`
   - Selects the pipeline based on the user's "Render engine" choice
     (`auto` / `mse` / `webcodecs`) and the selected tracks' packaging
   - Filters the namespace selector so namespaces incompatible with the
     active engine (or with ClearKey when unsupported) dim out
   - Drives a buffer-control loop that adjusts playback rate via
     `IPlaybackPipeline.setPlaybackRate` for either engine
   - Renders the engine legend overlay (namespace, engine, DRM, video/audio
     track names)

### Key Components

1. **Client** (`src/transport/client.ts`):
   - Main entry point for establishing WebTransport connections
   - Handles connection setup, track subscription, and message routing
   - Negotiates draft-14 (`moq-00`) vs draft-16 (`moqt-16`) via ALPN

2. **TrackAliasRegistry** (`src/transport/trackaliasregistry.ts`):
   - Manages mappings between track namespaces, names, and aliases
   - Tracks registration of callbacks for data objects

3. **TracksManager** (`src/transport/tracks.ts`):
   - Manages incoming unidirectional streams for data
   - Processes and routes incoming data objects to registered callbacks
   - Surfaces MoQ Object extension headers (used by LOC for capture
     timestamps) on `MOQObject.extensions`

4. **WarpCatalogManager** (`src/warpcatalog.ts`):
   - Parses MSF/CMSF catalogs (full and delta) and applies catalog-level
     namespace inheritance
   - Looks up tracks by namespace + name + role for subscription

5. **IPlaybackPipeline** (`src/pipeline/index.ts`):
   - Common interface for both render engines
   - Capability matrix functions (`engineSupports`, `engineCanPlayTracks`,
     `defaultEngineForTracks`, `resolveEngine`) determine which engine
     plays a given (packaging, encrypted) combination

6. **MsePipeline** (`src/pipeline/msePipeline.ts`):
   - Owns the `MediaSource` / `ManagedMediaSource`, `SourceBuffer`s, and
     the segment + box parsers that feed them
   - Targeted to also own `MediaKeys` / EME state in upcoming phases

7. **WebCodecsLocPipeline** (`src/pipeline/webcodecsLocPipeline.ts`):
   - Owns `VideoDecoder` / `AudioDecoder`, the overlay canvas, the
     `AudioContext`, and the wallclock-anchored render loop
   - Re-configures decoders on parameter-set changes (SPS/PPS for AVC;
     VPS/SPS/PPS for HEVC); audio decoders are configured once from
     catalog metadata
   - Mute is implemented through a `GainNode` between every
     `AudioBufferSourceNode` and the destination

8. **MediaBuffer** (`src/buffer/mediaBuffer.ts`):
   - Parses CMAF initialization and media segments
   - Extracts timing information for media synchronization

9. **MediaSegmentBuffer** (`src/buffer/mediaSegmentBuffer.ts`):
   - Manages the queue of media segments with timing information
   - Provides interfaces for appending to `SourceBuffer` for playback

10. **LOC helpers** (`src/loc/`):
    - `avc.ts` / `hevc.ts` — walk length-prefixed NALUs, extract parameter
      sets, build `VideoDecoderConfig.description` (avcC / hvcC), and
      detect IDR / IRAP keyframes
    - `aac.ts` — build AudioSpecificConfig from catalog `samplerate`,
      `channels`, and `mp4a.OO.A` codec strings
    - `opus.ts` — build the `OpusHead` ID Header from catalog metadata
    - `extensions.ts` — parse moqtransport KeyValuePair extension blobs
      and read LOC property `0x06` (capture timestamp in microseconds
      since the Unix epoch)

## Technical Notes

1. The implementation supports MOQ Transport draft-14 and draft-16, with the MSF/CMSF catalog format (draft-ietf-moq-msf-00 / draft-ietf-moq-cmsf-00) and LOC packaging (draft-mzanaty-moq-loc).
2. WebTransport is available in Chrome 87+, Edge 87+, Firefox, and Safari 26.4+. The WebCodecs render engine additionally requires WebCodecs (Chrome 94+, Edge 94+, Safari 16.4+, Firefox 130+).
3. The client uses MSB (Most Significant Byte) 16-bit length fields for control messages.
4. Media data is delivered either as CMAF (ISO BMFF) for the MSE pipeline or as raw codec payloads (length-prefixed AVC/HEVC NALUs, raw AAC access units, raw Opus packets) for the WebCodecs pipeline.
5. The client includes proper handling of bidirectional control streams for subscribing to content.
6. The player should work fine towards https://github.com/Eyevinn/moqlivemock/cmd/mlmpub as a source.
7. Encrypted content always flows through the MSE engine; production browsers do not expose Encrypted WebCodecs.
8. The project follows the Eyevinn code quality standards with:
   - Conventional commits using commitlint
   - Prettier for code formatting
   - ESLint for code linting
   - TypeScript strict type checking

## Recent Features

### MSF/CMSF Catalog Format

- Catalog parsing follows draft-ietf-moq-msf-00 with CMSF
  (draft-ietf-moq-cmsf-00) for CMAF packaging
- Tracks identify their payload format via the `packaging` field
  (`"cmaf"`, `"loc"`, ...)
- Tracks that omit `namespace` inherit it from the announce namespace of
  the catalog track they were delivered on (see
  `WarpCatalogManager.processCatalog`)
- Delta updates via `addTracks` / `removeTracks` / `cloneTracks` are
  applied on top of the previously delivered catalog
- Content protection is signaled through the `contentProtections` array
  at the catalog root and referenced by `contentProtectionRefIDs` on
  individual tracks (CMSF ContentProtection signaling)

### WebCodecs LOC Pipeline

The player has a second render engine that decodes LOC-packaged tracks
directly with WebCodecs:

- Selectable from the UI ("Auto" / "MSE (CMAF)" / "WebCodecs (LOC)")
- Capability matrix in `src/pipeline/index.ts` decides which engine can
  play a given (packaging, encryption) combination; Auto picks MSE for
  CMAF / encrypted content and WebCodecs for clear LOC content
- Video codecs supported today: AVC (H.264) and HEVC (H.265). Parameter
  sets are extracted from each access unit; the decoder is reconfigured
  whenever VPS / SPS / PPS bytes change
- Audio codecs supported today: AAC-LC and Opus. AudioSpecificConfig
  (AAC) and OpusHead (Opus) are synthesized from the catalog metadata
  and passed as `AudioDecoderConfig.description`
- Render strategy: a canvas overlays the `<video>` element; a wallclock-
  anchored `requestAnimationFrame` loop draws `VideoFrame`s whose
  presentation time is at or before the playhead
- Audio strategy: one `AudioContext` for the session, decoded
  `AudioData` is converted to an `AudioBuffer` and scheduled on a fresh
  `AudioBufferSourceNode` against the same wallclock anchor used by the
  video render loop; a shared `GainNode` implements mute
- Capture timestamps travel in MoQ Object extension headers as LOC
  property `0x06` (microseconds since the Unix epoch); see
  `src/loc/extensions.ts`

### Render Engine Selector and Namespace Filter

- The "Render engine" dropdown lets the user force MSE or WebCodecs (or
  leave it on Auto). Engine choice changes re-render the namespace
  selector so namespaces incompatible with the chosen engine — or with
  ClearKey when the browser does not support it — dim out and become
  unselectable.
- An "Engine legend" overlay on the player surface shows the active
  namespace, render engine, DRM system, and selected video / audio
  track names while playback is active.

### Mute Toggle

- A "Mute / Unmute" button next to Start / Stop controls audio for both
  pipelines. The MSE pipeline uses the `<video>` element's `muted`
  attribute; the WebCodecs pipeline drives a shared `GainNode`. Both
  start muted to match the legacy `<video muted>` UX.

### Draft-14 / Draft-16 Negotiation

- The transport layer supports both MOQ Transport draft-14 (`moq-00`)
  and draft-16 (`moqt-16`), negotiated via WebTransport ALPN. The UI
  exposes an "MOQ Transport draft" dropdown (Auto / Draft 14 / Draft 16) for forcing a specific version.

### Fingerprint Support for Self-Signed Certificates

The player supports connecting to servers with self-signed certificates by providing a fingerprint URL:

- The `Player` constructor accepts an optional `fingerprintUrl` parameter
- The fingerprint is fetched from the URL and used for WebTransport connection
- This feature is useful for development environments
- See `FINGERPRINT.md` for detailed documentation

Note: The fingerprint feature was added to the Player class but the UI has been simplified to only show the server URL field.

## CI/CD

The project uses GitHub Actions for continuous integration:

1. **CI Workflow** (`ci.yml`):
   - Runs on push to main and pull requests
   - Tests on Node.js 20.x and 22.x
   - Runs ESLint, Prettier checks, TypeScript type checking
   - Builds the project and uploads artifacts
   - Uploads test coverage to Codecov

2. **Commit Linting** (`commitlint.yml`):
   - Validates commit messages follow conventional commit format
   - Runs on pull requests

3. **Dependency Review** (`dependency-review.yml`):
   - Security checks for dependencies
   - Runs on pull requests

# Extra instructions

- Use git add -u instead of git add -A to avoid accidentally adding extra files
- Don't mention Claude in commit messages
- When fixing linting issues in PRs, use `npx prettier --write` for formatting fixes
