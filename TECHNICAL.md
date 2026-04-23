# Technical Documentation: TikTok Sales Bot

## Architecture Overview

The TikTok Sales Bot follows a modular architecture with clear separation of concerns. Each module handles a specific aspect of the functionality while maintaining loose coupling.

## Module Structure

```
tiktok-sales-bot/
├── src/
│   ├── alerts/           # Alert system and rules
│   ├── bot/             # Telegram bot command handlers
│   ├── campaigns/       # Campaign management utilities
│   ├── config/          # Configuration utilities
│   ├── db/              # Database schema and connection
│   ├── google-sheets/   # Google Sheets API integration
│   ├── scheduler/       # Periodic task scheduler
│   ├── tiktok/          # TikTok Ads API integration
│   ├── types/           # TypeScript type definitions
│   ├── utils/           # Utility functions
│   └── index.ts         # Main application entry point
├── .env.example         # Environment variable template
├── package.json         # Dependencies and scripts
└── README.md           # User documentation
```

## Core Modules

### 1. Main Entry Point (`src/index.ts`)

The main application entry point that:
- Loads environment variables
- Connects to the database
- Initializes the Telegram bot
- Sets up command handlers
- Starts the scheduler
- Handles graceful shutdown

```typescript
import { Telegraf } from 'telegraf';
import { config } from 'dotenv';
import { connectDB } from './db';
import { setupBotHandlers } from './bot/handlers';
import { startScheduler } from './scheduler';

// Load environment variables
config();

async function main() {
  // Connect to database
  await connectDB();

  // Initialize Telegram bot
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

  // Setup bot command handlers
  setupBotHandlers(bot);

  // Start the bot
  await bot.launch();

  // Start the scheduler for periodic updates
  startScheduler(bot);

  console.log('Telegram bot is running...');
}

// Handle graceful shutdown
process.once('signal', async () => {
  console.log('Shutting down gracefully...');
  await bot.stop();
});

// Start the application
main().catch(console.error);
```

### 2. Database Module (`src/db/index.ts`)

Manages the SQLite database connection and creates the necessary tables:

- `campaigns` - Stores TikTok campaign metadata
- `campaign_performance` - Stores daily performance metrics
- `account_balance` - Stores account balance history
- `alerts` - Stores generated alerts
- `alert_rules` - Stores configurable alert conditions

The module exports a global `db` instance for use throughout the application.

### 3. TikTok API Module (`src/tiktok/api.ts`)

Handles all communication with the TikTok Ads API:

#### Interfaces
```typescript
export interface TikTokAccountBalance {
  advertiser_id: string;
  balance: number;
  currency: string;
}

export interface TikTokCampaign {
  id: string;
  advertiser_id: string;
  name: string;
  status: string;
  objective_type: string;
  daily_budget?: number;
  lifetime_budget?: number;
  created_time: string;
  updated_time: string;
}

export interface TikTokCampaignPerformance {
  campaign_id: string;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  cpc: number; // Cost Per Click
  cpa: number; // Cost Per Acquisition
  ctr: number; // Click Through Rate
}
```

#### Key Functions
- `getTikTokAccountBalance()` - Retrieves account balances for all configured advertisers
- `getCampaigns()` - Fetches all campaigns for configured advertisers
- `getCampaignPerformance()` - Gets performance metrics for a specific campaign
- `duplicateCampaign()` - Creates a copy of an existing campaign
- `toggleCampaignStatus()` - Enables/disables a campaign

### 4. Google Sheets Module (`src/google-sheets/api.ts`)

Integrates with Google Sheets to manage sales data:

#### Interface
```typescript
export interface SalesData {
  date: string;
  amount: number;
  source: string; // e.g., 'Sheet1', 'Sheet2', etc.
}
```

#### Key Functions
- `getSalesData()` - Reads sales data from all sheets in the configured spreadsheet
- `addSalesData()` - Adds new sales data to a specific sheet

The module automatically detects date and amount columns by looking for keywords in the header row.

### 5. Bot Handlers Module (`src/bot/handlers.ts`)

Processes Telegram commands and provides the user interface:

#### Commands Implemented
- `/start` - Welcome message with available commands
- `/balance` - Shows account balances
- `/campaigns` - Lists all campaigns
- `/performance` - Shows campaign performance metrics
- `/sales` - Displays sales data
- `/duplicate` - Duplicates a campaign (admin only)
- `/toggle` - Toggles campaign status (admin only)
- `/alerts` - Shows recent alerts (admin only)
- `/help` - Shows help information

#### Helper Functions
- `isAdmin()` - Checks if the user is the admin
- `formatCurrency()` - Formats monetary amounts
- `formatPercentage()` - Formats percentage values

