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
using Media over QUIC (MoQ) transport protocol, draft version 11,
via WebTransport. It uses the WARP protocol to fetch a catalog with media tracks.
The actual media playback is done using MSE, and the media container is CMAF.
This player allows browsers to connect to MoQ servers, subscribe to media tracks, and receive media segments over WebTransport.

### Project Structure

The project follows the Eyevinn TypeScript project template structure:

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

The transport used is MoQ Transport, currently
[draft-11](https://www.ietf.org/archive/id/draft-ietf-moq-transport-11.txt)

For the WARP catalog, the specification is
[draft-0](https://www.ietf.org/archive/id/draft-ietf-moq-warp-00.txt)
but with some modifications added later like updates to Catalog.
CMAF is used as packaging instead of LOC.

The codebase is organized into several key modules:

1. **Transport Layer**:

   - Located in `src/transport/`
   - Handles WebTransport connection and MoQ protocol implementation
   - Manages bidirectional control streams and unidirectional data streams
   - Implements client-server setup messaging, track subscription, and data reception

2. **Buffer Layer**:

   - Located in `src/buffer/`
   - Processes incoming media segments (CMAF format)
   - Parses segments and extracts timing information
   - Manages buffering of media segments for playback

3. **Player Integration**:
   - Located in `src/player.ts` and `src/browser.ts`
   - Provides the high-level API for connecting to MoQ servers
   - Handles user interface interaction for track discovery and subscription

### Key Components

1. **Client** (`src/transport/client.ts`):

   - Main entry point for establishing WebTransport connections
   - Handles connection setup, track subscription, and message routing

2. **TrackAliasRegistry** (`src/transport/trackaliasregistry.ts`):

   - Manages mappings between track namespaces, names, and aliases
   - Tracks registration of callbacks for data objects

3. **TracksManager** (`src/transport/tracks.ts`):

   - Manages incoming unidirectional streams for data
   - Processes and routes incoming data objects to registered callbacks

4. **MediaBuffer** (`src/buffer/mediaBuffer.ts`):

   - Parses CMAF initialization and media segments
   - Extracts timing information for media synchronization

5. **MediaSegmentBuffer** (`src/buffer/mediaSegmentBuffer.ts`):
   - Manages the queue of media segments with timing information
   - Provides interfaces for appending to SourceBuffer for playback

## Technical Notes

1. The implementation follows the MoQ Transport protocol draft version 11.
2. WebTransport is only available in Chrome 87+ and Edge 87+, not in Safari or Node.js.
3. The client uses MSB (Most Significant Byte) 16-bit length fields for control messages.
4. Media data is expected in CMAF format with ISO BMFF container structure.
5. The client includes proper handling of bidirectional control streams for subscribing to content.
6. The player should work fine towards https://github.com/Eyevinn/moqlivemock/cmd/mlmpub as a source
7. The project follows the Eyevinn code quality standards with:
   - Conventional commits using commitlint
   - Prettier for code formatting
   - ESLint for code linting
   - TypeScript strict type checking

## Recent Features

### Fingerprint Support for Self-Signed Certificates

The player now supports connecting to servers with self-signed certificates by providing a fingerprint URL:

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
