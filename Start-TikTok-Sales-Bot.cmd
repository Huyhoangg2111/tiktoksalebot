@echo off
REM Script to start the TikTok Sales Bot as a background service

echo Starting TikTok Sales Bot...

REM Change to the tiktok-sales-bot directory
cd /d "%~dp0"

REM Check if node_modules exists, if not install dependencies
if not exist "node_modules" (
    echo Installing dependencies...
    npm install
)

REM Build the project
echo Building the project...
npm run build

REM Start the bot in the background
echo Starting the TikTok Sales Bot...
npm run start

pause