@echo off
REM Setup script for TikTok Sales Bot

echo ===========================================
echo TikTok Sales Bot Setup
echo ===========================================

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Error: Node.js is not installed. Please install Node.js before continuing.
    pause
    exit /b 1
)

echo ✓ Node.js detected

REM Check if npm is installed
npm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Error: npm is not installed.
    pause
    exit /b 1
)

echo ✓ npm detected

REM Navigate to the project directory
cd /d "%~dp0"

echo Current directory: %cd%

REM Install dependencies
echo Installing dependencies...
npm install

if %errorlevel% neq 0 (
    echo Error: Failed to install dependencies.
    pause
    exit /b 1
)

echo ✓ Dependencies installed successfully

REM Build the project
echo Building the project...
npm run build

if %errorlevel% neq 0 (
    echo Error: Failed to build the project.
    pause
    exit /b 1
)

echo ✓ Project built successfully

REM Check if .env file exists
if not exist ".env" (
    echo ⚠️  Warning: .env file not found. Creating from .env.example...
    copy .env.example .env
    echo Please update the .env file with your actual configuration before running the bot.
) else (
    echo ✓ .env file found
)

echo.
echo ===========================================
echo Setup Complete!
echo ===========================================
echo.
echo To run the TikTok Sales Bot:
echo 1. Update the .env file with your configuration
echo 2. Run: npm run start
echo.
echo For development mode:
echo 1. Update the .env file with your configuration
echo 2. Run: npm run dev
echo.
echo For more information, check the README.md file.
echo ===========================================

pause
