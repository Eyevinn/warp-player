<h1 align="center">
  WARP Player
</h1>

<div align="center">
  A browser-based Media Player for Media over QUIC (MoQ) protocol with WARP support
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

1. Establishes a WebTransport connection to a MoQ server
2. Subscribes to and parses WARP catalogs for available media
3. Subscribes to selected media tracks through MoQ transport protocol
4. Receives media segments in CMAF format through the MoQ protocol
5. Uses Media Source Extensions (MSE) to decode and play media content
6. Provides adaptive buffer management for smooth playback experience
7. This player is intended to work towards [moqlivemock][moqlivemock] publisher

## Requirements

- A modern browser that supports WebTransport (Chrome 87+ or Edge 87+)
- A MoQ server that supports draft-11 such as moqlivemock
- Node.js version 20+

## Project Structure

```
warp-player/
├── src/
│   ├── transport/        # MoQ protocol implementation
│   │   ├── client.ts     # WebTransport client implementation
│   │   ├── setup.ts      # Setup message handling
│   │   ├── tracks.ts     # Track subscription and management
│   │   └── control.ts    # Control stream handling
│   ├── buffer/           # Media buffering components
│   │   ├── mediaBuffer.ts         # CMAF segment parsing
│   │   └── mediaSegmentBuffer.ts  # Buffer management for MSE
│   ├── player.ts         # Core player implementation with MSE integration
│   ├── browser.ts        # Browser entry point and UI handling
│   └── index.html        # HTML template and UI components
├── references/           # MoQ and WARP specification references
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

4. Enter the MoQ server URL (e.g., `https://localhost:4443/moq`) and click "Connect"

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

- Complete MoQ client implementation based on draft-11 of the specification
- Full WARP catalog support for discovering available media streams
- Media Source Extensions (MSE) integration for seamless playback in browsers
- CMAF/ISO-BMFF media segment parsing and playback
- Advanced two-parameter buffer control system (see Buffer Control Algorithm below)
- Adaptive playback rate adjustment based on buffer health and latency
- Synchronized audio and video playback with automatic recovery
- Configurable logging with support for debug, info, warn, and error levels
- Clean and intuitive UI with real-time buffer and latency monitoring

## Buffer Control Algorithm

The player uses a sophisticated two-parameter control system to maintain optimal playback:

### Parameters

1. **Minimal Buffer** (default: 200ms)
   - The safety threshold below which playback quality may suffer
   - Prevents buffer underruns and playback stalls
2. **Target Latency** (default: 300ms)
   - The desired end-to-end latency for live streaming
   - Must be greater than the minimal buffer value

### Control Logic

The playback rate is adjusted based on a priority system:

1. **Priority 1 - Buffer Safety**: If buffer level < minimal buffer

   - Reduce playback rate to 0.97x to build up buffer
   - This takes precedence over latency control

2. **Priority 2 - Latency Control**: If buffer level ≥ minimal buffer

   - If latency > target: Increase playback rate (up to 1.02x) to reduce latency
   - If latency < target: Decrease playback rate (down to 0.98x) to maintain target latency
   - This prevents drifting too close to the live edge

3. **Normal Playback**: When within acceptable ranges
   - Playback rate returns to 1.0x

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
- WebTransport is required (Chrome/Edge only)

## Notes

- WebTransport is only supported in some modern browsers, not in Node.js or Safari
- For development, you may need to accept the self-signed certificate warning in your browser
- The UI includes controls for adjusting both minimal buffer and target latency

## Acknowledgments

The MoQ transport implementation in this project is based on work from:

- [moq-js](https://github.com/kixelated/moq-js) by Luke Curley (kixelated)
- [moq-js fork](https://github.com/englishm/moq-js) by Mike English (englishm)

We are grateful for their pioneering work on MoQ transport in JavaScript/TypeScript.

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