### 6. Alert System (`src/alerts/index.ts`)

Monitors metrics and generates alerts based on configurable thresholds:

#### Interfaces
```typescript
export interface AlertRule {
  id?: number;
  metric: string; // e.g., 'spending', 'balance', 'cpc', 'cpa', 'conversions', 'ctr'
  threshold: number;
  comparison_operator: 'gt' | 'lt' | 'eq' | 'gte' | 'lte'; // greater than, less than, etc.
  is_active: boolean;
}

export interface Alert {
  id?: number;
  type: string; // e.g., 'spending_exceeded', 'low_balance', 'high_cpc'
  message: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  created_at?: string;
}
```

#### Key Functions
- `initializeAlertRules()` - Sets up default alert rules in the database
- `checkAndSendAlerts()` - Main function that checks metrics against rules and sends alerts
- `calculateAlertSeverity()` - Determines alert severity based on threshold deviation
- `createAlertMessage()` - Generates human-readable alert messages

#### Default Alert Rules
- Spending threshold (default: $1000)
- Balance threshold (default: $500)
- CPC threshold (default: $2)
- CPA threshold (default: $50)
- Conversions threshold (default: 10)
- CTR threshold (default: 2%)

### 7. Scheduler Module (`src/scheduler/index.ts`)

Runs periodic tasks using node-cron:

- Executes every 5 minutes
- Runs the alert checking function
- Uses Asia/Ho_Chi_Minh timezone for consistency with business operations
- Provides manual trigger capability for testing

## Configuration Management

### Environment Variables

The application relies on environment variables for configuration, defined in `.env`:

- `TELEGRAM_BOT_TOKEN` - Telegram bot API token
- `ADMIN_CHAT_ID` - Chat ID for admin notifications
- `TIKTOK_ACCESS_TOKEN` - TikTok Ads API access token
- `TIKTOK_ADVERTISER_IDS` - Comma-separated list of advertiser IDs
- `GOOGLE_SHEET_ID` - Google Sheet ID containing sales data
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` - Google Service Account email
- `GOOGLE_PRIVATE_KEY` - Private key for Google Service Account
- `SPENDING_THRESHOLD`, `BALANCE_THRESHOLD`, etc. - Alert thresholds
- `DATABASE_PATH` - Path to SQLite database file

### Configuration Validation

The TikTok config module (`src/tiktok/config.ts`) validates that required environment variables are present and throws errors if they're missing.

## Error Handling Strategy

The application implements a comprehensive error handling strategy:

1. **API Request Errors**: Each API call wraps in try-catch blocks with specific error logging
2. **Network Errors**: Timeout handling with configurable duration
3. **Database Errors**: Transaction safety and connection recovery
4. **Authentication Errors**: Specific handling for invalid credentials
5. **Validation Errors**: Input validation for user commands
6. **Graceful Degradation**: Continues operating when non-critical services fail

## Data Processing Flow

1. **Data Retrieval**:
   - Fetch campaign data from TikTok Ads API
   - Retrieve performance metrics for each campaign
   - Get account balances for all advertisers
   - Read sales data from Google Sheets

2. **Data Storage**:
   - Store campaign metadata in `campaigns` table
   - Store daily performance in `campaign_performance` table
   - Store account balances in `account_balance` table
   - Store sales data from sheets

3. **Alert Generation**:
   - Calculate current values for monitored metrics
   - Compare against configured thresholds
   - Generate alerts when thresholds are exceeded
   - Store alerts in database and send via Telegram

4. **User Interaction**:
   - Process Telegram commands
   - Query local database or APIs for requested data
   - Format and send responses to users

## Testing Strategy

While not explicitly shown in the code, a comprehensive testing strategy would include:

- Unit tests for individual modules
- Integration tests for API interactions
- Mock implementations for external services
- End-to-end tests for bot commands

## Deployment Considerations

- Environment variables must be securely configured
- Database backup strategy should be implemented
- Monitoring for the alert system should be set up
- Logging should be configured for production environments
- Proper error reporting mechanism should be in place

## Performance Optimization

- API responses are cached when appropriate
- Database queries are optimized with proper indexing
- Pagination is used for large datasets
- Asynchronous operations are properly awaited
- Memory usage is minimized during data processing

## Security Measures

- API tokens are stored in environment variables
- Admin-only commands are restricted by chat ID
- Input validation is performed on user commands
- Sensitive information is not logged
- Database connections are secured

This technical documentation provides a comprehensive overview of the TikTok Sales Bot's architecture and implementation, enabling developers to understand, maintain, and extend the system effectively.