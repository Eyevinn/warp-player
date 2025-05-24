# Configuration

The WARP Player can be configured after build by editing the `config.json` file in the distribution directory.

## Configuration File

The `config.json` file supports the following options:

```json
{
  "defaultServerUrl": "https://moqlivemock.demo.osaas.io/moq",
  "targetBufferDuration": 200
}
```

### Options

- **defaultServerUrl**: The default MoQ server URL that appears in the connection input field
- **targetBufferDuration**: The default target buffer duration in milliseconds

## Usage

1. After building the application (`npm run build`), locate the `config.json` file in the `dist` directory
2. Edit the file with your preferred settings
3. The application will load these settings on startup

If the configuration file is not found or cannot be loaded, the application will use built-in defaults.

## Example

To change the default server to your own instance:

```json
{
  "defaultServerUrl": "https://your-server.example.com:443/moq",
  "targetBufferDuration": 500
}
```