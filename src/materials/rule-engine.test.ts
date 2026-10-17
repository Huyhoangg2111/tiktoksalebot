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
