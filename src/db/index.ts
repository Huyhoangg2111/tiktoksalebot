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

const MIGRATION_MARKER_KEY = 'material_ruler_migrated';

/**
 * Migration một lần (idempotent): chuyển rule cũ của tab "Ruler lập lịch"
 * trong admin_config_rows (section='material_ruler', dạng spend_operator/spend_threshold,
 * cpa_*, conversions_*) thành quy tắc thống nhất trong alert_action_rules với
 * trigger_kind='scheduled'. Sau đó xoá những dòng đã chuyển đi.
 *
 * - Operator cũ `> >= < <= =` → gt/gte/lt/lte/eq.
 * - Nếu một dòng có CẢ điều kiện spend và cpa được set (hiếm): chọn cpa, log thêm.
 * - Dòng có điều kiện bất thường / không bật / chỉ có campaign_match + note:
 *   giữ nguyên trong admin_config_rows (không còn code nào đọc chúng).
 */
async function migrateLegacyMaterialRulerRules(): Promise<void> {
  const marker = await db.get<{ value: string }>(
    'SELECT value FROM bot_settings WHERE key = ?',
    [MIGRATION_MARKER_KEY]
  );
  if (String(marker?.value || '') !== '1') {
    await db.run(
      'INSERT OR IGNORE INTO bot_settings(key,value) VALUES(?,?)',
      [MIGRATION_MARKER_KEY, '1']
    );
  }

  const rows = await db.all<{ id: number; data_json: string }>(
    'SELECT id,data_json FROM admin_config_rows WHERE section=? ORDER BY id',
    ['material_ruler']
  ).catch(() => []);

  if (rows.length === 0) return;

  const parseText = (value: unknown): string => String(value ?? '').trim();
  const parseOperator = (value: unknown): string | undefined => {
    const raw = parseText(value);
    if (raw === '>') return 'gt';
    if (raw === '>=') return 'gte';
    if (raw === '<') return 'lt';
    if (raw === '<=') return 'lte';
    if (raw === '=') return 'eq';
    return undefined;
  };
  const parseCondition = (operatorValue: unknown, thresholdValue: unknown): { operator: string; threshold: number } | undefined => {
    const rawOperator = parseText(operatorValue);
    const rawThreshold = parseText(thresholdValue).replace(',', '.');
    if (!rawOperator && !rawThreshold) return undefined;
    if (!rawOperator || !rawThreshold) return undefined;
    const operator = parseOperator(rawOperator);
    const threshold = Number(rawThreshold);
    return operator && Number.isFinite(threshold) ? { operator, threshold } : undefined;
  };
  const isLegacyEnabled = (value: unknown): boolean =>
    ['true', '1', 'yes', 'on', 'enabled', 'bat', 'bật'].includes(parseText(value).toLocaleLowerCase('vi-VN'));

  // Giờ/khoảng mặc định lấy từ bot_settings của Ruler lập lịch cũ (đọc bằng SQL thường).
  const readSetting = async (key: string, fallback: string): Promise<string> => {
    const row = await db.get<{ value: string }>('SELECT value FROM bot_settings WHERE key = ?', [key]).catch(() => undefined);
    const value = parseText(row?.value);
    return value || fallback;
  };
  const rawRunTime = await readSetting('material_ruler_run_time', '00:05');
  const runTime = /^\d{2}:\d{2}$/.test(rawRunTime) ? rawRunTime : '00:05';
  const rawPeriod = await readSetting('material_ruler_period', 'today');
  const period = /^(today|yesterday|month_to_date|last_\d{1,3}_days|\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2})$/i.test(rawPeriod)
    ? rawPeriod.toLowerCase()
    : 'today';

  let migrated = 0;
  let kept = 0;
  const migratedIds: number[] = [];

  for (const row of rows) {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(row.data_json) as Record<string, unknown>;
    } catch {
      console.warn(`[DB migration] material_ruler row ${row.id}: JSON không hợp lệ, giữ nguyên`);
      kept += 1;
      continue;
    }

    if (!isLegacyEnabled(value.enabled)) {
      kept += 1;
      continue;
    }

    const spend = parseCondition(value.spend_operator, value.spend_threshold);
    const cpa = parseCondition(value.cpa_operator, value.cpa_threshold);
    const conversions = parseCondition(value.conversions_operator, value.conversions_threshold);

    const malformed = ([
      [value.spend_operator, value.spend_threshold],
      [value.cpa_operator, value.cpa_threshold],
      [value.conversions_operator, value.conversions_threshold],
    ] as const).some(([operatorValue, thresholdValue]) =>
      Boolean(parseText(operatorValue) || parseText(thresholdValue)) && !parseCondition(operatorValue, thresholdValue)
    );

    if (malformed || (!spend && !cpa)) {
      console.warn(`[DB migration] material_ruler row ${row.id}: điều kiện không đọc được, giữ nguyên trong admin_config_rows`);
      kept += 1;
      continue;
    }

    let metricCondition: { metric: 'spend' | 'cpa'; operator: string; threshold: number };
    if (cpa && spend) {
      metricCondition = { metric: 'cpa', operator: cpa.operator, threshold: cpa.threshold };
      console.log(`[DB migration] material_ruler row ${row.id}: có cả điều kiện Spend và CPA — chọn CPA`);
    } else {
      metricCondition = cpa
        ? { metric: 'cpa', operator: cpa!.operator, threshold: cpa!.threshold }
        : { metric: 'spend', operator: spend!.operator, threshold: spend!.threshold };
    }

    await db.run(
      `INSERT INTO alert_action_rules
        (entity,name_contains,metric,metric_operator,metric_threshold,metric_min_threshold,
         conversions_operator,conversions_threshold,action,trigger_kind,run_time,period,is_active,note)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        'material',
        parseText(value.campaign_match) || null,
        metricCondition.metric,
        metricCondition.operator,
        metricCondition.threshold,
        null,
        conversions ? conversions.operator : 'gte',
        conversions ? conversions.threshold : 0,
        'enable',
        'scheduled',
        runTime,
        period,
        1,
        parseText(value.note) || null,
      ]
    );
    migratedIds.push(row.id);
    migrated += 1;
  }

  if (migrated > 0) {
    await db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of migratedIds) {
        await db.run('DELETE FROM admin_config_rows WHERE id=?', [id]);
      }
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  }

  console.log(
    `[DB migration] material_ruler: chuyển ${migrated} rule sang alert_action_rules (scheduled ${runTime}, khoảng ${period}); giữ lại ${kept} dòng trong admin_config_rows`
  );
}

const UNIFY_RULER_ENTITY_MARKER = 'ruler_entity_unified_both_migrated';
const DUAL_LAYER_RULER_MARKER = 'ruler_entity_dual_layers_migrated';

/**
 * Deprecated: không còn gộp campaign/material → both.
 * Chỉ đánh dấu đã xử lý để không chạy lại bản gộp cũ trên DB mới.
 */
async function migrateUnifyRulerEntityToBoth(): Promise<void> {
  const marker = await db.get<{ value: string }>(
    'SELECT value FROM bot_settings WHERE key = ?',
    [UNIFY_RULER_ENTITY_MARKER]
  );
  if (String(marker?.value || '') === '1') return;

  await db.run(
    'INSERT OR REPLACE INTO bot_settings(key, value, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)',
    [UNIFY_RULER_ENTITY_MARKER, '1']
  );
  console.log('[DB migration] ruler entity: bỏ qua gộp → both (giữ ngưỡng camp/material riêng)');
}

/**
 * Một lần: tách entity=both (pause/enable) thành 2 dòng campaign + material
 * cùng ngưỡng ban đầu — UI/engine dùng ngưỡng riêng từng tầng.
 * Quy tắc notify giữ entity=both.
 */
async function migrateBothEntityToDualLayers(): Promise<void> {
  const marker = await db.get<{ value: string }>(
    'SELECT value FROM bot_settings WHERE key = ?',
    [DUAL_LAYER_RULER_MARKER]
  );
  if (String(marker?.value || '') === '1') return;

  type BothRow = {
    id: number;
    trigger_kind: string | null;
    run_time: string | null;
    period: string | null;
    name_contains: string | null;
    metric: string;
    metric_operator: string;
    metric_threshold: number;
    metric_min_threshold: number | null;
    conversions_operator: string;
    conversions_threshold: number;
    action: string;
    is_active: number | null;
    note: string | null;
  };

  const bothRows = await db.all<BothRow>(
    `SELECT id,trigger_kind,run_time,period,name_contains,metric,metric_operator,metric_threshold,
            metric_min_threshold,conversions_operator,conversions_threshold,action,is_active,note
     FROM alert_action_rules
     WHERE entity = 'both' AND action IN ('pause', 'enable')
     ORDER BY id`
  ).catch(() => [] as BothRow[]);

  let expanded = 0;
  if (bothRows.length > 0) {
    await db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of bothRows) {
        await db.run(
          `UPDATE alert_action_rules SET entity = 'campaign', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [row.id]
        );
        await db.run(
          `INSERT INTO alert_action_rules(
            entity,trigger_kind,run_time,period,name_contains,metric,metric_operator,metric_threshold,
            metric_min_threshold,conversions_operator,conversions_threshold,action,is_active,note
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            'material',
            row.trigger_kind || 'continuous',
            row.run_time,
            row.period,
            row.name_contains,
            row.metric,
            row.metric_operator,
            row.metric_threshold,
            row.metric_min_threshold,
            row.conversions_operator,
            row.conversions_threshold,
            row.action,
            row.is_active ?? 1,
            row.note,
          ]
        );
        expanded += 1;
      }
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  }

  await db.run(
    'INSERT OR REPLACE INTO bot_settings(key, value, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)',
    [DUAL_LAYER_RULER_MARKER, '1']
  );

  console.log(
    `[DB migration] ruler dual-layer: tách ${expanded} rule both → campaign + material`
  );
}

export async function connectDB() {
  // Open the database
  db = new SqliteDatabase(resolve(process.env.DATABASE_PATH || './bot_data.db'));

  // Create tables if they don't exist
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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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

  const addColumnIfMissing = async (sql: string): Promise<void> => {
    try {
      await db.run(sql);
    } catch (error) {
      if (!String(error).includes('duplicate column name')) {
        throw error;
      }
    }
  };

  await addColumnIfMissing("ALTER TABLE alert_action_rules ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'continuous'");
  await addColumnIfMissing('ALTER TABLE alert_action_rules ADD COLUMN run_time TEXT');
  await addColumnIfMissing('ALTER TABLE alert_action_rules ADD COLUMN period TEXT');

  await migrateLegacyMaterialRulerRules();
  await migrateUnifyRulerEntityToBoth();
  await migrateBothEntityToDualLayers();

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
    CREATE TABLE IF NOT EXISTS campaign_change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT,
      action TEXT NOT NULL,
      advertiser_id TEXT,
      campaign_id TEXT,
      before_json TEXT,
      after_json TEXT,
      ok INTEGER NOT NULL,
      detail TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
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

  console.log('Connected to database and initialized tables');
  return db;
}

export { db };
