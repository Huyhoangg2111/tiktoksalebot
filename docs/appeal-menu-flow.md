# Smart+ appeal menu flow

The bot exposes one parent command for Smart+ appeals:

- `/appeal` opens the Smart+ rejected-ad scan menu.

The parent command does not immediately start an appeal scan. It shows two child actions:

- **Chỉ quảng cáo chưa xử lý**: uses local SQLite appeal history and skips ads the bot already attempted.
- **Quét lại toàn bộ**: ignores local appeal history and retries all currently rejected ads that are eligible by appeal status.

`/appealall` is intentionally not registered. This keeps the Telegram interaction behind a single parent entry and makes the destructive/force-rescan choice explicit before the scan starts.
