import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { handleCampaignAdmin } from './campaign-tools.js';
import { createConfirmation, peekConfirmation } from '../campaigns/confirmations.js';

function request(body: unknown): IncomingMessage {
  return Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
}

function response(): ServerResponse & { statusCode: number; payload: string } {
  const res = {
    statusCode: 0,
    payload: '',
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
    end(data?: string) {
      this.payload = data || '';
    },
  };
  return res as unknown as ServerResponse & { statusCode: number; payload: string };
}

test('dashboard delete keeps the confirm token when the retyped id does not match', async () => {
  const token = createConfirmation({
    kind: 'delete-partial',
    actor: 'dashboard',
    summary: 'xóa',
    payload: { campaignId: '12345' },
  });
  const res = response();
  const handled = await handleCampaignAdmin(
    Object.assign(request({ token, confirmId: '99999' }), { method: 'POST' }),
    res,
    new URL('http://127.0.0.1/admin/api/campaigns/confirm')
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.match(res.payload, /Gõ lại đúng campaign id/);
  assert.ok(peekConfirmation(token));
});

test('dashboard confirm does not consume a token that belongs to another actor', async () => {
  const token = createConfirmation({
    kind: 'budget',
    actor: 'telegram:1:2',
    summary: 'ngân sách',
    payload: { campaignId: '12345', budget: 10, stateHash: 'abc' },
  });
  const res = response();
  await handleCampaignAdmin(
    Object.assign(request({ token }), { method: 'POST' }),
    res,
    new URL('http://127.0.0.1/admin/api/campaigns/confirm')
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.payload, /không còn hiệu lực/);
  assert.ok(peekConfirmation(token));
});
