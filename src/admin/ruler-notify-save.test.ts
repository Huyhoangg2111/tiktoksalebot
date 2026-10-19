import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'admin-notify-')), 'test.db');
process.env.ADMIN_CHAT_ID = '100';
process.env.ADMIN_WEB_USERNAME = 'admin';
process.env.ADMIN_WEB_PASSWORD = 'secret-basic';
process.env.ADMIN_WEB_PORT = '0';
process.env.ADMIN_DEV_SKIP_AUTH = '1';

test('PUT ruler_auto persists brand-new notify rows (insert ids not deleted)', async () => {
  const dbMod = await import('../db/index.js');
  const { startAdminServer } = await import('./server.js');
  await dbMod.connectDB();
  const database = dbMod.db;
  await database.run('DELETE FROM alert_action_rules');

  const server = await startAdminServer(async () => {});
  assert.ok(server);
  await onceListening(server);
  const port = listenPort(server);

  try {
    const payload = {
      rows: [{
        entity: 'both',
        trigger_kind: 'continuous',
        run_time: '',
        period: '',
        name_contains: 'TEST-NOTIFY',
        metric: 'spend',
        metric_operator: 'gt',
        metric_threshold: '50',
        metric_min_threshold: '',
        conversions_operator: 'gte',
        conversions_threshold: '1',
        action: 'notify',
        enabled: 1,
        note: 'telegram notify',
      }],
    };
    const saved = await fetch(`http://127.0.0.1:${port}/admin/api/ruler_auto`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(saved.status, 200, await saved.text());

    const rows = await database.all<{ entity: string; action: string; name_contains: string; metric_threshold: number }>(
      'SELECT entity, action, name_contains, metric_threshold FROM alert_action_rules'
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].entity, 'both');
    assert.equal(rows[0].action, 'notify');
    assert.equal(rows[0].name_contains, 'TEST-NOTIFY');
    assert.equal(Number(rows[0].metric_threshold), 50);

    const existing = await database.get<{ id: number }>('SELECT id FROM alert_action_rules LIMIT 1');
    assert.ok(existing);
    const mixed = await fetch(`http://127.0.0.1:${port}/admin/api/ruler_auto`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rows: [
          { ...payload.rows[0], id: existing.id },
          {
            entity: 'campaign',
            trigger_kind: 'continuous',
            name_contains: 'TEST-NOTIFY',
            metric: 'spend',
            metric_operator: 'gt',
            metric_threshold: '100',
            metric_min_threshold: '',
            conversions_operator: 'gte',
            conversions_threshold: '1',
            action: 'pause',
            enabled: 1,
            note: '',
          },
        ],
      }),
    });
    assert.equal(mixed.status, 200, await mixed.text());
    const after = await database.all<{ action: string }>('SELECT action FROM alert_action_rules ORDER BY action');
    assert.deepEqual(after.map(row => row.action), ['notify', 'pause']);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

function onceListening(server: Server) {
  return new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
  });
}

function listenPort(server: Server) {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}
