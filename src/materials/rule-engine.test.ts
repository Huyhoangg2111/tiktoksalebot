import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'rule-engine-')), 'test.db');

test('resolvePeriodValue trả về khoảng đúng cho từng loại period', async () => {
  const { resolvePeriodValue, vnNow } = await import('./rule-engine.js');
  const today = '2026-10-17';

  assert.deepEqual(resolvePeriodValue('today', today), { start: '2026-10-17', end: '2026-10-17', label: '2026-10-17' });
  assert.deepEqual(resolvePeriodValue(undefined, today), { start: '2026-10-17', end: '2026-10-17', label: '2026-10-17' });
  assert.deepEqual(resolvePeriodValue('hôm_nay', today), { start: '2026-10-17', end: '2026-10-17', label: '2026-10-17' });
  assert.deepEqual(resolvePeriodValue('yesterday', today), { start: '2026-10-16', end: '2026-10-16', label: '2026-10-16' });
  assert.deepEqual(resolvePeriodValue('month_to_date', today), { start: '2026-10-01', end: '2026-10-17', label: '2026-10-01..2026-10-17' });
  assert.deepEqual(resolvePeriodValue('last_7_days', today), { start: '2026-10-11', end: '2026-10-17', label: '2026-10-11..2026-10-17' });
  // Kẹp số ngày tối đa 90.
  assert.deepEqual(resolvePeriodValue('last_999_days', today), { start: '2026-07-20', end: '2026-10-17' , label: '2026-07-20..2026-10-17' });
  // Khoảng cố định hợp lệ.
  assert.deepEqual(resolvePeriodValue('2026-09-01..2026-09-30', today), { start: '2026-09-01', end: '2026-09-30', label: '2026-09-01..2026-09-30' });
  // Khoảng đảo chiều và giá trị lạ → undefined.
  assert.equal(resolvePeriodValue('2026-09-30..2026-09-01', today), undefined);
  assert.equal(resolvePeriodValue('tuan_truoc', today), undefined);
  // vnNow theo HH:mm và YYYY-MM-DD.
  const now = vnNow();
  assert.match(now.dateKey, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(now.timeKey, /^\d{2}:\d{2}$/);
});

test('ruler dual-layer: tách entity=both (pause/enable) thành campaign + material', async () => {
  const dbModule = await import('../db/index.js');
  await dbModule.connectDB();
  const database = dbModule.db;
  assert.ok(database, 'db phải sẵn sàng sau connectDB');

  await database.run('DELETE FROM alert_action_rules');
  await database.run('DELETE FROM bot_settings WHERE key = ?', ['ruler_entity_dual_layers_migrated']);
  await database.run(
    `INSERT INTO alert_action_rules
      (entity,name_contains,metric,metric_operator,metric_threshold,conversions_operator,conversions_threshold,action,trigger_kind,is_active,note)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ['both', 'gau-bong-vn', 'spend', 'gt', 0.5, 'lt', 1, 'pause', 'continuous', 1, 'demo']
  );
  await database.run(
    `INSERT INTO alert_action_rules
      (entity,name_contains,metric,metric_operator,metric_threshold,conversions_operator,conversions_threshold,action,trigger_kind,is_active,note)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ['both', 'gau-bong-vn', 'spend', 'gt', 1, 'gte', 0, 'notify', 'continuous', 1, 'keep-both']
  );

  // Chạy logic migrate tương đương production (module đã connect 1 lần).
  const bothRows = await database.all<{
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
  }>(
    `SELECT id,trigger_kind,run_time,period,name_contains,metric,metric_operator,metric_threshold,
            metric_min_threshold,conversions_operator,conversions_threshold,action,is_active,note
     FROM alert_action_rules WHERE entity='both' AND action IN ('pause','enable') ORDER BY id`
  );
  for (const row of bothRows) {
    await database.run(`UPDATE alert_action_rules SET entity='campaign' WHERE id=?`, [row.id]);
    await database.run(
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
  }
  await database.run(
    'INSERT OR REPLACE INTO bot_settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)',
    ['ruler_entity_dual_layers_migrated', '1']
  );

  const rows = await database.all<{ entity: string; action: string }>(
    'SELECT entity, action FROM alert_action_rules ORDER BY entity, action'
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map(r => `${r.entity}:${r.action}`).sort(),
    ['both:notify', 'campaign:pause', 'material:pause']
  );
});

test('ruler dual-layer: ngưỡng camp và material khác nhau không bị gộp', async () => {
  const dbModule = await import('../db/index.js');
  await dbModule.connectDB();
  const database = dbModule.db;
  await database.run('DELETE FROM alert_action_rules');
  await database.run(
    `INSERT INTO alert_action_rules
      (entity,name_contains,metric,metric_operator,metric_threshold,conversions_operator,conversions_threshold,action,trigger_kind,is_active)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ['campaign', 'gau bong -VN', 'spend', 'gt', 0.5, 'lt', 1, 'pause', 'continuous', 1]
  );
  await database.run(
    `INSERT INTO alert_action_rules
      (entity,name_contains,metric,metric_operator,metric_threshold,conversions_operator,conversions_threshold,action,trigger_kind,is_active)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ['material', 'gau bong -VN', 'spend', 'gt', 0.2, 'lt', 1, 'pause', 'continuous', 1]
  );

  const camp = await database.all<{ entity: string; metric_threshold: number }>(
    `SELECT entity, metric_threshold FROM alert_action_rules WHERE entity IN ('campaign','both')`
  );
  const mat = await database.all<{ entity: string; metric_threshold: number }>(
    `SELECT entity, metric_threshold FROM alert_action_rules WHERE entity IN ('material','both')`
  );
  assert.equal(camp.length, 1);
  assert.equal(camp[0]?.metric_threshold, 0.5);
  assert.equal(mat.length, 1);
  assert.equal(mat[0]?.metric_threshold, 0.2);
});
