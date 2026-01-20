# Using WebTransport with Self-Signed Certificates

When developing locally with self-signed certificates, WebTransport requires the certificate fingerprint to establish a connection. This guide explains how to use the fingerprint feature in WARP Player.

## How it Works

WebTransport allows connections to servers with self-signed certificates by providing the SHA-256 fingerprint of the certificate in the `serverCertificateHashes` option. This is particularly useful for local development.

## Certificate Requirements

For fingerprint-based authentication to work, certificates must meet strict requirements:

- **Algorithm**: Must use ECDSA (not RSA)
- **Validity**: Maximum 14 days
- **Type**: Must be self-signed

If these requirements are not met, the connection will fail even with a valid fingerprint.

## Server Setup

### Using moqlivemock (Recommended)

The easiest way is to use [moqlivemock](https://github.com/Eyevinn/moqlivemock) which automatically generates WebTransport-compatible certificates:

```bash
# Automatically generates and uses a compatible certificate
mlmpub -fingerprintport 8081
```

This starts:

- MoQ server on port 4443 with auto-generated certificate
- HTTP fingerprint server on port 8081

### Manual Certificate Generation

If you need to generate certificates manually, ensure they meet WebTransport requirements:

```bash
# Generate ECDSA private key
openssl ecparam -genkey -name prime256v1 -out key.pem

# Generate self-signed certificate (14 days max)
openssl req -new -x509 -key key.pem -out cert.pem -days 14 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

**Note**: Using RSA keys or certificates valid for more than 14 days will cause connection failures.

### 2. Get the Certificate Fingerprint

Extract the SHA-256 fingerprint from your certificate:

```bash
# Get the fingerprint in hex format
openssl x509 -in cert.pem -noout -fingerprint -sha256 | sed 's/://g' | cut -d'=' -f2
```

This will output something like:

```
A1B2C3D4E5F6789012345678901234567890123456789012345678901234567890
```

### 3. Serve the Fingerprint

The fingerprint must be served over HTTP(S) with proper CORS headers.

If using moqlivemock, this is handled automatically on the fingerprint port. For other servers, create an endpoint that returns the fingerprint as plain text:

```go
http.HandleFunc("/fingerprint", func(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "text/plain")
    w.Header().Set("Access-Control-Allow-Origin", "*")
    fmt.Fprint(w, "0123456789abcdef...") // Your certificate's SHA-256 fingerprint
})
```

## Client Usage

The WARP Player client automatically supports fingerprint-based connections:

```typescript
// When creating a client connection
const client = new Client({
  url: "https://localhost:4443/moq",
  fingerprint: "https://localhost:4443/fingerprint", // URL to fetch the fingerprint
});
```

The client will:

1. Fetch the fingerprint from the provided URL
2. Parse it as a hex string
3. Include it in the WebTransport connection options

## Alternative: Browser Trust

For development, you can also:

1. **Chrome**: Navigate to `https://localhost:4443` and accept the certificate warning
2. **Use mkcert**: Run `mkcert -install` to add your local CA to the system trust store

## Benefits

- No need to manually trust certificates in the browser
- Works immediately without browser warnings
- Allows automated testing with self-signed certificates
- Secure for development environments

## Troubleshooting

If connections fail despite having a valid fingerprint:

1. **Verify certificate requirements**: Use `openssl x509 -in cert.pem -text -noout` to check:
   - Signature Algorithm should be `ecdsa-with-SHA256`
   - Validity period should be ≤ 14 days
   - Issuer and Subject should match (self-signed)

2. **Check browser console**: Look for specific error messages about certificate validation

3. **Ensure server listens on all interfaces**: Use `0.0.0.0` instead of `localhost` for the server address

4. **Clear browser cache**: Chrome may cache certificate validation results

For more details on WebTransport certificate requirements, see:

- [MDN WebTransport serverCertificateHashes](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport/WebTransport#servercertificatehashes)
- [moqlivemock documentation](https://github.com/Eyevinn/moqlivemock#using-certificate-fingerprint)

## Security Note

This fingerprint mechanism is intended for development use only. In production, always use properly signed certificates from a trusted Certificate Authority.
