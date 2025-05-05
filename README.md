# WARP Player

A browser-based Media Player using the Media over QUIC (MoQ) protocol to access WARP catalogs and stream media content, using Media Source Extensions (MSE) for playback.

## Overview

This project implements a media player that:
1. Establishes a WebTransport connection to a MoQ server
2. Subscribes to and parses WARP catalogs for available media
3. Subscribes to selected media tracks through MoQ transport protocol
4. Receives media segments in CMAF format through the MoQ protocol
5. Uses Media Source Extensions (MSE) to decode and play media content
6. Provides adaptive buffer management for smooth playback experience

## Prerequisites

- A modern browser that supports WebTransport (Chrome 87+ or Edge 87+)
- A MoQ server that supports draft-11 such as moqlivemock

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

## Getting Started

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

## Building for Production

To build the application for production:

```
npm run build
```

This will create a `dist` directory with the compiled application.

## Features

- Complete MoQ client implementation based on draft-11 of the specification
- Full WARP catalog support for discovering available media streams
- Media Source Extensions (MSE) integration for seamless playback in browsers
- CMAF/ISO-BMFF media segment parsing and playback
- Advanced buffer management with configurable target buffer duration
- Adaptive playback rate adjustment based on buffer health
- Synchronized audio and video playback with automatic recovery
- Configurable logging with support for debug, info, warn, and error levels
- Clean and intuitive UI for track selection and playback control

## Notes

- WebTransport is only supported in some modern browsers, not in Node.js or Safari
- For development, you may need to accept the self-signed certificate warning in your browser
- The UI includes controls for adjusting target buffer duration and log level
