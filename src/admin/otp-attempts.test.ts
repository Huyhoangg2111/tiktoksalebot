import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'admin-otp-')), 'test.db');
process.env.ADMIN_CHAT_ID = '100';
process.env.ADMIN_WEB_USERNAME = 'admin';
process.env.ADMIN_WEB_PASSWORD = 'secret-basic';
process.env.ADMIN_WEB_PORT = '0';
delete process.env.ADMIN_DEV_SKIP_AUTH;
delete process.env.ADMIN_COOKIE_SECURE;

test('OTP wrong codes increment attempts; Secure cookie only on HTTPS', async () => {
  const dbMod = await import('../db/index.js');
  const { startAdminServer } = await import('./server.js');
  await dbMod.connectDB();
  const database = dbMod.db;

  let otp = '';
  const server = await startAdminServer(async code => {
    otp = code;
  });
  assert.ok(server);
  await onceListening(server);
  const port = listenPort(server);

  try {
    const requested = await fetch(`http://127.0.0.1:${port}/admin/auth/request`, { method: 'POST' });
    assert.equal(requested.status, 200);
    assert.match(otp, /^\d{10}$/);

    for (let i = 0; i < 4; i++) {
      const wrong = await fetch(`http://127.0.0.1:${port}/admin/auth/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '0000000000' }),
      });
      assert.equal(wrong.status, 401);
      const row = await database.get<{ attempts: number }>(
        'SELECT attempts FROM admin_login_codes WHERE used_at IS NULL ORDER BY id DESC LIMIT 1'
      );
      assert.equal(row?.attempts, i + 1);
    }

    const locked = await fetch(`http://127.0.0.1:${port}/admin/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '0000000000' }),
    });
    assert.equal(locked.status, 429);
    const after = await database.get<{ attempts: number; used_at: number | null }>(
      'SELECT attempts, used_at FROM admin_login_codes ORDER BY id DESC LIMIT 1'
    );
    assert.equal(after?.attempts, 5);
    assert.ok(after?.used_at);

    const lateCorrect = await fetch(`http://127.0.0.1:${port}/admin/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: otp }),
    });
    assert.equal(lateCorrect.status, 401);

    // Reset rate-limit window so we can mint a fresh code for cookie checks.
    await database.run('DELETE FROM admin_login_codes');
    otp = '';
    const requested2 = await fetch(`http://127.0.0.1:${port}/admin/auth/request`, { method: 'POST' });
    assert.equal(requested2.status, 200);
    assert.match(otp, /^\d{10}$/);

    const secureVerify = await fetch(`http://127.0.0.1:${port}/admin/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ code: otp }),
    });
    assert.equal(secureVerify.status, 200);
    const secureCookie = secureVerify.headers.get('set-cookie') || '';
    assert.match(secureCookie, /Secure/i);
    assert.match(secureCookie, /HttpOnly/i);
    assert.match(secureCookie, /SameSite=Strict/i);

    await database.run('DELETE FROM admin_login_codes');
    await database.run('DELETE FROM admin_sessions');
    otp = '';
    const requested3 = await fetch(`http://127.0.0.1:${port}/admin/auth/request`, { method: 'POST' });
    assert.equal(requested3.status, 200);

    const plainVerify = await fetch(`http://127.0.0.1:${port}/admin/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: otp }),
    });
    assert.equal(plainVerify.status, 200);
    const plainCookie = plainVerify.headers.get('set-cookie') || '';
    assert.doesNotMatch(plainCookie, /;\s*Secure/i);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

function onceListening(server: Server) {
  return new Promise<void>(resolve => {
    if (server.listening) resolve();
    else server.once('listening', () => resolve());
  });
}

function listenPort(server: Server) {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}
