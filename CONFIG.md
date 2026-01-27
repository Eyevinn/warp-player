# Configuration

The WARP Player can be configured after build by editing the `config.json` file in the distribution directory.

## Configuration File

The `config.json` file supports the following options:

```json
{
  "defaultServerUrl": "https://moqlivemock.demo.osaas.io/moq",
  "minimalBuffer": 200,
  "targetLatency": 300
}
```

### Options

- **defaultServerUrl**: The default MOQ server URL that appears in the connection input field
- **minimalBuffer**: The minimal buffer threshold in milliseconds (default: 200ms). Below this threshold, playback quality may suffer
- **targetLatency**: The target end-to-end latency in milliseconds (default: 300ms). Must be greater than minimalBuffer

## Usage

1. After building the application (`npm run build`), locate the `config.json` file in the `dist` directory
2. Edit the file with your preferred settings
3. The application will load these settings on startup

If the configuration file is not found or cannot be loaded, the application will use built-in defaults.

## Example

To change the default server and adjust buffer parameters for lower latency:

```json
{
  "defaultServerUrl": "https://your-server.example.com:443/moq",
  "minimalBuffer": 150,
  "targetLatency": 250
}
```

Note: Setting targetLatency too low may result in more frequent buffer underruns. The targetLatency must always be greater than minimalBuffer.
