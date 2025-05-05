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
```

## Project Overview

WARP Player is a browser-based TypeScript implementation of a media player,
using Media over QUIC (MoQ) transport protocol, draft version 11,
via WebTransport. It uses the WARP protocol to fetch a catalog with media tracks.
The actual media playback is done using MSE, and the media container is CMAF.
This player allows browsers to connect to MoQ servers, subscribe to media tracks, and receive media segments over WebTransport.


### Core Architecture

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