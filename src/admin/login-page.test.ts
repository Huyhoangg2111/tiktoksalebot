import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'admin-login-')), 'test.db');
process.env.ADMIN_CHAT_ID = '100';
process.env.ADMIN_WEB_USERNAME = 'admin';
process.env.ADMIN_WEB_PASSWORD = 'secret-basic';
process.env.ADMIN_WEB_PORT = '0';

test('dashboard login is the OTP page, never the browser password dialog', async () => {
  const { connectDB } = await import('../db/index.js');
  const { startAdminServer } = await import('./server.js');
  await connectDB();
  let otp = '';
  const server = await startAdminServer(async code => {
    otp = code;
  });
  assert.ok(server);
  await onceListening(server);
  const port = listenPort(server);
  const basic = `Basic ${Buffer.from('admin:secret-basic').toString('base64')}`;
  try {
    const page = await fetch(`http://127.0.0.1:${port}/admin/`, {
      headers: { accept: 'text/html', authorization: basic },
    });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('www-authenticate'), null);
    assert.match(await page.text(), /<title>Đăng nhập · TikTokSaleBot Admin<\/title>/);

    const stale = await fetch(`http://127.0.0.1:${port}/admin/`, {
      headers: { accept: 'text/html', cookie: 'admin_session=expired-token', authorization: basic },
    });
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get('www-authenticate'), null);
    assert.match(await stale.text(), /<title>Đăng nhập · TikTokSaleBot Admin<\/title>/);

    const api = await fetch(`http://127.0.0.1:${port}/admin/api/settings`, {
      headers: { accept: 'application/json', authorization: basic },
    });
    assert.equal(api.status, 401);
    assert.equal(api.headers.get('www-authenticate'), null);
    assert.deepEqual(await api.json(), { error: 'login_required' });

    const requested = await fetch(`http://127.0.0.1:${port}/admin/auth/request`, { method: 'POST' });
    assert.equal(requested.status, 200);
    assert.match(otp, /^\d{10}$/);

    const verified = await fetch(`http://127.0.0.1:${port}/admin/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: otp }),
    });
    assert.equal(verified.status, 200);
    const setCookie = verified.headers.get('set-cookie') || '';
    const token = /admin_session=([^;]+)/.exec(setCookie)?.[1];
    assert.ok(token);

    const dashboard = await fetch(`http://127.0.0.1:${port}/admin/`, {
      headers: { accept: 'text/html', cookie: `admin_session=${token}`, authorization: basic },
    });
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.headers.get('www-authenticate'), null);
    assert.match(await dashboard.text(), /<title>TikTokSaleBot Admin<\/title>/);
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
