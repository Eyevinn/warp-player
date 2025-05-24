# Deploying WARP Player to a Static Web Server

This guide explains how to build and deploy the WARP Player to various static hosting services.

## Prerequisites

- Node.js (version 20 or higher)
- npm (included with Node.js)
- A static web hosting service that supports HTTPS (required for WebTransport)

## Build Process

The WARP Player uses webpack to bundle all assets into a production-ready distribution:

```bash
# Install dependencies (if not already installed)
npm install

# Build for production
npm run build
```

This will create a `dist` directory with all necessary files for deployment.

## Deployment Options

### Option 1: Use the Deployment Script

We provide a deployment script that simplifies the process:

```bash
# Make the script executable (if not already)
chmod +x deploy.sh

# Run the deployment script
./deploy.sh
```

This interactive script will guide you through:

1. Building for production
2. Testing the build locally
3. Deploying to your chosen hosting service

### Option 2: Manual Deployment

If you prefer to deploy manually, you can follow these steps:

1. Build the project for production:

   ```bash
   npm run build
   ```

2. Test the build locally:

   ```bash
   npm run serve:dist
   ```

3. Upload the contents of the `dist` directory to your web server using your preferred method:
   - FTP client
   - SFTP
   - rsync
   - Web hosting control panel
   - Cloud service CLI tool

## Hosting Services Compatible with WebTransport

The WARP Player requires HTTPS and a server that supports WebTransport. Here are some compatible hosting options:

### GitHub Pages

```bash
# Install gh-pages package
npm install -g gh-pages

# Deploy to GitHub Pages
npx gh-pages -d dist
```

### Netlify

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Deploy to Netlify
netlify deploy --dir=dist --prod
```

### AWS S3 + CloudFront

```bash
# Configure AWS CLI first
aws s3 sync dist/ s3://your-bucket-name/ --delete

# Make sure CloudFront is configured for HTTPS
```

### Azure Static Web Apps

```bash
# Use Azure CLI
az staticwebapp deploy --name your-app-name --resource-group your-resource-group --source dist
```

### Google Firebase Hosting

```bash
# Install Firebase CLI
npm install -g firebase-tools

# Initialize Firebase (if not already)
firebase init

# Deploy to Firebase Hosting
firebase deploy --only hosting
```

## Important Notes for Deployment

1. **HTTPS Requirement**: WebTransport requires HTTPS. Make sure your hosting service provides HTTPS.

2. **Cross-Origin Considerations**: If your MoQ server is on a different domain, it will need to support CORS and appropriate headers for WebTransport.

3. **Content Security Policy**: If your hosting service imposes strict CSP rules, you may need to configure them to allow WebTransport connections.

4. **Server Configuration**: Some static hosting services may require additional configuration to properly serve the application. Check their documentation for details.

5. **Testing After Deployment**: Always test your deployed application to ensure it works correctly with your MoQ server.
