# TikTok Sales Bot

A Telegram bot for aggregating and reporting TikTok advertising campaign information and sales data, with automated alerts and management capabilities.

## Features

- **TikTok Advertising Integration**: Fetch campaign data, performance metrics, and account balances
- **Sales Data Tracking**: Integrate with Google Sheets to track sales data
- **Automated Alerts**: Monitor key metrics and receive alerts when thresholds are exceeded
- **Automated Rules (Quy tắc)**: Configure rules in the dashboard tab "Quy tắc" — run continuously or on a schedule (HH:mm), over today/yesterday/month-to-date/last N days, applied to campaigns or materials, with actions TẮT (pause), BẬT (enable), or THÔNG BÁO (notify)
- **Campaign Management**: Duplicate (official TikTok API, with Smart+ copy using the copy API and a clone-by-recreate fallback) and toggle campaign statuses directly from Telegram
- **Periodic Updates**: Automatic data synchronization every 5 minutes
- **Multi-Language Support**: Vietnamese language interface

## Prerequisites

- Node.js (v16 or higher)
- TikTok Ads API access with valid credentials
- Google Service Account for Google Sheets access
- Telegram Bot Token

## Environment Variables

Create a `.env` file based on `.env.example`:

```env
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
ADMIN_CHAT_ID=your_chat_id_for_alerts_here

# TikTok Ads API Configuration
Không cấu hình token trong `.env`.
Đặt token trực tiếp trong Google Sheet tab `Token`:

TIKTOK_READ_ACCESS_TOKEN | your_read_token
TIKTOK_WRITE_ACCESS_TOKEN | your_write_token
# Optional override. If empty, the bot reads BC!A2 from CONFIG_GOOGLE_SHEET_ID.
TIKTOK_BC_ID=your_business_center_id_here
TIKTOK_ADVERTISER_IDS=comma_separated_advertiser_ids

# Google Sheets Configuration
GOOGLE_SHEET_ID=your_google_sheet_id_here
GOOGLE_SERVICE_ACCOUNT_EMAIL=your_service_account_email_here
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nyour_private_key_here\n-----END PRIVATE KEY-----"
TARGET_MKT_CODE=MKT80.HOÀNG-TH

# Alert Thresholds Configuration
SPENDING_THRESHOLD=1000 # Daily spending threshold in USD
BALANCE_THRESHOLD=500 # Account balance threshold in USD
CPC_THRESHOLD=2 # Cost Per Click threshold in USD
CPA_THRESHOLD=50 # Cost Per Acquisition threshold in USD
CONVERSION_THRESHOLD=10 # Minimum conversions threshold
CTR_THRESHOLD=2 # Click Through Rate threshold in percentage

# Database
DATABASE_PATH=./bot_data.db

# Data retention (optional, default 45, allowed 1-365)
# Data older than this many days (alert history, change/clone logs, audit log, ...)
# is cleaned up daily around 00:35 Vietnam time; latest 50 config snapshots per section are kept.
DATA_RETENTION_DAYS=45
```

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd tiktok-sales-bot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

## Usage

### Development Mode

Run the bot in development mode with automatic restart on file changes:

```bash
npm run dev
```

### Production Mode

Build and run the bot in production:

```bash
npm run build
npm start
```

### VPS / Docker Mode

For Ubuntu VPS or Docker without GUI, use the one-command install script after uploading the repo and `.env`:

```bash
bash install-vps.sh
```

The script will:

- install Docker if missing
- install Docker Compose plugin if missing
- build the image (no browser download involved, so builds are fast)
- start the bot in background with restart policy `unless-stopped`
- persist SQLite data in `./runtime`

## Available Commands

After starting the bot, you can interact with it using these commands:

- `/start` - Start the bot and see available commands
- `/balance` - Check account balances
- `/campaigns` - View campaigns with spend today
- `/sales` - View sales data
- `/xcamp <campaign_id> [số lượng] [ngân sách] [giá thầu]` - Xem trước rồi xác nhận mới nhân bản. Tên bản sao giữ quy tắc `<tên> - API`, không thêm `COPIED_`. Sau khi tạo xong, campaign, nhóm quảng cáo và quảng cáo được bật. Tối đa 3 bản khi `campaign_clone_log` còn trống, sau đó tối đa 10. Dừng ở lỗi đầu tiên và liệt kê id đã tạo cùng id tạo dở.
- `/duplicate` - Cùng luồng với `/xcamp`
- `/materialruler` - Chạy ngay toàn bộ quy tắc đã cấu hình trong tab `Quy tắc` của dashboard (luồng "Liên tục" vẫn chạy định kỳ riêng; lệnh này chạy thử ngay không chờ tới giờ hẹn)
- `/budget <campaign_id> <số tiền> [ngày|trọn|dynamic]` - Đổi ngân sách sau khi xác nhận (admin)
- `/bid <campaign_id> <giá thầu>` - Đổi giá thầu sau khi xác nhận (admin)
- `/on <campaign_id>` và `/off <campaign_id>` - Bật hoặc tắt campaign (admin)
- `/setalert <metric> <threshold>` - Set alert thresholds (admin only)
- `/alerts` - View recent alerts (admin only)
- `/help` - Show help information

## Alert System

The bot monitors several key metrics and sends alerts when thresholds are exceeded:

- **Spending**: Daily spending exceeds threshold
- **Balance**: Account balance falls below threshold
- **CPC**: Cost Per Click exceeds threshold
- **CPA**: Cost Per Acquisition exceeds threshold
- **Conversions**: Conversions fall below threshold
- **CTR**: Click Through Rate falls below threshold

Alerts are categorized by severity:
- Low: Minor threshold deviation
- Medium: Moderate threshold deviation
- High: Significant threshold deviation
- Critical: Major threshold deviation (>50%)

## Architecture

The bot is organized into several modules:

- `bot/` - Telegram bot command handlers
- `tiktok/` - TikTok Ads API integration
- `google-sheets/` - Google Sheets API integration
- `alerts/` - Alert system and rules
- `db/` - Database schema and connection
- `scheduler/` - Periodic task scheduler
- `campaigns/` - Campaign management utilities
- `utils/` - Utility functions
- `types/` - TypeScript type definitions

## Database Schema

The bot uses SQLite to store data:

- `campaigns` - Information about TikTok campaigns
- `campaign_performance` - Performance metrics for campaigns
- `account_balance` - Account balance history
- `alerts` - Historical alert records
- `alert_rules` - Configurable alert thresholds

## Configuration

### Setting Up TikTok Ads API Access

1. Register your application on the TikTok Marketing API portal
2. Obtain your access token, Business Center ID, and advertiser IDs
3. Add them to your `.env` file
4. Alternatively, put the Business Center ID in the configuration Google Sheet tab `BC`, cell `A2`

### Setting Up Google Sheets Access

1. Create a Google Service Account
2. Share your Google Sheet with the service account email
3. Download the private key and add it to your `.env` file
4. Add team sheet IDs in `Sources`, exchange rate in `Settings`, ad accounts in `Permissions`, and channel mapping in `PageMap`
5. Sales rows are read from each team sheet's `Đài Loan` tab, columns A/D/E/F/G/O, filtered by `TARGET_MKT_CODE`

### Setting Up Telegram Bot

1. Create a bot with BotFather on Telegram
2. Get the bot token and add it to your `.env` file
3. Get your chat ID for admin access (use a Telegram bot to retrieve it)

## Troubleshooting

- Check logs for error messages
- Verify all environment variables are correctly set
- Ensure API credentials have sufficient permissions
- Check database connectivity

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a pull request

## License

This project is licensed under the MIT License.
