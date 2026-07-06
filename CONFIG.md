# Configuration

The WARP Player can be configured after build by editing the `config.json` file
in the distribution directory (`dist/config.json`) — no rebuild required. The
same file lives at `src/config.json` for the built-in defaults.

## Configuration File

```json
{
  "defaultServerUrl": "https://moqlivemock.demo.osaas.io/moq",
  "fingerprintUrl": "",
  "bufferProfiles": {
    "base": { "minimalBuffer": 200, "targetLatency": 300 },
    "rules": []
  }
}
```

### Options

- **defaultServerUrl**: The default MOQ server URL shown in the connection input field.
- **fingerprintUrl**: Optional URL for fetching a self-signed certificate
  fingerprint (see [FINGERPRINT.md](FINGERPRINT.md)). Leave empty to disable.
- **bufferProfiles**: Buffer/latency defaults, resolved per render engine and
  browser (see below). Omit the whole object to use the built-in default.

## Buffer profiles

Buffer/latency targets depend on the render engine actually chosen for a session
(MSE for CMAF/LOCMAF, WebCodecs for LOC) and the browser, because their latency
floors differ. `bufferProfiles` is a `base` plus an ordered list of `rules`:

```json
"bufferProfiles": {
  "base": { "minimalBuffer": 200, "targetLatency": 300 },
  "rules": [
    { "browser": "safari", "engine": "mse", "minimalBuffer": 500, "targetLatency": 600 }
  ]
}
```

- **minimalBuffer** (ms): buffered media required before playback starts; the
  control loop keeps the buffer at or above this. **targetLatency** must be
  greater than it.
- **targetLatency** (ms): the end-to-end latency the control loop steers toward
  after playback starts.
- Resolution: start from `base`, then apply every matching rule in order (later
  wins). A rule matches when its `engine` (`mse` | `webcodecs`) and `browser`
  (`safari` | `other`) equal the session's — omit either field to match any.

The resolved profile is applied when the engine is determined at Start and shown
in the buffer input fields. Editing those fields in the UI overrides the profile
for that session.

The built-in default is `base` 200/300 ms with no rules — stable across all
engines and browsers. Add a rule only to tune a specific combination (e.g. raise
Safari + MSE if needed). If `config.json` is missing or unreadable, the built-in
default is used.

## Usage

1. After `npm run build`, edit `dist/config.json`.
2. Reload the app; settings load on startup.
