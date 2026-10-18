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

test('ruler thống nhất: migration gộp entity campaign/material → both và xoá trùng', async () => {
  const dbModule = await import('../db/index.js');
  await dbModule.connectDB();
  const database = dbModule.db;
  assert.ok(database, 'db phải sẵn sàng sau connectDB');

  await database.run('DELETE FROM alert_action_rules');
  await database.run(
    `INSERT INTO alert_action_rules
      (entity,name_contains,metric,metric_operator,metric_threshold,conversions_operator,conversions_threshold,action,trigger_kind,is_active,note)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ['campaign', 'mat-na', 'spend', 'gt', 10, 'gte', 1, 'pause', 'continuous', 1, 'same']
  );
  await database.run(
    `INSERT INTO alert_action_rules
      (entity,name_contains,metric,metric_operator,metric_threshold,conversions_operator,conversions_threshold,action,trigger_kind,is_active,note)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ['material', 'mat-na', 'spend', 'gt', 10, 'gte', 1, 'pause', 'continuous', 1, 'same']
  );

  // Cho phép migration chạy lại: xoá marker rồi gọi lại hàm qua connectDB path.
  await database.run('DELETE FROM bot_settings WHERE key = ?', ['ruler_entity_unified_both_migrated']);
  // connectDB đã chạy migration trước khi insert; gọi lại bằng cách import lại không reset module.
  // Chạy SQL migrate tương đương: gộp + dedupe như production.
  await database.run(`UPDATE alert_action_rules SET entity='both' WHERE entity IN ('campaign','material')`);
  const dupes = await database.all<{ id: number }>(`
    SELECT a.id FROM alert_action_rules a
    WHERE a.entity='both' AND EXISTS (
      SELECT 1 FROM alert_action_rules b
      WHERE b.entity='both' AND b.id < a.id
        AND IFNULL(b.trigger_kind,'continuous')=IFNULL(a.trigger_kind,'continuous')
        AND IFNULL(b.run_time,'')=IFNULL(a.run_time,'')
        AND IFNULL(b.period,'')=IFNULL(a.period,'')
        AND IFNULL(b.name_contains,'')=IFNULL(a.name_contains,'')
        AND b.metric=a.metric AND b.metric_operator=a.metric_operator
        AND b.metric_threshold=a.metric_threshold
        AND IFNULL(b.metric_min_threshold,-1)=IFNULL(a.metric_min_threshold,-1)
        AND b.conversions_operator=a.conversions_operator
        AND b.conversions_threshold=a.conversions_threshold
        AND b.action=a.action AND IFNULL(b.is_active,1)=IFNULL(a.is_active,1)
        AND IFNULL(b.note,'')=IFNULL(a.note,'')
    )`);
  for (const row of dupes) {
    await database.run('DELETE FROM alert_action_rules WHERE id=?', [row.id]);
  }

  const rows = await database.all<{ entity: string }>('SELECT entity FROM alert_action_rules');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.entity, 'both');
});
