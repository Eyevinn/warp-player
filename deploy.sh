#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}WARP Player Deployment Script${NC}"
echo -e "This script will build and deploy the WARP Player to a static hosting service."

# Step 1: Build for production
echo -e "${BLUE}Step 1/3: Building for production...${NC}"
npm run build

# Verify build succeeded
if [ ! -d "dist" ]; then
  echo -e "${RED}Error: Build failed. The 'dist' directory does not exist.${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Build completed successfully${NC}"

# Step 2: Test the build locally (optional)
echo -e "${BLUE}Step 2/3: Testing build locally...${NC}"
echo -e "Starting local server to test the build..."
echo -e "Open ${GREEN}http://localhost:5000${NC} in your browser to test."
echo -e "Press Ctrl+C when finished testing."
npx serve -s dist

# Step 3: Choose deployment target
echo -e "${BLUE}Step 3/3: Choose deployment target:${NC}"
echo -e "1. Deploy to GitHub Pages"
echo -e "2. Deploy to Netlify"
echo -e "3. Deploy to AWS S3"
echo -e "4. Deploy to Azure Static Web Apps"
echo -e "5. Copy files to custom location"
echo -e "6. Exit"

read -p "Enter your choice (1-6): " choice

case $choice in
  1)
    # GitHub Pages
    echo -e "${BLUE}Deploying to GitHub Pages...${NC}"
    # Check if gh-pages exists
    if ! command -v gh &> /dev/null; then
      echo -e "${RED}Error: GitHub CLI not found. Please install with 'npm install -g gh-pages'${NC}"
      exit 1
    fi
    npx gh-pages -d dist
    echo -e "${GREEN}✓ Deployed to GitHub Pages${NC}"
    ;;
  2)
    # Netlify
    echo -e "${BLUE}Deploying to Netlify...${NC}"
    # Check if netlify-cli exists
    if ! command -v netlify &> /dev/null; then
      echo -e "${RED}Error: Netlify CLI not found. Please install with 'npm install -g netlify-cli'${NC}"
      exit 1
    fi
    netlify deploy --dir=dist --prod
    echo -e "${GREEN}✓ Deployed to Netlify${NC}"
    ;;
  3)
    # AWS S3
    echo -e "${BLUE}Deploying to AWS S3...${NC}"
    read -p "Enter your S3 bucket name: " bucket_name
    # Check if aws cli exists
    if ! command -v aws &> /dev/null; then
      echo -e "${RED}Error: AWS CLI not found. Please install it and configure your credentials.${NC}"
      exit 1
    fi
    aws s3 sync dist/ s3://$bucket_name/ --delete
    echo -e "${GREEN}✓ Deployed to AWS S3 bucket: ${bucket_name}${NC}"
    ;;
  4)
    # Azure Static Web Apps
    echo -e "${BLUE}Deploying to Azure Static Web Apps...${NC}"
    # Check if azure cli exists
    if ! command -v az &> /dev/null; then
      echo -e "${RED}Error: Azure CLI not found. Please install it and configure your credentials.${NC}"
      exit 1
    fi
    read -p "Enter your Azure Static Web App name: " app_name
    read -p "Enter your Azure Resource Group: " resource_group
    az staticwebapp deploy --name $app_name --resource-group $resource_group --source dist
    echo -e "${GREEN}✓ Deployed to Azure Static Web App: ${app_name}${NC}"
    ;;
  5)
    # Copy to custom location
    echo -e "${BLUE}Copying files to custom location...${NC}"
    read -p "Enter the destination path: " dest_path
    mkdir -p "$dest_path"
    cp -r dist/* "$dest_path"
    echo -e "${GREEN}✓ Files copied to: ${dest_path}${NC}"
    ;;
  6)
    echo -e "${BLUE}Exiting without deployment.${NC}"
    exit 0
    ;;
  *)
    echo -e "${RED}Invalid choice. Exiting.${NC}"
    exit 1
    ;;
esac

echo -e "${GREEN}Deployment completed successfully!${NC}"
echo -e "${BLUE}Note: WebTransport requires HTTPS. Make sure your static hosting provides HTTPS.${NC}"
echo -e "${BLUE}If you're using a custom domain, you'll need to configure HTTPS for it.${NC}"