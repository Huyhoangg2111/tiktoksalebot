import sqlite3 from 'sqlite3';
import { resolve } from 'node:path';

type QueryParams = unknown[] | Record<string, unknown>;

export interface Database {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: QueryParams): Promise<sqlite3.RunResult>;
  get<T = unknown>(sql: string, params?: QueryParams): Promise<T | undefined>;
  all<T = unknown>(sql: string, params?: QueryParams): Promise<T[]>;
  close(): Promise<void>;
}

class SqliteDatabase implements Database {
  private readonly database: sqlite3.Database;

  constructor(filename: string) {
    this.database = new sqlite3.Database(filename);
  }

  exec(sql: string): Promise<void> {
    return new Promise((resolveExec, reject) => {
      this.database.exec(sql, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolveExec();
      });
    });
  }

  run(sql: string, params: QueryParams = []): Promise<sqlite3.RunResult> {
    return new Promise((resolveRun, reject) => {
      this.database.run(sql, params, function (this: sqlite3.RunResult, error: Error | null) {
        if (error) {
          reject(error);
          return;
        }

        resolveRun(this);
      });
    });
  }

  get<T = unknown>(sql: string, params: QueryParams = []): Promise<T | undefined> {
    return new Promise((resolveGet, reject) => {
      this.database.get<T>(sql, params, (error, row) => {
        if (error) {
          reject(error);
          return;
        }

        resolveGet(row);
      });
    });
  }

  all<T = unknown>(sql: string, params: QueryParams = []): Promise<T[]> {
    return new Promise((resolveAll, reject) => {
      this.database.all<T>(sql, params, (error, rows) => {
        if (error) {
          reject(error);
          return;
        }

        resolveAll(rows);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolveClose, reject) => {
      this.database.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolveClose();
      });
    });
  }
}

let db: Database;

export async function connectDB() {
  // Open the database
  db = new SqliteDatabase(resolve(process.env.DATABASE_PATH || './bot_data.db'));

  // Create tables if they don't exist
  await db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      advertiser_id TEXT,
      name TEXT,
      status TEXT,
      daily_budget REAL,
      lifetime_budget REAL,
      created_time TEXT,
      updated_time TEXT
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_performance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id TEXT,
      date TEXT,
      spend REAL,
      impressions INTEGER,
      clicks INTEGER,
      conversions INTEGER,
      cpc REAL,
      cpa REAL,
      ctr REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS account_balance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      advertiser_id TEXT UNIQUE,
      balance REAL,
      currency TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS advertiser_tracking (
      advertiser_id TEXT PRIMARY KEY,
      advertiser_name TEXT,
      is_tracked BOOLEAN DEFAULT 1,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      message TEXT,
      severity TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      tenant_id TEXT NOT NULL DEFAULT 'default'
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metric TEXT UNIQUE,
      threshold REAL,
      comparison_operator TEXT,
      is_active BOOLEAN DEFAULT 1
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS alert_action_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity TEXT NOT NULL,
      name_contains TEXT,
      metric TEXT NOT NULL,
      metric_operator TEXT NOT NULL,
      metric_threshold REAL NOT NULL,
      metric_min_threshold REAL,
      conversions_operator TEXT NOT NULL,
      conversions_threshold REAL NOT NULL,
      action TEXT NOT NULL,
      campaign_status TEXT,
      is_active BOOLEAN DEFAULT 1,
      note TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      tenant_id TEXT NOT NULL DEFAULT 'default'
    )
  `);

  try {
    await db.run('ALTER TABLE alert_action_rules ADD COLUMN campaign_status TEXT');
  } catch (error) {
    if (!String(error).includes('duplicate column name')) {
      throw error;
    }
  }

  try {
    await db.run('ALTER TABLE alert_action_rules ADD COLUMN metric_min_threshold REAL');
  } catch (error) {
    if (!String(error).includes('duplicate column name')) {
      throw error;
    }
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS alert_action_state (
      rule_id INTEGER NOT NULL,
      subject_key TEXT NOT NULL,
      state TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (rule_id, subject_key)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_daily_alert_tracking (
      date_key TEXT NOT NULL,
      advertiser_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      is_tracked BOOLEAN DEFAULT 1,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (date_key, advertiser_id, campaign_id)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS product_pause_callbacks (
      token TEXT PRIMARY KEY,
      created_at_ms INTEGER NOT NULL,
      product_short_name TEXT NOT NULL,
      market_code TEXT NOT NULL,
      target_mkt_code TEXT,
      alert_level TEXT NOT NULL,
      item_number INTEGER NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_product_pause_callbacks_created_at
    ON product_pause_callbacks(created_at_ms)
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS spent_campaign_cache (
      advertiser_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      date_key TEXT NOT NULL,
      campaign_name TEXT,
      advertiser_name TEXT,
      mkt_code TEXT,
      status TEXT,
      raw_status TEXT,
      spend REAL DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      conversions INTEGER DEFAULT 0,
      cpc REAL DEFAULT 0,
      cpa REAL DEFAULT 0,
      ctr REAL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (advertiser_id, campaign_id, date_key)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS campaign_clone_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_campaign_id TEXT NOT NULL,
      cloned_campaign_id TEXT NOT NULL UNIQUE,
      cloned_advertiser_id TEXT,
      cloned_campaign_name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_campaign_clone_log_original
    ON campaign_clone_log(original_campaign_id)
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS smart_plus_appeal_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      advertiser_id TEXT NOT NULL,
      smart_plus_ad_id TEXT NOT NULL,
      campaign_id TEXT,
      previous_appeal_status TEXT,
      review_status TEXT,
      secondary_status TEXT,
      rejected_material_count INTEGER DEFAULT 0,
      outcome TEXT NOT NULL,
      response_code INTEGER,
      response_message TEXT,
      request_id TEXT,
      is_forced BOOLEAN DEFAULT 0,
      attempted_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_smart_plus_appeal_attempts_ad
    ON smart_plus_appeal_attempts(advertiser_id, smart_plus_ad_id)
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_smart_plus_appeal_attempts_time
    ON smart_plus_appeal_attempts(attempted_at)
  `);

  // Bảng cấu hình dashboard (dùng chung với webapp độc lập qua cùng file SQLite).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS admin_config_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT NOT NULL,
      data_json TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      tenant_id TEXT NOT NULL DEFAULT 'default'
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS admin_config_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT NOT NULL,
      data_json TEXT NOT NULL,
      row_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      tenant_id TEXT NOT NULL DEFAULT 'default'
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Database cũ: bổ sung cột tenant khi chưa có.
  for (const table of ['admin_config_rows', 'admin_config_history', 'alert_action_rules', 'alerts']) {
    try {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
    } catch {
      // Cột đã tồn tại.
    }
  }

  console.log('Connected to database and initialized tables');
  return db;
}

export { db };
