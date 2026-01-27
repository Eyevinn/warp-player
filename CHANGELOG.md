# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Nothing yet

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

- Initial WARP player implementation following MOQ Transport draft-11
- WebTransport client with bidirectional control stream support
- WARP catalog parsing and track subscription
- MSE-based media playback with CMAF segment handling
- Basic UI with connection controls and playback information
- Support for video and audio track selection
- Real-time playback metrics (buffer levels, latency, playback rate)

[Unreleased]: https://github.com/Eyevinn/warp-player/releases/tag/v0.4.1...HEAD
[0.4.1]: https://github.com/Eyevinn/warp-player/releases/tag/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Eyevinn/warp-player/releases/tag/v0.2.0...v0.4.0
[0.2.0]: https://github.com/Eyevinn/warp-player/releases/tag/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Eyevinn/warp-player/releases/tag/v0.1.0
[moqt-d11]: https://datatracker.ietf.org/doc/draft-ietf-moq-transport/11/
[moqt-d14]: https://datatracker.ietf.org/doc/draft-ietf-moq-transport/14/
