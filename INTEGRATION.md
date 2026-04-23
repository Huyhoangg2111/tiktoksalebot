# TikTok Sales Bot Integration Guide

This document explains how the TikTok Sales Bot integrates with the main BotCare application to provide automated TikTok advertising monitoring, sales tracking, and alerting capabilities.

## Overview

The TikTok Sales Bot is a specialized component of the BotCare ecosystem that focuses on TikTok advertising campaign management and sales data tracking. It combines TikTok Ads API data with Google Sheets sales data to provide comprehensive insights and automated alerts.

## Integration Points

### 1. API Integration

The bot connects to TikTok Ads API to retrieve:
- Campaign information and status
- Performance metrics (spend, impressions, clicks, conversions)
- Account balances
- Ad creative details

It also connects to Google Sheets API to track sales data from configured spreadsheets.

### 2. Database Synchronization

The bot stores data in a local SQLite database with the following tables:
- `campaigns` - TikTok campaign metadata
- `campaign_performance` - Daily performance metrics
- `account_balance` - Account balance history
- `alerts` - Generated alerts based on thresholds
- `alert_rules` - Configurable alert conditions

### 3. Alert System

The bot monitors key metrics and sends alerts through Telegram when thresholds are exceeded:
- Spending limits
- Account balance thresholds
- Performance metrics (CPC, CPA, CTR)
- Conversion targets

### 4. Telegram Interface

Users interact with the bot through Telegram commands to:
- View campaign information
- Check performance metrics
- Access sales data
- Manage campaigns (duplicate, enable/disable)
- Configure alerts

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   TikTok Ads    │    │  Google Sheets   │    │   Telegram      │
│    API          │    │    API           │    │   Bot           │
└─────────┬───────┘    └─────────┬────────┘    └─────────┬───────┘
          │                      │                       │
          │                      │                       │
          ▼                      ▼                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    TikTok Sales Bot                           │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │   TikTok API    │  │ Google Sheets   │  │   Scheduler     │ │
│  │   Module        │  │   Module        │  │   Module        │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │   Alert         │  │   Database      │  │   Bot Handler   │ │
│  │   Module        │  │   Module        │  │   Module        │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
          │                      │                       │
          │                      │                       │
          ▼                      ▼                       ▼
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ Local SQLite    │    │   Google Sheets  │    │   Telegram      │
│   Database      │    │   (Sales Data)   │    │   Notifications │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## Key Components

### 1. TikTok API Module (`src/tiktok/api.ts`)

Handles all communication with the TikTok Ads API, including:
- Retrieving account balances
- Fetching campaign information
- Getting performance metrics
- Managing campaigns (duplicate, toggle status)

### 2. Google Sheets Module (`src/google-sheets/api.ts`)

Manages sales data from Google Sheets, including:
- Reading sales data from configured sheets
- Writing new sales data to sheets
- Processing different sheet formats

### 3. Alert Module (`src/alerts/index.ts`)

Implements the alerting system with:
- Configurable thresholds for different metrics
- Severity-based alert categorization
- Automatic alert generation and delivery

### 4. Scheduler Module (`src/scheduler/index.ts`)

Runs periodic tasks every 5 minutes to:
- Fetch fresh data from TikTok and Google Sheets
- Check metrics against alert thresholds
- Generate and send alerts as needed

### 5. Bot Handler Module (`src/bot/handlers.ts`)

Processes Telegram commands from users to:
- Display campaign information
- Show performance metrics
- Access sales data
- Manage campaigns
- Configure alerts

## Configuration

The bot is configured through environment variables in the `.env` file:

- `TELEGRAM_BOT_TOKEN` - Telegram bot API token
- `ADMIN_CHAT_ID` - Chat ID for admin notifications
- `TIKTOK_ACCESS_TOKEN` - TikTok Ads API access token
- `TIKTOK_ADVERTISER_IDS` - Comma-separated list of advertiser IDs
- `GOOGLE_SHEET_ID` - Google Sheet ID containing sales data
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` - Google Service Account email
- `GOOGLE_PRIVATE_KEY` - Private key for Google Service Account
- `SPENDING_THRESHOLD`, `BALANCE_THRESHOLD`, etc. - Alert thresholds
- `DATABASE_PATH` - Path to SQLite database file

## Data Flow

1. **Data Collection**:
   - Every 5 minutes, the scheduler fetches data from TikTok Ads API
   - Sales data is retrieved from Google Sheets
   - Campaign performance metrics are aggregated

2. **Alert Generation**:
   - Metrics are compared against configurable thresholds
   - Alerts are generated when thresholds are exceeded
   - Alerts are stored in the database and sent via Telegram

3. **User Interaction**:
   - Users send commands to the Telegram bot
   - Bot retrieves data from local database or APIs
   - Formatted responses are sent back to users

## Error Handling

The bot implements comprehensive error handling:
- API request timeouts and retries
- Invalid credentials detection
- Network error handling
- Database connection recovery
- Graceful degradation when services are unavailable

## Security Considerations

- API credentials are stored in environment variables
- Access to sensitive operations is restricted to admin users
- Input validation is performed on all user commands
- Error messages don't expose sensitive information

## Deployment

The bot can be deployed as a standalone service or integrated into the broader BotCare ecosystem. It can run continuously to provide real-time monitoring and alerting.

## Future Enhancements

Potential areas for improvement:
- Enhanced visualization of metrics
- More sophisticated alert conditions
- Integration with additional advertising platforms
- Advanced campaign optimization recommendations
- Custom reporting capabilities