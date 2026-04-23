#!/bin/bash
# Setup script for TikTok Sales Bot

echo "==========================================="
echo "TikTok Sales Bot Setup"
echo "==========================================="

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install Node.js before continuing."
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2)
NODE_MAJOR_VERSION=$(echo $NODE_VERSION | cut -d'.' -f1)

if [ "$NODE_MAJOR_VERSION" -lt 16 ]; then
    echo "Error: Node.js version 16 or higher is required. Current version: $NODE_VERSION"
    exit 1
fi

echo "✓ Node.js version $NODE_VERSION detected"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed."
    exit 1
fi

echo "✓ npm detected"

# Navigate to the project directory
cd "$(dirname "$0")"

echo "Current directory: $(pwd)"

# Install dependencies
echo "Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "Error: Failed to install dependencies."
    exit 1
fi

echo "✓ Dependencies installed successfully"

# Build the project
echo "Building the project..."
npm run build

if [ $? -ne 0 ]; then
    echo "Error: Failed to build the project."
    exit 1
fi

echo "✓ Project built successfully"

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "⚠️  Warning: .env file not found. Creating from .env.example..."
    cp .env.example .env
    echo "Please update the .env file with your actual configuration before running the bot."
else
    echo "✓ .env file found"
fi

echo ""
echo "==========================================="
echo "Setup Complete!"
echo "==========================================="
echo ""
echo "To run the TikTok Sales Bot:"
echo "1. Update the .env file with your configuration"
echo "2. Run: npm run start"
echo ""
echo "For development mode:"
echo "1. Update the .env file with your configuration"
echo "2. Run: npm run dev"
echo ""
echo "For more information, check the README.md file."
echo "==========================================="