import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Chạy từ dist/: đọc bản đã biên dịch (cùng nội dung HTML/JS nhúng).
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'server.js'),
  'utf8'
);

test('ruler UI: groupRulerRows không gộp metric khác / slot đã có trên cùng tên camp', () => {
  assert.match(source, /layerHasThreshold/);
  assert.match(source, /cfg\.metric!==rowMetric/);
  assert.match(source, /cfg\[row\.action\]&&String\(cfg\[row\.action\]\.metric_threshold/);
});

test('ruler UI: entity=both và flatten không tái dùng cùng id cho hai tầng', () => {
  assert.match(source, /if\(layerIndex>0\)delete copy\.id/);
  assert.match(source, /const usedIds=new Set\(\)/);
  assert.match(source, /if\(usedIds\.has\(n\)\)id=undefined/);
});

test('ruler UI: có thêm quy tắc thông báo Telegram (blankNotify + nút)', () => {
  assert.match(source, /const blankNotify=/);
  assert.match(source, /id="add-notify"/);
  assert.match(source, /action:'notify'/);
  assert.match(source, /entity:'both'/);
  assert.match(source, /Thông báo Telegram/);
});
