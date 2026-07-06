<h1 align="center">
  WARP Player
</h1>

<div align="center">
  A browser-based Media Player for MOQ protocol with WARP support
  <br />
  <br />
</div>

<div align="center">
<br />

[![npm](https://img.shields.io/npm/v/@eyevinn/warp-player?style=flat-square)](https://www.npmjs.com/package/@eyevinn/warp-player)
[![github release](https://img.shields.io/github/v/release/Eyevinn/warp-player?style=flat-square)](https://github.com/Eyevinn/warp-player/releases)
[![license](https://img.shields.io/github/license/eyevinn/warp-player.svg?style=flat-square)](LICENSE)

[![CI](https://github.com/Eyevinn/warp-player/actions/workflows/ci.yml/badge.svg)](https://github.com/Eyevinn/warp-player/actions/workflows/ci.yml)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-ff69b4.svg?style=flat-square)](https://github.com/eyevinn/warp-player/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22)

</div>

## Overview

This project implements a media player that:

1. Establishes a WebTransport connection to a MOQ server
2. Negotiates MOQ Transport draft-14 or draft-16 with the server
3. Subscribes to and parses MSF/CMSF catalogs for available media
   ([draft-ietf-moq-msf-01], [draft-ietf-moq-cmsf-01])
4. Subscribes to selected media tracks through the MOQ transport protocol
5. Renders media through one of two interchangeable pipelines:
   - **MSE** for CMAF (`packaging: "cmaf"`) and LOCMAF
     (`packaging: "locmaf"`, [draft-einarsson-moq-locmaf]), with optional EME
     for protected content
   - **WebCodecs** for LOC (`packaging: "loc"`, [draft-mzanaty-moq-loc]), clear content only
6. Provides adaptive buffer management for a smooth playback experience
7. This player is intended to work towards the [moqlivemock][moqlivemock]
   publisher and uses the CMSF ContentProtection signaling
   ([moq-wg/cmsf](https://github.com/moq-wg/cmsf)) for DRM

## Catalog and Packaging

Media is discovered through an MSF/CMSF catalog and delivered in one of three
packagings:

- **CMAF** (`packaging: "cmaf"`) — standard fragmented MP4, played through MSE.
- **LOCMAF** (`packaging: "locmaf"`, [draft-einarsson-moq-locmaf]) — a compact
  CMAF packaging (wire version 0.3) that trims per-object overhead on the wire.
  Objects are reconstructed into standard CMAF chunks before MSE append, so
  LOCMAF and CMAF share the same init data and render path. Decoding mirrors the
  reusable [`Eyevinn/locmaf`](https://github.com/Eyevinn/locmaf) reference
  implementation; only LOCMAF packaging version `0.3` is accepted.
- **LOC** (`packaging: "loc"`, [draft-mzanaty-moq-loc]) — raw codec frames,
  decoded directly by the WebCodecs pipeline (clear content only).

Catalogs follow **MSF [draft-ietf-moq-msf-01]** with **CMSF
[draft-ietf-moq-cmsf-01]** for CMAF packaging. The catalog `version` string must
be `"draft-01"`. Initialization data lives in a catalog-level `initDataList`,
and each track references an entry by `initRef` — so a CMAF track and its LOCMAF
counterpart share one init-data entry. Content protection (Widevine, PlayReady,
FairPlay, and ClearKey) is signaled through the CMSF ContentProtection catalog
fields; draft-ietf-moq-cmsf-01 is the revision that carries the `initData` and
DRM/ContentProtection catalog fields this player relies on.

Catalog documents can be checked against the draft-01 schema with the
[msf-catalog-validator](https://github.com/Eyevinn/msf-catalog-validator), which
validates MSF/CMSF draft-01 catalogs including the `locmaf` packaging and
`locmafVersion`.

## Requirements

- A modern browser that supports WebTransport (Chrome 87+, Edge 87+, Firefox, or Safari 26.4+)
- For the WebCodecs pipeline, a browser that exposes the WebCodecs API
  (Chrome 94+, Edge 94+, Safari 16.4+, Firefox 130+)
- A MOQ server that supports draft-14 or draft-16 such as moqlivemock
- Node.js version 20+

## Project Structure

```
warp-player/
├── src/
│   ├── transport/        # MOQ protocol implementation (draft-14 / draft-16)
│   │   ├── client.ts     # WebTransport client implementation
│   │   ├── setup.ts      # Setup message handling
│   │   ├── tracks.ts     # Track subscription and management
│   │   ├── control.ts    # Control stream handling
│   │   └── version.ts    # Draft version constants and ALPN negotiation
│   ├── buffer/           # CMAF segment buffering for the MSE pipeline
│   │   ├── mediaBuffer.ts         # CMAF segment parsing
│   │   └── mediaSegmentBuffer.ts  # Buffer management for MSE
│   ├── loc/              # LOC payload helpers for the WebCodecs pipeline
│   │   ├── avc.ts        # AVC (H.264) NALU walker / avcC builder
│   │   ├── hevc.ts       # HEVC (H.265) NALU walker / hvcC builder
│   │   ├── aac.ts        # AAC AudioSpecificConfig from catalog metadata
│   │   ├── opus.ts       # Opus ID-header (OpusHead) from catalog metadata
│   │   └── extensions.ts # LOC extension-header parsing (capture timestamps)
│   ├── locmaf/           # LOCMAF (compact CMAF packaging) for the MSE pipeline
│   │   ├── locmaf.ts     # Version-gating wrapper (LOCMAF v0.3 only)
│   │   ├── vi64.ts       # MOQT (draft-18 §1.4.1) varints + zigzag
│   │   └── v03/          # v0.3 codec: decoder + canonical CMAF reconstruction
│   ├── pipeline/         # Pluggable render pipelines
│   │   ├── index.ts                # IPlaybackPipeline + capability matrix
│   │   ├── msePipeline.ts          # MSE/CMAF pipeline (with optional EME)
│   │   └── webcodecsLocPipeline.ts # WebCodecs/LOC pipeline (clear only)
│   ├── warpcatalog.ts    # MSF/CMSF catalog types and parsing
│   ├── player.ts         # Core player: catalog → tracks → pipeline
│   ├── browser.ts        # Browser entry point and UI handling
│   └── index.html        # HTML template and UI components
├── references/           # MOQ, MSF, CMSF, and LOC specification references
├── tsconfig.json         # TypeScript configuration
├── webpack.config.js     # Webpack configuration
└── package.json          # Project dependencies and scripts
```

## Installation / Usage

1. Install dependencies:

   ```
   npm install
   ```

2. Start the development server:

   ```
   npm start
   ```

3. Open your browser at `https://localhost:8080`

4. Enter the MOQ server URL (e.g., `https://localhost:4443/moq`) and click "Connect"

### Connecting with Self-Signed Certificates

When using self-signed certificates for development, you have two options:

1. **Using certificate fingerprint**:
   - Enter the server URL: `https://localhost:4443/moq`
   - Enter the fingerprint URL: `http://localhost:8081/fingerprint`
   - The player will fetch the certificate fingerprint and use it to authenticate the connection
   - **Important**: Certificates must be ECDSA, valid for ≤14 days, and self-signed
   - See [FINGERPRINT.md](FINGERPRINT.md) for detailed requirements

2. **Installing the certificate**:
   - Use mkcert to install the certificate in your system trust store
   - Or manually accept the certificate warning in your browser

For the easiest setup, use [moqlivemock](https://github.com/Eyevinn/moqlivemock) with `-fingerprintport 8081` which automatically generates compatible certificates.

## Development

The development server includes:

- Hot module replacement for quick development
- Source maps for debugging
- HTTPS support (required for WebTransport)

### Available Scripts

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

# Check code styling
npm run pretty

# Type checking
npm run typecheck

# Lint code
npm run lint

# Fix linting issues
npm run lint:fix
```

### Git Hooks

This project uses [Husky](https://typicode.github.io/husky/) to manage Git hooks that ensure code quality:

#### Pre-push Hook

Before pushing code, the following checks are automatically run:

- **TypeScript type checking** (`npm run typecheck`)
- **ESLint linting** (`npm run lint`)
- **Jest tests** (`npm test`)

If any of these checks fail, the push will be blocked.

#### Commit Message Hook

All commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) format. Examples:

- `feat: add new buffer control algorithm`
- `fix: resolve WebTransport connection issue`
- `docs: update README with configuration details`
- `chore: update dependencies`

The commit will be rejected if the message doesn't follow this format.

### Code Quality Standards

The project enforces the following standards:

- **TypeScript**: Strict type checking enabled
- **ESLint**: Enforces code style and best practices
  - All `if` statements must use curly braces
  - Imports must be ordered and grouped
  - No unused variables (prefix with `_` to ignore)
- **Prettier**: Automatic code formatting
- **Jest**: Unit tests for critical components

## Building for Production

To build the application for production:

```
npm run build
```

This will create a `dist` directory with the compiled application.

## Configuration

Default parameters can be configured in two ways:

1. **Before build**: Edit `src/config.json` to change defaults
2. **After build**: Edit `dist/config.json` to change defaults without rebuilding

See [CONFIG.md](CONFIG.md) for detailed configuration options.

## Features

- MOQ client implementation supporting draft-14 and draft-16
  (auto-negotiated via WebTransport ALPN; can be forced from the UI)
- MSF/CMSF catalog support for discovering available media streams
  ([draft-ietf-moq-msf-01], [draft-ietf-moq-cmsf-01])
- CMAF, LOCMAF (compact CMAF, [draft-einarsson-moq-locmaf]), and LOC packaging
- Catalog retrieval via SUBSCRIBE plus a relative joining FETCH by default, so
  playback starts from the latest catalog group aligned to the live edge; a
  "Catalog retrieval" selector (joining | subscribe | fetch) is exposed in the
  UI, with a fallback to a plain subscription against legacy publishers
- Two interchangeable render engines selected per session:
  - **MSE / CMAF** — the default for CMAF tracks, also handles encrypted content via EME
  - **WebCodecs / LOC** — clear-only pipeline for `packaging: "loc"` tracks,
    supporting AVC and HEVC video plus AAC and Opus audio
    ([draft-mzanaty-moq-loc])
- Engine selector with `Auto` mode that picks MSE or WebCodecs from the
  selected tracks' packaging and encryption status, and namespace filtering
  that dims out namespaces incompatible with the chosen engine
- Engine legend overlay showing the active namespace, engine, DRM system,
  and selected video / audio tracks
- Advanced two-parameter buffer control system (see Buffer Control Algorithm
  below) — applied to both pipelines through a common `IPlaybackPipeline`
  interface
- Adaptive playback rate adjustment based on buffer health and latency
- Synchronized audio and video playback with automatic recovery, including
  a wallclock-anchored render loop and gap-free audio scheduling for the
  WebCodecs pipeline
- Configurable logging with support for debug, info, warn, and error levels
- Clean and intuitive UI with real-time buffer and latency monitoring and
  a Mute / Unmute toggle that works for both engines
- DRM support for Widevine, PlayReady, and FairPlay, plus ClearKey for
  development, using the CMSF ContentProtection signaling merged into the
  [moq-wg/cmsf](https://github.com/moq-wg/cmsf) main branch for the next
  draft (also supported by [Shaka Player](https://github.com/shaka-project/shaka-player/pull/9972));
  encrypted content is always routed through the MSE engine

## Render Engines

Two render engines coexist behind a small `IPlaybackPipeline` interface
(`src/pipeline/index.ts`). Player selects one per session based on the
catalog and the user's "Render engine" choice in the UI:

| Engine    | Packaging        | Encryption | Notes                                                         |
| --------- | ---------------- | ---------- | ------------------------------------------------------------- |
| MSE       | `cmaf`, `locmaf` | clear, EME | Default for CMAF; required path for any DRM-protected content |
| WebCodecs | `loc`            | clear only | Decodes directly with `VideoDecoder` / `AudioDecoder`         |

The `Auto` engine choice resolves at subscribe time:

- CMAF and/or LOCMAF tracks → MSE (they share the MSE-CMAF family, so a CMAF
  video and a LOCMAF audio may be selected together)
- All-LOC tracks (clear) → WebCodecs
- Any encrypted track → MSE (WebCodecs cannot play encrypted content
  because production browsers do not expose Encrypted WebCodecs)

Forcing `MSE (CMAF)` or `WebCodecs (LOC)` overrides the auto choice and
filters the namespace selector so only compatible namespaces remain
selectable.

The WebCodecs pipeline draws decoded `VideoFrame`s onto a canvas overlaid
on the `<video>` element using a wallclock-anchored `requestAnimationFrame`
loop. Audio decoded via `AudioDecoder` is converted to `AudioBuffer`s and
scheduled on a single `AudioContext` so video and audio share the same
wallclock anchor. The capture timestamp travels in MoQ Object extension
headers (LOC property `0x06`, microseconds since the Unix epoch).

## Buffer Control Algorithm

The player uses a sophisticated two-parameter control system to maintain optimal playback:

### Parameters

1. **Minimal Buffer** (default: 200ms)
   - The safety threshold below which playback quality may suffer, and the
     buffer level required before playback starts
2. **Target Latency** (default: 300ms)
   - The desired end-to-end latency the controller steers toward once playing
   - Must be greater than the minimal buffer value

Both parameters are resolved per **render engine × browser** from the
`bufferProfiles` table in `config.json` (default 200/300 ms everywhere) and can
be overridden live from the UI inputs — see [CONFIG.md](CONFIG.md).

### Control Logic

A fixed-cadence (250ms) control loop adjusts the playback rate by priority; the
250ms timer keeps the loop responsive regardless of how often the browser fires
`timeupdate` (Safari fires it sparsely). Playback starts once the minimal buffer
is filled, then:

1. **Priority 1 - Buffer Safety**: If buffer level < minimal buffer
   - Reduce playback rate to build up buffer; takes precedence over latency
2. **Priority 2 - Latency Control**: If buffer level ≥ minimal buffer
   - If latency > target: speed up to reduce latency (ceiling 1.02x, higher on
     Safari whose media clock runs slightly slow). A large excursion instead
     triggers a resync seek toward the live edge.
   - If latency < target: slow down to hold the target and avoid the live edge
3. **Normal Playback**: return to 1.0x when within the target range

### Visual Indicators

Buffer levels are color-coded in the UI:

- **Red background**: Buffer is below minimal threshold (critical)
- **Orange background**: Buffer is within 50ms of minimal threshold (warning)
- **Default colors**: Buffer is at safe levels

### Latency Measurement

Accurate latency measurement requires:

- **Clock Synchronization**: Both the client (player) and server must have their clocks synchronized via NTP
- **Media Timestamps**: The media timestamps must be relative to the UNIX epoch (wall clock time)
- **Calculation**: Latency = Current Time - Media Presentation Time

Without proper NTP synchronization on both client and server, latency measurements will be inaccurate.

### Limitations

- Target latency must be greater than minimal buffer
- Latency measurement accuracy depends on clock synchronization
- WebTransport is required (Chrome, Edge, Firefox, or Safari 26.4+)

## Notes

- WebTransport is supported in Chrome, Edge, Firefox, and Safari 26.4+
- The WebCodecs render engine additionally requires WebCodecs support
  (Chrome 94+, Edge 94+, Safari 16.4+, Firefox 130+); when WebCodecs is
  unavailable the namespace selector dims any LOC-only namespaces
- For development with self-signed certificates, see [FINGERPRINT.md](FINGERPRINT.md) for detailed instructions
- Alternatively, you may need to accept the self-signed certificate warning in your browser
- The UI includes controls for adjusting both minimal buffer and target latency,
  picking the MOQ Transport draft, and picking the render engine

## Acknowledgments

The MOQ transport implementation in this project is based on work from:

- [moq-js](https://github.com/kixelated/moq-js) by Luke Curley (kixelated)
- [moq-js fork](https://github.com/englishm/moq-js) by Mike English (englishm)

We are grateful for their pioneering work on MOQ transport in JavaScript/TypeScript.

## Contributing

See [CONTRIBUTING](CONTRIBUTING.md)

## License

This project is licensed under the MIT License, see [LICENSE](LICENSE).

For third-party software acknowledgments, see [NOTICE](NOTICE).

## Support

Join our [community on Slack](http://slack.osaas.io/) where you can post any questions regarding any of our open source projects. Eyevinn's consulting business can also offer you:

- Further development of this component
- Customization and integration of this component into your platform
- Support and maintenance agreement

Contact [sales@eyevinn.se](mailto:sales@eyevinn.se) if you are interested.

## About Eyevinn Technology

[Eyevinn Technology](https://www.eyevinntechnology.se) help companies in the TV, media, and entertainment sectors optimize costs and boost profitability through enhanced media solutions.
We are independent in a way that we are not commercially tied to any platform or technology vendor. As our way to innovate and push the industry forward, we develop proof-of-concepts and tools. We share things we have learn and code as open-source.

With Eyevinn Open Source Cloud we enable to build solutions and applications based on Open Web Services and avoid being locked in with a single web service vendor. Our open-source solutions offer full flexibility with a revenue share model that supports the creators.

Read our blogs and articles here:

- [Developer blogs](https://dev.to/video)
- [Medium](https://eyevinntechnology.medium.com)
- [OSC](https://www.osaas.io)
- [LinkedIn](https://www.linkedin.com/company/eyevinn/)

Want to know more about Eyevinn, contact us at info@eyevinn.se!

[moqlivemock]: https://github.com/Eyevinn/moqlivemock
[draft-ietf-moq-msf-01]: https://datatracker.ietf.org/doc/html/draft-ietf-moq-msf-01
[draft-ietf-moq-cmsf-01]: https://datatracker.ietf.org/doc/html/draft-ietf-moq-cmsf-01
[draft-einarsson-moq-locmaf]: https://datatracker.ietf.org/doc/draft-einarsson-moq-locmaf/
[draft-mzanaty-moq-loc]: https://datatracker.ietf.org/doc/html/draft-mzanaty-moq-loc
